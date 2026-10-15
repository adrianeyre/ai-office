# Issue #53: Request history and live request and log streams — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit of
the issue (`30ddbfe`), after `pnpm install --frozen-lockfile`.

## What was built

- **Recorded per request** (`gateway_requests`, migration
  `0017_request_history`): besides the AI Account, Agent, Floor or Owner
  tool, tokens and cost (#35, #49), the time to first byte, the caller's
  headers with credentials (`x-api-key`, `authorization`,
  `proxy-authorization`, `cookie`) shown as `[REDACTED]` and passed through
  the central redactor, and the headers of the answer the caller got.
- **Bodies, encrypted at rest, toggleable in admin:** while body storage is
  on (the default, as PRD §7's retention defaults have it), the request's
  body and the answer the caller got (passed through, translated, streamed
  or an error) are kept in `gateway_request_bodies`, up to 1 MiB each
  (`truncated` says when cut). Each is sealed with `ENCRYPTION_KEY` for its
  own request (context `gateway_request.body:<id>:request|response`); a
  check constraint refuses anything not sealed. Read back, bodies are
  redacted. With storage off, nothing is kept. The setting lives in
  `office_settings.gateway_store_bodies` (`GET`/`PUT
  /api/office/request-bodies`, a `config.changed` event); the server
  re-reads it when it changes, so the Gateway asks it without a query.
- **Request history** (`packages/gateway/src/history/`):
  `createRequestHistory` records (implementing the Gateway's `RequestLog`),
  lists (search over Model, account, Owner tool, Agent, Floor, endpoint and
  the AI Provider's request id; filters by status class or status,
  endpoint, Model, account, Agent, Floor and Owner tool; a time range;
  newest first, paged), reads one with its bodies, reads after an id, and
  tells subscribers of each new request matching their filter. Memory and
  Postgres stores.
- **API** (`apps/server/src/gateway-requests/`): `GET
  /api/gateway/requests`, `GET /api/gateway/requests/:id`, the live request
  stream `GET /api/gateway/requests/stream` (SSE, filters, resumes after
  `Last-Event-ID` without loss or repeats), and the live Gateway log stream
  `GET /api/gateway/logs/stream` (the last 500 lines, then each new one).
  Both streams send a heartbeat that re-checks the session and end at
  sign-out or shutdown. The server tees its logger's (already redacted)
  lines to a log hub that keeps the Gateway's; the Gateway now logs each
  finished request.
- **Web:** **Gateway** in the navigation: the request list (time,
  endpoint, Model, caller linked to its Agent, account, status, tokens,
  cost, latency), filters in the address, new requests streaming in at the
  top, older pages, and the live **Gateway log**; each request's page
  (`/gateway/requests/<id>`) with timings, tokens, cost, account, caller,
  headers and bodies; Admin's **Request history** card with **Keep request
  and response bodies (encrypted)**.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below): 869 passed, 153 skipped without
      Docker; 1007 passed, 15 skipped against Postgres 18.
- [x] **Tests: bodies stored encrypted and absent when storage is off.**
      `packages/gateway/src/history/history.test.ts`, every case in memory
      and in Postgres 18, through a real Gateway:
  - `keeps the bodies sealed while body storage is on`: both stored bodies
    are `aio1:…`, contain neither the prompt nor the answer, open to them
    with their own request's context and fail with another's; the detail
    gives them back in clear.
  - `keeps no bodies while body storage is off`: nothing in
    `gateway_request_bodies`, the detail's `bodies` is null and holds no
    trace of the prompt, while tokens and the rest are kept.
  - Also: headers without the Gateway Key or cookie, and the timings; a
    body over 1 MiB cut and marked; a credential in a prompt redacted as it
    is read back; search, filters and pages; subscribers.
  - In Postgres, an unsealed body is refused by the check constraint.

  `apps/server/src/gateway-requests/routes.test.ts` (8 tests): the list,
  filters, pages and bad queries; the detail (with and without bodies,
  404s); all four routes need a session; the live request stream (live,
  filtered, and resuming after `Last-Event-ID`); the live log stream
  (recent then new lines, only the Gateway's, capacity); the body storage
  setting. `packages/orchestrator/src/office/settings.test.ts` covers the
  setting and its event in memory and Postgres;
  `apps/web/src/gateway-requests.test.tsx` (7 tests) the pages.
- [x] **Playwright: live stream shows a new request.**
      `e2e/tests/gateway-requests.spec.ts`, in Chromium against the real
      server, its Gateway and Postgres: with the Gateway page open and live,
      a request made through the Gateway with an Owner tool's key appears as
      `Request 1` without a reload (Model, caller, status 503 as there is no
      AI Account), with its log line in the live log; its page shows
      `x-api-key: [REDACTED]` and both bodies; the key is in neither the page
      nor the server's log; after unticking body storage in Admin, the next
      request's page says its bodies were not kept. The whole suite passed:
      18 tests.

  **Negative checks** (each reverted afterwards):
  - Bodies kept whatever the setting: 1 test failed.
  - Request bodies stored unsealed: 3 tests failed (in memory; in Postgres
    the check constraint also refuses them).
  - Subscribers never told of new requests: 8 tests failed.
  - The web page ignoring streamed requests: the Playwright spec failed
    (`getByRole('row', { name: 'Request 1' })` not visible).

### How Postgres and Chromium were run here

As for #35: `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp/pg18`
(port 54329), with a scratch, reverted edit pointing the clone's
`postgresTest` at it, and `E2E_POSTGRES_URL` for `pnpm e2e`; Chromium with
Debian bookworm's libraries in `/tmp/chromelibs`.

### Not verifiable in this sandbox

- The Testcontainers path of the Postgres tests and of `pnpm e2e` (no
  Docker); both ran against the embedded Postgres 18.3.
- Requests from real agent tools to real AI Accounts in the history (no AI
  Account here; #45 is open). The Playwright test's request is refused for
  want of an AI Account, which is still a recorded request.
- Retention of bodies and metadata (#112, out of scope).

## Output

`pnpm lint` (fresh clone):

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  89 passed (89)
      Tests  869 passed | 153 skipped (1022)
   Duration  15.64s (tests 42%, import 38%, transform 10%, environment 9%, setup 1%)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  89 passed (89)
      Tests  1007 passed | 15 skipped (1022)
   Duration  38.09s (tests 85%, import 10%, environment 3%, transform 2%)
```

`pnpm e2e` (tail):

```text
  ✓  10 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (2.9s)
  18 passed (11.8s)
```
