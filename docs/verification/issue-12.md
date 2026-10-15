# Issue #12: Rate-limit login and record failed attempts — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit
of the issue (`65fbac2`), after `pnpm install --frozen-lockfile`.

## What was built

- **The limiter** (`apps/server/src/auth/login-limiter.ts`), per client:
  - **Client.** The client is its IPv4 address, or the /64 network of its
    IPv6 address: one host usually holds a whole /64, so a per-address limit
    would be trivial to dodge. IPv4-mapped IPv6 counts as IPv4.
  - **Exponential lockout.** A client may fail 5 times in a row. The 5th
    failure locks it out for 1 minute, so the 6th rapid attempt gets
    `429 Too Many Requests` with `Retry-After: 60` and
    `{"error":"too_many_attempts","message":"Too many failed sign-ins. Try again in 60 seconds."}`.
    Each failure after a lockout doubles it (2, 4, 8, 16, 32 minutes), up to
    1 hour. Attempts refused during a lockout do not lengthen it. Even the
    right password is refused while locked out.
  - **Reset.** A successful sign-in forgets the client's failures, and so
    does a day with no attempts.
  - **No race.** Each attempt is counted the moment it starts, before the
    (deliberately slow) Argon2id check, and a success takes it back. Twelve
    simultaneous guesses therefore get exactly 5 checks and 7 refusals.
  - **In memory.** A restart forgets the counts. AI Office runs as one
    process, and every checked attempt is in `sign_in_events` anyway. The
    map is swept of stale clients once it holds over 1000.
- **`sign_in_events`** (migration `0004_sign_in_events`): `id`,
  `occurred_at`, `outcome` (`succeeded` or `failed`, held by a check
  constraint), `ip`, `user_agent` (cut to 512 characters; null when empty
  or missing).
  - Every checked attempt is recorded, failed or successful.
  - Attempts refused by the limit before the password was checked are not
    recorded, and neither are malformed requests (400). An attacker
    hammering a locked-out address cannot fill the table.
  - The password is never stored or logged.
- **Logs.** Each failure is logged as a warning with the client key, and so
  is the start of each lockout (`lockoutSeconds`). The password never is.
- **`TRUST_PROXY`** (new, optional; `.env.example` documents it and compose
  passes it through). Behind the Caddy reverse proxy the PRD prescribes for
  EC2, every request comes from the proxy. Without this setting, all
  clients would share one limit, and one attacker could lock the Owner
  out.
  - It takes a hop count or a comma-separated list of addresses and CIDR
    ranges. The client's address then comes from `X-Forwarded-For`.
  - "Trust everyone" (`true`, `0`) is refused at start-up: it would let any
    client pick its own address and dodge the limit.
  - Unset, `X-Forwarded-For` is ignored.

  It is passed to Fastify's `trustProxy`; a hop count becomes the function
  Fastify itself uses for numbers, since Fastify's types do not take one.
- **Web:** the login page shows the server's message on a 429.
- **README:** the rate limit and `TRUST_PROXY`, under "Signing in".

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below). `pnpm build` passes too.
- [x] **Integration test: the sixth rapid failed attempt is refused with 429
      and a retry-after.**
      - `apps/server/src/auth/rate-limit.test.ts > rate-limiting sign-ins >
        refuses the sixth rapid failed attempt with 429 and a retry-after`
        drives the real app: five wrong passwords get 401, and the sixth gets
        429 with `retry-after: 60` and the `too_many_attempts` body.
      - The same file covers:
        - the right password refused while locked out;
        - another client unaffected;
        - the lockout doubling (60 → 120 → 240 s);
        - a success resetting the count;
        - 12 simultaneous guesses letting only 5 through;
        - `TRUST_PROXY`: `X-Forwarded-For` is ignored without it and used
          with it.
      - The same flow runs against Postgres 18 in `store.test.ts > records
        sign-ins through the app, and refuses the sixth failure`
        (Testcontainers; skipped here, run against an embedded Postgres 18.3,
        below), and against the real server (below).
      - **Negative check:** with `freeFailures` changed from 5 to 6, the
        sixth-attempt test fails, along with 10 others (`Tests  11 failed |
        2 passed (13)`); restored afterwards.
- [x] **Each failed and successful sign-in is recorded (time, IP, user
      agent) in `sign_in_events`.** (From "What to build".) This is checked
      in memory by `sign_in_events > records each failed and successful
      sign-in with time, IP and user agent`. It is checked in Postgres by
      `store.test.ts > records sign-in events`, which also tests the
      outcome constraint. The real server's rows are shown below.

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written** (2 new ones in
  `apps/server/src/auth/store.test.ts`), because there is no Docker. They
  were run against an embedded Postgres 18.3 instead (method of #6 and #33:
  `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp/pg18`, port 54329,
  scratch copies of the test files with only the container fixture
  replaced; nothing from this is committed).
- **`TRUST_PROXY` behind a real Caddy and under compose's networking.**
  Which address the app sees for a published port depends on Docker's
  userland proxy and the network's gateway, and only the host can show
  that. Here it was checked with Fastify's `inject` and with curl against
  the real server on loopback (below).
- **Surfacing the events in the Activity Feed** is #29 (out of scope here).

### Notes

- PRD FR-4 says repeated failures are "recorded in the Activity Feed". The
  Activity Feed does not exist yet. The records it will show are in
  `sign_in_events`, as the issue asks.

## Output

### Fresh clone (`/tmp/clone12`)

```text
65fbac2 feat(server): rate-limit sign-ins per client and record each attempt
$ pnpm install --frozen-lockfile
Done in 351ms using pnpm v12.10.0
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
 Test Files  29 passed (29)
      Tests  339 passed | 17 skipped (356)
$ pnpm build
build exit=0
✓ built in 543ms
```

The 17 skipped tests:
- 15 Postgres integration tests (5 `db`, 2 `gateway`, 8 `server`),
  skipped without Docker;
- `docker compose config validates the file`, skipped without Compose;
- the opt-in compose end-to-end test.

```text
$ pnpm exec vitest run --project @ai-office/server --reporter=verbose src/auth/rate-limit.test.ts src/auth/login-limiter.test.ts
 ✓ src/auth/login-limiter.test.ts > createLoginLimiter > allows five failures, then locks the client out for a minute 2ms
 ✓ src/auth/login-limiter.test.ts > createLoginLimiter > rounds the wait up to whole seconds 0ms
 ✓ src/auth/login-limiter.test.ts > createLoginLimiter > doubles the lockout with each failure after one, up to an hour 0ms
 ✓ src/auth/login-limiter.test.ts > createLoginLimiter > refuses refused attempts without lengthening the lockout 0ms
 ✓ src/auth/login-limiter.test.ts > createLoginLimiter > forgets a client's failures when it succeeds 0ms
 ✓ src/auth/login-limiter.test.ts > createLoginLimiter > forgets a client after a day without attempts 0ms
 ✓ src/auth/login-limiter.test.ts > createLoginLimiter > keeps each client's count apart 0ms
 ✓ src/auth/login-limiter.test.ts > clientKey > limits 203.0.113.7 as 203.0.113.7 0ms
 ✓ src/auth/login-limiter.test.ts > clientKey > limits ::ffff:203.0.113.7 as 203.0.113.7 0ms
 ✓ src/auth/login-limiter.test.ts > clientKey > limits 2001:db8:1:2:3:4:5:6 as 2001:db8:1:2::/64 5ms
 ✓ src/auth/login-limiter.test.ts > clientKey > limits 2001:db8:1:2::ffff as 2001:db8:1:2::/64 1ms
 ✓ src/auth/login-limiter.test.ts > clientKey > limits 2001:0db8:0001:0002:aaaa::1 as 2001:db8:1:2::/64 0ms
 ✓ src/auth/login-limiter.test.ts > clientKey > limits 2001:db8::1 as 2001:db8:0:0::/64 0ms
 ✓ src/auth/login-limiter.test.ts > clientKey > limits ::1 as 0:0:0:0::/64 0ms
 ✓ src/auth/rate-limit.test.ts > rate-limiting sign-ins > refuses the sixth rapid failed attempt with 429 and a retry-after 105ms
 ✓ src/auth/rate-limit.test.ts > rate-limiting sign-ins > refuses even the right password while locked out 47ms
 ✓ src/auth/rate-limit.test.ts > rate-limiting sign-ins > limits each client address on its own 55ms
 ✓ src/auth/rate-limit.test.ts > rate-limiting sign-ins > locks out for longer after each failure that follows a lockout 66ms
 ✓ src/auth/rate-limit.test.ts > rate-limiting sign-ins > starts afresh after a successful sign-in 96ms
 ✓ src/auth/rate-limit.test.ts > rate-limiting sign-ins > lets no more than five guesses through when they arrive at once 20ms
 ✓ src/auth/rate-limit.test.ts > rate-limiting sign-ins > logs when a client is locked out 45ms
 ✓ src/auth/rate-limit.test.ts > sign_in_events > records each failed and successful sign-in with time, IP and user agent 21ms
 ✓ src/auth/rate-limit.test.ts > sign_in_events > does not record attempts the rate limit refused, nor malformed ones 49ms
 ✓ src/auth/rate-limit.test.ts > sign_in_events > records no user agent for an empty one, and cuts a long one 25ms
 ✓ src/auth/rate-limit.test.ts > the client's address behind a proxy > is the proxy's address unless TRUST_PROXY is set, so it cannot be forged 53ms
 ✓ src/auth/rate-limit.test.ts > the client's address behind a proxy > comes from X-Forwarded-For when TRUST_PROXY names the proxy's address 64ms
 ✓ src/auth/rate-limit.test.ts > the client's address behind a proxy > comes from X-Forwarded-For when TRUST_PROXY names a hop count 57ms
      Tests  27 passed (27)
```

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > has no password until one is created 1718ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > creates the password only once 93ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > refuses to store anything but an Argon2id hash 74ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > stores the setup screen's password as an Argon2id hash 163ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > keeps, finds and ends sessions 78ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > signs in, out and out everywhere through the app 123ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > records sign-in events 70ms
 ✓ src/auth/scratch-local-pg-store.test.ts > databaseAuthStore against Postgres 18 > records sign-ins through the app, and refuses the sixth failure 148ms
      Tests  8 passed (8)
$ (packages/db) scratch copy of src/migrate.test.ts, all 5 migrations
      Tests  6 passed (6)
```

### The real server against Postgres 18.3

`pnpm db:migrate` on an empty database, `node apps/server/src/main.ts`
with `TRUST_PROXY=127.0.0.1`, the password set through `POST /api/setup`,
then curl from 127.0.0.1:

```text
attempt 1: 401 retry-after= {"error":"wrong_password","message":"That password is not right."}
attempt 2: 401 retry-after= {"error":"wrong_password","message":"That password is not right."}
attempt 3: 401 retry-after= {"error":"wrong_password","message":"That password is not right."}
attempt 4: 401 retry-after= {"error":"wrong_password","message":"That password is not right."}
attempt 5: 401 retry-after= {"error":"wrong_password","message":"That password is not right."}
attempt 6: 429 retry-after=60 {"error":"too_many_attempts","message":"Too many failed sign-ins. Try again in 60 seconds."}
right password while locked: {"error":"too_many_attempts","message":"Too many failed sign-ins. Try again in 60 seconds."} 429
another client (X-Forwarded-For 192.0.2.9, proxy trusted): 200
┌─────────┬─────┬────────────────────────────┬─────────────┬─────────────┬─────────────────┐
│ (index) │ id  │ occurred_at                │ outcome     │ ip          │ user_agent      │
├─────────┼─────┼────────────────────────────┼─────────────┼─────────────┼─────────────────┤
│ 0       │ '1' │ '2026-10-08T23:01:06.138Z' │ 'failed'    │ '127.0.0.1' │ 'e2e-agent/1.0' │
│ 1       │ '2' │ '2026-10-08T23:01:06.161Z' │ 'failed'    │ '127.0.0.1' │ 'e2e-agent/1.0' │
│ 2       │ '3' │ '2026-10-08T23:01:06.182Z' │ 'failed'    │ '127.0.0.1' │ 'e2e-agent/1.0' │
│ 3       │ '4' │ '2026-10-08T23:01:06.202Z' │ 'failed'    │ '127.0.0.1' │ 'e2e-agent/1.0' │
│ 4       │ '5' │ '2026-10-08T23:01:06.222Z' │ 'failed'    │ '127.0.0.1' │ 'e2e-agent/1.0' │
│ 5       │ '6' │ '2026-10-08T23:01:06.259Z' │ 'succeeded' │ '192.0.2.9' │ 'curl/7.88.1'   │
└─────────┴─────┴────────────────────────────┴─────────────┴─────────────┴─────────────────┘
"msg":"Sign-ins from this client are locked out after repeated failures."
$ grep -c '<the passwords tried>' server.log
0
```
