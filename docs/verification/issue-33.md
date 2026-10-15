# Issue #33: AI Gateway skeleton: `/v1/messages` passthrough with request records — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last commit of the
issue (`7816af4`), after `pnpm install --frozen-lockfile`.

## What was built

### `gateway_requests` (`packages/db`, migration `0001_gateway_requests`)

One row per request: `started_at`, `account`, `endpoint` (`messages` or
`count_tokens`), `model`, `streamed`, `status`, `latency_ms`,
`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens` and `upstream_request_id`. It is indexed by
`started_at`.
- Token counts are null when the response carried no usage: an error, or
  `count_tokens`, which consumes none.
- `account` is the AI Account's name. It is null when there was none. #34
  can turn it into a reference once accounts have a table.

### `packages/gateway`

- **`buildGateway()`** is a Fastify app with `POST /v1/messages` and
  `POST /v1/messages/count_tokens`. Both are forwarded to one Anthropic
  API-key AI Account (`{ name, apiKey, baseUrl }`).
  - **Request.** The body is forwarded as the bytes that arrived; no parser
    touches it. The query string (Claude Code sends `?beta=true`) and any
    path prefix of the account's URL are kept. The caller's own
    credentials (`x-api-key`, `authorization`, `cookie`) and hop-by-hop
    headers are dropped, and the account's `x-api-key` is added.
    `accept-encoding: identity` is asked for, so bodies need no
    re-encoding. Other headers (`anthropic-version`, `anthropic-beta`,
    `x-stainless-*`…) pass through.
  - **Response.** Status, headers (minus hop-by-hop, length/encoding and
    `set-cookie`) and body pass through unchanged. Streamed or not, the
    body is piped as it arrives, and a `Transform` tap watches it.
  - **Usage.** For SSE, `StreamUsageReader` reads `message_start`
    (input/cache counts) and `message_delta` (cumulative output, or all
    counts). It handles chunks split anywhere, CRLF and multi-byte
    characters, and parses only those two events. For a non-streamed
    message it reads `usage` from the JSON once the body has passed.
  - **Recording.** It happens when the response closes, so it adds nothing
    to the caller's latency. The requested `model` is read from the body at
    that point too. A failed record is logged; the caller's response is
    unaffected.
  - **Failures, in the Anthropic error format:** no AI Account → 503
    `api_error` (FR-38: no account at all is a 503); AI Provider
    unreachable → 502; other routes → 404 `not_found_error`. A caller that
    goes away aborts the upstream request and is recorded as 499, with the
    usage seen so far.
  - **`GET /health`** reports whether an AI Account is configured.
- **Recorder mode** (`directoryFixtureRecorder`). It writes each
  request/response pair as `<time>-<n>-<endpoint>-<status>.json` in the
  `Fixture` format, after passing it through the central redactor with the
  account's key registered. Caller credentials are never in a fixture,
  because they are dropped before forwarding.
- **Fixtures:** `packages/gateway/fixtures/anthropic/` holds six files:
  non-streamed, streamed (`?beta=true`, with multi-byte text), streamed
  tool use with CRLF line endings and full usage in `message_delta`, a
  mid-stream `overloaded_error`, a 429 `rate_limit_error`, and
  `count_tokens`.

### Server (`apps/server`)

- `startServer()` builds the Gateway with `databaseRequestLog(db)`, using a
  child of the server's redacting logger. It listens on `GATEWAY_PORT`
  (default 4000) and `GATEWAY_HOST`, and closes it with the app.
- New config:
  - `GATEWAY_PORT`, which must differ from `PORT`.
  - `GATEWAY_HOST`, defaulting to `127.0.0.1` (see the notes).
  - `GATEWAY_FIXTURES_DIR`.
  - `ANTHROPIC_API_KEY`, a secret: added to `secretConfigKeys` and to the
    logger's secret values.
  - `ANTHROPIC_BASE_URL`, defaulting to `https://api.anthropic.com`.

  The AI Account is named `env:ANTHROPIC_API_KEY`.
- `.env.example` and the README document the new variables and the Gateway.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below).
- [x] **Contract tests replay recorded fixtures: streamed and non-streamed
      responses arrive intact and usage is recorded.** `src/contract.test.ts`
      replays every file in `fixtures/anthropic/` through a real Gateway.
      The fake AI Provider writes the recorded response in 1-byte, 7-byte
      and whole-body chunks, which gives 18 cases. For each case it asserts:
      - the status and every recorded header arrive;
      - the body is byte-identical to the recording;
      - the AI Provider received the exact request body, path, query and
        headers, with the account's key and not the caller's;
      - the `gateway_requests` record has the expected endpoint, Model,
        streamed flag, status, all four token counts and the AI Provider's
        request ID.

      A guard test fails if a fixture has no expectation or an expectation
      has no fixture. `src/fixtures.test.ts` checks that recorder mode
      writes this same format: a recorded pair replays through the Gateway
      unchanged, with the same usage.

      **Negative checks:**
      - With the tap changed to drop each chunk's last byte, all 18 replays
        fail (`Tests  18 failed | 1 passed (19)`).
      - With stream usage reading disabled, the 9 streamed replays fail
        (`Tests  9 failed | 10 passed (19)`).

      Both changes were reverted.
- [x] **Benchmark test: median added latency under 10 ms against a local fake
      upstream.** `src/benchmark.test.ts` runs 300 timed rounds after 50
      warm-up rounds. Each round sends the same 20 KB request straight to
      the fake AI Provider and then through the Gateway, interleaved. It
      asserts that the median through the Gateway minus the median direct
      is under 10 ms, for a non-streamed and for a streamed message.
      Measured from the fresh clone: **0.84 ms** non-streamed and
      **0.71 ms** streamed (output below).

### Postgres (skipped here, run in CI and on the host)

`src/request-log.test.ts` uses #6's Testcontainers harness, so its 2 tests
skip without Docker. To check them against a real Postgres 18 anyway, I
used the method from #6 and #7:
- I installed `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp/pg18`,
  outside the repository, and started it on port 54329.
- I ran scratch copies of `src/request-log.test.ts` and
  `packages/db/src/migrate.test.ts`, replacing only the container fixture
  with `preparePostgresServer(…54329…)`.
- All 8 tests passed (output below). The scratch files were deleted and
  nothing from this check is committed.

## Output

### Fresh clone (`/tmp/clone33`)

```text
$ pnpm install --frozen-lockfile
Done in 509ms using pnpm v12.10.0

$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/gateway typecheck: Done
apps/server typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  19 passed (19)
      Tests  222 passed | 7 skipped (229)
test exit=0
```

The 7 skipped tests are the Postgres integration tests: #6's 5 and this
issue's 2. Each skip names the reason:

```text
Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.
```

```text
$ pnpm exec vitest run --project @ai-office/gateway --reporter=verbose
 ✓ src/usage.test.ts > StreamUsageReader > reads input and cache counts from message_start and output from message_delta
 ✓ src/usage.test.ts > StreamUsageReader > reads the same however the stream is split (1-byte chunks)
 ✓ src/usage.test.ts > StreamUsageReader > reads the same however the stream is split (2-byte chunks)
 ✓ src/usage.test.ts > StreamUsageReader > reads the same however the stream is split (3-byte chunks)
 ✓ src/usage.test.ts > StreamUsageReader > reads the same however the stream is split (5-byte chunks)
 ✓ src/usage.test.ts > StreamUsageReader > reads the same however the stream is split (64-byte chunks)
 ✓ src/usage.test.ts > StreamUsageReader > reads CRLF-separated events and data lines without a space
 ✓ src/usage.test.ts > StreamUsageReader > takes every count from a message_delta that carries them all
 ✓ src/usage.test.ts > StreamUsageReader > keeps what it has when the stream breaks off or holds nonsense
 ✓ src/usage.test.ts > StreamUsageReader > has no usage for a stream without it
 ✓ src/usage.test.ts > usageFromMessage > reads a message's usage
 ✓ src/usage.test.ts > usageFromMessage > has no usage for an error
 ✓ src/usage.test.ts > usageFromMessage > has no usage for not JSON
 ✓ src/usage.test.ts > usageFromMessage > has no usage for negative counts
 ✓ src/contract.test.ts > the Anthropic fixtures > each have an expectation, and each expectation a fixture
 ✓ src/contract.test.ts > … > count-tokens.json > arrives intact through the Gateway and its usage is recorded (1-byte chunks)
 ✓ src/contract.test.ts > … > count-tokens.json > … (7-byte chunks)
 ✓ src/contract.test.ts > … > count-tokens.json > … (1000000-byte chunks)
 ✓ src/contract.test.ts > … > messages-rate-limited.json > … (1-byte, 7-byte and 1000000-byte chunks: 3 tests)
 ✓ src/contract.test.ts > … > messages-streaming-overloaded.json > … (3 tests)
 ✓ src/contract.test.ts > … > messages-streaming-tool-use.json > … (3 tests)
 ✓ src/contract.test.ts > … > messages-streaming.json > … (3 tests)
 ✓ src/contract.test.ts > … > messages.json > … (3 tests)
 ✓ src/gateway.test.ts > forwarding > sends the AI Account's key in place of the caller's credentials
 ✓ src/gateway.test.ts > forwarding > keeps the query string and any path prefix of the account's URL
 ✓ src/gateway.test.ts > forwarding > forwards a body that is not JSON unchanged and records no model
 ✓ src/gateway.test.ts > streaming > passes each event on as it arrives, without waiting for the end
 ✓ src/gateway.test.ts > streaming > stops the AI Provider's stream and records a 499 when the caller goes away
 ✓ src/gateway.test.ts > when the request cannot be served > is a 503 in the Anthropic error format when there is no AI Account
 ✓ src/gateway.test.ts > when the request cannot be served > is a 502 when the AI Provider cannot be reached, and never logs the key
 ✓ src/gateway.test.ts > when the request cannot be served > still answers when the request cannot be recorded
 ✓ src/gateway.test.ts > when the request cannot be served > is a 404 in the Anthropic error format for other routes
 ✓ src/gateway.test.ts > GET /health > says whether an AI Account is configured
 ↓ src/request-log.test.ts > databaseRequestLog against Postgres 18 > stores a record in gateway_requests
 ↓ src/request-log.test.ts > databaseRequestLog against Postgres 18 > records a request through the Gateway
 ✓ src/fixtures.test.ts > recorder mode > saves each request/response pair as a fixture, without the account's key
 ✓ src/fixtures.test.ts > recorder mode > writes fixtures that replay through the Gateway unchanged
 ✓ src/fixtures.test.ts > recorder mode > records nothing when it is off
 ✓ src/benchmark.test.ts > the Gateway's added latency > has a median under 10 ms for a non-streamed message
 ✓ src/benchmark.test.ts > the Gateway's added latency > has a median under 10 ms for a streamed message
      Tests  48 passed | 2 skipped (50)

stdout | src/benchmark.test.ts
a non-streamed message: direct median 0.53 ms, through the Gateway 1.37 ms, added 0.84 ms over 300 rounds
a streamed message: direct median 0.41 ms, through the Gateway 1.12 ms, added 0.71 ms over 300 rounds
```

The server's new tests (in the same run):
- `config.test.ts`: reads the AI Gateway's AI Account; refuses a
  `GATEWAY_PORT` that is the same as `PORT`; refuses a malformed
  `GATEWAY_PORT` or `ANTHROPIC_BASE_URL`, naming it but not its value;
  `secretValues` includes the AI Account's key.
- `logger.test.ts`: the existing test now also covers `ANTHROPIC_API_KEY`.
  Its value is deliberately not shaped like an Anthropic key, so only its
  registration as a secret removes it.
- `main.test.ts`: starts the AI Gateway on `GATEWAY_PORT` and closes it with
  the app. The Gateway forwards to a fake AI Provider with the configured
  key and stops listening after `app.close()`.

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ src/scratch-local-pg.test.ts > databaseRequestLog against Postgres 18 > stores a record in gateway_requests 1050ms
 ✓ src/scratch-local-pg.test.ts > databaseRequestLog against Postgres 18 > records a request through the Gateway 110ms
      Tests  2 passed (2)
 ✓ src/scratch-local-pg.test.ts > the migrations folder > lists every SQL migration in the journal, in order 2ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18 1001ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > create schema_meta and record the application 96ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > are a no-op when run again 75ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > hand each test its own database (write) 67ms
 ✓ src/scratch-local-pg.test.ts > migrations against Postgres 18 > hand each test its own database (read) 65ms
      Tests  6 passed (6)
```

### End to end through the real server (sandbox)

`pnpm db:migrate` was run on a fresh `ai_office_e2e` database on that
Postgres. I then started the server (`node src/main.ts`) with
`GATEWAY_PORT=4917`, an `sk-ant-…` test key, and `ANTHROPIC_BASE_URL`
pointing at a small fake AI Provider that streams two events 50 ms apart.

```text
$ curl localhost:4917/health
{"status":"ok","account":"configured"}
$ curl -N localhost:4917/v1/messages?beta=true -H 'x-api-key: callers-own-key' … -d '{"model":"claude-haiku-5-5",…,"stream":true,…}'
event: message_start
data: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":21,"cache_read_input_tokens":300,"cache_creation_input_tokens":0,"output_tokens":1}}}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":8}}

event: message_stop
data: {"type":"message_stop"}

fake AI Provider: upstream got /v1/messages?beta=true x-api-key=the account key
gateway_requests: [{"account":"env:ANTHROPIC_API_KEY","endpoint":"messages","model":"claude-haiku-5-5","streamed":true,"status":200,"latency_ms":75,"input_tokens":21,"output_tokens":8,"cache_read_input_tokens":300,"cache_creation_input_tokens":0,"upstream_request_id":"req_e2e"}]
occurrences of the key in the server log: 0
server log: "Server listening at http://127.0.0.1:4917" (Gateway, loopback only)
            "Server listening at http://127.0.0.1:3917", "…172.17.0.10:3917" (app)
            "AI Office is listening."
```

## Notes for the reviewer

- **The committed fixtures are hand-written, not recorded.** There is no AI
  Account in this sandbox, and contract tests must never call a live AI
  Provider (PRD §9). I wrote the six files in the recorder's exact
  `Fixture` format from the Anthropic Messages API's documented shapes:
  - SSE event sequence and `usage` fields;
  - error bodies with `request_id`;
  - `retry-after` and `request-id` headers;
  - a mid-stream `error` event.

  `fixtures/README.md` says so. A test proves that recorder output replays
  the same way. Re-recording them on the host with
  `GATEWAY_FIXTURES_DIR` and a real key would replace the hand-written
  bodies with real ones. That is listed under "not verifiable" below.
- **The Gateway is unauthenticated until Gateway Keys (#35).** ADR 0001 and
  PRD §7 say it must never be exposed unauthenticated. So `GATEWAY_HOST`
  defaults to `127.0.0.1`, and `.env.example` says never to expose the
  port. Compose (#9) should not publish it. Anyone who can reach the port
  can spend the AI Account until #35 lands.
- **"One API-key AI Account read from config"** is read from the
  environment (`ANTHROPIC_API_KEY`). FR-67 lists only start-up secrets for
  the environment, and AI Accounts move to Postgres, encrypted, with #34.
  Without the variable, every Gateway request is a recorded 503.
- **`count_tokens` is recorded** (every request is), but with null token
  counts. Its `input_tokens` is an estimate, not consumption, and must not
  count towards Token Caps later.
- **499 for a caller that went away** is nginx's convention for "client
  closed request". It keeps those rows apart from real upstream statuses.
- **Latency** is measured from the request arriving to the response
  closing, so it includes upstream time, as FR-43's latency charts need.
  The Gateway's own overhead is what the benchmark measures.
- **FR-47 (health).** The Gateway has its own `GET /health` saying whether an
  AI Account is configured. Account status is not yet part of the app's
  `/health`, which compose uses (#9). That can follow with #34.
- **Fastify's `disableRequestLogging`** is deprecated in 5.12. The Gateway
  uses `logController: new LogController({ disableRequestLogging: true })`,
  because every request is recorded in `gateway_requests` instead.

## Not verifiable in this sandbox

- Recording real fixtures against the Anthropic API with a real AI Account
  (no AI Account here; recorder mode is tested against a fake).
- Claude Code (or any agent tool) pointed at the Gateway with
  `ANTHROPIC_BASE_URL`.
- The Testcontainers Postgres tests as written (no Docker). They were run
  against an embedded Postgres 18.3 instead, as above, and run in CI.
- The Gateway inside the compose network (#9).
