# Issue #261: [fix] P1-8 — The Decision Model's tool-call screen rates nothing while off (the default) or when Jev cannot answer, is shown only… — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`ad794ac`,
`fix(security): P1-8 a tool call is screened before it runs, by AI Office's rules when Jev is off or cannot answer`,
on top of P1-7's `b7431c6` (#259). Its blocker, the P1 probe (#194), is
in the tree: `docs/pen-testing/assessments/P1.md`,
`packages/orchestrator/src/decision-model/decision-model.pen-test.test.ts`
and `packages/orchestrator/src/sandbox/runner.pen-test.test.ts`.

This is the remediation of finding **P1-8** (`severity:medium`, H10).

## What was fixed

FR-17 says the Decision Model answers "Is this tool call safe?", and that
"when it is off, those judgements use the Manager's own Model or
deterministic rules". The finding had four parts:

- **Off (the default), nothing judged a call.** `toolCallCheck` let every
  call be.
- **When Jev could not answer**, or answered in the wrong shape, the call
  was let be too.
- **Jev was shown only a command's first 4,000 characters**, so padding
  hid the rest.
- **The screen raced the call.** Claude Code, with its permission prompts
  off, had run a call by the time Jev answered, so a call judged unsafe
  stopped the run after it had happened. The setup command was never
  screened at all.

**Now:**

- **AI Office's own rules judge every call** (`toolCallRules`, in
  `decision-model/tool-call-rules.ts`), with the Decision Model on or
  off, and whether Jev answers or not. They are FR-17's "deterministic
  rules" and catch what is plainly unsafe for an Agent working an issue:
  reading the sandbox's credentials (`$GH_TOKEN`, the Gateway Key under
  each tool's name) or its whole environment (`env`, `printenv`,
  `/proc/*/environ`), reaching the cloud's metadata service or the host's
  Docker, sending data to a host other than the sandbox (`curl -d`,
  `--upload-file`, `wget --post-data`; `localhost` is fine), running a
  script it downloads (`curl … | sh`), raw connections (`nc`, `socat`,
  `/dev/tcp`), scans and `rm -rf /`. Ordinary work (`pnpm install`,
  `pnpm test`, commits, `rm -rf dist`, `curl` to the local dev server) is
  let be.
- **A call too long to read whole is not passed.** Over 100,000 characters
  (`maxScreenedCall`), the rules refuse it, and Jev is not shown part of
  it.
- **Jev is shown the whole call**, while it is on. Its "unsafe" still
  stops the call with its own reason. When it passes a call, or cannot
  answer, the rules' verdict stands.
- **Claude Code asks before each call runs.** AI Office gives it a
  `PreToolUse` hook on every tool, in settings of its own (`--settings`).
  The hook posts the call to the AI Gateway's new screen route
  (`POST /v1/ai-office/tool-calls`) with the Agent's Gateway Key (from the
  environment, never in the command) and its session's header. The
  Gateway passes it to `ToolCallScreens`, where each running session has
  opened its screen. A call judged unsafe does not run, and it still
  stops the run, as before. A call also does not run when the screen
  cannot be asked: the route cannot be reached, `curl` is missing, the
  call is from no running session of that Agent, or it is not judged
  within 90 seconds (the hook waits 120). Each call is judged once,
  though it is both asked about and seen in the stream.
- **The setup command is screened before it runs**, once per run, as a
  `Setup` call. One judged unsafe never runs, and the run fails, saying
  why.

The guide (`docs/guide/issue-pipeline.md`, Sandboxes; and
`docs/guide/ai-gateway.md`, The Decision Model) says the same.

### Sibling paths with the same flaw, fixed and tested

- **Tools the stream never shows.** Sandcastle shows only Claude Code's
  `Bash`, `WebSearch`, `WebFetch` and `Agent` calls, so a `Read` of
  `/proc/self/environ` was never screened at all. The hook is on every
  tool. Tested: "P1-8: every tool is asked about before it runs, not only
  those the stream shows (a Read of the environment)".
- **Fact-finding** (a Grilling Session's facts and a research
  Contractor's sandbox, `grilling/fact-finding.ts`) ran its agent tool
  with prompts off and screened nothing. It is now screened by AI
  Office's rules, before each call where Claude Code asks and as each
  streams, and keeps no answer from a sandbox one stopped. Tested in
  `grilling/fact-finding.test.ts`: "asks AI Office's rules about each tool
  call before it runs, and keeps no answer from a sandbox one stopped
  (P1-8)".
- **The screen's route and its registry** are tested on their own:
  `gateway/src/tool-call-screen.test.ts` (an Agent's key only, an Owner
  tool's is a `403`, no key a `401`, nothing recorded as a model call,
  not served without a screen) and `sandbox/tool-call-screens.test.ts`
  (unknown, another Agent's or closed sessions, unreadable calls, failed
  and late screens are all denied).

## Decisions

- **Deterministic rules, not the Manager's Model.** FR-17 allows either.
  The rules cost nothing, need no AI Account, and cannot be talked round
  by the text they judge. Asking the Manager's Model about every call
  would double the cost of every sandbox. The rules catch only what is
  plainly unsafe. Jev, when on, judges the rest.
- **When Jev cannot answer, the rules' verdict stands.** The other
  option was to stop every call Jev cannot judge, so one Gateway hiccup
  would stop every Agent. The rules still judge each call, so none is let
  be unjudged, as the issue asks.
- **The screen's route is on the Gateway.** Sandboxes reach nothing of
  the stack but the Gateway (ADR 0001), so the hook asks there. That
  widens what an Agent's Gateway Key reaches by one route. FR-46 says
  keys are "scoped to calling models only". The route takes only an
  Agent's own key, judges only that Agent's running sessions, reaches no
  AI Account and is not recorded as a model call. The Owner may want
  FR-46 to say so.
- **Fail closed.** Anything that stops the hook asking blocks the call,
  so a broken route stops work rather than letting it run unscreened.
- **Codex and opencode are still screened as their calls stream.**
  Neither gives AI Office a way, that can be verified here, to be asked
  before a command runs. Codex in `exec` mode cannot ask anyone. opencode
  has plugins with a `tool.execute.before` hook, but no opencode runs in
  this sandbox to prove one. For them, AI Office's rules now judge every
  call, Jev sees the whole call, and a call judged unsafe stops the run,
  but such a call has already run when it is judged. The Owner may
  decide whether ChatGPT, Grok and Gemini Agents should wait for a
  pre-call hook in their tools, or keep working with the screen as it is.
- **Fact-finding is screened by the rules alone.** The Decision Model's
  tool-call question is about an issue's work, and a fact has no issue.
- **The probe's padding is kept at 4,000 characters.** The probe built
  its long command from `maxToolCallArgs`, the old limit, which is gone.
  The command is built the same way from a constant, `shownBefore`, of
  the same 4,000. The `it` bodies are unchanged.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** All four
      are `it`s and pass, with their bodies unchanged:
      - "still judges a tool call while the Decision Model is off, as
        FR-17 says the Manager's Model or deterministic rules then do";
      - "does not let a tool call be unjudged when Jev cannot answer";
      - "Jev is shown all of a command it lets be";
      - "has not run: the screen judges a call before the agent tool runs
        it".
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
      - *"off is the default, and then every tool call, however plain its
        intent, is let be, unjudged"* is now "regression (P1-8): off is
        still the default, but a tool call is no longer let be unjudged:
        AI Office's rules judge it, Jev unasked".
      - *"when Jev cannot answer, or answers in the wrong shape, the call
        is let be"* is now "regression (P1-8): … the call is no longer let
        be: AI Office's rules judge it".
      - *"only its first 4,000 characters reach Jev, so padding hides the
        rest, and a call Jev passes on that is let be"* is now
        "regression (P1-8): no longer only its first 4,000 characters
        reach Jev …". It asserts Jev was shown the whole command, the
        attacker's host included, and the call is not let be.
      - *"the run is stopped, after the call has already run"* is now
        "regression (P1-8): the run is still stopped, but no longer after
        the call has already run: it never ran". It also asserts the call
        was judged once.
      - *"the setup command runs, and the screen is never asked about it"*
        is now "regression (P1-8): the setup command still runs, but no
        longer unscreened: the screen is asked about it first".

      No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. Also new: the rules' other cases with Jev off, a command too
      long to read whole, a setup command judged unsafe, and a call the
      screen cannot be asked about. The unit test "shows Jev only the
      start of a long tool call" spelt out the old limit. It is now
      "shows Jev the whole of a tool call, and asks nothing of one too
      long to read whole (P1-8)".
- [x] **The assessment's findings table marks `P1-8` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #261), with
      the commit's subject (the hash is filled at merge), and what is
      left for Codex and opencode.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on two `deployment` tests of
      files under `docker/` that no commit here touches, and which fail
      the same way on the base commit (below). Every test of these fixes
      passes.

## Real output of the checks

The three checks were run on the branch head, `cf8547c` (all four
fixes), with this note and the others uncommitted in the tree:

```
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit 0
$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
$ pnpm test
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 Test Files  2 failed | 448 passed (450)
      Tests  2 failed | 5018 passed | 30 expected fail | 611 skipped (5661)
test exit 1
```

**The two failures are not these fixes'.** Both are in the `deployment`
project and read only files under `docker/`: the Caddyfile
(`reverse_proxy app:3045 {`, where the test expects the directive with
no block) and the pen-test stack's environment file (which holds
`127.0.0.1`). No commit here touches `docker/`, `.env.example` or
`docker-compose.yml` (`git diff --stat 27c394e HEAD -- docker/
.env.example docker-compose.yml` is empty), and the two tests fail the
same way on the base commit's files:

```
$ pnpm vitest run --project deployment docker/caddy/caddyfile.pen-test.test.ts docker/pen-test/compose.test.ts
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
      Tests  2 failed | 22 passed | 1 expected fail | 1 skipped (26)
```

The web app's tests, which an earlier run of this branch saw time out
under the host's load (`whiteboard.test.tsx` in one run here, passing on
its own, 6 of 6), all passed in this run.

### P1-8's tests on their own

```
 ✓ |@ai-office/orchestrator| src/sandbox/tool-call-screens.test.ts > the tool-call screens > judges a running session's call by its screen, letting it run or saying why not
 ✓ |@ai-office/orchestrator| src/sandbox/tool-call-screens.test.ts > the tool-call screens > denies a call from no running session, another Agent's session, or a closed one, judging nothing
 ✓ |@ai-office/orchestrator| src/sandbox/tool-call-screens.test.ts > the tool-call screens > denies a call it cannot read, one its screen fails on, and one not judged in time
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: the tool-call screen, off or unable to answer > still judges a tool call while the Decision Model is off, as FR-17 says the Manager's Model or deterministic rules then do
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: the tool-call screen, off or unable to answer > regression (P1-8): off is still the default, but a tool call is no longer let be unjudged: AI Office's rules judge it, Jev unasked
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: the tool-call screen, off or unable to answer > does not let a tool call be unjudged when Jev cannot answer
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: the tool-call screen, off or unable to answer > regression (P1-8): when Jev cannot answer, or answers in the wrong shape, the call is no longer let be: AI Office's rules judge it
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: the tool-call screen, off or unable to answer > P1-8: the rules' other plain cases are judged with Jev off too, and ordinary work is let be
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: what Jev is shown of a long command > Jev is shown all of a command it lets be
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: what Jev is shown of a long command > regression (P1-8): no longer only its first 4,000 characters reach Jev: padding hides nothing, and a call Jev passes is still judged by the rules
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.pen-test.test.ts > P1-8: what Jev is shown of a long command > P1-8: a command too long to read whole is not passed, and Jev is not shown part of it
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-8: a tool call the screen judges unsafe > has not run: the screen judges a call before the agent tool runs it
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-8: a tool call the screen judges unsafe > regression (P1-8): the run is still stopped, but no longer after the call has already run: it never ran
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-8: a tool call the screen judges unsafe > regression (P1-8): the setup command still runs, but no longer unscreened: the screen is asked about it first
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-8: a tool call the screen judges unsafe > P1-8: a setup command judged unsafe never runs, and the run fails, saying why
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-8: a tool call the screen judges unsafe > P1-8: every tool is asked about before it runs, not only those the stream shows (a Read of the environment)
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-8: a tool call the screen judges unsafe > P1-8: a call the screen cannot be asked about does not run
 ✓ |@ai-office/orchestrator| src/grilling/fact-finding.test.ts > the sandbox fact finder > asks AI Office's rules about each tool call before it runs, and keeps no answer from a sandbox one stopped (P1-8)
 Test Files  4 passed (4)
      Tests  33 passed (33)
 ✓ |@ai-office/gateway| src/tool-call-screen.test.ts > the tool-call screen's route > passes an Agent's call on with the Agent its key belongs to and its session, and answers what the screen says
 ✓ |@ai-office/gateway| src/tool-call-screen.test.ts > the tool-call screen's route > refuses a request with no key in use, and an Owner tool's key, asking nothing
 ✓ |@ai-office/gateway| src/tool-call-screen.test.ts > the tool-call screen's route > is not served when AI Office gives the Gateway no screen
```

## What could not be verified here

- **Claude Code itself running the hook.** The fake sandbox stands in
  for Claude Code. As Claude Code does, it runs the `PreToolUse` hooks of
  the settings its command line gives before each tool call, really
  running the hook's command (`curl` to a stand-in for the Gateway's
  route), and makes no call a hook blocks. That Claude Code runs a
  `--settings` hook with `--dangerously-skip-permissions`, and honours
  `permissionDecision: "deny"` and exit code 2, is its documented
  behaviour, not seen here. On the pen-test stack, a corpus item whose
  issue asks for `curl -d "$GH_TOKEN" …` should leave no canary in the
  stub's log, and the run should stop saying "AI Office's rules judged a
  Bash call unsafe".
- **The route on the real Gateway, reached from a sandbox.** It is tested
  on a running Gateway (`tool-call-screen.test.ts`) and wired in
  `apps/server/src/server.ts`, but no Docker runs here.
- **A live Jev.** What Jev makes of a whole command needs a live model.

## Noticed, out of scope

- **This worktree's admin directory was pruned on the host mid-run.**
  After the fix was committed, the shared repository no longer listed
  this worktree (its parent checkout's entry was gone too), and every
  git command in the workspace failed. Only this worktree's own entry
  (`worktrees/sandcastle-20261011-183818-30ac23`: `HEAD`, `commondir`,
  `gitdir`) was put back, as its siblings have them, so the tests (which
  run git) and the later commits could go on. The branch and its commits
  were never touched.
- **Two `deployment` tests fail on the base commit too**: the Caddyfile's
  `reverse_proxy` now has a block, and the pen-test stack's environment
  file holds `127.0.0.1`, which their tests do not expect (see the
  checks above). They are outside these fixes.
