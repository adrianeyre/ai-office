# Issue #211: [fix] A1-1 — The sign-in limiter keys on an X-Forwarded-For any caller that bypasses Caddy chooses — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `dd17f91`,
`fix(security): A1-1 X-Forwarded-For is believed only from the proxy that proves itself`,
on top of `3c081be`. Its blocker, the A1 probe (#192), is in the tree:
`docs/pen-testing/assessments/A1.md` and the probe tests it names,
including `apps/server/src/auth/login-limiter.pen-test.test.ts`.

This is the remediation of finding **A1-1** (`severity:high`, H3) only.
Whether a sandbox can reach `app:3045` at all is #193's (S2), and stays as
it is: this fix makes that reach harmless to the limiter.

## What was fixed

The limiter, `sign_in_events` and the Activity Feed all key on
`request.ip`. With `TRUST_PROXY` set, Fastify took it from
`X-Forwarded-For` whenever the TCP peer matched `TRUST_PROXY`: with `1`,
any peer at all; with `.env.example`'s `172.16.0.0/12`, any peer on
Docker's default pools, sandboxes included. A peer address cannot tell
Caddy from a sandbox: both are on Docker networks the app joins.

So the proxy now **proves itself**. It sends a secret only it and the app
hold, `PROXY_SECRET`, in an `X-AI-Office-Proxy` header, and the app
believes `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`
only from a request that carries it:

- **`apps/server/src/auth/proxy.ts`** (`believeOnlyTheProxy`): compares the
  header with `PROXY_SECRET` in constant time (SHA-256 of each, then
  `timingSafeEqual`). On any other request it deletes the three
  `X-Forwarded-*` headers. It always deletes the proof itself, so no log
  line, route or event can see it. With no `PROXY_SECRET`, no request is
  believed, whatever `TRUST_PROXY` says.
- **Where it runs** (`apps/server/src/app.ts`): as Fastify's `rewriteUrl`,
  which is called once per request, before routing, before the request's
  own log line, and before anything reads `request.ip`, `request.host` or
  `request.protocol`. It returns the URL unchanged. `inject` goes through
  it too, so the probe exercises the real path.
- **Configuration** (`apps/server/src/config.ts`): `PROXY_SECRET`, at least
  32 characters. `TRUST_PROXY` and `PROXY_SECRET` must be set together, or
  neither; the server refuses to start with one alone and says why.
  `PROXY_SECRET` is a secret config key, so the logger removes it wherever
  it appears.
- **Caddy** (`docker/caddy/Caddyfile`): `reverse_proxy app:3045 {
  header_up X-AI-Office-Proxy {env.PROXY_SECRET} }`. Caddy still replaces
  any client's `X-Forwarded-For` with the real peer (no `trusted_proxies`),
  and `header_up` replaces any `X-AI-Office-Proxy` a client sent.
- **Compose** (`docker-compose.yml`): `PROXY_SECRET: ${PROXY_SECRET:-}` for
  both the app and Caddy. The pen-test stack passes
  `PEN_TEST_PROXY_SECRET` beside `PEN_TEST_TRUST_PROXY`.
- **Documents**: `.env.example` no longer suggests `172.16.0.0/12`, and
  explains `PROXY_SECRET`; the EC2 guide's `.env` table and
  troubleshooting, the running guide's TLS profile and sign-in sections,
  and the pen-test stack document say to set both.

### Sibling paths

- **TOTP codes and API keys.** `POST /api/login/totp` and
  `POST /api/login/api-key` use the same `request.ip`, so they are fixed by
  the same change; the probe's pin for them is now a regression test.
- **`X-Forwarded-Host` and `-Proto`.** With `TRUST_PROXY` set, Fastify also
  believed these for `request.host` and `request.protocol`, which
  `robots.txt`, `sitemap.xml` and `index.html` use for their absolute URLs
  when `PUBLIC_URL` is unset. They are dropped with `X-Forwarded-For`.
- **Setup's loopback check** (A1-2, #213) reads `request.ip`, so a caller
  cannot claim `127.0.0.1` with `X-Forwarded-For` either; #213 tests it.
- **The AI Gateway and the OAuth callback** are separate Fastify
  instances with no `trustProxy`; they never believed `X-Forwarded-For`.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** Both
      `it.fails` "a caller that is not the trusted proxy cannot choose the
      address it is limited by" (for `TRUST_PROXY=1` and
      `=172.16.0.0/12`) are now `it`, with their bodies unchanged. They
      build the app with `trustProxy` alone, as before, and pass.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "pins today: rotating
      X-Forwarded-For gives every guess a fresh bucket" is now
      "regression (A1-1): rotating X-Forwarded-For no longer gives every
      guess a fresh bucket", run with `PROXY_SECRET` set as the documents
      now configure it: twenty guesses from a sandbox give five `401`s and
      fifteen `429`s, the right password is `429` while locked out, and
      `sign_in_events` holds the sandbox's own address only. "pins today:
      the same rotation guesses TOTP codes and API keys without limit" is
      now "regression (A1-1): the same rotation no longer guesses…": codes
      and keys take turns against one limit, five failures between them,
      then `429`.
- [x] **Sibling paths with the same flaw are fixed and tested.** New
      `describe("A1-1 · the proxy proves itself with PROXY_SECRET")` in
      `login-limiter.pen-test.test.ts`: the proxy that sends the secret is
      believed (and its client locked out alone); no proof, a wrong secret
      and an empty one are not, from inside the trusted range; with no
      `PROXY_SECRET` nobody is, even a caller that sends one; the proof is
      in no log line; `X-Forwarded-Host` and `-Proto` are believed only
      from the proxy (`robots.txt`). Elsewhere: `config.test.ts` (both or
      neither, a short secret refused without echoing it, `secretValues`
      includes it), `logger.test.ts` (never logged),
      `rate-limit.test.ts` (behind a proxy, now with the proof),
      `docker/deployment.test.ts` and
      `docker/caddy/caddyfile.pen-test.test.ts` (the Caddyfile sends it,
      compose gives both containers the same variable).
- [x] **The assessment's findings table marks `A1-1` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #211) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below.

Two existing tests changed beyond the probe's: "with TRUST_PROXY=1,
believes only the hop nearest the app" (`login-limiter.pen-test.test.ts`)
and "comes from X-Forwarded-For when TRUST_PROXY names %s"
(`rate-limit.test.ts`) now send the proof, as Caddy does; without it they
would pass for the wrong reason (nothing believed at all). The Caddyfile
tests that pinned `reverse_proxy app:3045` now pin
`reverse_proxy app:3045 {`, the same single upstream with a block.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: two failures, both pre-existing and unrelated

Run at `6fdba40`, after all four fixes:

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  2 failed | 422 passed (424)
      Tests  2 failed | 4827 passed | 22 expected fail | 600 skipped (5451)
test exit 1
```

Both expect the first release heading of `CHANGELOG.md` to carry a date
(`expected '1.0.0' to match /^1.0.0 \(/`). They failed the same way in a
run before any of these changes, and neither `CHANGELOG.md` nor either
test is touched by them (`git diff 3c081be --stat -- CHANGELOG.md
apps/web/src/site-footer.tsx apps/web/src/site-footer.test.tsx
apps/web/src/legal` is empty). The 600 skipped are the Postgres-backed
tests (no Docker here). The 22 expected fails are the open findings'
`it.fails` (A1-5 to A1-9, S2's and the others'); none of A1-1 to A1-4's
remain.

### The probe tests, verbose

```
✓ login-limiter.pen-test.test.ts > A1-1: the limiter's client address, from a caller that is not Caddy > with TRUST_PROXY=1 > a caller that is not the trusted proxy cannot choose the address it is limited by
✓ login-limiter.pen-test.test.ts > A1-1: the limiter's client address, from a caller that is not Caddy > with TRUST_PROXY=1 > regression (A1-1): rotating X-Forwarded-For no longer gives every guess a fresh bucket
✓ login-limiter.pen-test.test.ts > A1-1: the limiter's client address, from a caller that is not Caddy > with TRUST_PROXY=172.16.0.0/12 > a caller that is not the trusted proxy cannot choose the address it is limited by
✓ login-limiter.pen-test.test.ts > A1-1: the limiter's client address, from a caller that is not Caddy > with TRUST_PROXY=172.16.0.0/12 > regression (A1-1): rotating X-Forwarded-For no longer gives every guess a fresh bucket
✓ login-limiter.pen-test.test.ts > A1-1: the limiter's client address, from a caller that is not Caddy > regression (A1-1): the same rotation no longer guesses TOTP codes and API keys without limit
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > a caller cannot claim loopback with X-Forwarded-For (A1-1)
✓ login-limiter.pen-test.test.ts > A1-1 · the proxy proves itself with PROXY_SECRET > believes X-Forwarded-For from the proxy that sends PROXY_SECRET
✓ login-limiter.pen-test.test.ts > A1-1 · the proxy proves itself with PROXY_SECRET > does not believe a caller that sends no proof, from inside the trusted range
✓ login-limiter.pen-test.test.ts > A1-1 · the proxy proves itself with PROXY_SECRET > does not believe a caller that sends a wrong secret, from inside the trusted range
✓ login-limiter.pen-test.test.ts > A1-1 · the proxy proves itself with PROXY_SECRET > does not believe a caller that sends an empty one, from inside the trusted range
✓ login-limiter.pen-test.test.ts > A1-1 · the proxy proves itself with PROXY_SECRET > believes nobody with no PROXY_SECRET, even a caller that sends one
✓ login-limiter.pen-test.test.ts > A1-1 · the proxy proves itself with PROXY_SECRET > keeps the proof itself from every log line and route
✓ login-limiter.pen-test.test.ts > A1-1 · the proxy proves itself with PROXY_SECRET > does not believe X-Forwarded-Host or -Proto from a caller that is not the proxy either
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **A shared secret, not an address, says who the proxy is.** A sandbox
   and Caddy are both on Docker networks the app joins, and their
   addresses come from the same pools, so no `TRUST_PROXY` value can tell
   them apart; nor can the app know the sandbox network's subnet without
   asking Docker. A header only the proxy and the app know does not
   depend on the network at all, and works the same behind nginx or a
   CDN. The other option considered was a Unix socket shared only with
   Caddy; it needs a second listener and cannot be exercised with
   `inject`.
2. **`TRUST_PROXY` alone now refuses to start**, rather than starting and
   believing nobody. An Owner who set `TRUST_PROXY=1` meant a proxy to be
   believed; silently ignoring it would put every client behind Caddy in
   one limit (a lockout anyone who reaches Caddy could cause). The
   message names both variables, and the EC2 guide's troubleshooting table
   says what to do. **Upgrading a deployment that has `TRUST_PROXY` set
   needs `PROXY_SECRET` added to `.env`** before the app will start.
3. **`TRUST_PROXY` keeps its meaning** (hop count, or addresses and
   ranges), now applied only to a proven request. A deployment with
   several proxies in a chain still needs it.
4. **The proof is checked even when `TRUST_PROXY` is unset**, and always
   removed: the header never reaches a route or a log, whatever the
   configuration.

## Noticed, out of scope

- **The reach itself** (a sandbox reaching `app:3045` and `app:1455`) is
  S2/#193's. With this fix the limiter no longer depends on it; setup
  (#213) and the routes behind a session do not either.
- **A restart forgets every lockout** (A1-7) and **sessions never idle
  out** (A1-8): separate findings, still open.

## What could not be verified here

- **Caddy itself.** Running Caddy needs Docker. That `header_up` with an
  `{env.*}` placeholder sets the header to the container's environment
  value at request time, and replaces one the client sent, is Caddy's
  documented behaviour, pinned here as text only. On the live stack:
  `curl -H 'X-Forwarded-For: 1.2.3.4' https://<domain>/api/login` six
  times with a wrong password must reach `429` for the curl's own address,
  and the same loop from inside a sandbox against
  `http://app:3045/api/login` must reach `429` too.
- **Compose's interpolation** of `PROXY_SECRET` into both containers was
  read, not run.
