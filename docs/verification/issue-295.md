# Issue #295: [fix] W1-4 — Nothing limits the deliveries one caller sends to the public webhook route — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no GitHub, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`32a44e5`,
`fix(security): W1-4 a caller's failed webhook deliveries are refused unverified past a bound, and logged once`,
on top of W1-3's `0b37fbf` (#293). Its blocker, the W1 probe (#196), is
in the tree: `docs/pen-testing/assessments/W1.md` and
`apps/server/src/webhooks/routes.pen-test.test.ts`.

This is the remediation of finding **W1-4** (`severity:low`, new,
positions 1 and 5).

## What was fixed

`POST /api/github/webhooks` needs no session, and nothing limited what
one caller sent to it. Each forged delivery cost a database read, the
secret opened (AES-GCM), one HMAC over up to 5 MiB, and a warning in the
log, as often as anyone sent one.

**Now a caller's failed deliveries are bounded**
(`apps/server/src/webhooks/delivery-limiter.ts`, `routes.ts`):

- **Twenty in ten minutes per client.** A client, by its address as the
  sign-in limiter counts them (`clientKey(request.ip)`, so `TRUST_PROXY`
  applies), may send 20 deliveries that fail the signature check in a
  window, which begins at its first failure.
- **Then refused before they are verified.** From the twentieth until
  the window ends, its deliveries are answered `429` with `Retry-After`,
  before the settings are read, the secret opened or the body hashed.
- **Their log lines are bounded too.** The first nineteen failures are
  warned as before. The twentieth's warning says the client's deliveries
  are now refused, unverified and unlogged. A `429` is not logged.
- **GitHub's own deliveries are never refused for it.**
  - They come from GitHub's addresses, which no forger sends from, and a
    client is counted on its own.
  - A delivery that verifies and is new forgets its client's failures. A
    replay (W1-1) does not, so a captured delivery cannot be used to
    reset the count.
  - Saving the **GitHub webhooks** card (a new secret, or webhooks on or
    off) forgets every client's failures. So GitHub's deliveries, refused
    while the two secrets differed, are taken once they match.

The setup guide (its webhooks section and a troubleshooting row for
`429`), the deployment guide (`TRUST_PROXY`, and a troubleshooting row)
and the issue pipeline guide say so.

### Sibling paths with the same flaw, fixed and tested

- **A delivery with no signature at all** is a failure like a wrong one:
  the probe's `it` sends 200 with no header.
- **GitHub's Redeliver after the secrets are fixed.** Tested: "setting
  the secret again forgets every refused caller…".
- **A replayed delivery used to reset the count.** Tested: "a delivery
  that verifies forgets its caller's failures; a replayed one does not".
- **Another address while one is refused.** Tested: "GitHub's own
  deliveries are never refused for it: they come from another address
  than the forger's".
- **The limiter on its own** (`delivery-limiter.test.ts`): the bound,
  `Retry-After` counting down to the window's end, a new window, each
  client counted on its own, forgetting, and the sweep of ended windows
  past a thousand clients.
- Other public routes: sign-in (`/api/login`, TOTP) has its own limiter
  already (FR-4). The other public routes are not webhook deliveries and
  belong to other probes, so they are left as they are.

## Decisions

- **Twenty failures in ten minutes, per address.** GitHub sends a
  delivery once, and an Owner who mistypes the secret sees `401` in
  **Recent Deliveries** long before twenty. A forger gets twenty HMACs
  and twenty log lines per ten minutes per address, not one per request.
  The window is fixed from the first failure, so a client cannot keep
  itself refused forever with one more failure. The Owner may want other
  numbers; they are `defaultDeliveryLimits`.
- **By address, as the sign-in limiter.** Behind Caddy that needs
  `TRUST_PROXY=1`, which the deployment guide already prescribes for
  sign-in. Without it every client is Caddy, and a forger's twenty
  failures would have GitHub's deliveries refused for ten minutes. The
  deployment guide's troubleshooting table now says so. Keying on
  anything else a forger sends (a header, the body) would be the
  forger's to choose.
- **In memory.** A restart forgets it, as it does the sign-in limiter
  (H7). Each window is ten minutes, so there is little to lose.
- **A `repeated` or `malformed` delivery neither counts nor forgets.**
  Both are signed, so they are not forgeries. But only a new delivery
  shows the client holds the secret, so only it forgets the failures.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "a caller
      that keeps sending deliveries that fail the signature check is
      refused with 429 before they are verified" is an `it` and passes,
      with its body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** *"pins today: 200 forged
      deliveries from one caller are each verified, refused with 401 and
      logged as a warning"* is now "regression (W1-4): 200 forged
      deliveries from one caller are no longer each verified, refused
      with 401 and logged as a warning: past the bound they are refused
      with 429, unverified and unlogged". It sends the same 200 and
      asserts:
  - twenty `401`s, then 180 `429`s with a `Retry-After`;
  - twenty deliveries reached the receiver, counted by its reads of the
    webhook settings, which it makes before anything else;
  - twenty warnings;
  - no intake round.

  No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above.
- [x] **The assessment's findings table marks `W1-4` fixed.**
      `docs/pen-testing/assessments/W1.md`: **fixed** (issue #295), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on six `repository` and
      `deployment` tests that fail the same way on the base commit
      (below). Every test of these fixes passes.

## Real output of the checks

The three checks were run on the tree of all six fixes (W1-6 then
uncommitted, since committed as `a579b6a` unchanged), before these notes
were written:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
$ pnpm test
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 Test Files  4 failed | 473 passed (477)
      Tests  6 failed | 5325 passed | 55 expected fail | 611 skipped (5997)
test exit 1
```

**The six failures are not these fixes'.** They read only
`.env.example`, `docker-compose.yml` and files under `docker/`, which no
commit here touches (`git diff --stat 20b619d HEAD -- docker
.env.example docker-compose.yml test` is empty), and the same six fail
on the base commit, `20b619d`, run in a scratch worktree
(`pnpm vitest run --project repository --project deployment`: "Tests  6
failed | 202 passed | 14 expected fail | 13 skipped (235)"). The full
listing, and what each asserts, is in
[issue #289's note](issue-289.md#real-output-of-the-checks).

### W1-4's tests on their own

```
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-4: nothing limits the deliveries one caller sends > a caller that keeps sending deliveries that fail the signature check is refused with 429 before they are verified
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-4: nothing limits the deliveries one caller sends > regression (W1-4): 200 forged deliveries from one caller are no longer each verified, refused with 401 and logged as a warning: past the bound they are refused with 429, unverified and unlogged
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-4: nothing limits the deliveries one caller sends > W1-4: GitHub's own deliveries are never refused for it: they come from another address than the forger's
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-4: nothing limits the deliveries one caller sends > W1-4: a delivery that verifies forgets its caller's failures; a replayed one does not
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-4: nothing limits the deliveries one caller sends > W1-4: setting the secret again forgets every refused caller, so GitHub's deliveries refused while the secrets differed are taken once they match
 ✓ |@ai-office/server| src/webhooks/delivery-limiter.test.ts > createDeliveryLimiter > lets a client fail twenty times, says so at the twentieth, then refuses it until ten minutes from its first
 ✓ |@ai-office/server| src/webhooks/delivery-limiter.test.ts > createDeliveryLimiter > counts each client on its own
 ✓ |@ai-office/server| src/webhooks/delivery-limiter.test.ts > createDeliveryLimiter > forgets a client whose delivery verified, and every client when cleared
 ✓ |@ai-office/server| src/webhooks/delivery-limiter.test.ts > createDeliveryLimiter > sweeps clients whose window has ended once it counts more than a thousand
```

The route's other tests (the signature over the raw bytes, a missing,
malformed or doubled header, webhooks off) send fewer than twenty
failures each and pass unchanged.

## What could not be verified here

The route was driven through Fastify's `inject`, with its `remoteAddress`
standing in for each client. Behind Caddy, with `TRUST_PROXY=1`, on the
pen-test stack:

- Send 25 deliveries signed with a wrong secret from one host. The first
  twenty should answer `401` and the rest `429` with `Retry-After`. The
  server's log should hold twenty warnings, the last saying the client is
  refused.
- Meanwhile, check that GitHub's own deliveries to the stack (from
  **Recent Deliveries** → **Redeliver**, or a new issue event) are taken
  (`202`).
- Without `TRUST_PROXY`, check that the same forgeries have GitHub's
  deliveries refused, as the deployment guide's new troubleshooting row
  says. That is the reason the setting matters.

## Noticed, out of scope

- **The six `repository` and `deployment` tests that fail on the base
  commit** (see [issue #289's note](issue-289.md#noticed-out-of-scope)).
- **Signed deliveries are not limited.** Only the holder of the secret,
  or of a captured delivery, can send one. W1-1 makes a captured one
  start nothing, but each still costs one HMAC. Bounding those would
  risk GitHub's own, which is what they are.
