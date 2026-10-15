# Issue #121: Fresh Starts for sandbox Agents, automatic and manual — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

The blockers are built on this branch:

- #24, the sandbox runner ([`issue-24.md`](issue-24.md)): one Agent's task
  in a Sandcastle sandbox, on the issue's branch, its model calls naming the
  run as their session. The Fresh Start loop lives in it.
- #27, Notices ([`issue-27.md`](issue-27.md)): the action Notice raised at
  the cap.
- #120, Context Usage ([`issue-120.md`](issue-120.md)): each session's
  Context Usage, which the threshold watches.

## What was built

- **Thresholds** (migration `0048_context_usage_skills_and_grilling`,
  PRD FR-86):
  - `floors.fresh_start_threshold`: 85 by default.
  - `agents.fresh_start_threshold`: null uses the Floor's.
  - Both are whole percentages from 10 to 100, checked in the schema
    (`freshStartThresholdSchema`) and the database. Both are in the API
    (`PATCH /api/floors/:floorId`, `PATCH …/agents/:agentId`, with
    `config.changed`) and in the admin forms: the Floor's **Settings**, and
    the Agent editor (empty is the Floor's).
- **The service** (`createFreshStarts`,
  `packages/orchestrator/src/context/fresh-start.ts`):
  - `watch(session)`: due once the session's Context Usage, in whole
    percent, reaches the Agent's threshold. That is its own, else its
    Floor's, else 85. Only that session's calls count, and it is checked
    on every call.
  - `request(floorId, agentId)`: due at once, with the session's current
    Context Usage. It answers the session being ended, or nothing when
    none is going.
  - `summarise(input)`: the Agent's own Model (FR-89), through the AI
    Gateway with the Agent's Gateway Key, attributed to the issue, and
    naming the ended session (so it changes no Context Usage). It must
    match `freshStartSummarySchema` (`done`, `inProgress`, `nextSteps`,
    `decisions`, `filesTouched`, each a bounded list of strings). A
    non-matching answer is asked for once more with what was wrong (the
    reviewers' `parseAnswer` pattern), then it fails. Credentials are
    redacted from it.
  - `escalate(…)`: pauses the Agent (`enabled: false`, with
    `config.changed`) and raises an action Notice.
- **The runner** (`packages/orchestrator/src/sandbox/runner.ts`). Each
  sandbox is one session, and a Fresh Start goes:
  1. When the watch is due, work not yet committed in the worktree is
     committed (`chore: save work in progress for a Fresh Start`, as the
     Floor's Git identity, best effort). Then the sandbox is stopped, and
     `sandbox.stopped` gets the new outcome `fresh_start`.
  2. The summary is asked for, from the session as AI Office recorded it:
     Claude Code's own text and tool calls, read from its stream lines (as
     Sandcastle holds text back until a tool call it shows), otherwise
     Sandcastle's events. With it go the branch's commit subjects and
     changed files.
  3. `agent.fresh_start` is published (trigger `threshold` or `manual`,
     and the Context Usage). A new sandbox, with a new session id, starts
     in the same clone on the same branch. Sandcastle reuses the branch's
     worktree. Its prompt is the issue's prompt plus a "Fresh Start N of
     at most 3" section with the summary.

  `SandboxRun` gains `freshStarts` and `escalated`. Its `commits` are
  every session's, and its `usage` is the sum. When one more Fresh Start
  than the cap (3) is due, `escalate` runs and the run ends with
  `escalated: true` and its commits kept.
- **The flows** (coder, QA, docs). An escalated run pushes what was
  committed and lets the issue go. The status is `paused` ("… was paused
  after 3 Fresh Starts"), and the work goes back in the queue, as at a
  Token Cap.
- **The action** (`POST /api/floors/:floorId/agents/:agentId/fresh-start`,
  for the Agent card and monitor). It answers 202 `{ session }`, or 409
  `no_session` when the Agent has no sandbox session going. It answers 404
  for an Agent or Floor that does not exist.
- The server wires one `FreshStarts` into the sandbox runner and the API.
  The README has a Fresh Starts section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Their output
  is below. Postgres cases skip without Docker, as before.
- [x] **Scenario test with a fake agent: crossing 85% triggers a Fresh
  Start that resumes on the same branch with the summary.**
  `packages/orchestrator/src/sandbox/fresh-start.test.ts` runs real
  Sandcastle with the fake sandbox provider and a bare repository. In
  session 1, the fake agent:
  - commits `model.txt` and leaves `view.txt` half written;
  - makes calls of 120,000 and then 172,000 tokens of 200,000, told to
    Context Usage with the session its sandbox was given.

  At 86%, the session ends. The test then checks:
  - The coder's Model was asked, naming the ended session, with the
    session's text, the commit and the changed files.
  - Session 2's prompt starts with the issue's prompt and holds "Fresh
    Start 1 of at most 3" and every part of the summary.
  - Session 2 found `view.txt` as left (saved in a commit), and finished.
  - The branch has the three commits.
  - The events: one `agent.fresh_start` (`threshold`, 0.86); two
    sandboxes on the same branch; stopped outcomes `fresh_start` then
    `finished`; and the ended session's Context Usage cleared.
- [x] **Manual action works mid-task.**
  - The scenario file's second case calls `request` while session 1 runs
    (at 25%). That session ends, `agent.fresh_start` has trigger `manual`
    and 0.25, and session 2 resumes with the summary and the uncommitted
    file.
  - Before the run, `request` finds no session.
  - `apps/server/src/context-usage/routes.test.ts` checks the API: 202
    with the session, 409 `no_session`, 404 and 401.
- [x] **The fourth Fresh Start escalates instead.** The scenario file's
  third case has every session cross the threshold:
  - three Fresh Starts are made (three summaries, three
    `agent.fresh_start`, four sandboxes);
  - when the fourth is due, the Agent is disabled (`config.changed`
    `enabled`) and one action Notice is raised ("Fresh Start cap reached:
    … is paused on #4 after 3 Fresh Starts …");
  - the run ends `escalated` with all four sessions' commits.

  `packages/orchestrator/src/coder/coder.test.ts` checks the coder flow
  with an escalated run. Its commits are pushed, no pull request is
  opened, the issue stays at `needs-code` and is let go, the work is
  queued again, and the status is `paused` with the reason. No "Agent
  blocked" Notice is raised.
- Also unit-tested (`packages/orchestrator/src/context/fresh-start.test.ts`):
  - the threshold's edge (169,999 tokens not due, 170,000 due), and the
    Floor's and the Agent's own thresholds;
  - another session's calls not counting;
  - the summary's retry, its failure and its redaction;
  - both prompts, and reading Claude Code's stream lines.

### Verified on the host

- [ ] **A long real coder run Fresh-Starts and still completes its issue.**
  This needs Docker, Claude Code, a real AI Account and #18's App and
  sandbox repository.

## Not verifiable in this sandbox

- **Real Docker sandboxes.** In the fake provider the worktree is the
  host's, as with Docker's bind mount. Three things only the host can show:
  - that stopping a real container leaves the branch's commits in the
    clone (Sandcastle removes the worktree, not the branch);
  - that `git commit` on the host can save files a container wrote (owner
    and permissions);
  - that the next container picks the branch up.
- **A real agent tool's stream.** The transcript reads Claude Code's
  `stream-json` lines. Codex's and opencode's sessions give Sandcastle's
  text and tool-call events only, which may hold back the last text before
  the session ended.
- **A real Model writing the summary.** It was answered by the fake model.
  Whether real Models keep to the schema is for the host run. One retry is
  allowed.
- **Postgres:** the new columns and their checks (migration 0043) run in
  the stores' Postgres cases, which skip without Docker.
- **A browser:** the threshold fields were checked through the DOM in
  component tests only.

## Notes

- **Order of the three steps.** The issue asks the Agent for its summary,
  then ends the session. An agent tool running headless in a sandbox
  (`claude -p`, `codex exec`, `opencode run`) cannot be asked another
  question mid-run. So the agent tool is stopped first, and the Agent's
  own Model, with its own Gateway Key, writes the summary from the session
  as AI Office recorded it. This keeps FR-89 ("written by the Agent's own
  Model"). The PRD and the issue were not changed.
- **Work in progress is committed.** Stopping a sandbox loses files the
  Agent had not committed, as Sandcastle force-removes the worktree on
  abort. So they are committed first, and pushed with the rest
  (authorship rewritten to the Owner with the `Agent:` trailer, ADR 0002).
- **A failed summary fails the run.** When the second answer does not
  match the schema either, the run fails like any sandbox failure: the
  Agent is blocked with an action Notice. As with other sandbox failures,
  that run's commits are not pushed.
- **The cap is per task.** It counts one `runner.run`, which is one piece
  of work. Manual Fresh Starts count too. After the Owner resumes the
  Agent, the task starts again with a fresh count. As with any Agent
  paused in its editor, the work queue may give the waiting work to
  another Agent of the Role meanwhile.
- **Decision Model.** Summaries are written by the Agent's Model only.
  The Decision Model option arrives with #109, as the issue says.
- **Out of scope:** the Manager chat's `/clear` and `/compact` (#122), the
  3D buttons (#72), and the bar's animation when a Fresh Start empties it
  (the 3D Office). The live view shows the stopped sandbox as "stopped for
  a Fresh Start", and the Activity Feed shows each `agent.fresh_start`.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  236 passed (236)
      Tests  2760 passed | 366 skipped (3126)
   Duration  105.81s (tests 52%, import 32%, transform 9%, environment 6%, setup 1%)
```

The issue's own tests (`vitest run --reporter=verbose`):

```text
✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > watching a session > is due once Context Usage reaches the default 85%, not before 14ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > watching a session > uses the Floor's threshold, and the Agent's own over it 3ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > watching a session > is not due for another session's calls, or once closed 1ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > watching a session > is due at once by hand, with the session's Context Usage 1ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > the summary > is written by the Agent's own Model, against the session that ended 3ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > the summary > is asked for once more when it does not match the schema 2ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > the summary > fails when the second answer does not match either 1ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > the summary > has credentials removed before it reaches a prompt 1ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > the prompts > gives the Model the branch's commits and files and the end of the session 1ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > the prompts > starts the next session with the issue and the summary 0ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > the prompts > names why a flow's Agent was paused 0ms
 ✓ |@ai-office/orchestrator| src/context/fresh-start.test.ts > transcriptLines > reads Claude Code's text and tool calls, and nothing else 0ms
 ✓ |@ai-office/orchestrator| src/sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > makes a Fresh Start when Context Usage crosses 85%, resuming on the same branch with the Agent's summary 281ms
 ✓ |@ai-office/orchestrator| src/sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > makes a Fresh Start by hand mid-task 206ms
 ✓ |@ai-office/orchestrator| src/sandbox/fresh-start.test.ts > Fresh Starts in the sandbox runner > escalates at the fourth Fresh Start: the Agent is paused and the Owner gets an action Notice 388ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > GET /api/floors/:floorId/context-usage > lists each Agent with a session going and its Context Usage, from the requests the Gateway recorded 150ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > GET /api/floors/:floorId/context-usage > shows a Model with no context window in the catalogue as unknown, not 0% 68ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > GET /api/floors/:floorId/context-usage > answers 404 for a Floor that does not exist, and 401 signed out 31ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > POST /api/floors/:floorId/agents/:agentId/fresh-start > makes a Fresh Start of the Agent's session at once, answering with the session being ended 30ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > POST /api/floors/:floorId/agents/:agentId/fresh-start > answers 409 when the Agent has no sandbox session going 21ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > POST /api/floors/:floorId/agents/:agentId/fresh-start > answers 409 without Fresh Starts, 404 for an Agent or Floor that does not exist, and 401 signed out 23ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > contextWindowOf > reads a Model's context window from its AI Provider's catalogue, at most once a minute 1ms
 Test Files  3 passed (3)
      Tests  22 passed (22)
 ✓ |@ai-office/orchestrator| src/models/client.test.ts > gatewayModelClient > names the session a call belongs to, when it has one (a Fresh Start's summary) 14ms
 ✓ |@ai-office/orchestrator| src/floors/floors.test.ts > Floors, kept in memory > changes settings, recording which ones changed 3ms
 ✓ |@ai-office/orchestrator| src/coder/coder.test.ts > the coder flow > pauses at the Fresh Start cap: pushes what the Agent committed, lets the issue go and queues the work again 226ms
 ✓ |@ai-office/web| src/floors.test.tsx > the Floor admin page > sets the Floor's Fresh Start threshold, and an Agent's own over it (PRD FR-86) 284ms
 Test Files  4 passed (4)
      Tests  60 passed | 13 skipped (73)
```

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `97de0fe`, after merging `feat/issues-110-130-b` into the
integration branch (`d5ae18f`) and its follow-ups: `1b5254a`
(configuration export and import carry Fresh Start thresholds) and
`97de0fe` (a Kickoff acknowledgement is no working context).

- **Migrations.** The integration branch keeps `0044_retention` to
  `0047_connection_delivery_retention`. This branch's
  `0044_context_usage_and_fresh_starts`, `0045_manager_chat_skills`,
  `0046_grilling_sessions` and `0047_manager_chat_compaction` are replaced
  by one regenerated `0048_context_usage_skills_and_grilling`, which this
  file now names. `drizzle-kit generate` finds nothing more to generate.
  It has not been applied to a real Postgres here (no Docker).

- **Configuration export and import** (#113) now carry the Fresh Start
  thresholds: the Floor's with its other settings, and each Agent's own
  (null for its Floor's). The round trip sets both away from their
  defaults (`1b5254a`).
- **Idle behaviours** (#110) are not set off by a Fresh Start: the
  Agent's status stays `working` while one sandbox stops and the next
  starts, so it never has a "finished" moment to stretch in.

### Output of the checks

```text
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  279 passed (279)
      Tests  3179 passed | 448 skipped (3627)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 448 skipped tests need what the sandbox lacks: Postgres 18 and
Mailpit through Testcontainers (Docker), Docker, hadolint or Caddy for
the deployment, or the real GitHub App. They run on the host and in CI.

The Fresh Start and configuration tests:

```text
 Test Files  4 passed (4)
      Tests  25 passed | 5 skipped (30)
```
