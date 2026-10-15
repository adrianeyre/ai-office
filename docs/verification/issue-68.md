# Issue #68: Monitors show live Agent activity — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code commit
(`efa9759`), with the README commit after it changing only Markdown.

The blockers are built on this branch:

- #32, the Agent live view ([`issue-32.md`](issue-32.md)): `AgentLiveView`
  in `apps/web/src/agent-live-view.tsx`, made to be reused by the monitors;
- #66, a Floor with a desk and monitor for each Agent
  ([`issue-66.md`](issue-66.md));
- #67, the inspectable objects, whose monitor panel this issue fills
  ([`issue-67.md`](issue-67.md)).

**The scope addition is not built.** The comment on the issue adds PRD
FR-85's Context Usage gauge on each desk monitor, "using the API from
#120". That API is not on this branch: nothing serves an Agent's Context
Usage (FR-84), and the only Context Usage in the code is the
`agent.fresh_start` event's field, which nothing publishes. Building the
gauge would mean inventing #120's API, so it waits for #120 (below).

## What was built

All of it is in `apps/web/src/scene/` unless named otherwise.

- **What a monitor shows, as data** (`monitor-preview.ts`, PRD FR-58, §5
  scenario 2). `monitorScreens(agentIds, events)` gives each Agent's
  monitor from its Floor's events, read once each and in id order:
  - **Working or not.** An Agent is working from a status of `working`
    (`agent.status_changed`) or its sandbox starting (`sandbox.started`)
    until its next status. Each time it starts work, its screen starts
    empty.
  - **Lines of "writing".** No text is drawn in the scene (PRD §7), so each
    thing the Agent does becomes a line only as long as it is
    (`screenColumns`, 48 characters to a full line):
    - each line of terminal output (`sandbox.text`), indented as far as it
      is, wrapped onto at most three rows, with a blank line as a gap;
    - each tool call (`sandbox.tool_call`);
    - a diff's file, then each of its lines (`sandbox.diff`);
    - each model call (`model_call.completed`).
  - **Coloured by kind,** from the palette: output in `ink`, tool calls in
    `state-info`, removed and added lines in `state-critical` and
    `state-ok`, a diff's file and `@@` and model calls in `state-neutral`.
  - It keeps the latest 16 lines: a screen's eight, and eight more that
    have just scrolled off the top, so they can be seen leaving. Each line
    has a number after every earlier one's, so the scene can tell which
    are new.
- **The monitors in the scene** (`monitor-screens.tsx`):
  - **The glow.** Each working Agent's screens (a designer's two) glow in
    `screen-glow`, the art direction's "monitor at work", at its screen
    emissive (1.2), bright enough to bloom. A display sits on the screen's
    face towards the Agent's chair, 1.5 cm in from its edges. An idle Agent's
    monitor stays `screen-off`, as before.
  - **The lines** are written on the display, top down. A screen fills
    from the top, as a terminal does; once full, new lines scroll in from
    the bottom, eased, and the oldest scroll off the top.
  - **A pulse.** At each new line the display glows up to 0.6 brighter
    (1.8 at most, within the spec's 1.2 to 2.0), then settles back.
  - **Reduced motion:** new lines are there at once, and the glow is
    steady.
  - **Cost.** Every display is an instance of one mesh and every line an
    instance of another, so all the monitors together cost two draw calls.
  - **Each screen's own centre.** `DeskSet.screenCentres` (`desk-set.ts`)
    is each screen's centre, from the Agent's left; `screenDepth` names
    the screen's 3 cm.
- **Fed live** (`office-view.tsx`):
  - **Reading.** On a Floor, the Office reads two pages of the Floor's
    latest events (`GET /api/events`, 200 each): its Agents' statuses, and
    their activity. They are read apart, so a busy Agent's output never
    hides another's status.
  - **Following.** It then follows the Floor's stream, resuming after the
    older page's newest event so neither page misses one, and reads
    repeats once.
  - **Feeding the scene.** Each monitor's screen goes to the scene
    (`OfficeScene` → `OfficeLocationScene` → `Floor` → `MonitorScreens`).
  - Nothing is read in the lobby. With no page read, the stream starts
    from now rather than replay every stored event.
- **The monitor's panel is the Agent live view** (`inspector-panels.tsx`).
  Inspecting a monitor (a click on it, the keyboard list, or the Office's
  address) flies the camera in, as #67 built, and its panel now shows
  `AgentLiveView` for that Agent:
  - its terminal output, tool calls, diffs and model calls, the last 200,
    then each new one as it comes;
  - with auto-scroll and **Jump to latest**, as on the 2D page;
  - cut to `min(18rem, 45vh)` high, so it fits the canvas at its smallest.

  **Open the live view** still links to the full page. Closing the panel
  closes its stream.
- **README:** "The 3D Office" describes the monitors, and the monitor's
  panel; "The Agent live view" says the monitor shows it.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too.

### Verified on the host

- [ ] **Clicking a working Agent's monitor shows its live activity.**
      Needs the host: a working Agent needs Docker (a real sandbox run),
      and seeing it needs a GPU. Here it is verified as far as the sandbox
      allows:
  - **The component tests** (`office-view.test.tsx`, the real
    `OfficeView` against a stubbed server):
    - "shows a working Agent's live activity in its monitor's panel,
      live": the coder is working, with a line of output stored. Opening
      its monitor (what a click on it does; the click itself is #67's
      `inspectable-hotspots.test.tsx`) shows a `Live activity` log in the
      panel with "Now working on #4" and the output, and not another
      Agent's. A new line sent on the Agent's stream (resuming after its
      last stored event) appears in the open panel. Escape closes the
      panel and its stream.
    - "light up a working Agent's monitor from the Floor's latest events,
      then follow them live": the scene is given the coder's monitor on
      with its two lines, and the idle Agents' off. Each page is read once
      (Floor, types, 200), and the stream resumes after the older page's
      newest (4, not 5). A repeat is read once. A reviewer starting work
      lights up, and the coder going idle goes off.
    - "never lose one Agent's status under another's output": 250 lines
      from one Agent after another's status of working; that one is still
      working.
    - "read nothing in the lobby".
  - **The scene tests** (`monitor-screens.test.tsx`, React Three Fiber's
    test renderer):
    - an idle Agent's monitor stays off;
    - a working one's displays are over each of its screens (checked
      against the Floor's own screen pieces), on the face its chair sees,
      in `screen-glow` × 1.2;
    - its lines are on the display, inside its padding, top down, in their
      kinds' colours, an indented line starting further in;
    - a designer's two screens show the same lines;
    - new lines start where the old ones were, then scroll up: never more
      than nine lines on a screen, never outside it, settling with the
      newest at the bottom and the oldest gone;
    - a screen with room fills from the top without moving;
    - the pulse brightens, then settles back to the base glow;
    - with reduced motion, new lines are at once in place and the glow is
      steady;
    - an Agent that stops goes dark, and starts empty when it works again;
    - 12 desks (23 screens) are all drawn.
  - **The Floor's tests** (`floor.test.tsx`):
    - a Floor lights its working Agents' monitors and leaves the rest off;
    - the per-frame budget test now runs with all 12 Agents at work and
      every screen full: still within Medium's draw calls and triangles,
      with room for their Avatars.
  - `monitor-preview.test.ts` (10 tests): working or not, and in what
    order; starting empty; each Agent's own; repeats; each event type's
    lines, their lengths, indents, wrapping, gaps and colours; the latest
    16, in order.

  **Negative checks** (each reverted afterwards):
  - Lines not scrolling: 1 test failed.
  - No pulse: 1 test failed.
  - Reduced motion ignored: 1 test failed.
  - Idle Agents' monitors lit: 4 tests failed.
  - One page for statuses and activity together: 2 tests failed.
  - Resuming after the newer page: 1 test failed.
  - Monitors not given to the scene: 2 tests failed.
  - The panel without the live view: 1 test failed.

  **Rendered in headless Chromium.** As in #64, #66 and #67: Playwright's
  Chromium headless shell, its missing libraries unpacked from Debian
  bookworm's packages into `/tmp` (nothing installed), and SwiftShader. A
  throwaway page under Vite (deleted afterwards) rendered the real
  `OfficeView` at 1280 × 720 with a stubbed `fetch` and event streams. The
  Floor had a Manager and a QA Agent (idle), and a coder, a designer and a
  reviewer (working).
  - **Overview:** the three working Agents' screens glowed light blue
    among the dark ones.
  - **The coder's monitor**, opened: a glowing screen with its lines (the
    output with its blank-line gaps, a blue tool call, the diff's grey
    file, then its red and green lines). Beside it, the panel's live view
    showed the same output, tool call and coloured diff, "Live".
  - **New output:** four lines sent on the stream reached both the screen
    (the oldest scrolled off) and the panel.
  - **The designer's monitor:** the same lines on both screens.
  - **The reviewer's monitor:** glowing, with no lines (see "Noticed").
  - **The coder stopping:** its monitor went dark.
  - The only console output was R3F's `THREE.Clock` deprecation (see #64)
    and React's DevTools notice. At SwiftShader's few frames a second the
    scroll itself could not be watched; the screenshot taken during it
    already showed it settled.

### The scope addition: Context Usage on the monitor (PRD FR-85)

- [ ] **A small colour-coded Context Usage gauge on each desk monitor.**
      Not built: it uses the API from #120, which this branch does not
      have (see the top of this note). Once it exists, the gauge is one
      more instance on the display (`monitor-screens.tsx`), filled by the
      Agent's Context Usage, in `state-ok` below 60%, `state-warning` from
      60% and `state-critical` from 85%.

### Not verifiable in this sandbox

- **A real Agent at work** (no Docker): the events a real sandbox run
  publishes were stubbed, in the shapes the coder, QA, docs and reviewer
  flows publish them.
- **How it looks and moves on a real GPU**:
  - whether the lines read at a glance from the default view, which shows
    the glow more than the lines;
  - the feel of the scroll and the pulse;
  - the bloom on the screens;
  - the frame rate with every monitor scrolling.
- **The e2e suites** (no Docker): signed-in tests that land on a Floor now
  also read the monitors' two pages and open their stream; nothing they
  check changes.

## Noticed, out of scope

- **Reviewers' monitors glow with no lines.** A reviewer has no sandbox,
  so its only activity is its model calls. `model_call.completed` is not
  published yet ("Model calls appear once the AI Gateway publishes them as
  events", README), so for now a reviewer's monitor glows empty while it
  reviews. A line for each of its model calls will follow from that
  change, with nothing more to do here.
- **The receiving monitor lighting up at a Handoff** (FR-59) is the
  Handoff walks' issue; the monitor already lights up once the receiving
  Agent's status is `working`.
- **Event streams per page.** With a monitor's panel open on a Floor, the
  Office keeps four event streams open: the Notices, the Floor's team, its
  monitors, and the open Agent's live view. Browsers allow six
  connections per host over HTTP/1.1. The team's and the monitors' streams
  could be one later.
- **A narrow live view.** In the 20 rem panel (#67's framing assumes that
  width), long output wraps and wide diffs scroll sideways. **Open the
  live view** gives the full page.
- **`sandbox.stopped` is not read.** The coder's flow pushes and opens its
  pull request after its sandbox stops, so a monitor stays on until the
  Agent's status changes, which is when its work ends.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker (the Postgres and Docker tests skip):

```text
 Test Files  165 passed (165)
      Tests  1714 passed | 258 skipped (1972)
   Duration  44.47s (tests 42%, import 37%, environment 10%, transform 9%, setup 1%)
```

`pnpm build` (the web app's assets):

```text
dist/index.html                              0.47 kB │ gzip:   0.30 kB
dist/assets/icon-BQiMWJ90.svg                1.45 kB │ gzip:   0.63 kB
dist/assets/bookcase-ByU8ivTX.glb            4.47 kB
dist/assets/laptop-BLtO2X_m.glb              4.83 kB
dist/assets/potted-plant-36DUeMg3.glb        5.43 kB
dist/assets/books-BYjT1lk0.glb               6.06 kB
dist/assets/coffee-machine-Bpg4NQAd.glb      6.55 kB
dist/assets/fridge-qPv0m6nz.glb              6.99 kB
dist/assets/index-BoIk-Rdj.css              36.13 kB │ gzip:   7.36 kB
dist/assets/index-CZn0CrnJ.js              873.19 kB │ gzip: 266.98 kB
dist/assets/office-scene-C9skaDq6.js     1,393.12 kB │ gzip: 450.16 kB
✓ built in 734ms
```

The new and changed tests, verbose:

```text
✓ monitor-preview.test.ts > whether a monitor shows its Agent at work > is off until its Agent works, and off again when it stops
✓ monitor-preview.test.ts > whether a monitor shows its Agent at work > is on once its sandbox starts, whatever the order the events came in
✓ monitor-preview.test.ts > whether a monitor shows its Agent at work > starts empty each time its Agent starts work, keeping its lines while it works
✓ monitor-preview.test.ts > whether a monitor shows its Agent at work > is each Agent's own, and leaves out the events of Agents not on the Floor
✓ monitor-preview.test.ts > whether a monitor shows its Agent at work > reads each event once, however many times it is given
✓ monitor-preview.test.ts > whether a monitor shows its Agent at work > reads an Agent's statuses, its sandbox starting, and the activity the live view shows
✓ monitor-preview.test.ts > the lines on a monitor > are a line of writing for each line of terminal output, as long and indented as it
✓ monitor-preview.test.ts > the lines on a monitor > wrap a long line onto a few rows, and draw a short one as a word
✓ monitor-preview.test.ts > the lines on a monitor > are a line for a tool call, a header and a line each for a diff, and a line for a model call
✓ monitor-preview.test.ts > the lines on a monitor > keep the latest lines, each numbered after the ones before
✓ monitor-screens.test.tsx > the desks' monitors in the scene > stay off while their Agents are idle
✓ monitor-screens.test.tsx > the desks' monitors in the scene > glow over each of a working Agent's screens, on the face its chair sees
✓ monitor-screens.test.tsx > the desks' monitors in the scene > write the Agent's lines on its display, top down, each in its kind's colour
✓ monitor-screens.test.tsx > the desks' monitors in the scene > show the same lines on each of a designer's two screens
✓ monitor-screens.test.tsx > the desks' monitors in the scene > scroll up as new lines come, the newest settling at the bottom
✓ monitor-screens.test.tsx > the desks' monitors in the scene > fill from the top before they scroll, as a terminal does
✓ monitor-screens.test.tsx > the desks' monitors in the scene > glow brighter for a moment as a line comes, then settle back
✓ monitor-screens.test.tsx > the desks' monitors in the scene > with reduced motion, show new lines at once, with a steady glow
✓ monitor-screens.test.tsx > the desks' monitors in the scene > go off when the Agent stops, and start empty when it works again
✓ monitor-screens.test.tsx > the desks' monitors in the scene > make room when a desk is added
✓ floor.test.tsx > a Floor in the scene > lights its working Agents' monitors, and leaves the rest off
✓ floor.test.tsx > a Floor's cost > is within Medium's per-frame budgets with 12 Agents at work, leaving room for their Avatars
  (and floor.test.tsx's 5 other tests, unchanged)
✓ office-view.test.tsx > the desks' monitors > light up a working Agent's monitor from the Floor's latest events, then follow them live
✓ office-view.test.tsx > the desks' monitors > never lose one Agent's status under another's output
✓ office-view.test.tsx > the desks' monitors > read nothing in the lobby
✓ office-view.test.tsx > inspectable objects > shows a working Agent's live activity in its monitor's panel, live
  (and office-view.test.tsx's 24 other tests, unchanged; #67's test of the
  monitor's panel still finds its text and its one link)
 Test Files  4 passed (4)
      Tests  55 passed (55)
```
