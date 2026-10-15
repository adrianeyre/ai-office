# Issue #34: AI Accounts: encrypted store and admin for key-based accounts — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit of
the issue (`e1df5a2`), after `pnpm install --frozen-lockfile`.

## What was built

### `ai_accounts` (`packages/db`, migration `0014_ai_accounts`)

- **Columns:** `id` (a UUID), `name` (unique), `account_type` (`api_key` or
  `oauth`), `ai_provider`, `credential`, `endpoint_url` (null for the AI
  Provider's own API), `priority` (1 to 100, 1 first), `paused`,
  `created_at` and `updated_at`.
- **The credential is sealed.** It is stored only as `aio1:…`, sealed with
  `ENCRYPTION_KEY` (#13), with the context `ai_account.credential:<id>`. The
  context is authenticated, so a value copied into another row does not
  open. A check constraint (`ai_accounts_credential_sealed`) refuses
  anything that is not sealed.
- **`gateway_requests.ai_account_id`** references the account, and is set to
  null when the account is deleted. `account` keeps the name the request was
  served under. #33 left this reference to this issue.

### `packages/shared` (`ai-accounts.ts`)

- **Schemas** for adding an account, for `PATCH` (`name`, `priority`,
  `paused`, at least one of them) and for the account as the API sends it.
  The last has no field for the credential.
- **Account kinds.** `aiAccountKinds` lists what can be added so far: an
  **Anthropic Console API key** (Claude, `api_key`, default endpoint
  `https://api.anthropic.com`).
- **Custom endpoint URLs** must be `http(s)`, with no query or fragment and
  no `user:password@`, because the URL is shown back to the Owner.
- **Validation messages never contain the value given.**

### `packages/gateway`

- **`accounts/store.ts`:** `memoryAiAccountStore` and
  `databaseAiAccountStore`. They list accounts by priority, then oldest
  first, and a duplicate name comes back as `name_taken`.
- **`accounts/accounts.ts`:** `createAiAccounts({ store, encryptor, events,
  onCredential })`. It provides:
  - `list`;
  - `add`, which seals the key, and puts the account after the others unless
    given a priority;
  - `update`, to rename, reprioritise, pause or resume;
  - `remove`;
  - `select`, which returns the first active account of a kind the Gateway
    can call, with its key opened.

  Each change publishes `config.changed` (scope `gateway`) with keys such as
  `aiAccounts.added`, `aiAccounts.name`, `aiAccounts.priority`,
  `aiAccounts.paused` and `aiAccounts.deleted`. Values are never in the
  event. `onCredential` is told each key in clear once, the first time this
  process holds it.
- **The Gateway selects from the store instead of config.** `buildGateway`
  takes an `AccountSource` and asks it for an account on every request, so
  a change applies at once, without a restart (FR-45). The 503 cases:
  - no active account: `No AI Account is available.`;
  - the accounts cannot be read (database down, undecryptable): `The AI
    Gateway could not read its AI Accounts.`, which is logged.

  Records carry `accountId`. `GET /health` on the Gateway says `available`
  or `none`. `staticAccounts()` is for tests.
- **`directoryFixtureRecorder`** also takes the shared redactor.

### `apps/server`

- **`/api/ai-accounts`** (`ai-accounts/routes.ts`), each route needing a
  session, with CSRF for changes:
  - `GET` lists the accounts;
  - `POST` adds one, answering `201`;
  - `PATCH /:accountId` changes one;
  - `DELETE /:accountId` deletes one, answering `204`.

  Errors: `400 invalid_request` (problems only), `404 ai_account_not_found`
  and `409 ai_account_name_taken`. `aiAccountBody` names every field it
  sends, so a credential cannot slip into an answer through a spread.
- **One redactor.** `startOffice` makes one redactor and gives it to the
  logger (`createLogger({ redactor })`), the event bus and the fixture
  recorder. `onCredential` registers each AI Account key with it, so a key
  is removed from logs even when it is not shaped like a known credential.
- **No AI Account from the environment.** `ANTHROPIC_API_KEY` and
  `ANTHROPIC_BASE_URL` are no longer read, as PRD FR-67 lists only start-up
  secrets for the environment. They are gone from `.env.example` and
  `docker-compose.yml`.

### `apps/web`

Admin has an **AI Accounts** card (`ai-accounts-card.tsx`):

- **The list,** in the order the Gateway uses the accounts. Each shows its
  status (Active or Paused), its kind, its priority and any custom endpoint.
- **Actions:** **Edit** (name and priority), **Pause** or **Resume**, and
  **Delete**, which asks for confirmation first.
- **The add form:** account type, name, API key (a password field, cleared
  once saved) and an optional custom endpoint URL. It says "Its key is
  stored encrypted and will not be shown again."

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). Without Docker the Postgres tests
      skip with the reason (744 passed, 120 skipped). Against Postgres 18
      (below), 849 passed and 15 skipped.
- [x] **Integration tests: credentials are stored encrypted and never
      returned by the API.**
  - **`apps/server/src/ai-accounts/routes.test.ts`** runs every case in
    memory and in Postgres 18, through the real routes, auth and logger.
    - **Stored sealed:** the stored credential is `aio1:…`, does not contain
      the key, and opens to the key only with its own row's context.
    - **Exact answer:** the `POST` answer is exactly the nine public fields,
      with no hint of the key.
    - **Nothing carries the key.** After every action, no answer, stored
      event or log line contains the key: every `POST`, `GET` and `PATCH`
      answer, the `409` and `400` answers, and the server's logger at
      `trace`. The key used is deliberately not shaped like an Anthropic key,
      so only its registration with the redactor could hide it.
    - **Refusals without echoes:** a malformed key, or an endpoint URL with
      a password in it, is refused without echoing either.
    - **Access:** the routes need a session, and the CSRF token for changes.
  - **`packages/gateway/src/accounts/accounts.test.ts`** also runs in memory
    and in Postgres 18:
    - sealing, and a sealed value moved to another row failing to open;
    - ordering, selection and pausing;
    - events without the key;
    - Postgres refusing an unsealed credential (the check constraint);
    - a deleted account's requests keeping its name, with
      `ai_account_id` set to null;
    - the Gateway forwarding with the opened key and recording the
      account's id.
  - **`apps/server/src/main.test.ts`** runs the real `startServer` against
    Postgres 18:
    - with no account, the Gateway answers 503;
    - an account added through the API is served at once, with the key sent
      upstream;
    - the `ai_accounts` row holds only the sealed value;
    - the stored events do not contain the key.

  **Negative checks** (each reverted afterwards):
  - **Storing the key unsealed.** 19 tests failed, in memory and in
    Postgres, including the Postgres check constraint refusing the insert.
  - **Echoing the key in the `POST` answer.** 3 API tests failed.
  - **Logging the key in the `POST` route.** With the redactor registration
    working, the tests still passed: the key was redacted from the log.
    With registration turned off as well, 3 tests failed.
- [x] **Playwright: add, pause and delete an account.**
      `e2e/tests/ai-accounts.spec.ts` runs in real Chromium against the real
      server, its AI Gateway and a fake AI Provider, on the embedded
      Postgres 18.3. It:
  - adds "Work" from the form, and checks the key field is cleared;
  - sees the Gateway serve from it at once, sending the key upstream;
  - reloads, and checks the key is not in the page;
  - pauses it, and sees the Gateway answer 503, then reloads and sees it is
    still paused;
  - deletes it, which needs a confirmation, and reloads;
  - finds the change in the Activity Feed;
  - checks the key is in neither the page nor the server's log.

  The whole Playwright suite passed: 16 tests (output below).

  **Negative check:** with `select()` changed to serve paused accounts, the
  spec failed at the pause step (`Expected: 503, Received: 200`). The change
  was reverted.

Component tests (`apps/web/src/ai-accounts-card.test.tsx`, 5 tests) cover:

- the empty state;
- adding an account: the request body, the CSRF token, the key field
  cleared and the key absent from the DOM;
- validation and API errors shown;
- pausing, resuming, renaming and reprioritising, which re-orders the list;
- deleting only after confirming.

### How Postgres and Chromium were run here

There is no Docker in this sandbox, so I used the method of #6 to #33:

- **Postgres.** `@embedded-postgres/linux-x64@18.3.0-beta.16` in
  `/tmp/pg18`, outside the repository, on port 54329. For the unit and
  integration tests, a scratch edit to the clone's
  `packages/db/src/testing/postgres.ts` pointed `postgresTest` at that
  server. It was reverted with `git checkout`, and nothing from it is
  committed. `pnpm e2e` used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium.** Installed with `playwright install chromium`. Its missing
  shared libraries (`libnss3`, `libgbm1`, `libcups2`…) were extracted
  from Debian bookworm's packages into `/tmp/chromelibs`, outside the
  repository, and used through `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- The Testcontainers path of the Postgres tests and of `pnpm e2e` (no
  Docker). Both ran against the embedded Postgres 18.3 instead, and run in
  CI.
- A real Anthropic Console API key through the Gateway, against
  `api.anthropic.com`. There is no AI Account here, and tests never call a
  live AI Provider (PRD §9). A fake AI Provider stood in.
- The `docker compose` stack with accounts added in Admin (#9's stack).
- Claude Code in a real sandbox reaching models through the Gateway (needs
  Docker, and the App and sandbox repository of #18).

## Notes

- **Priority:** 1 is used first. That is the reverse of a Floor's priority
  (0 to 10, higher first), but it reads as an order ("account 1 first"),
  which is what the Gateway uses it for. Ties go to the oldest account. A
  new account goes after the others unless given a priority.
- **The Gateway reads `ai_accounts` on every request.** It is one indexed
  query on a tiny table, plus one AES-GCM decryption, so changes from Admin
  apply at once. The benchmark from #33 uses a static account, so it still
  measures only the forwarding overhead. Caching can come with the
  strategies of #38 if it is ever needed.
- **Selection is by priority alone.** Load-balancing strategies are #38,
  and OAuth accounts are #37. `select` skips kinds it cannot call yet, so a
  future `oauth` row cannot reach the API-key forwarding path.
- **"Never shown again" is literal.** FR-5 allows "never shown in full",
  but the issue says the credential is never shown again, so the API sends
  no hint (such as the last four characters).
- **`ANTHROPIC_API_KEY` is no longer read.** An installation that set it
  must add the account in Admin. The Gateway answers 503 until then, as it
  did without the variable before. The variable is still allowed in a
  sandbox's environment for agent tools (#24); that is unrelated.
- **The Gateway's `/health`** now says `available` (an active account
  exists) rather than `configured`.
- **Activity Feed wording.** A change shows as "AI Gateway settings changed:
  aiAccounts.paused." It does not say which account: `config.changed` names
  settings, never values, and an account's name is a value the Owner typed.

## Output

### Fresh clone (`/tmp/clone34`, `e1df5a2`)

```text
$ pnpm install --frozen-lockfile
Done in 978ms using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  77 passed (77)
      Tests  744 passed | 120 skipped (864)
test exit=0
```

### Against the embedded Postgres 18.3

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  77 passed (77)
      Tests  849 passed | 15 skipped (864)
```

The 15 skips are the migration tests that start their own container, the
real-App GitHub contract (#18), and the Docker image and compose checks.

The new and changed Postgres-backed tests (verbose):

```text
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > stores the credential sealed for its own row, and never hands it back 4564ms
 ✓ src/ai-accounts/routes.test.ts > the AI Accounts API, in Postgres 18 > adds an account, stores its credential sealed, and never returns it 4271ms
 ✓ src/request-log.test.ts > databaseRequestLog against Postgres 18 > records a request through the Gateway 3501ms
 ✓ src/main.test.ts > the AI Gateway and the AI Accounts added in Admin > serves from an account added through the API, with its key sealed in the database 3668ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > lists accounts by priority, new ones after the rest unless given one 223ms
 ✓ src/ai-accounts/routes.test.ts > the AI Accounts API, in Postgres 18 > renames, reprioritises, pauses, resumes and deletes an account 221ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > serves from the first unpaused account, with its key in clear 103ms
 ✓ src/ai-accounts/routes.test.ts > the AI Accounts API, in Postgres 18 > refuses a malformed account without echoing what was sent 113ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > renames, reprioritises, pauses and resumes, recording only what changed 212ms
 ✓ src/ai-accounts/routes.test.ts > the AI Accounts API, in Postgres 18 > refuses a second account of one name, and an unknown account 193ms
 ✓ src/ai-accounts/routes.test.ts > the AI Accounts API's access > needs a session, and the CSRF token to change anything 13ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > refuses a second account of one name 135ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > deletes an account, and the next one serves 83ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > refuses to change or delete an account that does not exist 67ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > tells each credential once, so it can be redacted 83ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > is what the Gateway forwards with, and records 80ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > refuses a credential that is not sealed 69ms
 ✓ src/accounts/accounts.test.ts > AI Accounts, kept in Postgres 18 > keeps a deleted account's requests, by name 86ms
      Tests  36 passed (36)
```

(The in-memory cases of the same files also passed; they are in the 36.)

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium)

```text
  ✓   1 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (4.5s)
  ✓   4 [chromium] › tests/agent-live-view.spec.ts:10:1 › an Agent's events stream into its live view (4.5s)
  ✓   8 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (4.4s)
  ✓   2 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (4.5s)
  ✓   5 [chromium] › tests/ai-accounts.spec.ts:47:1 › adds an AI Account, pauses it, then deletes it (4.5s)
  ✓   6 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (4.5s)
  ✓   3 [chromium] › tests/activity.spec.ts:81:1 › the Activity Feed loads older events as it scrolls (4.5s)
  ✓   7 [chromium] › tests/agent-live-view.spec.ts:107:1 › the live view follows new output, and pauses while the Owner reads back (4.4s)
  ✓  12 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (3.5s)
  ✓  14 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (3.5s)
  ✓  10 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (3.5s)
  ✓  11 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (3.5s)
  ✓  13 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (3.5s)
  ✓   9 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (3.5s)
  ✓  15 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (3.5s)
  ✓  16 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (2.8s)
  16 passed (9.6s)
```

Without `E2E_POSTGRES_URL` or Docker:

```text
Docker is not available (Could not find a working container runtime strategy), so the end-to-end tests are skipped. They run in CI and on the host, or set E2E_POSTGRES_URL.
```
