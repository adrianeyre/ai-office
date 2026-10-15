# Issue #269: [fix] G1-1 — A Gateway Key holder bills its calls to any issue on its Floor, or none — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `cf7a30b`,
`fix(security): G1-1 an Agent's calls count against the issue AI Office gave its work, never one they name`,
on top of `560aad8`. Its blocker, the G1 probe (#195), is in the tree:
`docs/pen-testing/assessments/G1.md`,
`apps/server/src/token-caps/enforcement.pen-test.test.ts` and
`packages/gateway/src/gateway.pen-test.test.ts`.

This is the remediation of finding **G1-1** (`severity:high`, H11). It is
the first of four fixes in this run (G1-1 to G1-4, issues #269, #271,
#273 and #275), which touch the same Gateway handler and are made to
agree; the real output of the checks, run once on the finished tree, is
[below](#real-output-of-the-checks).

## What was fixed

The Gateway took an Agent's issue and pull request from the call's own
`x-ai-office-issue` and `x-ai-office-pull-request` headers (`workOf`), and
Token Caps read them (`capCheck`, `observe`). Code in a sandbox can send
any header, or none. So a sandbox slipped its issue's cap by naming no
issue, escaped its own cap by naming an issue with a higher one, and
paused another Agent by using up its issue's cap.

Now what an Agent's call counts against is the work AI Office gave it,
never what the call names (`packages/gateway/src/work.ts`,
`createAgentWork`):

- **A task's sandbox holds its work.** The sandbox runner holds the issue,
  and its open pull request, for the Agent from the moment it knows them
  until the run ends, finished or failed (`holdWork`,
  `packages/orchestrator/src/sandbox/runner.ts`). Meanwhile every call
  the Agent's key makes counts against them, whatever it names or omits.
- **AI Office's own calls open their work.** A call AI Office makes for an
  Agent outside a sandbox (a review, a Manager's judgement or answer, a
  Fresh Start's summary, the Decision Model's questions, and a call run
  through Claude Code or Codex for a subscription) opens its work and
  sends the token it is given as `x-ai-office-work`. The token is 24
  random bytes, good for that Agent alone, and closed once the Gateway has
  answered (once the tool has run, for a call through an agent tool).
  `gatewayModelClient`, `gatewayDecisionModelClient` and
  `agentToolModelClient` take a `work` option, which the server wires to
  the same registry.
- **Any other call of an Agent's counts against no issue**, so it is held
  to its own, its Floor's or the office's cap. That includes a Gateway
  built without the registry: the default no longer trusts the header.
- **The Communications Agent** is treated as an Agent: nothing is ever
  opened for it, so its calls name no issue.
- **An Owner tool's calls** still bill the numbers they name. An Owner tool
  belongs to no Floor, so no issue's cap counts them.
- `x-ai-office-work` is one of AI Office's headers (`aiOfficeHeaders`), so
  it is never forwarded to an AI Provider, and the request history shows
  it redacted.

The guide says so: `docs/guide/ai-gateway.md` (Gateway Keys,
Attribution), `docs/guide/issue-pipeline.md` (the sandbox's environment)
and `docs/guide/floors-and-agents.md` (Enforcement).

### Sibling paths

- **Every way an Agent's call reaches the Gateway** was checked for where
  its issue comes from: a task's sandbox (held), the Grilling Session's
  fact-finding and the Manager chat's sessions (nothing held, so no
  issue, as before: they named none), the in-process model client, the
  Decision Model's client, and calls through an agent tool (each opens
  its own work). Each is fixed or already named none.
- **What reads the attribution downstream** now reads AI Office's word:
  Token Caps' `check` and `observe`, the request history and analytics'
  issue breakdown (FR-43), prompt-cache keep-alive (which caps-checks its
  pings with the recorded issue) and the request history's "for #4,
  PR #7".

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** All three
      are `it`s in `apps/server/src/token-caps/enforcement.pen-test.test.ts`,
      with their assertions unchanged:
      - "G1-1: an Agent working an issue is refused at the issue's cap,
        whatever its calls name";
      - "G1-1: an Agent is refused at its own cap, whatever issue its
        calls name";
      - "G1-1: one Agent's calls never pause another Agent".
      The probe's `office()` now wires the registry into the Gateway as
      `server.ts` does, and the first test gives the coder #4 as its
      sandbox's runner does (see Decisions, 6).
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** Each pin is now a
      `regression (G1-1)` test asserting the opposite of what it pinned:
      - "the same work, naming no issue, is no longer kept off #4's cap:
        it counts against #4, which pauses the coder" (was: five 200s,
        none of it #4's);
      - "naming #7, the coder no longer spends past its own cap: #7 is
        billed nothing, and the coder is refused and paused";
      - "the coder's calls naming #9 no longer use up its cap: #9 has used
        nothing, and QA, working #9, is served";
      - in `gateway.pen-test.test.ts`, "an Agent's key no longer bills
        whatever issue and pull request its call names, or none: it bills
        the work AI Office gave it".
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `enforcement.pen-test.test.ts`: "naming another issue, or one of
        another Floor's numbers, counts against the issue the Agent works
        too"; "once the sandbox's run has ended, its Agent's calls count
        against no issue".
      - `gateway.pen-test.test.ts`: "without the work AI Office gave, an
        Agent's calls count against no issue, whatever they name"; "AI
        Office's own call bills the work it opened, with its token, for
        its own Agent only and only while it is open" (another Agent
        sending the token, a closed token and a made-up one name nothing;
        the token is never kept or sent on); "an Owner tool's calls still
        bill the issue and pull request they name".
      - `runner.test.ts`: "holds the run's work, its issue and pull
        request, for its Agent at the Gateway while the sandbox runs, and
        ends it with the run" (a failed run ends it too).
      - `client.test.ts` (two), `decision-model/client.test.ts` and
        `agent-tool-client.test.ts` (two): each of AI Office's own clients
        sends its work's token and closes it once answered, and when the
        Gateway cannot be reached or the tool fails.
      - Tests that had an Agent name its issue in a header now give it its
        work as AI Office does: `caps.test.ts`, `keys/keys.test.ts`,
        `decisions.test.ts`, `keep-alive.test.ts`,
        `apps/server/src/gateway-entry.test.ts` and
        `token-caps/enforcement.test.ts` (§5 scenario 5).

      With the Gateway taking an Agent's issue from its headers again (the
      fix undone by hand in `workOf`), eleven tests of the two probe files
      fail: every `it` and regression test above but the two that hold
      either way ("an Owner tool's calls still bill…", and "the issue's cap
      holds while the calls name the issue"):

      ```
      × regression (G1-1): the same work, naming no issue, is no longer kept off #4's cap: it counts against #4, which pauses the coder
      × G1-1: an Agent working an issue is refused at the issue's cap, whatever its calls name
      × G1-1: naming another issue, or one of another Floor's numbers, counts against the issue the Agent works too
      × G1-1: once the sandbox's run has ended, its Agent's calls count against no issue
      × regression (G1-1): naming #7, the coder no longer spends past its own cap: #7 is billed nothing, and the coder is refused and paused
      × G1-1: an Agent is refused at its own cap, whatever issue its calls name
      × regression (G1-1): the coder's calls naming #9 no longer use up its cap: #9 has used nothing, and QA, working #9, is served
      × G1-1: one Agent's calls never pause another Agent
            Tests  8 failed | 2 passed | 10 skipped (20)
      × regression (G1-1): an Agent's key no longer bills whatever issue and pull request its call names, or none: it bills the work AI Office gave it
      × G1-1: without the work AI Office gave, an Agent's calls count against no issue, whatever they name
      × G1-1: AI Office's own call bills the work it opened, with its token, for its own Agent only and only while it is open
            Tests  3 failed | 2 passed | 13 skipped (18)
      ```

      Restored, all pass.
- [x] **The assessment's findings table marks `G1-1` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #269) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` exits 1 on eleven failures, none in a
      file this run changed: ten pre-existing failures of other probes'
      stale pins, and one timeout under load that passes alone. See
      [below](#real-output-of-the-checks).

## Real output of the checks

Run once on the finished tree, at `47eb66f`, after all four fixes of this
run (#269, #271, #273, #275); the other three notes point here.

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
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
exit 0
```

### `pnpm test`: eleven failures, none in what this run changed

```
 FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > G1-8: an Office served beyond localhost does not start with .env.example's public secrets
 FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > pins today: an Office served beyond localhost loads with .env.example's secrets, and the database password is not even named
 FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > I2-1: an answer on /v1 at the app's port carries the app-wide security headers (nosniff and Referrer-Policy at least)
 FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > pins today: an app-wide onRequest hook sets a header on the app's answers and never runs for /v1, whose answers carry no security header
 FAIL  |@ai-office/web| src/scene/idle-behaviours.test.ts > the trip to an idle activity > for each of 21 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > pins today: the compose file says sandboxes reach 'the AI Gateway as app:3047 and nothing else of the stack'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > the compose comment reflects that a sandbox also reaches the app's 3045 and 1455 (S2-3)
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 Test Files  5 failed | 463 passed (468)
      Tests  11 failed | 5220 passed | 54 expected fail | 607 skipped (5892)
exit 1
```

None of the eleven is in a file this run changed, nor reads one
(`git diff --name-only 560aad8` lists nothing under `docker/`, `test/`,
`apps/web/`, `.env.example`, `docker-compose.yml` or `config.ts`). They are
of two kinds:

- **Ten pre-existing failures** of other probes' pins and `it.fails`,
  which went stale when main's one-entry-point merge (#207–#209) and the
  pen-testing fixes changed what they pin (issue-287.md records the same):
  - G1-8's two (`config.pen-test.test.ts`, `ConfigError: AI Office
    cannot start`) and I2-1's two (`gateway-entry.pen-test.test.ts`,
    `expected 'nosniff' to be undefined`, and its `it.fails` now passing:
    `Expect test to fail`). Run at `560aad8`, before this run's first
    commit, these four fail the same way:

    ```
     FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > pins today: an Office served beyond localhost loads with .env.example's secrets, and the database password is not even named
     FAIL  |@ai-office/server| src/config.pen-test.test.ts > G1-8 (H16): the public sample secrets > G1-8: an Office served beyond localhost does not start with .env.example's public secrets
     FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > I2-1: an answer on /v1 at the app's port carries the app-wide security headers (nosniff and Referrer-Policy at least)
     FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > pins today: an app-wide onRequest hook sets a header on the app's answers and never runs for /v1, whose answers carry no security header
     Test Files  2 failed (2)
          Tests  4 failed | 25 passed | 3 expected fail (32)
    ```

  - I1's six (`supply-chain.pen-test.test.ts`,
    `documentation-drift.pen-test.test.ts`) read only the Dockerfiles,
    `docker-compose.yml` and `.env.example`, which are as they were at
    `560aad8`: the app image now starts from `docker:…-cli`, and the
    compose comment and `.env.example` no longer say what the pins quote.
- **One timeout under load.** `idle-behaviours.test.ts` timed out at
  30,000 ms; the host's load average was over 30. Run on its own it
  passes:

  ```
   Test Files  1 passed (1)
        Tests  45 passed (45)
  ```

Every test this run added or changed passes in that run.

## Decisions

1. **A registry of work, not signed headers or a key per task.** The
   alternatives:
   - an HMAC over the issue in the sandbox's headers stops a sandbox
     naming another issue, but not naming none, and a sandbox can replay
     a signature from an earlier task;
   - a Gateway Key per task, naming its issue, would also end a sandbox's
     key with its run (G1-4), but ADR 0001 says each Agent gets its own
     key, "created with the Agent", and sandboxes receive "that key";
     that is a new decision, not this fix's;
   - following `sandbox.started` and `sandbox.stopped` on the event bus
     needs no runner change, but the event carries no pull request.
   The runner already knows both the issue and its pull request when it
   asks for the key, so it holds them there.
2. **AI Office's own calls carry a one-time token.** The Manager and the
   reviewers can make several calls at once for different issues, so the
   Agent's held work cannot say which issue each is for. A token per
   call, closed once answered, is good only for the Agent it was opened
   for. The token of a call through an agent tool is in that container's
   environment while it runs (Claude Code's `ANTHROPIC_CUSTOM_HEADERS`,
   Codex's `AI_OFFICE_WORK`); it names only that call's own issue and
   ends with the run. `AI_OFFICE_WORK` was not added to the task
   sandbox's allow-list: a task's sandbox never has a token.
3. **A token beats held work.** A Fresh Start's summary or a review made
   while the Agent's sandbox runs counts against the work it was opened
   for; anything else of the Agent's counts against its sandbox's issue.
4. **Owner tools keep naming their issue.** It is the Owner's word, and an
   Owner tool has no Floor, so no issue's cap reads it.
5. **Sandboxes still send `x-ai-office-issue` and its kin.** They are read
   only from an Owner tool now. Leaving the sandbox's environment as it
   was keeps the change small; removing them is a clean-up for later.
6. **The probe tests were given the work AI Office gives.** The probe's
   `office()` wires the registry into the Gateway as `server.ts` does.
   "an Agent working an issue is refused at the issue's cap, whatever its
   calls name" and the regression tests beside it hold the coder's #4 (and
   QA's #9) as the sandbox's runner would; the property is about an Agent
   working an issue, which the probe said only in its comment. No
   assertion was changed. "the issue's cap holds while the calls name the
   issue" holds #4 too, since naming it no longer bills it.
7. **The Communications Agent is treated as an Agent.** Nothing opens work
   for it, so its calls count against no issue, as its records had none.

## Noticed, out of scope

- **`x-ai-office-session` is still the caller's word.** The assessment
  found it holds: a session is keyed under the caller's key, so naming
  one moves only its own stickiness and Context Usage (FR-84).
- **An issue's cap counts every Agent's tokens on the issue** (FR-32), so
  a reviewer's real review of #9 still uses #9's cap, and can pause the
  coder working it. That is the design; what is fixed is billing an issue
  AI Office did not give.
- **Request history rows from before the fix** keep whatever issue their
  callers named.

## What could not be verified here

There is no Docker here and no live model. Not tried:

- From a real coder's sandbox, `curl` to `sandbox-relay:3047` with its own
  `ANTHROPIC_AUTH_TOKEN`, naming another issue and none, and reading the
  request history and the Floor's caps.
- That Claude Code sends `x-ai-office-work` from `ANTHROPIC_CUSTOM_HEADERS`
  and Codex from `env_http_headers` (`AI_OFFICE_WORK`) on a subscription
  call through the agent tool; both are built as the existing headers
  are, which those tools already send.
- The Postgres stores: their tests are skipped here without Docker. The
  registry is in memory, and the stores are unchanged.
