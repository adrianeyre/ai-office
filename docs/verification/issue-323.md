# Issue #323: [fix] I2-1 — /v1 is served before any of the app's hooks run, so an app-wide security header set by a hook never reaches the Gateway — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker, no Postgres, no second host account). The fix for the sibling
path is commit `25917ac`,
`fix(security): I2-1 the sign-in callback's answers carry the security headers, as /v1's do`,
on top of `cda5483`. Its blocker, the I2 probe (#287), is in the tree:
`docs/pen-testing/assessments/I2.md`,
`apps/server/src/gateway-entry.pen-test.test.ts` and
`docker/sandbox-dir.pen-test.test.ts`.

This is the remediation of finding **I2-1** (`severity:low`). This run
worked five issues in order, #323, #325, #327, #329 and #331, one
commit each. The full output of the checks, run once on the finished
tree for all five, is [below](#real-output-of-the-checks).

## What was fixed

### `/v1` itself: already fixed when this run started

The finding's own path was fixed before this issue was worked. Lane f's
`175484e`,
`fix(security): the AI Gateway's /v1 on the app's port takes the proxy's proof off and carries the security headers`,
came in with the merge of the pen-testing lanes (`d665a5d`). It has
`gatewayEntry` set the app's security headers on every `/v1` answer
before the Gateway runs. `b222fd4` then turned I2-1's `it.fails` into an
`it` and its pin into a regression test, and marked I2-1 fixed in
`I2.md` ([merge note](merge-pen-testing-lanes.md)).

This run checked that it holds: a served call, a refusal and a 404 on
`/v1` carry the same Content-Security-Policy, X-Frame-Options, nosniff
and Referrer-Policy as the app's own answers, and HSTS only over https
(`gateway-entry.test.ts`). The answers that #325 and #327 add on `/v1`
(the early `401` and the `429`) carry them too, because the headers are
set before the Gateway runs. Their tests assert `nosniff` on both.

### The sibling: the sign-in callback on 1455

The flaw is structural: an answer that the app's Fastify never handles
gets none of its hooks. The app has one more listener like that:
ChatGPT's sign-in callback, `apps/server/src/ai-accounts/oauth-callback.ts`.
It is a `node:http` server of its own on 1455, and it serves an **HTML
page a browser renders**. Its page, its refusals and its 404 carried only
`Referrer-Policy: no-referrer` (and no header at all on the 404).

Each of its answers now sets `securityHeaders({ https: false })` itself:

- a CSP with `frame-ancestors 'none'` (its inline `<style>` is allowed by
  the policy's `style-src 'unsafe-inline'`; it has no script);
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`.

The page keeps its stricter `Referrer-Policy: no-referrer`, because its
address holds the sign-in's code. The 404 gets the app's `same-origin`.
There is no HSTS: the callback is plain http on this machine.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** Done by
      `b222fd4` before this run. "I2-1: an answer on /v1 at the app's port
      carries the app-wide security headers (nosniff and Referrer-Policy
      at least)" is an `it`, and passes.
- [x] **The "pins today" test becomes a regression test; neither is
      deleted.** Done by `b222fd4`. "regression (I2-1): an app-wide
      onRequest hook sets a header on the app's answers and still never
      runs for /v1, but /v1 answers now carry the security headers"
      passes. Both tests are in the file.
- [x] **Sibling paths with the same flaw are fixed and tested.** In
      `oauth-callback.test.ts`: "carries the security headers on every
      answer, its page, a refusal and a 404, with its own stricter
      Referrer-Policy". With the fix stashed, it fails:
      `AssertionError: /auth/callback?code=ac_1&state=abc: expected null to be 'nosniff'`.
      With the fix, it passes.
- [x] **The assessment's findings table marks `I2-1` fixed.** It already
      did. The row now also names the sibling's commit subject (issue
      #323, hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See
      [below](#real-output-of-the-checks).

### The tests, verbose

```
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > regression (I2-1): an app-wide onRequest hook sets a header on the app's answers and still never runs for /v1, but /v1 answers now carry the security headers
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > I2-1: an answer on /v1 at the app's port carries the app-wide security headers (nosniff and Referrer-Policy at least)
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > a served call on /v1 carries the security headers the app's own answers do
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > a refusal without a Gateway Key on /v1 carries the security headers the app's own answers do
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > a path the Gateway does not serve on /v1 carries the security headers the app's own answers do
✓ |@ai-office/server| src/ai-accounts/oauth-callback.test.ts > a sign-in's local callback > carries the security headers on every answer, its page, a refusal and a 404, with its own stricter Referrer-Policy
```

## Decisions

These are for the Owner to review.

1. **The Gateway's own port (3047) gets no security headers.** The
   issue's property is about the one entry point, the app's port, and
   that holds. 3047 is never published. Only the sandbox relay and the
   app itself reach it, and they are API clients, never a browser that
   renders an answer. Adding the headers there would need the Gateway to
   know `PUBLIC_URL` for HSTS, for no reader that uses them.
2. **The callback keeps `Referrer-Policy: no-referrer`** rather than the
   app's `same-origin`. Its address carries the sign-in's code, so it
   sends no referrer at all. A route's stricter header replacing the
   app's is how the app already treats the Manager chat's attachments.

## Noticed, out of scope

- **Node's own answers to a malformed request** (the `400 Bad Request`
  that `node:http` sends from its `clientError` handling, before any
  handler runs) carry no security headers. That holds on every listener,
  the app's own routes included. They have no body a browser would
  render. It was not changed here.

## What could not be verified here

There is no browser, Docker or Caddy here. Over a real socket: the
callback listener's answers, and `/v1` through the app's server factory.
Through Caddy's `tls` profile, the Caddyfile's `header ?…` defaults
reach `/v1` too, as before (`docker/caddy/caddyfile.pen-test.test.ts`
reads them). Confirming the headers on `https://<domain>/v1` and on
`http://localhost:1455/auth/callback` during a real ChatGPT sign-in is
for the pen-test stack.

## Real output of the checks

Run once on the finished tree, after all five commits (`e3bb3ec`).

`pnpm lint`:

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

Exit code 0.

`pnpm typecheck`:

```
$ tsc && pnpm --recursive typecheck
packages/db typecheck$ tsc
packages/github typecheck$ tsc
packages/shared typecheck$ tsc
packages/db typecheck: Done
packages/shared typecheck: Done
packages/events typecheck$ tsc
packages/github typecheck: Done
packages/events typecheck: Done
packages/communications typecheck$ tsc
packages/orchestrator typecheck$ tsc
packages/gateway typecheck$ tsc
apps/web typecheck$ tsc
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

Exit code 0.

`pnpm test`:

```
 Test Files  483 passed (483)
      Tests  5704 passed | 616 skipped (6320)
   Duration  158.12s (tests 68%, import 20%, transform 5%, environment 4%, setup 3%)
```

Exit code 0. There are no expected failures left: the five `it.fails`
the lanes' merge left (I2-2, I2-3, I2-4 twice, I2-5) are all `it`s now.
The 616 skipped tests need Docker, Postgres or a browser, as on
`feat/pen-testing` before this run. The repository project's
cross-reference test passes: every probe file that still holds an
`it.fails` is referenced by an assessment, and the two I2 files hold
none now but stay linked from `I2.md`.
