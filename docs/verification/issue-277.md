# Issue #277: [fix] G1-5 — A subscription AI Account serves whoever sends its agent tool's User-Agent — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `f184e6a`,
`fix(security): G1-5 an Agent is served by a subscription only as its own AI Provider's agent tool, whatever User-Agent it sends`,
on top of `da9189a`. Its blocker, the G1 probe (#195), is in the tree:
`docs/pen-testing/assessments/G1.md` and
`packages/gateway/src/gateway.pen-test.test.ts`.

This is the remediation of finding **G1-5** (`severity:medium`, new). This
run also fixed G1-6 ([issue-279.md](issue-279.md)) and G1-7
([issue-281.md](issue-281.md)); the real output of the checks, run once on
the finished tree for all three, is [below](#real-output-of-the-checks).

## What was fixed

A Claude subscription serves only Claude Code, a ChatGPT one only Codex
and a Grok one only opencode (FR-35, "as that provider's terms require").
The Gateway told which agent tool sent a request from its User-Agent alone
(`agentToolOf`), which any caller sets. A Grok Agent's sandbox, or any code
holding any key, sending `claude-cli/…` was served by the Owner's Claude
subscription with raw API calls.

Now the claim counts only for a caller that runs that tool (`servedAs`,
`packages/gateway/src/gateway.ts`):

- **An Agent's key** is served only as its own AI Provider's agent tool
  (FR-16: Claude and Anthropic-compatible run Claude Code, ChatGPT runs
  Codex, the others opencode). Any other claim is served as no agent
  tool, so no subscription serves it; API-key accounts still do.
- **The Agent's AI Provider is AI Office's, never the call's.** The
  server's `keysAtWork` (`apps/server/src/gateway-keys/agent-keys.ts`),
  which already reads the Agent at each call to check it is enabled
  (G1-4), now hands the Gateway its AI Provider too
  (`GatewayCaller.aiProvider`). An Agent whose AI Provider is not known is
  served as none.
- **The Communications Agent's key** is served as none: it has no sandbox
  and runs no agent tool (FR-90). Its Digests and reports are plain
  calls, which were never served as one.
- **An Owner tool's key** is taken at its word, as before: the Owner's own
  Claude Code and Codex use the Owner's subscriptions (§5 scenario 9).

The guide says so: `docs/guide/ai-gateway.md` (Claude subscriptions,
"Only a caller that runs Claude Code").

### Sibling paths

- **Every agent tool, not only Claude Code.** The same User-Agent check
  admitted Codex (`codex_…/`) to a ChatGPT subscription and opencode
  (`opencode/…`) to a Grok one. One rule covers all three; tested.
- **AI Office's own calls through an agent tool** (`throughAgentTool`:
  reviewers and the Manager's one-shot calls when only a subscription can
  serve, the Manager chat's sessions, Grilling fact-finding and task
  sandboxes) run their Agent's AI Provider's tool, so they are served as
  before.
- **A change of AI Provider** applies from the Agent's next call, since it
  is read at each call (tested).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-5: an
      Agent whose agent tool is not Claude Code is never served as Claude
      Code, whatever User-Agent it sends" is an `it`, its assertions
      unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-5): a plain
      HTTP call that says it is Claude Code is no longer told to the
      accounts as Claude Code": the User-Agent still parses as Claude Code
      and still goes upstream as sent, but the accounts are asked for no
      agent tool.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `gateway.pen-test.test.ts`: "G1-5: each agent tool is served only
        to an Agent whose AI Provider runs it; the Communications Agent is
        served as none" (Claude, ChatGPT and Grok Agents, each claiming its
        own and the others' tools); "an Owner tool, the Owner's own Claude
        Code, is still served as what it says it is".
      - `agent-keys.pen-test.test.ts`: "G1-5: the Gateway is told each
        Agent's AI Provider as it is now, read at each call, so its key is
        served only as that AI Provider's agent tool".

      With `servedAs` returning the claim whatever the caller:

      ```
      × regression (G1-5): a plain HTTP call that says it is Claude Code is no longer told to the accounts as Claude Code 112ms
      × G1-5: an Agent whose agent tool is not Claude Code is never served as Claude Code, whatever User-Agent it sends 16ms
      × G1-5: each agent tool is served only to an Agent whose AI Provider runs it; the Communications Agent is served as none 55ms
      × G1-5: the Gateway is told each Agent's AI Provider as it is now, read at each call, so its key is served only as that AI Provider's agent tool 55ms
            Tests  4 failed | 1 passed | 29 skipped (34)
      ```

      (The one that passes is the Owner tool's.) Restored, all pass.
- [x] **The assessment's findings table marks `G1-5` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #277) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` exits 1 on ten failures, none in a file
      this run changed: the same ten pre-existing failures of other
      probes' stale pins that [issue-269.md](issue-269.md) records (G1-8,
      I2-1, I1-4, I1-9, I1-10). See below.

## Decisions

1. **Bound to who the caller is, not to proof from the tool.** The
   assessment asks that a subscription serve on "something the caller
   cannot simply claim; at least, an Agent whose AI Provider runs another
   agent tool is never served by it". Nothing a request carries can prove
   it came from Claude Code rather than from other code in the same
   sandbox, which holds the same key and environment, so the fix is that
   "at least": the Agent's AI Provider, as AI Office knows it.
2. **An Agent whose AI Provider is not known is served as none**, the
   conservative side. In AI Office every Agent's key reaches the Gateway
   through `keysAtWork`, which always knows it.
3. **The Communications Agent is served as none.** It runs no agent tool
   (FR-90), and its calls never claimed one, so nothing it does changes.
4. **Owner tools are taken at their word.** They are the Owner's own
   tools, and the Owner's local Claude Code using the Owner's Claude
   subscription is §5 scenario 9; a malicious Owner is out of scope. See
   Noticed for a stolen Owner-tool key.
5. **An Agent whose AI Provider changes mid-task** is served as its new AI
   Provider's tool from its next call; a sandbox still running the old
   tool then gets no subscription for the rest of its run, and an API-key
   account still serves it if the Owner has one.

## Noticed, out of scope

- **An Agent's own sandbox can still use its own AI Provider's
  subscription with raw API calls**, sending that tool's User-Agent: a
  Claude Agent's sandbox can call the Messages API as "Claude Code".
  Telling the tool from other code in its sandbox needs something the
  sandbox's code cannot read, which nothing in a sandbox is today.
- **A stolen Owner-tool key** (position 4) can still claim any agent tool.
  Binding an Owner tool's key to the tools it is for (a setting on the
  key) would close it; that is a new decision for the Owner.
- **`agentToolModelClient` picks its tool from the Model's AI Provider**
  (`callingToolOf`), the Gateway from the Agent's. They agree while an
  Agent's Model is its AI Provider's, which the Agent editor keeps.

## What could not be verified here

- From a real Grok Agent's sandbox on the pen-test stack, `curl` to the
  Gateway with `user-agent: claude-cli/…` and the Agent's key, with only a
  Claude subscription to serve: a `503` (no account), where before it was
  served.
- Real Claude Code, Codex and opencode runs through subscriptions, which
  need the AI Providers.
- The Postgres stores: skipped here without Docker. `keysAtWork` reads
  the Agent through the same `agents.list` the rest of AI Office uses.

## Real output of the checks

Run once on the finished tree, at `f751f71`, after all three fixes of this
run (#277, #279, #281); the other two notes point here.

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
...
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: ten failures, none in what this run changed

```
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > the compose comment reflects that a sandbox also reaches the app's 3045 and 1455 (S2-3)
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > pins today: the compose file says sandboxes reach 'the AI Gateway as app:3047 and nothing else of the stack'
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > pins today: an Office served beyond localhost loads with .env.example's secrets, and the database password is not even named
 FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > G1-8: an Office served beyond localhost does not start with .env.example's public secrets
 FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > I2-1: an answer on /v1 at the app's port carries the app-wide security headers (nosniff and Referrer-Policy at least)
 FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > pins today: an app-wide onRequest hook sets a header on the app's answers and never runs for /v1, whose answers carry no security header
 Test Files  4 failed | 466 passed (470)
      Tests  10 failed | 5351 passed | 51 expected fail | 607 skipped (6019)
[ELIFECYCLE] Test failed. See above for more details.
test exit 1
```

These are the ten pre-existing failures [issue-269.md](issue-269.md)
records, of other probes' pins and `it.fails` that went stale when main's
one-entry-point merge and earlier pen-testing fixes changed what they pin:

- **I1's six** (`supply-chain.pen-test.test.ts`,
  `documentation-drift.pen-test.test.ts`) read only the Dockerfiles,
  `docker-compose.yml` and `.env.example`, which this run did not change
  (`git diff --name-only da9189a HEAD` lists nothing under `docker/`,
  `test/` or the repository root).
- **G1-8's two and I2-1's two** (`config.pen-test.test.ts`,
  `gateway-entry.pen-test.test.ts`). The I2-1 tests drive the Gateway, so
  they were run again with this run's gateway and `gateway-keys` sources
  put back to `da9189a`; they fail the same way there:

  ```
   FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > pins today: an Office served beyond localhost loads with .env.example's secrets, and the database password is not even named
   FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > G1-8: an Office served beyond localhost does not start with .env.example's public secrets
   FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > I2-1: an answer on /v1 at the app's port carries the app-wide security headers (nosniff and Referrer-Policy at least)
   FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > pins today: an app-wide onRequest hook sets a header on the app's answers and never runs for /v1, whose answers carry no security header
   Test Files  2 failed (2)
        Tests  4 failed | 25 passed | 3 expected fail (32)
  ```

Every test this run added or changed passes in that run. The gateway's
own suite, alone after the last fix:

```
 Test Files  61 passed (61)
      Tests  644 passed | 1 expected fail | 99 skipped (744)
```
