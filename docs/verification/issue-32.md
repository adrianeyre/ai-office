# Issue #32: 2D Agent live view — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **File diffs as they happen:** a new event, `sandbox.diff` (the file,
  its removed `-` and added `+` lines with `@@` between separate changes,
  and how many of each). The sandbox runner reads each `Edit`,
  `MultiEdit` and `Write` tool call from Claude Code's stream
  (`fileDiffs` in `packages/orchestrator/src/sandbox/diffs.ts`) and
  publishes its diff as the Agent makes the change, cut to the stream's
  8000 characters like the other sandbox events. Sandcastle shows none of
  these as tool calls (only Bash, WebSearch, WebFetch and Agent), so file
  changes were not visible at all before.
- **The panel** (`AgentLiveView` in `apps/web/src/agent-live-view.tsx`),
  for one Agent:
  - terminal output (`sandbox.text`) as written; tool calls
    (`sandbox.tool_call`) with the tool and its argument; file diffs
    (`sandbox.diff`) with the path, `+N −M` and coloured lines; model
    calls (`model_call.completed`) with the AI Provider, Model and tokens
    in, out and read from cache, and the latency; and, as quieter lines,
    its sandbox starting and stopping and its status changes;
  - it starts with the Agent's last 200 of those events (`GET
    /api/events?agentId=…&type=…&limit=200`), oldest first, then opens
    the live stream for the same filter, resuming right after them;
  - **auto-scroll:** it follows new events while at the bottom. Scrolling
    up pauses that, and **Jump to latest** (with how many arrived since)
    or scrolling back to the bottom follows again. It shows whether the
    stream is live, connecting or reconnecting;
  - it is a component taking an Agent's id (and a class for its size), so
    the 3D monitors (#68) can render it in their panel.
- **The page:** `/floors/<floor>/agents/<agent>`, with the Agent's name,
  Role, Floor (linked to its admin page), AI Provider and Model, then the
  panel.
- **Links:** every Agent link now opens its live view: the names in the
  Floor admin's Agents table, the Agent on a Notice (#27) and the Agents
  of each Activity Feed entry (#29). `eventHistoryUrl()` takes a page
  size.
- **README:** "The Agent live view".

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 at the issue's last commit (output below).
- [x] **Component tests render each event type.**
      `apps/web/src/agent-live-view.test.tsx`, "each kind of event in the
      live view": terminal output kept as written (line breaks and
      indentation); a tool call's tool and argument; a diff's path,
      counts, each line in order and its colour for removed and added
      lines; a model call's AI Provider, Model and tokens; the sandbox
      starting and stopping (timed out) and a status with its reason.
      Further tests of the whole page: the Agent's name and details, the
      backlog oldest first and the exact history request, streamed events
      following the backlog (the stream resuming after its last event),
      the empty state, and auto-scroll: following, pausing when scrolled
      up (new lines do not move the view; "Jump to latest (2 new)"),
      jumping back, and following again when scrolled to the bottom by
      hand (with the log's scroll geometry stubbed, as jsdom lays nothing
      out).

      **Negative check:** with the view scrolling to the bottom whatever
      the Owner did, the auto-scroll test failed; restored afterwards.
- [x] **Playwright: events stream into the panel.**
      `e2e/tests/agent-live-view.spec.ts`, in real Chromium against the
      real server and the embedded Postgres 18.3:
      - **"an Agent's events stream into its live view":** the coder's
        name in the Floor admin opens its live view (name, "Coder on
        web-shop", "Nothing yet.", status "Live"). A sandbox start, text,
        a tool call, a diff and a model call for it are published in the
        server, and another Agent's text: the panel shows exactly the
        five, in order, without a reload (a marker on `window` survives),
        and still has them after one.
      - **"follows new output, and pauses while the Owner reads back":**
        after 80 lines the panel is at the bottom; scrolled up with the
        mouse wheel, two more lines leave it at the top and offer "Jump
        to latest (2 new)", which takes it back to the bottom, where it
        follows the next line.

      Both passed 6 times each on 12 workers, and the whole suite (15
      tests) passed twice in a row (output below).

      **Negative check:** with the panel's stream disabled, the first test
      failed (its status stayed "Connecting…"); restored afterwards.

### Also checked here

- **The diffs** (`packages/orchestrator/src/sandbox/diffs.test.ts`): an
  Edit, a Write, a MultiEdit, and everything else ignored (text, Bash,
  an Edit without its strings, the result line, malformed lines). The
  runner test streams an Edit through the fake sandbox and checks its
  `sandbox.diff` event.
- **Postgres:** the whole suite against the embedded Postgres 18.3 (the
  method of #12 to #29): 758 passed, 15 skipped (the migration tests that
  start their own container, and the real-App GitHub contract, which
  needs #18).

### Not verifiable in this sandbox

- **A real Agent in a real sandbox** (Docker, Claude Code, an AI Account,
  and the App and sandbox repository of #18). The events were published
  as the runner publishes them, and the runner was run with its fake
  sandbox.
- **The Testcontainers path** of the Postgres tests and of `pnpm e2e`;
  both ran against the embedded Postgres 18.3.

## Notes

- **Model calls** show once the AI Gateway publishes
  `model_call.completed` with the calling Agent: it does not attribute
  calls to Agents yet (Gateway Keys, PRD FR-42 and FR-46). The panel
  already shows them, as the issue asks ("once the Gateway exists").
- **Order of text and diffs.** Sandcastle holds an Agent's text until a
  tool call it shows, and it does not show Edit or Write, so a diff can
  appear before the text that came just before it (the runner test
  records this).
- **Paths** are shown as the agent tool names them (inside the sandbox).
- **Context Usage** (FR-85 puts a gauge on the live view) is not in this
  issue's "What to build"; it needs Context Usage first.

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
 Test Files  70 passed (70)
      Tests  695 passed | 103 skipped (798)
   Start at  02:02:11
   Duration  7.66s (import 44%, tests 34%, environment 11%, transform 10%)
```

The whole suite against the embedded Postgres 18.3 (all but the
Docker-only `deployment` project):

```text
 Test Files  68 passed (68)
      Tests  758 passed | 15 skipped (773)
```

The new tests (verbose):

```text
✓ src/sandbox/diffs.test.ts > fileDiffs > reads an Edit as its removed and added lines 2ms
✓ src/sandbox/diffs.test.ts > fileDiffs > reads a Write as every line added 0ms
✓ src/sandbox/diffs.test.ts > fileDiffs > reads a MultiEdit as its changes, apart 0ms
✓ src/sandbox/diffs.test.ts > fileDiffs > ignores everything else 0ms
✓ src/agent-live-view.test.tsx > each kind of event in the live view > shows the Agent's terminal output as it is 20ms
✓ src/agent-live-view.test.tsx > each kind of event in the live view > shows a tool call with its tool and argument 10ms
✓ src/agent-live-view.test.tsx > each kind of event in the live view > shows a file diff with its path, counts and lines 79ms
✓ src/agent-live-view.test.tsx > each kind of event in the live view > shows a model call with its tokens 13ms
✓ src/agent-live-view.test.tsx > each kind of event in the live view > shows the sandbox starting and stopping, and the Agent's status 4ms
✓ src/sandbox/runner.test.ts > the sandbox runner > streams the files the Agent changes, as diffs, as it changes them 105ms
✓ src/agent-live-view.test.tsx > the Agent live view > names the Agent, and starts with its recent activity, oldest first 102ms
✓ src/agent-live-view.test.tsx > the Agent live view > streams new events in after the ones it started with 42ms
✓ src/agent-live-view.test.tsx > the Agent live view > says when there is nothing yet 23ms
✓ src/agent-live-view.test.tsx > the Agent live view > follows new events, pauses when scrolled up, and jumps back to the latest 119ms
```

`pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium), the
second of two runs in a row:

```text
  ✓   1 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (2.6s)
  ✓   5 [chromium] › tests/activity.spec.ts:81:1 › the Activity Feed loads older events as it scrolls (2.6s)
  ✓   7 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (2.5s)
  ✓   8 [chromium] › tests/agent-live-view.spec.ts:10:1 › an Agent's events stream into its live view (2.6s)
  ✓   4 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (2.6s)
  ✓   2 [chromium] › tests/agent-live-view.spec.ts:107:1 › the live view follows new output, and pauses while the Owner reads back (2.7s)
  ✓   6 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (2.9s)
  ✓   3 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (3.6s)
  ✓  10 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (1.5s)
  ✓  12 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (1.9s)
  ✓  13 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (1.9s)
  ✓   9 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (2.0s)
  ✓  11 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.0s)
  ✓  14 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (2.2s)
  ✓  15 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (2.5s)
  15 passed (7.1s)
```

The live view suite, 6 times each on 12 workers:

```text
  12 passed (5.4s)
```

The negative checks:

```text
     × follows new events, pauses when scrolled up, and jumps back to the latest 58ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
- Expected
+ Received
      Tests  1 failed | 8 passed (9)
  ✘  1 [chromium] › tests/agent-live-view.spec.ts:10:1 › an Agent's events stream into its live view (6.7s)
    Error: expect(locator).toHaveText(expected) failed
    Expected: "Live"
    Received: "Connecting…"
```
