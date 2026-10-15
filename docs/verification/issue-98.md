# Issue #98: Grilling in 3D: the Manager in the meeting room — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in this branch's working tree at `056f697`, the
guide, after the issue's last code commit (`9052d6e`).

The blockers are built on: #85's Kickoff and Wrap-up walks
([`issue-85.md`](issue-85.md)), whose meeting room waypoints, walkways,
timing and poses the session's walks reuse; and #94's Grilling Sessions
([`issue-94.md`](issue-94.md)), with #95's fact-finding
([`issue-95.md`](issue-95.md)), #96's whiteboard
([`issue-96.md`](issue-96.md)) and #97's issues
([`issue-97.md`](issue-97.md)), which are extended, not rebuilt.

## What was built

For the whole of a Grilling Session the Manager is in the meeting room,
sitting at the table (PRD FR-83, FR-60).

### The event (`packages/events`, `packages/orchestrator/src/grilling/session-events.ts`)

The Office is a projection of the event bus (PRD §8), but nothing said
when a session started, paused, resumed or ended. So:

- **`grilling.session_changed`**: the Floor, the Manager, the session,
  `change` (`started`, `paused`, `resumed`, `round`, `settled` or
  `ended`), the status, the round, the round's open questions and the
  decisions settled. Counts only: never a question, answer or decision.
  No migration: events are stored by type in one table.
- **`publishingGrillingStore`** wraps the Grilling Session store. Each
  `create` and `save` compares the session with what was kept
  (`sessionChange`) and publishes the change, naming the Floor's Manager.
  Saves that change nothing the Office shows (facts, documents, issues,
  which have events of their own) publish nothing. A publish that fails
  is reported (`onError`, logged by the server) and never fails the save.
  `server.ts` and `app.ts` give the Manager chat the wrapped store.
- **The Activity Feed** lists it under **Manager**: "Evelyn asked round 2
  of Grilling Session 3: 1 question open, 4 decisions settled."

### The scene (`apps/web/src/scene/`)

- **`grilling-walks.ts`** (data):
  - The Manager's seat is the back row's, beside the table's middle,
    facing the table, with the whiteboard behind it.
  - It walks there from its office when a session starts or is resumed,
    along the walkway behind the chairs (`meetingRoute`), and back when the
    session pauses or ends. Resumed before it got up, it stays. Resumed on
    its way back, it sets off again once home.
  - A session already running when the Floor is shown has the Manager
    seated, with no walk. It gets up at once when the session ends.
  - **Fact-finding visits.** At `grilling.fact_finding_started` and
    `grilling.fact_finding_stopped` an Agent the Manager sent gets up,
    walks to the walkway in front of the table, stands across it from the
    Manager for 8 s, and walks back. Up to five stand 0.8 m apart. A
    second event while it is there keeps it longer. The Manager finding a
    fact itself, another Floor's event, and events from before the Floor
    was shown make no visit.
  - Walks wait while their Agent is on a Handoff walk or gathered for a
    Kickoff or Wrap-up. **`meetingRoomWalks`** puts the session's walks
    with the meetings', so a Handoff from an Agent at the table is handed
    over at once and an Agent there is never idle (`away-pose.ts`).
    `meeting-walks.ts`'s pose and timing helpers now take any walk's
    timing (`Timing`), not only a meeting's.
- **`grilling-board.ts`** (data): the whiteboard without text (PRD §7).
  On the left, a heading with a tally of the round's number, over a
  sticky note per question of the round: amber while open, green once
  answered, grey when withdrawn (15 at most). On the right, a ticked line
  per decision, the latest twelve.
- **`grilling-room.tsx`** plays it:
  - `GrillingWalks` drives the walker from the running session and the
    fact-finding events;
  - `InSessionSign` is a lit lamp over the meeting room's door
    (`inSessionSign` in `floor-layout.ts`), with **In session** in HTML
    over the canvas;
  - `GrillingWhiteboardMarks` draws the marks as instances on the
    whiteboard's face (`Instances` is now exported from `lobby.tsx`).

  Neither the sign nor the marks exist while no session runs, so the
  scene with no session draws exactly as before.
- **`meeting-room.tsx`**: a Kickoff or Wrap-up waits for an Agent at the
  session's table, as it waits for a Handoff walk. The Manager finishes
  the session and walks home, then sets off for the whiteboard.
- **Reduced motion**: no one walks. The Manager is at the table while a
  session runs and at its desk otherwise, and no one visits.

### Clicking, and the panels

- **`inspectable.ts`**: while a session runs (`floorInspectables(…,
  { grilling: true })`), the table is an object, **The Grilling Session**
  (`grilling-session`), listed last. Its box holds the table and its ten
  chairs. Its view looks down into the room over the glass front: the
  Floor is a cut-away with no ceiling, and from inside the 4 m deep room
  the lens cannot take in the table. The Manager's box moves to its seat
  there. The whiteboard and the Manager carry `opens`, the session.
- **`inspectable-hotspots.tsx`**: clicking an object with `opens` opens
  that object; the one pointed at is still what is highlighted. The
  keyboard list still opens each object itself, so the whiteboard's
  Plans and the Manager's card stay reachable without a pointer.
- **`inspector-panels.tsx`**: the session's panel is the Manager chat
  (`ManagerChatPanel`): the session's bar, and its round's question cards
  to answer there. It has **Open the whiteboard**, **Open <Manager>'s
  card** and a link to the Manager chat page. The panel is a little wider
  (`w-96`) for the cards.
- **`office-view.tsx`**: the team's stream also carries
  `grilling.session_changed` (which reads the Floor's Grilling Sessions
  again) and the fact-finding events. The running session, its round,
  questions and decisions (`grillingBoard`) and the visits go to the
  scene; the table joins the objects.
- **The whiteboard's panel** (`grilling.tsx`, `GrillingWhiteboard`) shows
  the current round's questions, each **Open**, **Answered** or
  **Withdrawn**, above the outline and decisions. It follows
  `grilling.session_changed` as well as the documents' events.

### Docs

[A Grilling Session in the meeting room](../guide/web-app.md#a-grilling-session-in-the-meeting-room)
in the web app guide, and "In the Office" under
[Grilling Sessions](../guide/events-and-chat.md#grilling-sessions).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). Without Docker the Postgres tests skip with
      the reason: 3837 passed, 499 skipped. `pnpm build` passes too.

  The behaviour FR-83 asks for is tested without WebGL, as data and in
  React Three Fiber's test renderer. Each test below is in the passing
  run.
  - **The Manager walks to the table and sits there; back when the
    session ends or pauses.**
    - `grilling-room.test.tsx` renders the Floor: no session, then one.
      The Manager leaves its desk, is at its seat once there, and stays
      after 60 s, with no other Agent in the room. Paused, it walks back
      to its desk.
    - A session running when the Floor is shown has it seated at once.
    - `grilling-walks.test.ts` times it: walk, sit, stay 600 s, get up at
      once, home. Also: paused and resumed before it gets up (it stays),
      resumed on its way back (it returns), and waiting while busy.
    - The Manager's way to its seat, and every Agent's to every visiting
      spot, for teams of 2, 6 and 12, is sampled every 5 cm and stays
      0.2 m from anything standing, once off its chairs.
  - **The whiteboard behind it shows the current round's questions and
    the decisions.**
    - The seat is in the back row, facing the table, within the
      whiteboard's width (`grilling-walks.test.ts`).
    - `grilling-board.test.ts`: one note per question of the round, in
      its status's colour; the tally; a ticked line per decision; every
      mark on the board; the limits.
    - The rendered Floor has one amber note and four green marks (one
      answered note, three ticks) for a round of `answered, open` with 3
      decisions.
    - `whiteboard.test.tsx`: the panel lists round 2's questions with
      their status (not round 1's, nor one still waiting). A
      `grilling.session_changed` event brings round 3.
  - **The door shows "in session".** The lamp exists only while a
    session runs (rendered Floor), and the sign's label reads
    **In session** in the page, `aria-hidden` as the scene's other labels.
  - **Clicking the Manager, the table or the whiteboard opens the session
    chat.**
    - `inspectable-hotspots.test.tsx`: each of the three, clicked, selects
      `grilling-session` and flies to its view; another Agent still opens
      its own card.
    - `inspectable.test.ts`: the objects while a session runs; which carry
      `opens`; the table and chairs inside the session's box; the
      Manager's box over its meeting chair; and the view, with the table,
      the Manager and the whiteboard between the controls and the panel
      and nothing in the way.
    - `office-view.test.tsx`: with a running session from the API, the
      scene gets the table and the round. Opening it shows the session
      chat with question 2's answer box, and **Open the whiteboard**
      opens the whiteboard. A fact-finding event reaches the scene. An
      `ended` event reads the sessions again, and the table goes.
  - **Fact-finding Agents leave their desks to visit it and return.**
    - The rendered Floor: the coder is at its spot across the table
      mid-visit and back at its desk after, and the Manager's own fact
      makes no visit. Fact-finding from before the Floor was shown is not
      walked.
    - `grilling-walks.test.ts`: two visitors at two spots, one staying
      longer when sent again, a visit when it comes back with the fact,
      and none for another Floor.
  - **Work never waits; Kickoffs and reduced motion.** A Kickoff during
    the session waits for the Manager to be back. It walks home, then to
    the whiteboard, never more than walking pace (1.25 m) a second. With
    reduced motion the Manager is at the table during the session and at
    its desk after, and no one visits.
  - **The event.** `session-events.test.ts` runs `/grilling`, an answer,
    a pause, a resume, "recommended to all" twice and "confirm" through
    the Manager chat with a scripted Model. The ten events are compared in
    full: started, round 1, settled, paused, resumed, settled, round 2,
    settled, settled, ended. This passes in memory and in Postgres 18.4
    (below). Also tested: `sessionChange` for every change, and nothing
    for facts and the outline; a failing bus never fails the save; no
    Manager, no event. The Activity Feed's text is checked for each
    change.

  **Negative checks.** Each sabotage was made, run, then reverted with
  `git checkout`; the tests were green again after each:

  | Sabotage | Failed |
  | --- | --- |
  | A click opens the object itself, not the session | 1 test |
  | A Kickoff does not wait for the session's walk | 1 test (after strengthening it, `9052d6e`: it first passed, as it checked only where the Manager ended up) |
  | Reduced motion never puts the Manager at the table | 1 test |
  | Fact-finding events are never walked | 1 test |
  | `settled` is never published | 2 tests |
  | The whiteboard's panel ignores `grilling.session_changed` | 1 test |

### Verified on the host

- [ ] **The sequence plays correctly in the office.** Not verifiable
      here: it needs a browser with WebGL and a display. The walks,
      places, timing, marks, sign and clicks were checked as data, in the
      test renderer and in jsdom, not seen. On the host: start
      `/grilling` with the Floor shown and watch the Manager walk to the
      table and the sign light; answer a round and watch the whiteboard's
      notes turn green; let the Manager send an Agent to find a fact; click
      the Manager, the table and the whiteboard; pause, resume and confirm.

## How Postgres was run here

As for #92–#97:
- **The server:** `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4), downloaded and unpacked in `/tmp`, outside the
  repository, on port 55432.
- **The harness patch:** a scratch edit to
  `packages/db/src/testing/postgres.ts` (`SCRATCH_PG_URL`, database names
  unique per test file). It was applied for these runs and reverted with
  `git checkout`, never committed.

The whole suite against it: 4309 passed, 26 skipped, 1 failed. The
failure is `batches/batches.test.ts`, "at the Kickoff, an Agent whose
Model cannot be asked…", in Postgres, which #95, #96 and #97 recorded.
It fails the same way with the files at `57a47da`, before this issue,
with the same harness patch (below).

## Not verifiable in this sandbox

- **The look in a browser** (above). This includes the frame rate, the
  marks' legibility as notes and lines, and the sign's placement.
- **`pnpm scenes`**: Playwright's Chromium is not installed here. With no
  session the Floor draws as before (the sign and the marks exist only
  during a session), so the reference pictures should be unchanged.
  There is no reference picture of a session in the meeting room yet
  (below).
- **Testcontainers**: the Postgres tests ran against the embedded
  Postgres 18.4 instead. They run in CI.
- **A real Manager's session**: the scripted Model stands in, as CI
  never calls a live AI Provider.

## Notes

- **One event, not four.** The session's course is one event type with a
  `change`, as `memory.role_changed` does, rather than separate started,
  paused, resumed, round and ended events. The Office needs only the
  status, and the Activity Feed reads every change from the same counts.
- **Read from the sessions, not replayed from events.** The scene takes
  the running session from `GET …/grilling-sessions`, read again at each
  `grilling.session_changed` and each reconnection, rather than from the
  events alone. A missed event can then never leave the Manager at the
  table, and a session running when the Floor is opened shows at once.
- **A Kickoff during a session** gathers its other Agents at once. The
  Manager stays at the session's table until the session pauses or ends,
  then walks home and on to the whiteboard. This is the "work never
  waits for an animation" rule, as for Handoff walks.

### Noticed, out of scope

- A Kickoff or Wrap-up during a session with eight or more Agents seats
  the eighth in the Manager's grilling seat (`seatOrder`'s eighth is seat
  4), so two Avatars would overlap there. Rare (the Kickoff's Agents
  rarely number eight), and a Kickoff during a session is itself rare.
- While a session runs, the Manager's box is at its seat even while it
  is still walking there (a few seconds).
- The scene screenshot tests (PRD §9, Visual) could gain a "meeting room
  in session" scene, with reference pictures taken where Chromium runs.
- The PRD and ADRs: no disagreement found. The event holds counts only,
  so no credential can reach the Activity Feed through it (FR-5).

## Output

### `pnpm lint`

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0
```

### `pnpm typecheck`

```text
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test` (no Docker: the Postgres tests skip)

```text
 Test Files  339 passed (339)
      Tests  3837 passed | 499 skipped (4336)
test exit=0
```

### `pnpm build`

```text
✓ built in 638ms
build exit=0
```

### `pnpm test` against the embedded Postgres 18.4

```text
 FAIL  |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
 Test Files  1 failed | 338 passed (339)
      Tests  1 failed | 4309 passed | 26 skipped (4336)
test exit=1

$ git checkout 57a47da -- packages apps   # before this issue, with the same harness patch (twice)
$ SCRATCH_PG_URL=… pnpm exec vitest run packages/orchestrator/src/batches/batches.test.ts -t "Model cannot be asked"
     × at the Kickoff, an Agent whose Model cannot be asked is acknowledged for by AI Office's rules, and a rambling answer is one concern
AssertionError: expected [ { …(6) } ] to have a length of 2 but got 1
      Tests  1 failed | 3 passed | 28 skipped (32)
$ git checkout HEAD -- packages apps
```

The grilling, Manager chat, events and server chat route tests against
it:

```text
$ SCRATCH_PG_URL=… pnpm exec vitest run packages/orchestrator/src/grilling packages/orchestrator/src/manager/chat.test.ts packages/events apps/server/src/manager-chat
 Test Files  15 passed (15)
      Tests  184 passed (184)

 ✓ |@ai-office/orchestrator| src/grilling/session-events.test.ts > sessionChange > names what the Office shows of a session's change
 ✓ |@ai-office/orchestrator| src/grilling/session-events.test.ts > sessionChange > names nothing when only what has events of its own changed
 ✓ |@ai-office/orchestrator| src/grilling/session-events.test.ts > publishingGrillingStore > never fails a save when its event cannot be published
 ✓ |@ai-office/orchestrator| src/grilling/session-events.test.ts > publishingGrillingStore > publishes nothing for a Floor without a Manager
 ✓ |@ai-office/orchestrator| src/grilling/session-events.test.ts > a Grilling Session's events, in memory > a session's course in the Manager chat is published once per change, with counts only
 ✓ |@ai-office/orchestrator| src/grilling/session-events.test.ts > a Grilling Session's events, in Postgres > a session's course in the Manager chat is published once per change, with counts only
```

### The web app's tests for this issue (verbose)

```text
 ✓ src/scene/grilling-board.test.ts > a session on the whiteboard > takes the current round's questions, in order, and counts the decisions
 ✓ src/scene/grilling-board.test.ts > a session on the whiteboard > puts a note for each question, coloured by its status, a tally of the round, and a ticked line for each decision, all on the board
 ✓ src/scene/grilling-board.test.ts > a session on the whiteboard > holds fifteen notes, a tally of eight and the latest twelve decisions at most
 ✓ src/scene/grilling-board.test.ts > a session on the whiteboard > shows only its headings before the first round
 ✓ src/scene/grilling-walks.test.ts > fact-finding visits, from a Floor's events > an Agent setting off and coming back is a visit each time; nothing else is
 ✓ src/scene/grilling-walks.test.ts > where a session sits in the meeting room > the Manager sits in the back row, facing the table, with the whiteboard behind it
 ✓ src/scene/grilling-walks.test.ts > where a session sits in the meeting room > visitors stand across the table from it, facing it, 0.8 m apart
 ✓ src/scene/grilling-walks.test.ts > where a session sits in the meeting room > for a team of 2: the Manager's way to its seat, and each Agent's to each spot, clear of furniture and walls once off its chairs
 ✓ src/scene/grilling-walks.test.ts > where a session sits in the meeting room > for a team of 6: the Manager's way to its seat, and each Agent's to each spot, clear of furniture and walls once off its chairs
 ✓ src/scene/grilling-walks.test.ts > where a session sits in the meeting room > for a team of 12: the Manager's way to its seat, and each Agent's to each spot, clear of furniture and walls once off its chairs
 ✓ src/scene/grilling-walks.test.ts > a session, timed > the Manager walks to the table when a session starts, sits there however long it runs, and walks back when it ends
 ✓ src/scene/grilling-walks.test.ts > a session, timed > a session already running is shown with the Manager seated, and paused it walks back
 ✓ src/scene/grilling-walks.test.ts > a session, timed > paused and resumed before it gets up, the Manager stays; resumed on its way back, it walks back to the table once home
 ✓ src/scene/grilling-walks.test.ts > a session, timed > waits to set off while the Manager is busy elsewhere, and a session over before it set off is never walked
 ✓ src/scene/grilling-walks.test.ts > a session, timed > a fact-finding Agent visits the Manager across the table for a moment, then walks back; again when it comes back
 ✓ src/scene/grilling-walks.test.ts > a session, timed > two visitors take two spots; one sent again while there stays longer; the Manager finding facts itself, or another Floor's, makes no visit
 ✓ src/scene/grilling-walks.test.ts > a session, timed > settled (reduced motion): the Manager at the table while a session runs, and no one visiting
 ✓ src/scene/grilling-walks.test.ts > the meeting room's walks together > shows the session's pose before a meeting's, and counts either as being in the meeting room
 ✓ src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > the Manager walks to the table as it starts and sits there while it runs, with the door's sign lit and the whiteboard filled in; it walks back when the session pauses
 ✓ src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > a session running when the Floor is shown has the Manager at the table already
 ✓ src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > an Agent sent to find facts leaves its desk to visit the Manager, then walks back; the Manager finding facts itself stays put
 ✓ src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > never visits for fact-finding that came before the Floor was shown
 ✓ src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > a Kickoff during the session waits for the Manager to be back from the table
 ✓ src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > with reduced motion the Manager is at the table while the session runs, and at its desk once it ends, never walking
 ✓ src/scene/grilling-room.test.tsx > the sign over the meeting room's door > says the room is in session, in HTML over the canvas
 ✓ src/scene/inspectable.test.ts > a Floor's inspectable objects > while a Grilling Session runs: its table, the Manager sat there, and the whiteboard and the Manager opening the session chat
 ✓ src/scene/inspectable.test.ts > an inspectable object's names > are the five object types of FR-58, the Manager's bookshelf of Skills (FR-73), the Agents (FR-13) and a running Grilling Session (FR-83)
 ✓ src/scene/inspectable-hotspots.test.tsx > the inspectable objects in the scene > while a Grilling Session runs, opens the session chat when the Manager, the table or the whiteboard is clicked (PRD FR-83), and the rest as ever
 ✓ src/scene/office-view.test.tsx > inspectable objects > while a Grilling Session runs, gives the scene its round and fact-finding, and opens the session chat from its table, the Manager or the whiteboard (FR-83)
 ✓ src/whiteboard.test.tsx > the whiteboard > shows the running session's current round, each question with its status, and follows the session as it changes (FR-83)
 ✓ src/activity-feed.test.tsx > event text > says how a Grilling Session went, from its counts
 Test Files  8 passed (8)
      Tests  142 passed (142)
```

The render tests print three.js's `THREE.Clock` deprecation note on
stderr, as the existing scene tests do.
