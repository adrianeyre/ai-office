# Issue #293: [fix] W1-3 — One read-only token serves every sandbox, Manager chat session and fact-finding run of a Floor for 55 minutes and is never revoked — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no GitHub, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`0b37fbf`,
`fix(security): W1-3 each sandbox's read-only token is its own, and is revoked as the sandbox stops`,
on top of W1-2's `f650316` (#291). Its blocker, the W1 probe (#196), is
in the tree: `docs/pen-testing/assessments/W1.md` and
`packages/github/src/app.pen-test.test.ts`.

This is the remediation of finding **W1-3** (`severity:medium`, new,
position 3).

## What was fixed

`readOnlyToken()` was cached like the App's own token. So one read-only
token of a Floor was handed to every sandbox, Manager chat session and
fact-finding run that started within 55 minutes, and nothing ever
revoked it. A token a sandbox sent out (it has open egress, S2-1) read
the Floor's private repository, its issues and its pull requests for up
to an hour after the sandbox had gone. It could not be told from any
other sandbox's token. The setup guide said "each sandbox gets its own
short-lived installation token"; it did not.

**Now each sandbox's read-only token is its own, and is revoked as it
stops:**

- **The client** (`packages/github/src/app.ts`). `readOnlyToken()` is no
  longer cached: each call mints a token of its own. `revokeToken(token)`
  revokes one through GitHub's `DELETE /installation/token`, sent as the
  token itself. A token that has expired or was revoked already (401) is
  no error.
- **The sandbox runner** (`sandbox/runner.ts`). It mints one token per
  sandbox. The clone and the first session use it, and each Fresh Start's
  new sandbox gets a new one. Each is revoked as its sandbox stops: in
  the session's `finally`, and on any failure before or after.
- **The Manager chat** (`manager/chat-sessions.ts`). Each turn mints its
  own token for the host-side clone or fetch, and revokes it once the
  clone is fresh, before the tool runs. The session itself is given no
  GitHub token, as before.
- **Fact-finding** (`grilling/fact-finding.ts`). Each run mints its own
  token, the sandbox's `GH_TOKEN`, and revokes it as the sandbox stops,
  whatever the outcome.
- **Revoking can fail without failing the work.** If GitHub cannot be
  told, the token still expires within its hour, as before.

The fake GitHub, in memory and over HTTP, revokes tokens
(`DELETE /installation/token`), after which they reach nothing. The
Manager's client refuses `revokeToken` as it refuses `readOnlyToken`.
The setup guide, the issue pipeline guide (sandboxes) and the events and
chat guide (the Manager's clone, fact-finding) say so.

### Sibling paths with the same flaw, fixed and tested

Every caller of `readOnlyToken()` holds one of its own and revokes it:

- **A sandbox, finished or failed.** Tested in `sandbox/runner.test.ts`,
  "gives each sandbox a read-only token of its own, and revokes it as
  the sandbox stops, finished or failed (W1-3)". Two runs get different
  tokens, each works while its sandbox runs, and none works after. A run
  whose agent crashes leaves its token revoked too.
- **A Fresh Start's new sandbox.** Tested in `sandbox/fresh-start.test.ts`,
  "gives each session's sandbox a read-only token of its own, revoked as
  that sandbox stops (W1-3)". The second session's token differs from
  the first, and the first was revoked before the second session ran.
- **The Manager chat's clone.** Tested in `manager/chat-sessions.test.ts`,
  "clones with a read-only token of each turn's own, revoked once the
  clone is fresh and before the session runs (W1-3)".
- **Fact-finding.** `grilling/fact-finding.test.ts` and
  `fact-finding-scenario.test.ts` read each sandbox's token's scope while
  it runs (still `readOnlyPermissions`). They now also assert that each
  sandbox's token is its own, and revoked once it stopped. They used to
  read the scope afterwards, which a revoked token no longer has, as did
  `runner.test.ts`'s "gives the sandbox only the allow-listed
  environment". Each assertion is unchanged, made while the sandbox
  runs.

## Decisions

- **Revoked, not shortened.** GitHub's installation tokens last an hour
  and cannot be asked for less, so the bound on a leaked token is its
  sandbox's life, by revocation.
- **A failure to revoke is swallowed.** Failing a finished task because
  GitHub could not be told would cost the work and gain nothing: the
  token expires within the hour either way, as every token did before.
- **A session longer than an hour.** Its token expires within it, as
  before. It is now minted when the sandbox starts, never up to 55
  minutes earlier for another caller.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "W1-3:
      each sandbox's read-only token is its own, so one leaked names one
      sandbox and can be revoked with it" is an `it` and passes, with its
      body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** *"pins today (W1-3): one
      read-only token is handed to every caller for 55 minutes, and the
      client has no way to revoke one"* is now "regression (W1-3): one
      read-only token is no longer handed to every caller for 55 minutes,
      and the client revokes one". With the same clock, it asserts that
      the two tokens differ, that two were minted, and that the client
      has exactly `revokeToken`. It then revokes the first, which reaches
      nothing on the fake afterwards, while the second still does. A new
      test, "W1-3: a revoked token reads nothing more, while another
      sandbox's still reads; revoking it again is no error", drives it
      over HTTP: `GET /repos/{owner}/{repo}` answers 200, then 401 once
      revoked. No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above.
- [x] **The assessment's findings table marks `W1-3` fixed.**
      `docs/pen-testing/assessments/W1.md`: **fixed** (issue #293), with
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

### W1-3's tests on their own

```
 ✓ |@ai-office/github| src/app.pen-test.test.ts > how long a token lives, and who shares it > W1-3: each sandbox's read-only token is its own, so one leaked names one sandbox and can be revoked with it
 ✓ |@ai-office/github| src/app.pen-test.test.ts > how long a token lives, and who shares it > regression (W1-3): one read-only token is no longer handed to every caller for 55 minutes, and the client revokes one
 ✓ |@ai-office/github| src/app.pen-test.test.ts > how long a token lives, and who shares it > W1-3: a revoked token reads nothing more, while another sandbox's still reads; revoking it again is no error
 ✓ |@ai-office/orchestrator| src/sandbox/runner.test.ts > the sandbox runner > gives each sandbox a read-only token of its own, and revokes it as the sandbox stops, finished or failed (W1-3)
 ✓ |@ai-office/orchestrator| src/sandbox/runner.test.ts > the sandbox runner > gives the sandbox only the allow-listed environment
 ✓ |@ai-office/orchestrator| src/sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > gives each session's sandbox a read-only token of its own, revoked as that sandbox stops (W1-3)
 ✓ |@ai-office/orchestrator| src/manager/chat-sessions.test.ts > the Manager's session, run like a sandbox > clones with a read-only token of each turn's own, revoked once the clone is fresh and before the session runs (W1-3)
 ✓ |@ai-office/orchestrator| src/grilling/fact-finding.test.ts > the sandbox fact finder > answers from the repository, read in a sandbox with a read-only token and no Git identity, then deletes the clone
```

No token reaches the tests' output: the fake sandbox's output lines show
the branch and the log's path only.

## What could not be verified here

There is no GitHub and no Docker here. On the pen-test stack:

- From one sandbox, print the SHA-256 of `GH_TOKEN`, not the token.
  Start a second sandbox on the same Floor within the hour and compare:
  they should now differ.
- Then stop the first, and check that its token no longer answers
  `GET /repos/{owner}/{repo}` (401) well before its `expires_at`, while
  the second's still does until its own sandbox stops.
- Check that GitHub answers `DELETE /installation/token` sent with a
  read-only installation token (`204`), as its documentation says for
  any installation token.

## Noticed, out of scope

- **The six `repository` and `deployment` tests that fail on the base
  commit** (see [issue #289's note](issue-289.md#noticed-out-of-scope)).
- **The App's own token that writes is still cached for 55 minutes and
  never revoked.** It never leaves the app process (it reaches Git only
  through Git's own environment, in AI Office's scratch repositories), so
  it is not what W1-3 is about. A breach of the app (H1, H16) holds the
  App's private key anyway.
