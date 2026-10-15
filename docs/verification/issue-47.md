# Issue #47: Agent config editor — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`ae5becf`).

## What was built

### The API (`PATCH /api/floors/:floorId/agents/:agentId`, FR-11, FR-12)

- **What it takes.** Any of these, at least one, and nothing else
  (`updateAgentRequestSchema` in `packages/shared/src/agents.ts`):
  - `name`: trimmed, 1 to 40 characters, one line;
  - `aiProvider`: Claude, ChatGPT, Grok or Gemini;
  - `modelOverride`: a Model name, or null for the AI Provider's default;
  - `effort`: a level, or null for the default;
  - `extraInstructions`: up to 4,000 characters;
  - `enabled`: false pauses the Agent.
- **What it checks** (`Agents.update` in
  `packages/orchestrator/src/agents/agents.ts`):
  - the name is unique on the Floor: `409 agent_name_taken`. The store
    checks again, and in Postgres the existing `agents_floor_name_unique`
    constraint is read as the same refusal, so a racing request cannot
    slip a duplicate in.
  - a new AI Provider has a default Model: `400 model_required`, as for
    adding an Agent (#46).
  - a new Model override is in that AI Provider's catalogue:
    `400 model_not_in_catalogue`. One chosen before it left the
    catalogue is kept while other settings change.
  - the effort is one the AI Provider's agent tool takes
    (`aiProviderEfforts`): Claude Code `low`, `medium`, `high`, `xhigh`,
    `max`; Codex `minimal`, `low`, `medium`, `high`; opencode (Grok,
    Gemini) none. Anything else is `400 effort_not_supported`.
  - the Floor is in use (`409 floor_archived`, `404 floor_not_found`)
    and has the Agent (`404 agent_not_found`).
- **Moving to another AI Provider** without naming a Model or effort
  resets both to that AI Provider's defaults: another's Model means
  nothing to it.
- **Events.** Each change is a `config.changed` event (scope `agent`,
  with the Floor and Agent) naming the settings that changed, never their
  values. A request that changes nothing publishes nothing. The server's
  log line names the settings, not the values: extra instructions are the
  Owner's own words.
- **From the next task.** The coder flow already reads the Agent from the
  store when each task starts (AI Provider, Model, effort, extra
  instructions), and the work queue gives new work only to enabled
  Agents. So a change applies from the Agent's next task, and work
  already started carries on as it began.

### The editor (`apps/web/src/agent-editor.tsx`)

- **Edit** beside each Agent in the Floor admin's Agents table opens the
  editor below the table. An archived Floor offers none.
- Fields: Name; Status (Enabled or Paused); AI Provider, with those that
  have no default Model offered but disabled ("(no default Model yet)");
  Model, "Default (`<the AI Provider's default>`)" or one of that AI
  Provider's catalogue Models (a kept, unlisted override shows as "(not
  in the catalogue)"); Effort, disabled with a note where the agent tool
  takes none; Extra instructions.
- Choosing another AI Provider sets Model and Effort back to its
  defaults. Only what changed is sent.
- **Pronouns (FR-14).** `pronounsOf(avatar)` (shared) gives he/him/his,
  she/her/her or they/them/their from the Avatar's presentation. The
  editor uses them: "Changes apply from her next task; work she has
  started carries on as it began", "While paused, no new work goes to
  them", "Saved. Ada uses the changes from his next task."
- Refusals are shown as the API words them.

### The test seam for the end-to-end tests

- `startOffice(env, { sandboxRunner })` runs Agents' tasks with the given
  runner in place of Docker sandboxes; Agents then work issues whenever
  the GitHub App is configured. `RunningOffice` also exposes `intake`.
  Production (`main.ts`) passes nothing, so nothing changes there.
- `e2e/server/main.ts` gives it a stand-in runner that records each task
  (Agent, issue, AI Provider, Model, effort) and fails it ("The
  end-to-end tests' sandboxes run nothing."). Two new IPC commands:
  `office.pollIntake()` and `office.sandboxTasks()`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). Without Docker: 1126 passed, 211 skipped (the
      Postgres tests, with the reason). Against an embedded Postgres 18:
      1322 passed, 15 skipped.
- [x] **Playwright: change an Agent's AI Provider and Model; the next task
      uses them.** `e2e/tests/agent-editor.spec.ts` passed in headless
      Chromium against the built app, Postgres 18 and a fake GitHub (see
      "How Postgres and Chromium were run here"). It:
      1. adds an xAI API key whose custom endpoint is a fake xAI listing
         `grok-4` and `grok-4-fast`, refreshes the model catalogue
         ("Grok (API key): 2 Models.") and chooses `grok-4` as Grok's
         default, all in Admin;
      2. adds the Floor, opens the coder's editor, chooses Grok and
         `grok-4-fast`, saves, and sees "Grok grok-4-fast" in the table,
         also after a reload;
      3. opens an issue labelled `ai-office` on the fake GitHub and runs
         intake: the stand-in runner is given exactly
         `{ agentId: <the coder>, issue: 1, aiProvider: "Grok", model:
         "grok-4-fast", effort: null }`, and the Notice Board shows
         "Agent blocked: <coder> on #1: …" from the coder flow;
      4. moves the coder back to Claude (Model resets to "Default"),
         chooses effort `high`, and the next issue's task is given
         `Claude`, `claude-opus-5-5`, `high`;
      5. checks the xAI key never appears in the server's log.

      The whole suite, 19 tests, passed with it (`pnpm e2e`, output
      below).

### Other tests added

- `packages/orchestrator/src/agents/agents.test.ts`, each case in memory
  and in Postgres 18: every setting edited and stored with its
  `config.changed` event, and no event when nothing changes; a new AI
  Provider resets Model and effort; refusals (Model not in the catalogue,
  unsupported effort, taken name, AI Provider without a default, Gemini's
  missing effort, unknown Agent) leave the Agent unchanged; an unlisted
  override is kept; the store refuses a taken name and another Floor's
  Agent; archived Floors are refused.
- `apps/server/src/agents/routes.test.ts`, in memory and in Postgres 18:
  the PATCH round trip (Grok and back to Claude with an effort, then to
  the defaults), its `config.changed` event, and each refusal's status
  and code, including bodies with unknown fields, blank names, unknown
  AI Providers and over-long instructions.
- `apps/web/src/floors.test.tsx`: the editor's options (disabled AI
  Providers, Grok's Models, no effort for Grok), the request it sends
  (only what changed), the row updating, pronouns for a female and an
  androgynous Avatar, a refused name, a blank name refused before
  sending, Close, and no editor on an archived Floor.
- **Negative check:** with the memory store's update made a no-op, 3
  tests fail (reverted afterwards).

### How Postgres and Chromium were run here

As for earlier issues: `@embedded-postgres/linux-x64@18.3.0-beta.16` in
`/tmp/pgpkg` (port 54329); a scratch patch, applied only for the run and
reverted, pointed `postgresTest` at it with a template database per test
file; `E2E_POSTGRES_URL` for `pnpm e2e`. Chromium from
`playwright install chromium`, with Debian bookworm's libraries
extracted to `/tmp/chromelibs`. Nothing of this is in the repository.

## Not verifiable in this sandbox

- **Docker:** the Testcontainers Postgres and the compose stack. The
  Postgres tests ran against the embedded Postgres 18 instead.
- **Real sandboxes:** no real Sandcastle run took the new config. A real
  task on Grok or ChatGPT would still stop at the sandbox runner, which
  runs only Claude Code so far ("Sandboxes run Claude Code so far, not
  the agent tool for Grok."); Codex and opencode sandboxes are not built
  yet. The Agent's config reaches the runner, which is what this issue
  changes.
- **Real AI Accounts:** the catalogue came from a fake xAI.
- The effort levels for Codex (`minimal` to `high`) follow Codex's
  documented `model_reasoning_effort` values; no real Codex was run.

## Notes

- **Pausing** stops new work going to the Agent (the work queue assigns
  only enabled Agents). Work already queued for it before it was paused
  is still started; pausing "at a safe point" belongs to Token Cap
  enforcement (#51).
- **Role** is not editable here: the issue lists name, AI Provider,
  Model, effort, extra instructions and enabled or paused. Avatar (#71),
  Token Cap overrides (#50) and adding or removing Agents (#61) are out
  of scope.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  111 passed (111)
      Tests  1126 passed | 211 skipped (1337)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  111 passed (111)
      Tests  1322 passed | 15 skipped (1337)
   Duration  52.90s (tests 87%, import 9%, environment 2%, transform 2%)
```

`pnpm e2e` (tail):

```text
  ✓   2 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (5.8s)
  ✓   8 [chromium] › tests/agent-editor.spec.ts:52:1 › an Agent's new AI Provider and Model are what its next task uses (5.7s)
  ✓   6 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (5.8s)
  ✓   9 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (3.5s)
  ✓  19 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (2.7s)
  ✓  18 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (3.3s)
  19 passed (14.2s)
```
