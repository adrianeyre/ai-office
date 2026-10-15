# Issue #289: [fix] W1-1 — A webhook delivery is acted on every time it is sent — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no GitHub, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`8eeea47`,
`fix(security): W1-1 a webhook delivery is acted on once, whatever X-GitHub-Delivery it carries`,
the first of this run's six (W1-1 to W1-6, issues #289 to #299), on top
of `20b619d`. Its blocker, the W1 probe (#196), is in the tree:
`docs/pen-testing/assessments/W1.md` and
`apps/server/src/webhooks/routes.pen-test.test.ts`.

This is the remediation of finding **W1-1** (`severity:low`, H12,
position 5).

## What was fixed

GitHub signs a delivery's body, not its `X-GitHub-Delivery`, and nothing
remembered a delivery. So one captured delivery (from **Recent
Deliveries**, a TLS-terminating proxy or a logged body) could be sent
again, under its own id, a new one or none, as often as wanted. Each
time it was believed and ran intake over every Floor.

**Now a delivery is acted on once** (`packages/orchestrator/src/webhooks/webhooks.ts`):

- **Each body taken is remembered by its SHA-256.** The receiver keeps
  the last 10,000 (`rememberedDeliveries`), in memory, the oldest
  forgotten first.
- **The same body again starts nothing.** Whatever `X-GitHub-Delivery`
  it carries, and whatever `X-GitHub-Event` (also unsigned), it is
  answered `202 {"started":[]}` (`repeated`). It is logged at `debug`,
  not `info`, so a replayer cannot fill the log with it.
- **Two at once are taken once.** The body is checked and remembered with
  nothing awaited between.
- **Only a body taken is remembered.** A delivery refused (`401`, the
  secrets differed) or sent while webhooks were off (`404`) is not, so
  GitHub's **Redeliver** of it is taken once the cause is fixed.

The guide's **Webhooks** bullet (`docs/guide/issue-pipeline.md`) and the
setup guide's **Webhooks (optional)** (`docs/processes/setting-up-a-floor.md`)
say so.

### Sibling paths with the same flaw, fixed and tested

The check is in the receiver, before anything is started, so every
action a delivery starts is covered, not only intake:

- **Intake, the labels, the Batches' check and the Merge Policy's look at
  CI.** Tested in `webhooks/webhooks.test.ts`, "starts nothing again for
  a body taken before, whatever it starts".
- **The same body under another event** (the event is not signed).
  Tested at the route: "the replay of a delivery taken, under another
  event, starts nothing either".
- **A CI delivery replayed while the Merge Policy waits for CI.** The W1
  probe's replay tests (`webhooks.pen-test.test.ts`) wake the gate five
  times to show it always reads GitHub. Each wake is now a delivery of
  its own (a check run with its own `id`, as GitHub sends one per check
  run), and each test now also checks that replaying one of them wakes
  nothing. Their assertions about the gate are unchanged. The two
  "closed" bodies there were byte for byte the same; they now carry the
  issue and the pull request, as GitHub's do.
- **Concurrent sends, Redeliver and the memory's bound.** Tested in
  `webhooks.test.ts`: "takes the same body sent twice at once only once",
  "remembers only bodies taken…", "forgets the oldest body taken…". At
  the route: "GitHub's Redeliver of a delivery that was not taken… is
  taken".

## Decisions

- **The body is the key, not `X-GitHub-Delivery`.** GitHub signs only the
  body, so the id is the sender's to choose: keying on it would let a
  replay through under a new id. GitHub's documentation on webhook best
  practice says a redelivery carries the **same** `X-GitHub-Delivery` as
  the original. It is also the same body, so a Redeliver of a delivery
  AI Office already took (`202`) starts nothing, and one it did not take
  works. This could not be confirmed against GitHub here (below).
- **In memory, the last 10,000.** A restart forgets them, so a delivery
  replayed after a restart is acted on once more. That costs one intake
  round, which the server runs at start anyway. Keeping them in Postgres
  would need a table, a migration and its retention for a `low` finding;
  the Owner may want that later. 10,000 SHA-256 digests are under 1 MB.
  A Floor sees far fewer deliveries in the time an attacker could use
  one.
- **A replay is answered `202`, not an error.** GitHub retries nothing
  automatically, and a Redeliver the Owner sends of a delivery taken
  should not show as a failure in **Recent Deliveries**.
- **A delivery about one Floor still runs intake over every Floor.** The
  assessment's "what the fix must make true" adds that a delivery about
  one Floor should cost no other Floor a round. The issue's own "what
  the fix must make true" does not ask for it. With replays starting
  nothing, the cost the finding names (a full round per replay) is gone:
  the regression test shows five sends cost one round. Narrowing intake
  to one Floor's round needs a change to how rounds and their interval
  work (`rounds.ts`): a round restarts the interval, so a busy Floor's
  deliveries would put off every other Floor's check. That is left for
  its own decision (below).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "a
      delivery already taken is not acted on again: the same signed body
      starts nothing, under its own X-GitHub-Delivery or another" is an
      `it` and passes, with its body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** *"pins today: one captured
      delivery, sent again under any id or none, starts intake each time,
      and each round lists every Floor's issues"* is now "regression
      (W1-1): one captured delivery, sent again under any id or none, no
      longer starts intake each time: only the first starts a round, and
      the replays list no Floor's issues". It sends the same five
      deliveries and asserts the first starts intake, the other four
      `{"started":[]}`, one round in all, one `listIssues` per Floor, and
      the issue taken in once. No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above.
- [x] **The assessment's findings table marks `W1-1` fixed.**
      `docs/pen-testing/assessments/W1.md`: **fixed** (issue #289), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on six `repository` and
      `deployment` tests of `.env.example` and files under `docker/`,
      which no commit here touches and which fail the same way on the
      base commit (below). Every test of these fixes passes.

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
.env.example docker-compose.yml test` is empty). They fail the same way
on the base commit, checked out in a scratch worktree:

```
$ pnpm vitest run --project repository --project deployment   # at 20b619d
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
      Tests  6 failed | 202 passed | 14 expected fail | 13 skipped (235)
```

### W1-1's tests on their own

```
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-1: a delivery is acted on every time it is sent (H12) > a delivery already taken is not acted on again: the same signed body starts nothing, under its own X-GitHub-Delivery or another
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-1: a delivery is acted on every time it is sent (H12) > regression (W1-1): one captured delivery, sent again under any id or none, no longer starts intake each time: only the first starts a round, and the replays list no Floor's issues
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-1: a delivery is acted on every time it is sent (H12) > W1-1: the replay of a delivery taken, under another event, starts nothing either: the event is not signed
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > W1-1: a delivery is acted on every time it is sent (H12) > W1-1: GitHub's Redeliver of a delivery that was not taken (refused while the secrets differed, or sent while webhooks were off) is taken
 ✓ |@ai-office/server| src/webhooks/routes.pen-test.test.ts > a delivery's payload says when to look, never what to do > a replay after the Owner took the label off takes nothing in
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.test.ts > a delivery taken once (W1-1) > starts nothing again for a body taken before, whatever it starts: intake, the labels, the Batches' check or the wait for CI
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.test.ts > a delivery taken once (W1-1) > takes the same body sent twice at once only once
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.test.ts > a delivery taken once (W1-1) > remembers only bodies taken, so one refused or sent while off is taken when it comes again
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.test.ts > a delivery taken once (W1-1) > forgets the oldest body taken once it remembers as many as it may
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.pen-test.test.ts > replaying a CI delivery while the Merge Policy waits for CI > wakes the gate to read GitHub again, and never merges while GitHub's CI is still running
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.pen-test.test.ts > replaying a CI delivery while the Merge Policy waits for CI > a 'passed' delivery replayed after CI failed on GitHub sends the pull request to the Owner, unmerged
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.pen-test.test.ts > replaying a CI delivery while the Merge Policy waits for CI > once CI passes on GitHub the App merges once, and a replay afterwards merges nothing again
 ✓ |@ai-office/orchestrator| src/webhooks/webhooks.pen-test.test.ts > replaying a CI delivery while the Merge Policy waits for CI > a replayed 'closed' delivery only starts the Batches' check, which reads its Batches and GitHub
```

## What could not be verified here

There is no GitHub here: the fake stands in for its deliveries. On the
pen-test stack, with its own App and webhooks on:

- Take one delivery from the App's **Recent Deliveries**, as the red
  team's position-5 harness would hold it, and send it twice to
  `/api/github/webhooks` with `curl`, the second time with a new
  `X-GitHub-Delivery`. Both should now answer `202`. The first should
  log "A GitHub webhook delivery was taken." and start one intake round,
  and the second `{"started":[]}` and no round (its line is at `debug`).
- Confirm what GitHub's **Redeliver** sends for `X-GitHub-Delivery`.
  GitHub's documentation says the same GUID as the original, and the
  body is the same. The fix keys on the body, so it holds either way: a
  Redeliver of a delivery answered `202` starts nothing, and one answered
  `401` or `404` is taken.

## Noticed, out of scope

- **A delivery about one Floor runs intake over every Floor** (see
  Decisions). Narrowing it needs `rounds.ts` to run a round for some
  Floors without putting off the others' next check.
- **Six `repository` and `deployment` tests fail on the base commit.**
  By their assertions:
  - `.env.example` no longer says the Gateway "has no authentication of
    its own yet", so I1-9's pin fails and its `it.fails` passes ("Expect
    test to fail");
  - a Dockerfile's base image is `docker:${DOCKER_CLI_VERSION}-cli`,
    which I1-4's pattern does not allow;
  - the published-ports check ("binds the app, the OAuth callback and
    the Gateway to the host's loopback only") reads `false`;
  - the Caddyfile's `reverse_proxy app:3045` now has a block;
  - the pen-test stack's environment file holds `127.0.0.1`.

  They are outside this fix.
