# Issue #7: Fastify server skeleton: env config, `/health`, serves the web build — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the commit that
implemented the issue (`ce33e2b`), after `pnpm install --frozen-lockfile`.

## What was built

- **`apps/server/src/config.ts`:** a Zod schema over the environment.
  - Required: `DATABASE_URL` (a `postgres://` or `postgresql://` URL),
    `SESSION_SECRET` (at least 32 characters) and `ENCRYPTION_KEY` (32 bytes,
    base64).
  - Optional: `PORT` (default 3000), `PUBLIC_URL` (default
    `http://localhost:<PORT>`), `HOST` (default `0.0.0.0`), `LOG_LEVEL`
    (default `info`) and `WEB_DIST_DIR` (default `apps/web/dist`).
  - GitHub App: `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are optional, but
    must be set together. A key written on one line with `\n` escapes is
    accepted.
  - An empty variable counts as unset. Every problem is reported at once in a
    `ConfigError` that names the key and never echoes its value.
- **`src/logger.ts`:** pino JSON logging. Each serialised line passes through
  a scrubber that replaces every secret value with `[REDACTED]`, including
  its JSON-escaped form. The secrets are `DATABASE_URL`, its password (raw
  and URL-decoded), `SESSION_SECRET`, `ENCRYPTION_KEY` and the GitHub App
  key. Because the scrubbing happens after serialisation, a secret is
  removed wherever it appears: in messages, nested objects, error stacks,
  child bindings or request URLs. Start-up logs only the public URL and
  whether the GitHub App is configured, never the configuration itself.
- **`src/app.ts`:**
  - `buildApp()` wires up Fastify. `GET /health` returns
    `{status, database}`: 200 with the database up, 503 when the check
    answers no, throws, or takes longer than 2 s.
  - The built web app is served with `@fastify/static`, and any other page
    `GET`/`HEAD` falls back to `index.html`. `/api/*`, paths that look like
    files, and other methods get a JSON 404.
  - Without a build, a warning is logged and only the API is served.
- **`src/server.ts` and `src/main.ts`:** `startServer(env)` loads the
  configuration, connects to the database with `@ai-office/db` and listens.
  `main.ts` prints a `ConfigError` to stderr and exits 1, and closes cleanly
  on SIGINT/SIGTERM.
- Scripts: `dev` (`node --env-file-if-exists=../../.env --watch src/main.ts`)
  and `start`. There is a root `.env.example`, and the README has a "Running
  the server" section.
- `packages/shared` holds the `/health` response schema, following PRD §8,
  where route schemas live in `packages/shared` for the server and web.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below).
- [x] **Unit test: missing `ENCRYPTION_KEY` stops start-up with a message
      naming it.** Two tests:
      - `config.test.ts`: `loadConfig` throws a `ConfigError` matching
        `ENCRYPTION_KEY is required`. An empty value is treated the same way.
      - `main.test.ts`: runs the real entry point (`node src/main.ts`) without
        `ENCRYPTION_KEY`. It exits 1, stderr contains `AI Office cannot start`
        and `ENCRYPTION_KEY is required`, stdout is empty, and the values that
        were given are not echoed.
      Malformed values for every key are refused by name without echoing the
      value (10 cases).
- [x] **Unit test: the logger never emits values of secret config keys.**
      `logger.test.ts` logs the whole parsed config, the raw environment, a
      message containing `DATABASE_URL`, a nested PEM key, an `Error` whose
      message holds `SESSION_SECRET`, a child logger bound to
      `ENCRYPTION_KEY`, and the bare database password. It asserts that none
      of the secret values (each key's value, the password raw and
      URL-encoded, and the key body) appear in the output, that `[REDACTED]`
      does, and that every line is still valid JSON. A second test puts
      `SESSION_SECRET` in a request URL and checks Fastify's own request log.
      **Negative check:** with the scrubber replaced by the identity function,
      both tests fail (`Tests  2 failed | 33 passed`); the scrubber was then
      restored.

### Verified on the host

- [ ] **`pnpm --filter server dev` serves `/health` locally.** Not verified on
      the host. I ran the same command in the sandbox against a real
      PostgreSQL 18.3 (the `embedded-postgres` binary in `/tmp`, outside the
      repository, as in #6) and it served `/health` with a 200 (output below).

## Output

### Fresh clone (`/tmp/clone7`)

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/orchestrator typecheck: Done
packages/shared typecheck: Done
apps/server typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  12 passed (12)
      Tests  47 passed | 5 skipped (52)
test exit=0
```

The 5 skipped tests are #6's Postgres integration tests (no Docker).

```text
$ pnpm exec vitest run --project @ai-office/server --reporter=verbose
 ✓ src/config.test.ts > loadConfig > reads a valid environment and fills in the defaults
 ✓ src/config.test.ts > loadConfig > reads the optional values
 ✓ src/config.test.ts > loadConfig > stops start-up with a message naming ENCRYPTION_KEY when it is missing
 ✓ src/config.test.ts > loadConfig > treats an empty value as missing
 ✓ src/config.test.ts > loadConfig > names every missing required value at once
 ✓ src/config.test.ts > loadConfig > refuses a malformed DATABASE_URL, naming it but not its value   (×2)
 ✓ src/config.test.ts > loadConfig > refuses a malformed SESSION_SECRET, naming it but not its value
 ✓ src/config.test.ts > loadConfig > refuses a malformed ENCRYPTION_KEY, naming it but not its value (×2)
 ✓ src/config.test.ts > loadConfig > refuses a malformed PORT, naming it but not its value           (×2)
 ✓ src/config.test.ts > loadConfig > refuses a malformed PUBLIC_URL, naming it but not its value
 ✓ src/config.test.ts > loadConfig > refuses a malformed LOG_LEVEL, naming it but not its value
 ✓ src/config.test.ts > loadConfig > refuses a malformed GITHUB_APP_ID, naming it but not its value
 ✓ src/config.test.ts > loadConfig > refuses half a GitHub App
 ✓ src/config.test.ts > loadConfig > reads the GitHub App, turning escaped newlines in the key into newlines
 ✓ src/config.test.ts > secretValues > includes each secret and the database password
 ✓ src/logger.test.ts > the logger > never emits the value of a secret config key
 ✓ src/logger.test.ts > the logger > scrubs the server's own request logs
 ✓ src/app.test.ts > GET /health > is 200 with the database up
 ✓ src/app.test.ts > GET /health > is 503 when the database check answers no
 ✓ src/app.test.ts > GET /health > is 503 when the database check throws
 ✓ src/app.test.ts > GET /health > is 503 when the database check hangs
 ✓ src/app.test.ts > the web app > serves index.html at /
 ✓ src/app.test.ts > the web app > serves built files
 ✓ src/app.test.ts > the web app > falls back to index.html for the page /floors/web-shop
 ✓ src/app.test.ts > the web app > falls back to index.html for the page /admin?tab=gateway
 ✓ src/app.test.ts > the web app > is 404 for GET /api/nothing
 ✓ src/app.test.ts > the web app > is 404 for GET /assets/missing.js
 ✓ src/app.test.ts > the web app > is 404 for POST /floors/web-shop
 ✓ src/app.test.ts > without a web build > serves the API and is 404 for pages
 ✓ src/main.test.ts > starting the server > stops start-up with a message naming ENCRYPTION_KEY when it is missing
 ✓ src/main.test.ts > starting the server > refuses before listening or connecting
 ✓ src/main.test.ts > starting the server > listens and reports the database on /health
```

### `pnpm --filter server dev` against a real Postgres 18.3 (sandbox)

```text
$ DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres SESSION_SECRET=$(openssl rand -hex 32) \
  ENCRYPTION_KEY=$(openssl rand -base64 32) PORT=3917 timeout 6 pnpm --filter server dev
$ curl -i localhost:3917/health
HTTP/1.1 200 OK
{"status":"ok","database":"up"}
$ curl localhost:3917/floors/x
{"error":"Not Found"}            (no web build yet, so no SPA fallback)

server log:
{"level":40,…,"webDistDir":"/home/agent/workspace/apps/web/dist","msg":"The web app is not built, so only the API is served."}
{"level":30,…,"msg":"Server listening at http://127.0.0.1:3917"}
{"level":30,…,"publicUrl":"http://localhost:3917","githubApp":"not configured","msg":"AI Office is listening."}
{"level":30,…,"req":{"method":"GET","url":"/health",…},"msg":"incoming request"}
{"level":30,…,"res":{"statusCode":200},…,"msg":"request completed"}
{"level":30,…,"signal":"SIGTERM","msg":"Shutting down."}
```

When `timeout` stopped it, Node's `--watch` supervisor printed a native
assertion (`FSEventWrap::GetInitialized … Assertion failed: (wrap) !=
nullptr`) while unwatching files. This is in Node's watch mode, not in the
app. The app logged `Shutting down.` first, and `node src/main.ts` (the
`start` script) shuts down cleanly on SIGTERM without it.

Start-up refusal through the `start` script:

```text
$ DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres SESSION_SECRET=short pnpm start
AI Office cannot start: its configuration is invalid.
  - SESSION_SECRET must be at least 32 characters
  - ENCRYPTION_KEY is required
[ELIFECYCLE] Command failed with exit code 1.
```

## Notes for the reviewer

- **Required versus optional.** The issue lists five variables. I made the
  three secrets required and gave `PORT` and `PUBLIC_URL` defaults, so a local
  `dev` run needs only the secrets. `HOST`, `LOG_LEVEL` and `WEB_DIST_DIR` are
  small additions the issue doesn't name:
  - `HOST` defaults to `0.0.0.0`, which compose (#9) will need.
  - `WEB_DIST_DIR` lets the compose image put the web build somewhere other
    than `apps/web/dist`.
- **`ENCRYPTION_KEY` format.** It is 32 bytes, base64, the AES-256 key size
  that #13 uses.
- **Scope of the scrubbing.** This issue's scrubbing covers the values of the
  secret config keys only. #13 adds the central redaction utility (credential
  shapes and registered values) and moves the logger onto it.
- **`/health` and AI Accounts.** FR-47 also mentions AI Account status; that
  arrives with the AI Gateway. Today `/health` reports the database only.

## Not verifiable in this sandbox

- `pnpm --filter server dev` on the host (it was run here against an embedded
  Postgres, not the host's).
- Serving a real web build: `apps/web` has no build until #8. Static serving
  and the SPA fallback are covered by tests against a temporary `dist`
  folder.
