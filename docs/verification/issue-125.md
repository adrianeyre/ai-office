# Issue #125: Communications Agent, Connections and the generic webhook — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **`packages/communications`**, a new workspace package (PRD §8's layout):
  - **The Communications Agent** (FR-90): the one office-wide Agent, made at
    first start (`communications_agent`, one row, migration
    `0046_communications`). Its Role is `communications`; it belongs to no
    Floor and is not in `agents`, so it has no sandbox, no Gateway Key, no
    repository access and no GitHub token. It reads the event bus and
    writes only to Connections. Name, AI Provider, Model and enabled/paused
    are edited in the office admin; a change is `config.changed` with the
    new scope `communications`.
  - **Connections** (`connections`): name, type, rules, detail level
    (stored, `titles_and_summaries`), non-secret settings, credentials
    sealed with `ENCRYPTION_KEY` (`@ai-office/shared/crypto`, context
    `connection.credentials:<id>`), a hint, paused, status and the count of
    failures in a row.
  - **The durable queue** (`connection_deliveries`): the bus is read from a
    cursor kept with the Agent (`event_cursor`), so events published while
    AI Office is down are still queued; a unique index on
    `(connection_id, event_id)` makes each event queued at most once per
    Connection; the cursor moves in the same transaction as the inserts.
    A worker sends what is due, every 2 seconds and as soon as something
    is queued. Failures are retried after 30 s, doubling to at most an
    hour, or after the service's `Retry-After`, until 24 hours after the
    first attempt (`connection.delivery_expired`). After 5 failures in a
    row the Connection is failing (`connection.failing`) and an action
    Notice is raised; it links to the Connection
    (`/admin/connections?connection=<id>`), which is how it is never queued
    for that Connection. The next delivery that arrives records the
    recovery (`connection.recovered`). While the Agent is paused nothing is
    sent and deliveries wait.
  - **Rules and templates** (FR-92): action Notices (on), info Notices
    (off), work complete (on: `pull_request.merged`, which closes its issue
    by `Closes #N`), and a Floor filter. Messages are deterministic
    (`messages.ts`): title, Floor, kind, a link to the Notice (or the
    issue's activity) in AI Office and a link to GitHub; each is redacted
    before it is queued.
  - **The generic webhook** (FR-91): a JSON POST, signed with HMAC-SHA256
    in `X-AI-Office-Signature-256` when it has a secret, with the delivery
    id in `X-AI-Office-Delivery`. Its answer is never read.
- **Events** (`packages/events`): `connection.added`, `connection.changed`,
  `connection.removed`, `connection.failing`, `connection.recovered`,
  `connection.delivery_expired`, shown in the Activity Feed (with a
  "Connections" type group). Successful deliveries are only in the
  Connection's own log.
- **Server** (`apps/server/src/connections/routes.ts`): `GET`/`PATCH
  /api/communications-agent`, `GET`/`POST /api/connections`,
  `PATCH`/`DELETE /api/connections/:id`, `POST /api/connections/:id/test`,
  `GET /api/connections/:id/deliveries`. The server starts the Agent after
  it listens and stops it on close.
- **Web** (`/admin/connections`, linked from Admin's **Communications**
  card): the Communications Agent's form; each Connection with its status,
  last delivery and recent deliveries; Send test with its result; Edit
  (rename and rules); Pause, Resume and Delete; and the add form, whose
  address and secret are cleared once sent and never shown again.
- The Dockerfile copies the new package; the README documents it all.

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass — all three
      pass (output below). While the host was busy with sibling runs (load
      average 68 to 113 on 16 CPUs), earlier full runs had some
      pre-existing, unrelated web tests time out at Vitest's 5-second
      default (every failure `Error: Test timed out in 5000ms.`, never an
      assertion, a different set each run). Once the load fell, the same
      commit ran 233 of 233 files green. No test was skipped, weakened or
      given a longer time-out.
- [x] Integration tests against a fake webhook server
      (`packages/communications/src/communications.test.ts`, with
      `serveFakeWebhook` from `@ai-office/communications/testing`, a real
      HTTP server):
  - an action Notice is delivered once with a valid signature
    (`verifySignature` on the raw body, and refused with another secret;
    taking in and delivering again sends nothing more);
  - a restart mid-retry loses nothing: a delivery fails twice (500), the
    Agent is stopped, another event is published while it is down, and a
    new Agent over the same store sends both, each once, every attempt of
    one carrying the same delivery id;
  - 5 failures raise exactly one "Connection failing" action Notice, which
    a second Connection receives and the failing one never does (a sixth
    failure raises no other), with `connection.failing`;
  - recovery is recorded: the next delivery that arrives sets it `ok` and
    publishes `connection.recovered`;
  - also: exponential backoff (30 s, then 60 s), `Retry-After` respected,
    a delivery given up 24 hours after its first attempt, pausing the
    Agent holding deliveries until it resumes, rules and the Floor filter,
    and the templates being deterministic.
  - The server's API runs the same against the real Notices
    (`apps/server/src/connections/routes.test.ts`: "an action Notice
    raised in the Office reaches a webhook Connection once, signed").
- [x] Integration tests: credentials are stored encrypted and never
      returned by the API (`routes.test.ts`, "stores credentials sealed and
      never answers, logs or publishes them": the stored value is
      `aio1:`-sealed and holds neither the address nor the secret, and
      neither appears in any answer, the delivery log, the events or the
      server's log lines; `communications.test.ts` also opens the sealed
      value with its context).
- [ ] Playwright: add a webhook Connection, send a test, pause and delete
      it — **written** (`e2e/tests/connections.spec.ts`, plus the page in
      the accessibility spec's every-page check) and type-checked, **but
      not run**: the end-to-end suite needs Postgres through Testcontainers
      and there is no Docker here. The same flow is covered in jsdom by
      `apps/web/src/connections-page.test.tsx` (5 tests, passing).

The Postgres variants of every communications and Connections API case
(16 tests) are skipped here with the harness's reason ("Docker is not
available (Could not find a working container runtime strategy), so the
Postgres integration tests are skipped. They run in CI and on the
host."); their in-memory twins pass.

### Not verifiable in this sandbox

- The Postgres 18 runs of `communications.test.ts` and
  `connections/routes.test.ts`, including `0046_communications` migrating,
  the unique `(connection_id, event_id)` index and the cursor's
  transaction (needs Docker).
- `e2e/tests/connections.spec.ts` and the Connections page's axe check in
  `e2e/tests/accessibility.spec.ts` (needs Docker and Chromium).
- A real third-party webhook receiver (Discord, Teams, Zapier, n8n).

## Notes and gaps

- **Batch finished** is one of FR-92's work-complete triggers, but nothing
  on this branch publishes an event when a Batch finishes (there is no
  Wrap-up yet: `batchStatuses` is `awaiting_approval` and `in_progress`).
  Work complete therefore covers a pull request merged, which closes its
  issue; the template list (`triggerEventTypes`) is where a `batch.finished`
  event joins when the Wrap-up issue adds one.
- The detail level is stored per Connection (default
  `titles_and_summaries`) but not editable: detail levels are out of scope
  here.
- Delivery is at most once per Connection in the queue. If the process
  dies after a service accepted a message but before the delivery is
  marked, the delivery is tried again after the restart (so nothing is
  lost); the `X-AI-Office-Delivery` id lets a receiver drop that repeat.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (at load average ~30, after the issue's last commit):

```text
 Test Files  233 passed (233)
      Tests  2734 passed | 382 skipped (3116)
   Duration  56.60s
```

An earlier full run at load average 113, for the record (time-outs only):

```text
$ grep -E "^(Error|AssertionError)" | sort | uniq -c
      6 Error: Test timed out in 5000ms.
 Test Files  5 failed | 228 passed (233)
      Tests  12 failed | 2722 passed | 382 skipped (3116)
   Duration  182.25s
```

This issue's tests:

```text
$ pnpm exec vitest run --project @ai-office/communications --project @ai-office/server src/connections src/communications
 Test Files  2 passed (2)
      Tests  17 passed | 16 skipped (33)
$ pnpm exec vitest run --project @ai-office/web src/connections-page
      Tests  5 passed (5)
$ pnpm exec vitest run --project deployment
      Tests  39 passed | 8 skipped (47)
```

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `e713845`, after the merge (`9629801`) and its follow-ups:
`0ae986e` (two stray `.orig` files removed), `945c595` (retention deletes
Connections' delivery logs) and `e713845` (a test of the Batches' prompt
check).

- **Migrations.** This branch keeps `0044_retention` and
  `0045_github_webhooks`. The merged branch's `0044_communications`,
  `0045_push_connections`, `0046_connection_detail_quiet_hours_digests`,
  `0047_batch_kickoff_wrap_up` and `0048_publishing_destinations` are
  replaced by one regenerated `0046_communications`, with their header
  comments, and `0047_connection_delivery_retention` follows it.
  `drizzle-kit generate` finds nothing more to generate. Neither migration
  has been applied to a real Postgres here (no Docker).

- **Beside this branch's server.** The server builds the Connection routes
  beside the GitHub webhook routes (#114), and starts the Communications
  Agent beside the hourly retention jobs (#112). Neither touches the
  other.
- **The delivery log is kept 90 days** (PRD §7), by retention's new
  Connection deliveries rule (`945c595`, see [`issue-112.md`](issue-112.md)):
  finished deliveries go; pending ones, still being retried or held for
  quiet hours, are the queue and always stay. Admin's Storage card can
  delete the log sooner.
- **Not in the configuration export** (#113): neither the Communications
  Agent's settings nor the Connections. A Connection cannot be imported
  without its credentials, which are write-only and never exported, so
  carrying Connections needs a decision (import them paused, awaiting
  credentials?) beyond this merge. The Communications Agent's name, AI
  Provider, Model and on/off could join the format on their own. FR-65
  calls for all configuration except credentials, so this is a gap to
  close in a follow-up.
- `docs/guide/notices-and-skills.md.orig`, a stray copy of the guide page
  from this issue's branch, was removed (`0ae986e`).

### Output of the checks

```text
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  266 passed (266)
      Tests  3067 passed | 435 skipped (3502)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 435 skipped tests need what the sandbox lacks: 409 Postgres 18 and
3 Mailpit through Testcontainers (Docker), 10 Docker, hadolint or Caddy
for the deployment, and 13 the real GitHub App. They run on the host and
in CI.

The Communications tests:

```text
 Test Files  10 passed (10)
      Tests  109 passed | 25 skipped (134)
```
