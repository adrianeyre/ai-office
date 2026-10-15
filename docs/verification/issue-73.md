# Issue #73: Agent state visuals — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code commit
(`3fe512c`), with the README commit after it changing only Markdown.

The blockers are built on this branch:

- #69, the Floor's wall board ([`issue-69.md`](issue-69.md)): `GET
  /api/floors/:floorId/wall-board` and `createWallBoard`, whose per-Agent
  entries this issue extends with what the Office shows of each Agent;
- #70, the character kit ([`issue-70.md`](issue-70.md)): the shared rig and
  animation set, to which this issue adds the waiting pose, and the Agents
  at their desks, which now take their pose from their state.

It also builds on #66 (the desk's spot kept for the pile of tickets,
[`issue-66.md`](issue-66.md)) and #68 (each monitor's working state,
[`issue-68.md`](issue-68.md)).

**The scope addition is not built.** The comment on the issue adds PRD
FR-85's Context Usage bar over each Agent's head, with "data from the API
in #120" and an empty animation on a Fresh Start (#121). As #68 and #69
found, that API is not on this branch: nothing serves an Agent's Context
Usage (FR-84), and the only Context Usage in the code is the
`agent.fresh_start` event's field, which nothing publishes. Drawing the
bar would mean inventing #120's API, so it waits for #120 (below).

## What was built

- **The wall board says what the Office shows of each Agent** (PRD FR-62;
  `packages/shared/src/wall-board.ts`,
  `packages/orchestrator/src/wall-board/wall-board.ts`). Each entry in a
  Floor's `agents` now has, beside `waiting` (its queue):
  - `awaitingReview`: the issues it handed to review that wait on their
    verdicts. For each piece of the Floor's work at `needs-review`, the
    Agent that handed it there is the `fromAgentId` of the issue's latest
    `needs-review` Handoff, which the coder records as it moves the issue
    to review. Work that has left review (on to QA, or back to the coder)
    is no longer waited on;
  - `capped`: whether it is paused at a Token Cap, from the server's cap
    enforcement (`capPaused` in `buildApp`'s options, which `server.ts`
    passes as `capEnforcement.isPaused`). Without it, no Agent is capped.
- **How each state looks, as data** (`apps/web/src/scene/agent-state.ts`).
  `agentLook(state)` maps an Agent's state (working, enabled, capped, its
  issues at review, its queue) to its look:
  - **animation:** `type` while it works; `wait` while it is not working
    and any of its issues is at review; `sit` otherwise. A paused Agent
    finishing its task still types; a capped one never does.
  - **marker:** `capped` at a Token Cap, `paused` when the Owner has paused
    it in the Agent editor, none otherwise; a cap is shown over a pause.
  - **tickets:** its queue, at most 10 (`maxTicketsShown`, the art
    direction's).

  `agentLooks({ team, monitors, board })` gives every Agent of a Floor
  its look: working from its monitor (#68's status projection), paused
  from the team's `enabled`, the rest from the wall board. Before the board
  is read, an Agent has nothing queued, at review or capped.
  `floorNeedsOwner(notices, floorId)` is the red light: on while the Floor
  has an action Notice open.
- **The waiting pose** (`scene/avatar-animations.ts`): the twelfth
  animation, `wait`. The Agent leans back in its chair with its hands
  clasped behind its head and its elbows out, glancing over now and then.
  The arms are solved for each body, as the typing pose is, by a two-bone
  solve in 3D (the elbow placed out to the side, then each bone turned from
  hanging down to its direction in its parent's space), so the hands meet
  behind every Avatar's head, short or tall, slim or broad.
- **The visuals in the scene** (`scene/state-visuals.tsx`):
  - **Ticket piles:** A4 tickets (0.21 m × 0.297 m), 5 mm each, stacked on
    each desk's left (the spot #66 kept for them), each a little askew so
    the pile reads as sheets, in `paper`. All the piles are one instanced
    mesh.
  - **Markers:** over a paused or capped Agent's head (centre 1.78 m up, a
    32 cm sign), in `state-critical` at the lamp's emissive 1.6, so they
    bloom. A pause is a disc with two upright paper bars; a cap is an
    octagon with one bar across, like a no-entry sign. Each kind is its own
    shape, so neither is told by colour alone (the art direction's rule).
    Every marker turns to face the camera each frame. Each kind is two
    instanced meshes (signs and symbols).
  - **The red light** over the Manager's office door, on the glass above
    the door frame, facing the open plan: 0.8 m × 0.24 m, lit
    `state-critical` while the Floor has an action Notice, pulsing gently
    between the spec's emissive 1.2 and 2.0 every 1.4 s, steady at 1.6
    with reduced motion; a dark `screen-off` lens otherwise.
    `managersLight` in `floor-layout.ts` places it.
- **The Floor draws them** (`floor.tsx`, `desk-agents.tsx`): the Agents
  take their animation from their looks; the piles, markers and light are
  drawn beside them. A Floor given no looks works them out from its
  monitors and its team, as before.
- **The Office feeds them** (`office-view.tsx`): on a Floor it reads the
  wall board (`GET /api/floors/:floorId/wall-board`), and reads it again
  at each `agent.queue_changed`, `agent.status_changed`, `issue.assigned`
  and `issue.label_changed`, and when the stream (re)connects. These
  events come on the stream that already keeps the Floor's Agents live, so
  the Office opens no new stream. The red light follows the open Notices
  the Office already reads. In the lobby nothing is read.
- **README:** a new "Agents' states in the Office" section; "The 3D
  Office" (the Agents at their desks, the animations) and "The wall board"
  (its API) updated.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too.
- [x] **Unit tests for the state-to-visual mapping.**
      `scene/agent-state.test.ts` (10 tests):
  - nothing to do: `sit`, no marker, no tickets;
  - working: `type`;
  - waiting on review: `wait`, unlike an Agent with nothing queued; at
    work on something else while it waits, `type`;
  - paused: the `paused` marker, typing still while it finishes its task;
  - capped: the `capped` marker, never typing, shown over a pause, still
    waiting on review when its work is there;
  - the pile: one ticket per task, 0, 1, 4, 10, then 10 for 11 and 250,
    whatever else the Agent is doing;
  - a Floor: work from the monitors, pauses from the team, queues, review
    and caps from the wall board, Agents the board does not list (and
    those it lists who have left) handled; before the board is read, only
    work and pauses;
  - the red light: on for the Floor's action Notice; off for info Notices,
    another Floor's, the whole Office's, or none.

  Around the mapping:
  - `avatar-kit.test.ts`: the animation set is twelve, with `wait`; `wait`
    loops, moves, and sits every body on the seat with its feet on the
    floor. For each of the twelve bodies (4 shapes × 3 presentations), at
    three times in the loop: the wrists are behind the head, at its height,
    each on its own side and clear of it; the elbows are up and out past
    the shoulders; the arm keeps its lengths; the torso leans back from
    sitting.
  - `state-visuals.test.tsx` (10 tests, React Three Fiber's test
    renderer): the waiting Agent's hand is above and behind its head and
    its elbow out, while an idle one's hands are in its lap; the piles are
    one per task, at most 10, on each desk's left, stacked 5 mm a ticket
    from the desk top, A4, and grow, shrink and go; a disc (more than 16
    sides) with two bars over a paused Agent and an octagon (8) with one
    bar over a capped one, glowing `state-critical` × 1.6, over the seat,
    clear of the head and under the ceiling, and none over the others; the
    markers face the default camera, symbol in front; they come and go
    with the pause; the red light is over the door, above its frame and
    under the ceiling, in front of the glass; it is dark, then red and
    pulsing within 1.2 to 2.0 while on, dark again when the Notice goes,
    and steady with reduced motion.
  - `floor.test.tsx`: the per-frame budget test now draws a Floor of 12
    working Agents with **every** state shown: a full pile on each desk,
    six paused and six capped markers, and the red light on. It stays
    within Medium's 200 draw calls and 300,000 triangles (measured: 128
    draw calls, the post-processing's dozen included, and 72,912
    triangles).
  - `office-view.test.tsx` (4 new tests): the scene is given each Agent's
    look from its monitor, its pause and the Floor's wall board; an
    `agent.queue_changed` on the team's stream reads the board again (the
    stream carries the four state events, and no other stream opens for
    them); the red light comes on as an action Notice for the Floor
    arrives, live, and not for another Floor's; the lobby has no looks, no
    red light and reads no wall board.
  - `wall-board.test.ts` (orchestrator): the coder waits on the issue it
    handed to review, not on an older issue whose review is over; once the
    issue goes on to QA it no longer waits; `capPaused` marks QA capped;
    without it, none is. `routes.test.ts` (server): `capped` reaches the
    API, false until the coder is paused, then true.

  **Negative checks** (each reverted afterwards):
  - The wait pose never chosen: 7 tests failed.
  - No cap on the pile: 7 failed.
  - Markers not turned to the camera: 1 failed.
  - The red light on without an action Notice: 1 failed.
  - The wall board not read again on the state events: 1 failed.
  - The piles not drawn: 3 failed.
  - The Office not lighting the red light: 1 failed.
  - Any open work (not only review) counted as waiting on review: 1
    failed (orchestrator).
  - The waiting pose's arms left unsolved: 13 failed.

### Rendered in headless Chromium

As in #64 to #70: Playwright's Chromium headless shell, its missing
libraries unpacked from Debian bookworm's packages into `/tmp` (nothing
installed), and SwiftShader. A throwaway page under Vite (deleted
afterwards) rendered the real `OfficeScene` at Medium, 1280 × 720, on a
Floor of eight Agents: the Manager and two more working, a coder and a
reviewer waiting on review, QA capped with 6 tickets, docs paused, a
designer idle, a coder with 12 waiting, and the red light on.

- **From the default view (Overview):** the pause disc and the cap
  octagon stood out red over their Agents, with their bars readable; the
  red light showed over the Manager's office door; the piles were white
  on the birch desks; the waiting reviewer's raised elbows were visible.
- **Close up:** the waiting reviewer leaned back with both hands behind
  the head and the elbows out; the 10-ticket pile was a stack of sheets,
  each a little askew; the markers were round with two bars, and
  eight-sided with one.
- **From the corridor:** QA's six tickets on its desk's left, clear of its
  laptop and screens.
- **The Manager's office:** the red light across the glass above the door
  frame. The first render showed it smaller than it needed to be from the
  default view (0.7 m × 0.16 m); it is now 0.8 m × 0.24 m (`3fe512c`).
- The only console output was R3F's `THREE.Clock` deprecation (see #64)
  and Vite's.

### Verified on the host

- [ ] **Each state is recognisable at a glance from the default camera.**
      On the host: `pnpm dev`, open http://localhost:3045, ride the lift
      to a Floor and stay at Overview, at Low, Medium and High. To see each
      state:
  - **Working:** give an Agent work (a labelled issue); it types and its
    monitor glows.
  - **Waiting on review:** once its pull request is opened and the issue
    is at `needs-review`, the coder leans back with its hands behind its
    head until the review ends.
  - **Paused:** pause an Agent in the Floor admin's Agent editor: a red
    disc with two bars over it.
  - **Capped:** set an Agent's daily Token Cap low in its editor and let
    it work: at the cap, a red octagon with a bar across over it.
  - **Queue:** queue several issues for one Agent: a pile of tickets on
    its desk's left, one per issue, ten at most.
  - **Action Notice:** with an action Notice open for the Floor (a Token
    Cap warning will do), the light over the Manager's door is red and
    pulses; dismiss it and it goes dark.

  Things to judge there: whether the waiting pose reads apart from
  sitting at the Overview's distance (in the sandbox it read from the
  raised elbows), whether a pile of 5 mm tickets shows its size from that
  far, and whether Medium's bloom makes the red light and markers glow
  enough. Seen in the sandbox as far as SwiftShader allows (above).

### The scope addition: Context Usage over the head (PRD FR-85)

- [ ] **A camera-facing Context Usage bar over each Agent with an active
      session**, green below 60%, amber from 60%, red from 85%, with the
      percentage, following the Agent as it walks, hidden while idle,
      switchable off in settings, emptying with an animation on a Fresh
      Start. Not built: its data is the API from #120, which this branch
      does not have, and its Fresh Start is #121's (see the top of this
      note). Once #120 exists, the bar belongs in `state-visuals.tsx`
      beside the markers: a camera-facing instanced bar over each seat,
      with its percentage as HTML over the canvas (PRD §7: no text in the
      scene), its colour from `state-ok`, `state-warning` and
      `state-critical`. The markers sit 1.78 m up, leaving room above the
      head for it.
- [ ] **Verified on the host: readable at the default camera distance with
      12 Agents at 60 fps on medium.** Not applicable until the bar exists.

### Not verifiable in this sandbox

- **Real Agents in each state** (no Docker): the events and wall boards a
  real run gives were stubbed, in the shapes the coder flow, the work
  queue and cap enforcement give them.
- **How it looks and moves on a real GPU:** the bloom on the markers and
  the red light, the pulse, the waiting pose's glances, and the frame rate
  with every state shown (SwiftShader's frame rate says nothing about a
  GPU; the scene's cost is counted instead, above).
- **The Postgres runs** of the wall board's orchestrator and route tests
  (no Docker): skipped here, as each in-memory run passes; CI runs them.
- **The e2e suites** (no Docker): signed-in tests that land on a Floor now
  also read its wall board; nothing they check changes.

## Noticed, out of scope

- **FR-62's token label over the head** ("128k today", coloured against
  the daily Token Cap, with this month's on hover) is in the PRD's FR-62
  but not in this issue's "What to build", so it is not built. It would
  sit beside the Context Usage bar, and the same setting would hide both.
- **Blocked and errored Agents** have no look of their own: FR-62 names
  only paused and capped. A blocked Agent sits back like an idle one; its
  "Agent blocked" Notice lights the red light.
- **The `waiting` and `paused` Agent statuses** in the events schema
  (`agentStatuses`) are published by nothing. The Office takes waiting on
  review from the wall board, and paused from the Agent's `enabled`.
- **A review round's work** waits for the Floor's required reviewers, not
  one Agent (`agentId` null), so it is on no reviewer's pile, as the wall
  board's own queue counts already have it.
- **The markers are drawn over the seat**, so an Agent that walks
  (Handoffs, #74; idle behaviours, #110) leaves its marker at its desk.
  Those issues will want the marker, and the Context Usage bar, to follow
  the Agent.

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
 Test Files  198 passed (198)
      Tests  2357 passed | 306 skipped (2663)
   Duration  55.96s (tests 43%, import 35%, environment 11%, transform 9%, setup 2%)
```

`pnpm build` (the web app's assets):

```text
dist/assets/index-BBiBaHke.css            45.90 kB │ gzip:   9.42 kB
dist/assets/avatar-preview-Bf6ciFAx.js    17.37 kB │ gzip:   5.56 kB
dist/assets/office-scene-Cw9JF_X9.js     487.61 kB │ gzip: 211.38 kB
dist/assets/index-OXZBvs-B.js            945.71 kB │ gzip: 287.06 kB
dist/assets/materials-Rd5bt5kR.js        948.07 kB │ gzip: 254.10 kB
✓ built in 2.80s
```

The new and changed tests, verbose:

```text
✓ agent-state.test.ts > how an Agent's state looks > sits back with nothing to do, no marker and an empty desk
✓ agent-state.test.ts > how an Agent's state looks > types while it works
✓ agent-state.test.ts > how an Agent's state looks > waits on review, looking unlike an Agent with nothing queued
✓ agent-state.test.ts > how an Agent's state looks > shows a pause marker while paused, typing still if it is finishing its task
✓ agent-state.test.ts > how an Agent's state looks > shows a cap marker at a Token Cap, never typing, over a pause
✓ agent-state.test.ts > how an Agent's state looks > piles a ticket on the desk for each task that waits, up to ten
✓ agent-state.test.ts > how a Floor's Agents look > reads each Agent's work from its monitor, its pause from the team, and the rest from the wall board
✓ agent-state.test.ts > how a Floor's Agents look > before the wall board is read, shows only work and pauses
✓ agent-state.test.ts > the red light at the Manager's office > is on while the Floor has an action Notice open
✓ agent-state.test.ts > the red light at the Manager's office > is off for info Notices, another Floor's, the whole Office's, or none
✓ state-visuals.test.tsx > an Agent waiting on review > leans back with its hands behind its head, unlike one with nothing queued
✓ state-visuals.test.tsx > the piles of tickets > piles a ticket on each desk for each task that waits, up to ten, on the desk's left
✓ state-visuals.test.tsx > the piles of tickets > grows and shrinks as the queue does, and is gone when it is empty
✓ state-visuals.test.tsx > the markers over paused and capped Agents > puts a disc with a pause's two bars over a paused Agent, and an octagon with a bar across over a capped one
✓ state-visuals.test.tsx > the markers over paused and capped Agents > faces the camera, so it reads from the default view
✓ state-visuals.test.tsx > the markers over paused and capped Agents > comes and goes with the pause
✓ state-visuals.test.tsx > the red light at the Manager's office > is over the office's door, above its frame, facing the open plan
✓ state-visuals.test.tsx > the red light at the Manager's office > is red and pulses while the Floor has an action Notice, and dark otherwise
✓ state-visuals.test.tsx > the red light at the Manager's office > holds steady with reduced motion
✓ state-visuals.test.tsx > the red light at the Manager's office > pulses within the spec's emissive range, once every 1.4 s
✓ avatar-kit.test.ts > the animation set > has the twelve animations, each for every bone of the rig
✓ avatar-kit.test.ts > the animation set > waits on review as a slim male Avatar: leaning back, its hands behind its head and its elbows out
  (and the same for the other eleven bodies; and "sits a … Avatar on the
  seat with its feet on the floor", now with `wait`, for all twelve)
✓ floor.test.tsx > a Floor's cost > is within Medium's per-frame budgets with 12 Agents at work, leaving room for their Avatars
  (now with every state shown; floor.test.tsx's 13 other tests unchanged)
✓ office-view.test.tsx > what the Agents' states look like > gives the scene each Agent's state, from its monitor, its pause and the Floor's wall board
✓ office-view.test.tsx > what the Agents' states look like > reads the wall board again as an Agent's state changes, on the team's own stream
✓ office-view.test.tsx > what the Agents' states look like > lights the Manager's red light while the Floor has an action Notice
✓ office-view.test.tsx > what the Agents' states look like > shows no states in the lobby, nor reads a wall board there
✓ wall-board.test.ts (orchestrator) > a Floor's wall board > shows its issues in progress and its queues, in memory
↓ wall-board.test.ts (orchestrator) > a Floor's wall board > shows its issues in progress and its queues, in Postgres 18 [Docker is not available]
✓ routes.test.ts (server) > GET /api/floors/:floorId/wall-board > answers a Floor's issues in progress and its queues, in memory
↓ routes.test.ts (server) > GET /api/floors/:floorId/wall-board > answers a Floor's issues in progress and its queues, in Postgres 18 [Docker is not available]
```
