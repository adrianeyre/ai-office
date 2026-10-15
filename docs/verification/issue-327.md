# Issue #327: [fix] I2-3 — Gateway Key guesses at /v1 draw no rate limit and no Activity Feed record, unlike /api/login/api-key's — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker and no Postgres). The fix is commit `c1d7635`,
`fix(security): I2-3 Gateway Keys not in use at /v1 are limited per client and recorded, as sign-ins are`,
on top of `747cf60` (#325's). Its blocker, the I2 probe (#287), is in the
tree: `docs/pen-testing/assessments/I2.md` and
`apps/server/src/gateway-entry.pen-test.test.ts`.

This is the remediation of finding **I2-3** (`severity:low`). The full
output of the checks, run once on the finished tree for all five fixes,
is in [#323's note](issue-323.md#real-output-of-the-checks).

## What was fixed

`/api/login/api-key` limits and records guesses at a UI-capable key
(FR-4). A Gateway Key presented at `/v1` on the app's port drew no limit,
and no record the Owner could see, only a log line.

The one entry point now limits the check of each key a `/v1` request
presents, per client, as sign-ins are, and records each key not in use.

- **Which client.** It uses the address the app believes for
  `request.ip`: `TRUST_PROXY` and, since A1-1, `PROXY_SECRET` decide it.
  `app.ts` now builds one trust function and gives it to Fastify (for
  `request.ip`) and to the `/v1` hook, using `@fastify/proxy-addr`
  (Fastify's own, at the version it already uses). Both sides therefore
  read the client the same way. A caller that reaches the port directly
  with its own `X-Forwarded-For` gets no bucket of its own.
- **The limits.** They are the sign-in limits (`defaultLoginLimits`, or
  the app's `loginLimits`): five keys not in use in a row lock the client
  out for a minute, and each one after a lockout doubles it, up to an
  hour. A key in use, or a day without a key not in use, starts afresh.
- **A limiter of its own** (`apps/server/src/gateway-keys/key-guesses.ts`).
  The limits are the same, but the counts are apart from sign-ins: a tool
  left with a revoked key never locks the Owner out of signing in, and a
  run of wrong passwords never locks out their tools.
- **Locked out.** The client gets `429` with `Retry-After`, in the
  endpoint's own format (`rate_limit_error` for Anthropic's). Its key is
  not checked, so its right key waits too, as a right password does.
- **Recorded.** Each key not in use is a `gateway_key.failed` event, and
  each lockout a `gateway_key.locked_out` event, in the Activity Feed.
  Each carries the client's address (and user agent), never the key. The
  web app shows them as "Gateway Key refused" and "Gateway Keys locked
  out", under a **Gateway Keys** filter group. The lockout is also a log
  warning with the client, as a sign-in lockout is.

**How the pieces join.** `packages/gateway/src/key-checks.ts` lets
whoever hands a request to the Gateway limit its key check
(`limitKeyCheck`). The app's `gatewayEntry` hook, which already took the
proxy's proof off and set the security headers, registers the limit for
each `/v1` request. The Gateway asks it in #325's `onRequest` hook,
before the key is checked and before the body is read. It then tells the
limit whether the key was in use. A request no one limits is checked as
before.

The sign-in limiter (`login-limiter.ts`) has two new methods:
`lockedOutFor`, which asks without counting, and `forget`.

### Sibling paths

- **Every route that takes a key** shares the limit. The finding probed
  `/v1/messages`; once a client is locked out, every endpoint answers it
  `429` in its own format, and so does the tool-call screen, through the
  same hook.
- **Behind Caddy** the limit is per client Caddy names, not one bucket
  for the proxy. Without `PROXY_SECRET`'s proof, a forged
  `X-Forwarded-For` buys nothing (`gateway-entry.test.ts`).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "I2-3:
      guesses at a Gateway Key on the app's port are limited, as
      /api/login/api-key's are" is an `it`. Its assertion is unchanged:
      twenty guesses include a `429`.
- [x] **The "pins today" test becomes a regression test; neither is
      deleted.** "regression (I2-3): /api/login/api-key limits and records
      guesses at a UI-capable key, and /v1 now limits twenty guesses at a
      key and records them too, logging them still without the client's
      address". Of `/v1`'s twenty, five are `401` and fifteen `429`. Five
      `gateway_key.failed` events and one `gateway_key.locked_out`
      (60 seconds) are recorded, and the sign-in records are unchanged.
      The five refusals are logged without the client's address, and no
      log line holds a guessed key.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "holds since I2-3: a locked-out client is refused unchecked, its
        right key too, with Retry-After, on every endpoint that takes a
        key, in its callers' format". It covers the six endpoints, with
        Anthropic's and OpenAI's error shapes and `Retry-After: 60`, and
        no AI Provider is called. Once the lockout has run out, the right
        key is served.
      - "holds since I2-3: a key in use forgets the client's earlier keys
        not in use, and a request with no key counts none".
      - "holds since I2-3: the Gateway's own port, the sandboxes' through
        the sandbox relay, is not limited by client". Twenty guesses there
        are twenty `401`s, and nothing is recorded (see Decisions).
      - In `gateway-entry.test.ts`: "limits Gateway Keys not in use per
        client Caddy names: that client's right key waits too, another's
        does not, and a direct caller's own X-Forwarded-For buys no bucket
        of its own".
      - In `login-limiter.test.ts`: "says how long a client is locked out
        for without counting an attempt" and "forgets a client's failures
        when told to".
      - In `packages/events`, the two events parse, and the family list
        names `gateway_key`. The web app's Activity Feed tests cover every
        event type's text and filter group.

      Mutation check: with `app.ts` stashed, the four tests above that
      need the limit fail. With the fix, all pass.
- [x] **The assessment's findings table marks `I2-3` fixed.** The row
      reads **fixed** (issue #327), with the commit's subject.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See
      [#323's note](issue-323.md#real-output-of-the-checks).

### The tests, verbose

```
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-3: guessing a Gateway Key at /v1 > holds: a Gateway Key is the prefix and 32 random bytes, so guessing one is not feasible however many guesses are allowed
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-3: guessing a Gateway Key at /v1 > regression (I2-3): /api/login/api-key limits and records guesses at a UI-capable key, and /v1 now limits twenty guesses at a key and records them too, logging them still without the client's address
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-3: guessing a Gateway Key at /v1 > I2-3: guesses at a Gateway Key on the app's port are limited, as /api/login/api-key's are
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-3: guessing a Gateway Key at /v1 > holds since I2-3: a locked-out client is refused unchecked, its right key too, with Retry-After, on every endpoint that takes a key, in its callers' format
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-3: guessing a Gateway Key at /v1 > holds since I2-3: a key in use forgets the client's earlier keys not in use, and a request with no key counts none
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-3: guessing a Gateway Key at /v1 > holds since I2-3: the Gateway's own port, the sandboxes' through the sandbox relay, is not limited by client
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > limits Gateway Keys not in use per client Caddy names: that client's right key waits too, another's does not, and a direct caller's own X-Forwarded-For buys no bucket of its own
✓ |@ai-office/server| src/auth/login-limiter.test.ts > createLoginLimiter > says how long a client is locked out for without counting an attempt
✓ |@ai-office/server| src/auth/login-limiter.test.ts > createLoginLimiter > forgets a client's failures when told to
```

## Decisions

These are for the Owner to review. The PRD's FR-4 covers sign-ins; it
says nothing of Gateway Keys, so each choice below takes FR-4's shape
where it fits.

1. **The sign-in limits, with a limiter of their own.** The numbers are
   FR-4's (and A1's), so the Owner learns one rule. The counts are kept
   apart, so a misconfigured tool and a mistyped password never lock each
   other out.
2. **Only a key found not in use counts, after it is checked.** A sign-in
   counts every attempt before its password is hashed, so parallel
   guesses cannot slip in. A Gateway Key is checked in one lookup, not
   hashed, and a tool such as Claude Code sends many requests at once. If
   every request counted before its check, six arriving together would
   lock out a busy tool's right key for a minute. So a few guesses made
   in parallel may each be checked during one lookup's wait before the
   lockout starts. A key is 256 random bits, so that changes nothing.
3. **A request with no key counts nothing.** It is not a guess. It is
   still refused `401`, and a locked-out client's keyless request gets
   the `401` too, since no key is checked.
4. **A key in use forgets the client's failures**, as a successful
   sign-in does. A caller who holds one key in use (position 4) can
   reset its own count between guesses. That is the same as for
   sign-ins, and a second key gains them nothing a 256-bit guess could
   find.
5. **The Gateway's own port is not limited, and its keys not in use are
   not recorded.** Since ADR 0006 and ADR 0008, sandboxes reach 3047
   only through the sandbox relay, so every sandbox is one client there
   (the relay's address), and so is the app's own model client. A limit
   there would let one injected sandbox, sending wrong keys, lock every
   Agent on every Floor out of its models: a worse harm than the one the
   limit prevents. The port is unpublished; the network (position 1)
   reaches the Gateway only at `/v1`.
6. **The count is in memory, not replayed after a restart.** Sign-ins
   replay `sign_in_events` (A1-7); this limiter has no such table. Every
   key not in use and every lockout is still in the Activity Feed, which
   is what the finding asked to be recorded. A restart forgets a running
   lockout.
7. **Two new event types**, `gateway_key.failed` and
   `gateway_key.locked_out`, rather than reusing `sign_in.*`. A Gateway
   Key never signs anyone in, and the Activity Feed's "Sign-ins" filter
   should still mean sign-ins. The address is recorded, as for sign-ins;
   the key never is.
8. **A new dependency, `@fastify/proxy-addr`**, at 5.1.1, the version
   Fastify 5.12.5 already pulls in. Nothing new is installed. It lets the
   `/v1` client address be the one `request.ip` would give, from one
   trust function shared with Fastify, rather than a second
   `X-Forwarded-For` parser.

## Noticed, out of scope

- **The log line for a refused key still has no client address**, as the
  probe found and called good. Each key not in use and each lockout is
  now in the Activity Feed with it, and the lockout's log warning names
  the client as a sign-in lockout's does.

## What could not be verified here

There is no Docker or Caddy here. The limit was exercised over a real
socket on the app's port, directly and with a proven proxy's
`X-Forwarded-For`, and on the Gateway alone on a port of its own. On the
pen-test stack, from a second host, this is for the host:

- send six wrong keys to `https://<domain>/v1/messages`;
- see the `429` and the two event types in the Activity Feed;
- see a tool on another address still served.
