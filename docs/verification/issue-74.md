# Issue #74: Handoff walks — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code
commit (`b5540a0`, a test change after the README commit, which changes
only Markdown).

The blocker is built on this branch: #73, the Agents' states in the
Office ([`issue-73.md`](issue-73.md)), on which the walking Agent takes up
its state again once it is back in its chair. The walk also stands on:

- #66, the Floor's layout ([`issue-66.md`](issue-66.md)): the
  hand-placed waypoint graph (PRD §8), with each desk's waypoint on the
  walkway behind its chair, and `walk()`, its shortest way;
- #68, the monitors ([`issue-68.md`](issue-68.md)), which now light up as
  a ticket arrives;
- #70, the character kit ([`issue-70.md`](issue-70.md)): the shared rig
  and its `stand-up`, `walk` and `carry` (with a ticket in hand)
  animations, made for this issue;
- the `handoff` event (FR-26, FR-52), which the coder, reviewers, QA and
  docs Agents already publish as each receiving Agent takes the work:
  `fromAgentId`, `toAgentId`, `issue` and the `stage` it moves to.

## What was built

- **Two more animations** (`scene/avatar-animations.ts`), making
  fourteen: `hand-over`, standing and holding the ticket out as `carry`
  holds it, then reaching it forwards with a nod (1 s, the ticket in
  hand); and `sit-down`, `stand-up` played backwards (its keys mirrored in
  time), from standing to the seat. `carry`'s hold is now shared by both
  (`ticketHold`).
- **The way, as data** (`scene/handoff-walks.ts`). `handoffRoute(layout,
  from, to)` is the path from the giver's seat to beside the receiver's
  chair:
  - off its chair: a step 0.55 m aside (`stepAside`), to the side nearer
    where it is going, then straight back to its walkway, level with its
    desk's waypoint (for the Manager, whose waypoint is beside its chair,
    the two are one);
  - along the waypoint graph's shortest way (`walk()`) from the giver's
    desk waypoint to the receiver's. Joining the walkway past its own
    waypoint, on the way to the next, it goes straight on: it never
    doubles back behind its own chair (and likewise at the receiver's);
  - in to beside the receiver's chair, where it turns to face the
    receiver's seat (`handOverHeading`).

  It is undefined for an Agent to itself, or for one with no desk on the
  Floor. `pointAlong` and `headingAlong` say where the path is, and which
  way it heads, a distance along it, rounding each corner over 0.25 m.
- **The walk, timed** (`handoffWalk`, `walkPose`): stand up (1.2 s), carry
  the ticket along the way at 1.25 m/s (`walkSpeed`, matching the walk
  cycle's stride), hand it over (1 s), walk back the same way, sit down
  (1.2 s). `walkPose(walk, elapsed)` gives the position, heading,
  animation and whether the ticket is in hand; the ticket leaves the hand
  at `handOverAt`.
- **Each Agent's queue, skipping when behind** (`queueHandoff`,
  `advanceHandoffs`, `skipHandoffs`). The pipeline never waits: a
  `handoff` event is published after the work has moved on, and the walk
  only shows it. Each Agent (the giver) walks one Handoff at a time:
  - a Handoff for an Agent with nothing to walk is walked at once;
  - one for an Agent already walking waits, and the walk under way plays
    at twice the pace (`catchUpPace`) while it does;
  - one that arrives while another already waits has fallen behind: the
    waiting one is skipped, its ticket handed over at once, and the new
    one waits instead. So a queue never holds more than the walk under
    way and one waiting, and a burst (a reconnection replaying missed
    events, a round to three reviewers) shows its first and its newest;
  - a Handoff that cannot be walked (no way, reduced motion) is handed
    over at once.

  `createHandoffWalker(floorId)` keeps a Floor's queues as the scene plays
  them, ignores other Floors' Handoffs, and keeps each receiving
  monitor's light: lit for 3 s from the hand-over, fading over the last
  second (`monitorLight`).
- **In the scene** (`scene/handoff-tickets.tsx`, `desk-agents.tsx`,
  `monitor-screens.tsx`, `floor.tsx`):
  - `HandoffWalks` moves the walker on each frame and gives it each
    Handoff that arrives while the Floor is shown (earlier ones have been
    and gone, and are not walked). With reduced motion it skips every
    walk: no one walks, and each ticket is handed over at once.
  - Each `DeskAgent` takes its place, heading and animation from its walk
    while it is on one, its animation at the hurried pace when it is
    hurried; back in its chair, it takes up its state's animation again
    (#73's `type`, `wait` or `sit`).
  - **The ticket's label** is the issue's number (`#14`) in HTML over the
    canvas (drei's `Html`, as the art direction asks: "labels, ticket
    numbers and panels are HTML over it"), in the colour of the stage it
    goes to (`stage-review`, `stage-qa`…, or `paper` for another stage),
    floating over the ticket in the Agent's hands (0.35 m ahead, 1.3 m up)
    from setting off until it is handed over. It takes no pointer events,
    stays under the Office's panels (`zIndexRange` 0) and is
    `aria-hidden` (the Activity Feed has each Handoff).
  - **The receiving monitor lights up**: `monitorInstances` draws a
    display for an idle Agent lit by a ticket, at `screen-glow` × 1.8
    (within the spec's 1.2 to 2.0, as a new line's pulse peaks), fading
    back to dark; a working one pulses to the same brightness. With
    reduced motion the glow is steady for the 3 s, then dark. No draw call is added: the displays are
    the monitors' existing instanced mesh.
  - The stages' HTML colours moved from the wall board's panel to
    `scene/stage-colours.ts`, shared by both.
- **The Office feeds it** (`office-view.tsx`): the Floor's `handoff`
  events come on the stream that already keeps its Agents and wall board
  live (no new stream), which also reads the wall board again at each
  (a Handoff to review says who waits on it, #73). The scene is given the
  Floor's Handoffs, oldest first (`handoffTickets`). In the lobby there
  are none.
- **README:** a new "Handoff walks" section; "The 3D Office" (Agents at
  their desks, the animations) and "Agents' states in the Office" (the
  events it reads) updated.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too.
- [x] **Unit tests: path planning over waypoints.**
      `scene/handoff-walks.test.ts`, "the way a Handoff is walked":
  - for every team of 2 to 12 Agents (the Manager first), for **every**
    ordered pair of its Agents: the way starts at the giver's seat and
    ends 0.55 m beside the receiver's chair; it leaves its chair in one
    or two legs, then **every leg runs along an edge of the waypoint
    graph** (all of it or part), then it reaches the receiver's chair in
    one or two legs; its length is its legs', and no longer than the
    graph's shortest way between the two desks' waypoints plus the steps
    on and off; it faces its desk in its chair and the receiver as it
    hands over (11 parameterised tests, 572 ways);
  - for teams of 2, 5, 6 and 12, every way, sampled every 5 cm, stays on
    the Floor and at least 0.2 m (half an Agent's shoulders) from
    anything standing between the floor and 1.9 m, once it is 0.45 m from
    either chair (the Agent rises from inside its own);
  - to a neighbour in the row it goes straight along the walkway, every
    step the same way, 3.85 m in all (0.55 aside, 1 back, 1.3 along, 1
    in);
  - to and from the Manager it goes through the glass office's door;
  - none for an Agent to itself, or with an Agent not on the Floor;
  - `pointAlong` finds a point along a path and clamps to its ends.

  And the walk on it ("a Handoff walk"): its parts at the desks last as
  long as the `stand-up`, `hand-over` and `sit-down` animations; it
  stands at its seat, carries the ticket along the way facing where it
  goes, hands over at the end facing the receiver, walks back the same
  way facing home, and sits down; it never moves faster than walking
  pace.
- [x] **Unit tests: the animation queue skips when behind.**
      "each Agent's queue of Handoff walks":
  - it sets off at once, hands the ticket over on arriving (once only),
    and is done once back;
  - a ticket that cannot be walked is handed over at once;
  - the next Handoff waits behind the walk under way, which hurries at
    twice the pace while it does (it ends in half its time), and then
    sets off at its own pace;
  - **ten Handoffs at once for one Agent: the eight between the first and
    the newest are handed over the moment a newer one comes; the first is
    walked (hurried) and then the newest, and every ticket is handed over
    within those two walks**;
  - 500 Handoffs, one every 50 ms, never leave more than two not yet
    handed over (the one walking and the one waiting);
  - two Agents' walks run side by side, each in its own queue;
  - skipping hands every ticket over at once, under way and waiting, and
    none twice.

  "a Floor's Handoff walker": another Floor's Handoffs are ignored; the
  receiving monitor lights as the ticket is handed over, fades from 1 to
  0 over the light's last second, and goes; a ticket not walked lights it
  at once; skipping lights each. "Handoff tickets from the event stream":
  only `handoff` events become tickets, with their issue, stage and
  Agents.

  Around them:
  - `handoff-tickets.test.tsx` (React Three Fiber's test renderer, the
    real `Floor`): the coder stands at its seat, sets off with the ticket
    in its hands while the reviewer's monitor is dark, hands it over
    beside the reviewer's chair facing it, and the reviewer's monitor
    lights at `screen-glow` × 1.8 as the ticket leaves its hands; it walks
    away, the light goes after 3 s, and it is back in its chair facing its
    desk. Handoffs from before the Floor was shown are not walked. **Work
    never waits:** while the coder is on its way, the reviewer's and the
    coder's own monitors show their new work at once. **Four Handoffs at
    once:** QA's and docs' monitors light at once (skipped), the first
    walk hurries to the reviewer, then the coder sets off again with the
    newest, to the Manager. With reduced motion no one walks and the
    monitor holds a steady glow, then goes dark. The label is the issue's
    number in its stage's colour (`paper` for `ready-to-merge`); it is
    there only while the ticket is carried, `aria-hidden`, 1.3 m up and
    0.35 m ahead of the Agent, and goes with it.
  - `avatar-kit.test.ts`: the animation set is fourteen; `hand-over`
    holds a ticket (and only it and `carry`, besides `drink`'s mug). For
    each of the twelve bodies: `sit-down` is `stand-up` backwards (the
    hips, head, a foot and a hand within 1 mm at five times) and ends as
    `sit` begins; `hand-over` stands with the feet down, starts with the
    hands where `carry` holds them, and reaches them further forwards,
    between the hips and the head.
  - `office-view.test.tsx`: a `handoff` on the team's stream reaches the
    scene as a ticket; no other stream carries Handoffs; the lobby has
    none.

  **Negative checks** (each reverted afterwards; the three test files
  above run each time):
  - No hurrying (`catchUpPace` 1): 1 test failed.
  - A waiting Handoff never skipped: 3 failed.
  - The receiving monitor never lit: 3 failed.
  - The Agents never walk (no walker given to them): 3 failed.
  - Doubling back past its own desk (its waypoint kept): 2 failed.
  - Handoffs from before the Floor was shown walked: 1 failed.
  - The Office not streaming Handoffs: 1 failed.
  - No step off the chair: 1 failed.
  - Stepping only 0.3 m aside, too close to the chair: 4 failed (the
    clearance sweep, for each team size).

  The first run of the "no hurrying" check passed every test: the queue
  tests compared the pace with `catchUpPace` itself. They now pin it at
  twice the pace.

### Rendered in headless Chromium

As in #64 to #73: Playwright's Chromium headless shell, its missing
libraries unpacked from Debian bookworm's packages into `/tmp` (nothing
installed), and SwiftShader. A throwaway page under Vite (deleted
afterwards) rendered the real `OfficeScene` at Medium, 1280 × 720, on a
Floor of six Agents (Manager, coder, reviewer, QA, docs, designer), and
gave it Handoffs as the Office would.

SwiftShader ran the scene at about 4.5 fps, and each screenshot took over
10 s, so the first run's timed shots missed the walk (the coder was seen
standing up, then already back). The page's clock (`performance.now`,
which three.js's clock reads) was then slowed to 1/20 once the Handoff
was given, and a frame captured every 0.5 to 1 s of scene time:

- **0 to 1.1 s:** the coder rises from its chair.
- **2.0 to 5.0 s:** beside its chair, then along the walkway behind the
  reviewer's, the ticket held out in both hands, with a purple
  (`stage-review`) `#14` label floating just over it; at 5.0 s it stands
  beside the reviewer's chair, facing it, reaching the ticket out.
- **6.0 s** (the hand-over is due at 5.3 s): the label is gone, the
  coder walks back empty-handed, and the reviewer's monitor glows
  `screen-glow`.
- **8.8 to 11.5 s:** back along the walkway, then seated at its desk, the
  reviewer's monitor dark again.

From the default view (Overview, at real speed), a QA Agent's Handoff to
the Manager was caught twice: carrying a pink (`stage-docs`) `#21` ticket
along its row's walkway towards the aisle, then at the corridor's far end
by the Manager's office door. The labels read clearly at that distance.

The only console output was R3F's `THREE.Clock` deprecation (see #64)
and React's DevTools notice; no errors.

### Verified on the host

- [ ] **A real Handoff plays smoothly.** On the host: `pnpm dev` with a
      Floor whose coder, reviewer and QA Agents are set up (README,
      "Let Agents work issues"), open http://localhost:3045, ride the lift
      to the Floor and label an issue `ai-office`. When the coder opens
      its pull request and the reviewers take it, the coder gets up and
      walks a `#N` ticket in the review colour to each reviewer's desk
      (the second hurried after the first), each reviewer's monitor
      lighting as it arrives; at approval the reviewer walks one in the QA
      colour to QA, and QA one in the docs colour to docs. Things to judge
      there, at Low, Medium and High: whether the walk reads as smooth at
      60 fps (the walk cycle against the 1.25 m/s pace: no sliding feet),
      the turns at corners, the cross-fades between standing, carrying,
      handing over, walking and sitting, whether the label is readable
      and stays over the ticket, and whether the monitor's light reads
      from the default view. Then pause the stream (stop the server for a
      minute while work moves on, and start it again): the replayed
      Handoffs should show at most two walks per Agent, the rest lighting
      their monitors at once.

### Not verifiable in this sandbox

- **A real Handoff from a real run** (no Docker): the `handoff` events
  were stubbed, in the shape the coder, reviewers, QA and docs publish.
- **How it moves on a real GPU**: smoothness and frame rate. SwiftShader
  ran the scene at about 4.5 fps, which says nothing about a GPU; the
  walk adds no draw calls (the Agents are drawn already, the monitors'
  displays are instances of their mesh) and one HTML label per carried
  ticket.
- **The Postgres and e2e runs** (no Docker): skipped here, as before;
  nothing they check changes.

## Noticed, out of scope

- **What stays at the desk while its Agent walks:** the paused or capped
  marker over the seat (#73), the Agent's contact shadow on Low and High,
  and its inspectable box (clicking where it sat still opens its card).
  #73 noted the markers; the Context Usage bar (FR-85, #120) must follow
  a walking Agent too, and would share whatever moves these.
- **The ticket in the Agent's hands is `paper`**: the art direction says
  the tickets carried at a Handoff are in their Stage's colour. The
  label carries the colour here; the ticket prop is the character kit's,
  one for every Avatar, and colouring it per Handoff would need a
  material or vertex colour of its own.
- **Walkers pass through each other**: there is no avoidance. Walkways
  are 1.5 m wide so two Agents can pass (the art direction), but two on
  the same way overlap.
- **A walk keeps the way it was planned with**: if the team changes and
  the desks move mid-walk, the Agent finishes the old way and then sits
  at its new desk.
- **The `handoff` event is published as the receiving Agent starts**, so
  the receiver is usually already at work (its monitor glowing) when the
  ticket arrives. That is the issue's "the pipeline never waits".
- **Meetings** (Kickoff, Wrap-up, FR-60) are #85's.

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
 Test Files  200 passed (200)
      Tests  2411 passed | 306 skipped (2717)
   Duration  35.34s (tests 42%, import 35%, environment 13%, transform 8%, setup 2%)
```

One earlier full run, while the sandbox's host was under heavy load (load
average 72), failed one test that this issue does not touch:
`floor-layout.test.ts` › "keep every path of 10 Agents' Floor clear of
furniture and walls" timed out at Vitest's 5 s (it takes about 1 s alone;
the whole run took 73 s rather than 35 s). It passed in the next full
run and alone (77 of 77). This issue's own clearance sweep, the same kind
of test, was then made cheaper (`b5540a0`: only what is near each way is
checked, 1.3 s down to 0.6 s for 12 Agents) and still fails when the walk
comes too close to a chair (above).

`pnpm build` (the web app's assets):

```text
dist/assets/index-B0tP2zki.css            45.98 kB │ gzip:   9.44 kB
dist/assets/office-scene-DsDBBLvc.js     497.79 kB │ gzip: 214.58 kB
dist/assets/index-B2O05Jk9.js            950.66 kB │ gzip: 289.14 kB
✓ built in 748ms
```

The new and changed tests, verbose:

```text
✓ handoff-walks.test.ts > the way a Handoff is walked > goes from each of 2 Agents' seats over the waypoints to beside every other's chair
  (and the same for 3 to 12 Agents: 11 tests)
✓ handoff-walks.test.ts > the way a Handoff is walked > keeps every walk of 2 Agents' Floor clear of furniture and walls, once off the chairs
  (and for 5, 6 and 12 Agents)
✓ handoff-walks.test.ts > the way a Handoff is walked > goes straight along the row to a neighbour, never doubling back past its own desk
✓ handoff-walks.test.ts > the way a Handoff is walked > walks to and from the Manager's glass office
✓ handoff-walks.test.ts > the way a Handoff is walked > has no way for an Agent to itself, or for an Agent not on the Floor
✓ handoff-walks.test.ts > the way a Handoff is walked > finds a point along the way and clamps to its ends
✓ handoff-walks.test.ts > a Handoff walk > times the parts at the desks by the animations they play, and walks there and back
✓ handoff-walks.test.ts > a Handoff walk > stands, carries the ticket there, hands it over, walks back and sits down
✓ handoff-walks.test.ts > a Handoff walk > moves at walking pace every step of the way
✓ handoff-walks.test.ts > each Agent's queue of Handoff walks > sets off at once, hands the ticket over on arriving, and is done once back
✓ handoff-walks.test.ts > each Agent's queue of Handoff walks > hands a ticket over at once when it cannot be walked
✓ handoff-walks.test.ts > each Agent's queue of Handoff walks > queues the next Handoff behind the walk under way, which hurries while it waits
✓ handoff-walks.test.ts > each Agent's queue of Handoff walks > skips forward when it falls behind: a waiting Handoff is handed over at once for a newer one
✓ handoff-walks.test.ts > each Agent's queue of Handoff walks > never holds more than the walk under way and one waiting, however fast they come
✓ handoff-walks.test.ts > each Agent's queue of Handoff walks > walks each Agent's Handoffs in its own queue, side by side
✓ handoff-walks.test.ts > each Agent's queue of Handoff walks > hands every ticket over at once when skipped, under way and waiting
✓ handoff-walks.test.ts > a Floor's Handoff walker > walks its own Floor's Handoffs, ignoring another's
✓ handoff-walks.test.ts > a Floor's Handoff walker > lights the receiving monitor as the ticket is handed over, then lets it fade
✓ handoff-walks.test.ts > a Floor's Handoff walker > lights the monitor at once for a ticket that is not walked
✓ handoff-walks.test.ts > a Floor's Handoff walker > skips every walk at once, lighting each receiving monitor
✓ handoff-walks.test.ts > Handoff tickets from the event stream > takes each Handoff's issue, stage and Agents, and nothing else
✓ handoff-tickets.test.tsx > a Handoff walk on a Floor > gets up, carries the ticket to the next desk, hands it over, walks back and sits down
✓ handoff-tickets.test.tsx > a Handoff walk on a Floor > never walks the Handoffs that came before the Floor was shown
✓ handoff-tickets.test.tsx > a Handoff walk on a Floor > never holds up the work: the monitors show it at once, while the walk plays on
✓ handoff-tickets.test.tsx > a Handoff walk on a Floor > skips forward when it falls behind: only the first and the newest are walked
✓ handoff-tickets.test.tsx > a Handoff walk on a Floor > walks no one with reduced motion: the ticket is handed over at once
✓ handoff-tickets.test.tsx > the ticket's label > is the issue's number, in the colour of the stage it goes to
✓ handoff-tickets.test.tsx > the ticket's label > floats over the ticket as it is carried, in HTML, and goes once it is handed over
✓ avatar-kit.test.ts > the animation set > has the fourteen animations, each for every bone of the rig
✓ avatar-kit.test.ts > the animation set > holds a mug to drink and a ticket to carry and hand over, and nothing else
✓ avatar-kit.test.ts > the animation set > sits a slim male Avatar back down as it stood up, and holds a ticket out to hand it over
  (and the same for the other eleven bodies)
✓ office-view.test.tsx > what the Agents' states look like > gives the scene each Handoff on the Floor as it comes, on the team's own stream
  (and "shows no states in the lobby, nor reads a wall board there", now with no Handoffs there)
```
