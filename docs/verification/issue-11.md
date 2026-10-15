# Issue #11: Login, sessions and route protection — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit
of the issue (`d694fa6`), after `pnpm install --frozen-lockfile`.

## What was built

- **`sessions` table** (migration `0003_sessions`): `id` (the SHA-256 of
  the session token, hex), `created_at`, `expires_at`, with an index on
  `expires_at`. The token itself is never stored, so the table alone cannot
  be used to sign in.
- **Sessions** (`apps/server/src/auth/sessions.ts`), hand-rolled as PRD §8
  asks (no authentication framework):
  - The token is 32 random bytes (base64url), in the cookie
    `ai_office_session` with `Path=/; Max-Age=604800; HttpOnly;
    SameSite=Strict`, plus `Secure` when `PUBLIC_URL` is https.
  - A session expires 7 days after sign-in. The lifetime is fixed: use does
    not extend it. An expired session is rejected (401) and its row
    deleted. Expired rows are also swept whenever a new session starts.
  - A request whose cookie names no live session gets a 401 that also
    clears the cookie.
- **Routes** (`apps/server/src/auth/routes.ts`):

  | Route | Access | What it does |
  | --- | --- | --- |
  | `POST /api/login` | `sign-in` | `{password}` → 200 `{csrfToken, expiresAt}` and the cookie, or 401 `wrong_password` |
  | `GET /api/session` | `owner` | the current session's `csrfToken` and `expiresAt` |
  | `POST /api/logout` | `owner` | ends this session, clears the cookie (204) |
  | `POST /api/logout/everywhere` | `owner` | "sign out everywhere": ends every session (204) |

- **Route protection** (`apps/server/src/auth/access.ts`): the access levels
  from #10 gain `sign-in` (any time after setup, no session needed).
  `owner`, the default for a route that declares nothing, now needs a
  signed-in session. Without one:
  - API routes, including unknown `/api/…` paths, answer
    `401 {"error":"unauthorized","message":"Sign in at /login."}`;
  - pages redirect to `/login`, and `/login` redirects to `/` when already
    signed in.

  The exemptions are exactly:
  - `/health`;
  - `POST /api/setup`, until used;
  - `POST /api/login`;
  - the `/login` and `/setup` pages;
  - the built web app's files, which the login page needs and which hold
    no data.
- **CSRF protection** for state-changing requests (anything but
  GET/HEAD/OPTIONS), in two layers:
  1. On every non-public route (setup and login too), a request that a
     browser marks as coming from another site is refused with
     `403 csrf_refused`. That is `Sec-Fetch-Site: cross-site|same-site`, or
     an `Origin` whose host is not the request's `Host` (including
     `Origin: null`). Requests with neither header (curl, scripts) carry no
     ambient cookie, so they pass this layer. `setup` and `login` also take
     JSON only, which a cross-site form cannot send (415).
  2. On `owner` routes, the `x-csrf-token` header must equal the session's
     token: an HMAC-SHA256 of the session ID keyed by `SESSION_SECRET`,
     compared in constant time. A missing token, a wrong one, or another
     session's token gets `403 csrf_refused`. The token comes back from
     login and from `GET /api/session`.

  `SameSite=Strict` on the cookie is a third, browser-side layer.
- **Route-registration test** (`apps/server/src/auth/route-access.test.ts`):
  it reads every route the app registers (`app.routeAccess()`, collected by
  an `onRoute` hook) and fails when:
  - a route declares no `config.access`;
  - a route is exempt from needing a session without being on the test's
    explicit exemption list (the built web files aside).

  It also checks that the list has no stale entries, and calls every
  `owner` route without a session expecting 401. Further cases show the
  check catches an undeclared route and an unlisted exemption, and passes
  a properly declared route.
- **Web** (`apps/web`):
  - a standalone `/login` page (React Hook Form + the shared schema). It
    loads `/` on success, shows "That password is not right." and clears the
    field on failure, and goes to `/setup` if there is no password yet;
  - the app layout reads `GET /api/session`, and sends the browser to
    `/login` (or `/setup`) once the session has ended. It checks again every
    60 s, which notices "sign out everywhere" from another browser;
  - "Sign out" and "Sign out everywhere" buttons, which send the CSRF token.
- **README**: a "Signing in" section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). `pnpm build` passes too.
- [x] **Integration tests: unauthenticated API calls get 401; an expired
      session is rejected; sign out everywhere invalidates every session.**
      `apps/server/src/auth/sessions.test.ts` drives the real app
      (`buildApp` + `inject`) on a clock the test moves:
      - `a session > is required: unauthenticated API calls get 401` covers
        every session route and an unknown API path.
        `route-access.test.ts > that requires a session answers 401 without
        one` covers every `owner` route the app has.
      - `a session > expires 7 days after sign-in, and is then rejected`:
        at 7 days minus 1 ms the session works; at 7 days it is a 401 and
        the row is gone; a new sign-in starts a new 7 days.
      - `signing out > everywhere invalidates every session`: three
        sessions, sign out everywhere from one, and all three are 401 and
        the store is empty.
      - The same flow runs against Postgres 18 in `store.test.ts > signs
        in, out and out everywhere through the app` (Testcontainers;
        skipped here, run against an embedded Postgres 18.3, below), and
        against the real server (below).
      - **Negative check:** with the session check in the hook disabled, 12
        tests fail, including the four above (`Tests  12 failed | 29 passed
        | 6 skipped`); restored afterwards.
- [x] **A route-registration test fails if any new route is added without
      auth or an explicit exemption.**
      - **Negative check:** two routes were added to `buildApp`, one with
        no access declared and one with `access: "public"`. The test failed
        and named all four (GET and HEAD):
        `GET /api/forgotten declares no access`, `GET /api/open is exempt
        from sign-in (public) but not listed`, and so on. The file was then
        restored.
      - Even an undeclared route is still protected at runtime (it
        defaults to `owner`). The test shows `GET /api/streams/activity`,
        added with no access, answering 401.

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written** (2 new ones in
  `apps/server/src/auth/store.test.ts`), because there is no Docker. They
  were run against an embedded Postgres 18.3 instead (method of #6 and #33:
  `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp/pg18`, port 54329,
  scratch copies of the test files with only the container fixture
  replaced; nothing from this is committed).
- **The login page and sign-out buttons in a real browser**, including that
  the browser stores the cookie and sends `Origin`/`Sec-Fetch-Site` as
  expected. They are covered by jsdom tests
  (`apps/web/src/login-page.test.tsx`) and the server by curl (below). The
  Playwright login test the PRD plans (§9) needs Playwright in the
  workspace, which no issue has added yet.
- **`docker compose up` with login**: no Docker here (see #9).

### Notes

- **Streams.** There is no SSE stream yet. Any stream will be a Fastify
  route, so it needs a session by default, and the route-registration test
  covers it.
- **The AI Gateway** (`GATEWAY_PORT`) is a separate listener. Following ADR
  0001, Agents and Owner tools authenticate to it with Gateway Keys, not
  Owner sessions, so this issue does not put it behind sessions. It is
  still reachable only on loopback or inside the compose network, as #33
  and #9 left it. Gateway Keys are a later issue.
- **Rate limiting** of `POST /api/login` is #12.

## Output

### Fresh clone (`/tmp/clone11`)

```text
d694fa6 feat(web): login page and sign-out controls
$ pnpm install --frozen-lockfile
Done in 236ms using pnpm v12.10.0
$ pnpm lint
lint exit=0
Checking formatting...
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit=0
apps/web typecheck: Done
apps/server typecheck: Done
$ pnpm test
test exit=0
 Test Files  27 passed (27)
      Tests  303 passed | 15 skipped (318)
$ pnpm build
build exit=0
✓ built in 314ms
```

The 15 skipped tests:
- 13 Postgres integration tests (5 `db`, 2 `gateway`, 6 `server`),
  skipped without Docker;
- `docker compose config validates the file`, skipped without Compose;
- the opt-in compose end-to-end test.

```text
$ pnpm exec vitest run --project @ai-office/server --reporter=verbose src/auth/sessions.test.ts src/auth/route-access.test.ts
 ✓ src/auth/route-access.test.ts > every route > requires a session or is an explicit exemption 54ms
 ✓ src/auth/route-access.test.ts > every route > that requires a session answers 401 without one 12ms
 ✓ src/auth/route-access.test.ts > the route-registration check > fails for a new route that declares no access 4ms
 ✓ src/auth/route-access.test.ts > the route-registration check > fails for a new exemption that is not listed 3ms
 ✓ src/auth/route-access.test.ts > the route-registration check > passes a new route that requires a session 3ms
 ✓ src/auth/sessions.test.ts > POST /api/login > refuses a wrong password, and starts no session 62ms
 ✓ src/auth/sessions.test.ts > POST /api/login > refuses a malformed body 4ms
 ✓ src/auth/sessions.test.ts > POST /api/login > answers setup_required before setup 2ms
 ✓ src/auth/sessions.test.ts > POST /api/login > starts a 7-day session in an HttpOnly, SameSite=Strict cookie 13ms
 ✓ src/auth/sessions.test.ts > POST /api/login > marks the cookie Secure when PUBLIC_URL is https 13ms
 ✓ src/auth/sessions.test.ts > POST /api/login > refuses a sign-in from another site 12ms
 ✓ src/auth/sessions.test.ts > POST /api/login > never logs the password or the session token 22ms
 ✓ src/auth/sessions.test.ts > a session > is required: unauthenticated API calls get 401 4ms
 ✓ src/auth/sessions.test.ts > a session > is rejected when its cookie names no session, and the cookie cleared 2ms
 ✓ src/auth/sessions.test.ts > a session > describes itself at GET /api/session 13ms
 ✓ src/auth/sessions.test.ts > a session > expires 7 days after sign-in, and is then rejected 21ms
 ✓ src/auth/sessions.test.ts > a session > is not extended by use 11ms
 ✓ src/auth/sessions.test.ts > a session > removes expired sessions when a new one starts 27ms
 ✓ src/auth/sessions.test.ts > CSRF protection > refuses a state change without the session's CSRF token 22ms
 ✓ src/auth/sessions.test.ts > CSRF protection > refuses a state change from another site, even with the token 10ms
 ✓ src/auth/sessions.test.ts > CSRF protection > needs no token to read 10ms
 ✓ src/auth/sessions.test.ts > signing out > ends this session only, and clears its cookie 19ms
 ✓ src/auth/sessions.test.ts > signing out > everywhere invalidates every session 27ms
 ✓ src/auth/sessions.test.ts > pages > redirect to /login without a session, and /login to / with one 27ms
      Tests  24 passed (24)
```

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > has no password until one is created 1662ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > creates the password only once 83ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > refuses to store anything but an Argon2id hash 81ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > stores the setup screen's password as an Argon2id hash 145ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > keeps, finds and ends sessions 84ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > signs in, out and out everywhere through the app 127ms
      Tests  6 passed (6)
 ✓ src/scratch-local-pg-migrate.test.ts > the migrations folder > lists every SQL migration in the journal, in order 2ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > run on a fresh Postgres 18 1034ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > create schema_meta and record the application 72ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > are a no-op when run again 78ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > hand each test its own database (write) 73ms
 ✓ src/scratch-local-pg-migrate.test.ts > migrations against Postgres 18 > hand each test its own database (read) 66ms
      Tests  6 passed (6)
```

### The real server against Postgres 18.3

`pnpm db:migrate` on an empty database, `node apps/server/src/main.ts`
with the web app built, the password set through `POST /api/setup`, then
curl (session tokens elided):

```text
--- unauthenticated
{"error":"unauthorized","message":"Sign in at /login."} 401
/ 302 http://127.0.0.1:3320/login
/login 200
--- wrong password
{"error":"wrong_password","message":"That password is not right."} 401
--- login (two sessions)
{"csrfToken":"L63f3j_qScUnW-Ngrw4MgFRT42Bs9b4MOhT9rJSjpos","expiresAt":"2026-10-15T22:53:54.326Z"}
set-cookie: ai_office_session=<token>; Path=/; Max-Age=604800; HttpOnly; SameSite=Strict
--- signed in
GET /api/session 200
/ 200
/login 302 http://127.0.0.1:3320/
--- CSRF
{"error":"csrf_refused","message":"The x-csrf-token header is missing or does not match."} 403
{"error":"csrf_refused","message":"Requests from other sites are refused."} 403
--- sign out everywhere (from session 2)
204
session 1: 401
session 2: 401
sessions rows: 0
log lines with password or token: 0
      1 "msg":"A sign-in failed: wrong password."
      2 "msg":"The Owner signed in."
      1 "msg":"The Owner signed out everywhere."
      1 "msg":"The Owner's password was set."
```

With `PUBLIC_URL=https://office.example.com`:

```text
set-cookie: ai_office_session=<token>; Path=/; Max-Age=604800; HttpOnly; SameSite=Strict; Secure
```
