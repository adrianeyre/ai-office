# Issue #35: Gateway Keys for Agents and Owner tools — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit of
the issue (`68f6b3c`), after `pnpm install --frozen-lockfile`.

## What was built

### `gateway_keys` (`packages/db`, migration `0015_gateway_keys`)

- **Columns:** `id`, `kind` (`agent` or `owner_tool`), `name`, `agent_id`
  and `floor_id` (an Agent's key only), `key_hash` (the SHA-256, unique),
  `hint` (the first 11 characters, `aio_gk_AbCd`), `sealed_key`,
  `created_at`, `last_used_at` and `revoked_at`.
- **Only hashes are checked.** A key is looked up by its SHA-256. An
  Agent's key is also kept sealed with `ENCRYPTION_KEY` (context
  `gateway_key:<id>`), because its sandboxes are given it (ADR 0001); an
  Owner tool's is never kept, so it is shown once only. Check constraints
  refuse an Agent's key that is not sealed, and an Owner tool's key with a
  sealed copy.
- **One key in use per Agent** (`gateway_keys_one_per_agent`), and one
  Owner tool key in use per name. Revoked keys stay, for the requests
  they made.
- **`gateway_requests`** gains `gateway_key_id`, `agent_id`, `floor_id`
  and `owner_tool`, with indexes on Agent and Floor (FR-42).

### `packages/shared`

- `gateway-keys.ts`: the request and answer schemas, `gatewayKeyPrefix`
  (`aio_gk_`) and the error codes. `agentErrorCodes.agentNotFound`.
- The redactor removes anything shaped like a Gateway Key.

### `packages/gateway`

- **`keys/keys.ts`:** `createGatewayKeys` gives `authenticate`, `list`,
  `createOwnerToolKey` (the only time a key is returned), `revoke` (Owner
  tools' keys only), `issueAgentKey` (rotation), `ensureAgentKey`,
  `agentKey` (opens the sealed key for a sandbox) and `revokeAgentKey`.
  A key's last use is written at most once a minute, without holding up
  the request. `onKey` registers every key this process holds with the
  central redactor. Owner tool keys made and revoked, and Agents' keys
  rotated or revoked, are `config.changed` events naming what changed; a
  key made with its Agent is part of `agent.created`.
- **`buildGateway` takes `keys`.** Every request presents a key as
  `x-api-key` or `Authorization: Bearer`. Without a key in use it is
  refused with `401 authentication_error` before anything else is read,
  is not forwarded, and is not recorded (it belongs to no one); a warning
  goes to the Gateway's log. The key is never forwarded upstream.
- **Attribution:** each record carries the key's id and either the Agent
  and Floor or the Owner tool's name.

### `packages/orchestrator`

- The sandbox runner asks `modelEnvironment(agent)` for each task, and
  `gatewayModelEnvironment(gatewayUrl, gatewayKey)` sets
  `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. The placeholder
  `noGatewayKey` is gone.

### `apps/server`

- **`/api/gateway-keys`:** `GET` lists the keys in use; `POST {"name"}`
  makes an Owner tool's key and answers `201 {"gatewayKey","key"}` with
  `cache-control: no-store`; `DELETE /:keyId` revokes one (`404` unknown,
  `409 agent_key_not_revocable` for an Agent's).
- **`POST /api/floors/:floorId/agents/:agentId/gateway-key/rotate`**
  gives the Agent a new key and revokes the old one.
- **Each new Agent gets a key.** `keepAgentKeys` follows `agent.created`
  (a key) and `agent.removed` (revoked), and when the app is ready gives
  every Agent without a key one (Agents made before this issue).
- The server gives sandboxes their Agent's own key, opened when the run
  starts.

### `apps/web`

- Admin's **Gateway Keys** card: the Owner's tools' keys (hint, made, last
  used, **Revoke** with confirmation), a form that makes one and shows it
  once with **Copy**, and the Agents' keys.
- The Floor admin's Agents table gains a **Gateway Key** column (hint,
  last used) with **Rotate**.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker, the Postgres tests
      skip with the reason (767 passed, 136 skipped). Against Postgres 18,
      888 passed and 15 skipped (the Docker image and compose checks).
- [x] **Integration tests: no key or a revoked key gets 401; requests are
      attributed correctly.**
  - `packages/gateway/src/keys/keys.test.ts`, in memory and in Postgres 18,
    through a real Gateway in front of a fake AI Provider:
    - no key, an unknown key, a malformed bearer token and a revoked key
      each get `401 authentication_error`, and none reaches the AI
      Provider or the request log; the key is never forwarded;
    - a key works as `x-api-key` and as a bearer token;
    - an Agent's request is recorded with its key, Agent and Floor, an
      Owner tool's with its key and name;
    - hashing, sealing, rotation (the old key stops at once), revocation,
      the once-a-minute last use, and events without keys;
    - in Postgres: one key in use per Agent, an Agent's key must be sealed,
      an Owner tool's may not be kept.
  - `apps/server/src/gateway-keys/routes.test.ts`, in memory and in
    Postgres 18, through the real routes, auth and logger: a key is shown
    once and never listed, logged or published; a revoked key gets 401;
    names in use are refused; rotation; an Agent's key cannot be revoked
    on its own; removing an Agent revokes its key.
  - `apps/server/src/main.test.ts`: the real `startServer` refuses a
    request without a key with 401, and (Postgres 18) serves a request
    with a key made through the API, recording the Owner tool.

  **Negative checks** (each reverted afterwards):
  - `authenticate` accepting revoked keys: 7 tests failed.
  - The Gateway dropping the Agent from records: 2 tests failed.
- [x] **A new Agent has a working key.** `gives each new Agent a working
      key, attributed to it and its Floor` adds a Floor through the API
      (its four Agents), sees four Agent keys, and sends a request with the
      coder's key through the Gateway: `200`, recorded with the coder and
      the Floor. `gives Agents made before Gateway Keys theirs when the app
      is ready` covers Agents made before this issue. The runner test
      `gives the sandbox the AI Gateway's URL and its own Agent's Gateway
      Key` checks the sandbox gets that key and no AI Account credential.

Also: component tests for the card (`gateway-keys-card.test.tsx`, 4 tests)
and the Agents table (`floors.test.tsx`: the key column and rotating), and
a Playwright spec, `e2e/tests/gateway-keys.spec.ts`: the Gateway refuses a
request without a key, a key made in Admin is shown once, works, shows its
last use, and is refused once revoked, never appearing on the page or in
the server's log. `ai-accounts.spec.ts` now calls the Gateway with a key
made in Admin. The whole Playwright suite passed (17 tests). The Activity
Feed spec caught a `config.changed` event per new Agent's key, which was
then removed (`fix(gateway): a key made with its Agent is not a
configuration change`).

### How Postgres and Chromium were run here

As in #6 to #34, without Docker:

- **Postgres.** `@embedded-postgres/linux-x64@18.3.0-beta.16`, unpacked in
  `/tmp/pg18`, outside the repository, on port 54329. For the Vitest run, a
  scratch edit to the clone's `packages/db/src/testing/postgres.ts` pointed
  `postgresTest` at it (with names unique to each test file); it was
  reverted with `git checkout` and nothing from it is committed. `pnpm e2e`
  used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium.** `playwright install chromium`, with its missing shared
  libraries extracted from Debian bookworm's packages into
  `/tmp/chromelibs` and used through `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- The Testcontainers path of the Postgres tests and of `pnpm e2e` (no
  Docker). Both ran against the embedded Postgres 18.3 instead.
- A real sandbox (Docker) running Claude Code against the Gateway with its
  Agent's key, and a real local Claude Code or Codex with an Owner tool's
  key. The fake sandbox and fetch stood in.
- A real AI Account behind the Gateway (#45 is open; tests never call a
  live AI Provider).

## Output

`pnpm lint` (fresh clone):

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  80 passed (80)
      Tests  767 passed | 136 skipped (903)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  80 passed (80)
      Tests  888 passed | 15 skipped (903)
   Start at  06:01:02
   Duration  34.39s (tests 82%, import 11%, environment 3%, transform 3%)
```

`pnpm e2e` (`E2E_POSTGRES_URL` on the embedded Postgres 18, tail):

```text
  ✓   9 [chromium] › tests/gateway-keys.spec.ts:15:1 › makes a Gateway Key for a tool, uses it, then revokes it (2.8s)
  ✓   6 [chromium] › tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it (4.7s)
  ✓   3 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (4.8s)
  …
  17 passed (11.6s)
```
