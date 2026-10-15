# Issue #66: Floor layout: desks, offices, meeting room and amenities — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) against a fresh `git clone` of this branch at the
issue's last commit before this note (`814c93a`), after
`pnpm install --frozen-lockfile`.

The blockers are built on this branch: #21, Agents and Roles with a default
team per Floor ([`issue-21.md`](issue-21.md)); and #65, the lobby, the lift
and its floor picker ([`issue-65.md`](issue-65.md)).

## What was built

All of it is in `apps/web/src/scene/` unless named otherwise.

- **A Floor's layout from its Agents** (`floor-layout.ts`, PRD FR-57).
  `floorLayout(agents)` lays out a Floor as data, as the lobby is, so tests
  check it against the art spec without WebGL. Like the lobby it is a
  cut-away: the back and left walls stand, 20 m wide. Along the back wall,
  from the left:
  - **the Manager's glass office**, 4 m × 4 m: glass from 0.9 m to the
    ceiling over a solid base, in a dark frame, with a 0.9 m × 2.1 m
    doorway. The Manager's desk is inside, facing the door, with a plant;
  - **the meeting room**, 6 m × 4 m, glazed the same way, with a feature
    wall. It has a 1.8 m × 1.2 m whiteboard (bottom edge 0.9 m up, with a
    frame and a tray) and a table for ten (four chairs each side, one at
    each end);
  - **the wall board**, 1.6 m × 0.9 m, its centre 1.6 m up (felt in a
    wooden frame, like the lobby's Notice Board), and **the bookshelf**
    with books on three shelves;
  - **the lift core**, the same as the lobby's and in the same place;
  - **the canteen**: a feature wall, a counter with **the coffee machine**
    and a mug on its worktop, a fridge, and a café table with two chairs.

  In front of them a 1.5 m corridor runs the Floor's width, to **the water
  cooler** (0.35 m × 0.35 m × 1.1 m) at its end. From the lift a 1.5 m
  aisle runs to the front, with **the gym** on its right (a mat, a
  treadmill, a weight bench, a kettlebell rack and an exercise ball).
- **The layout adapts to team size.** The Manager's desk is in its office.
  Every other Agent gets a desk in the open plan, left of the aisle, in the
  API's order (so adding an Agent moves no one): rows of up to five, 2.4 m
  apart, rows 2.8 m apart (`deskGrid`: 4 Agents are one row of 4, 6 are 2
  rows of 3, 12 are 3 rows of 4). Each row has a 1.5 m walkway behind its
  chairs, the carpet covers the desks, and the Floor grows towards the
  front for more rows (at least 4.5 m in front of the corridor, for the
  gym).
- **Desk sets** (`desk-set.ts`), at the spec's Desks table: a 1.4 m ×
  0.7 m top 0.74 m up, a 0.55 m × 0.33 m monitor with its top at 1.15 m,
  0.45 m from the front edge, and a chair with its seat at 0.46 m and its
  back to 0.95 m. Each has a stripe along its front edge in its Role's
  Stage colour (none for the Manager), and its **Role's dressing**:

  | Role | On the desk |
  | --- | --- |
  | coder | monitor, keyboard, a mug in `stage-work` |
  | designer | **dual monitors** on one stand, a drawing tablet and a pen in `stage-work` |
  | reviewer | monitor, keyboard, printouts with a `stage-review` pen, a mug |
  | QA | monitor, keyboard, **test devices**: a laptop (model), a tablet and a phone |
  | docs | monitor, keyboard, books (model), a notebook with a `stage-docs` pen |
  | manager | monitor, keyboard, a mug and a desk lamp |

  The spot on each desk's left is kept clear for the ticket pile of FR-62
  (not drawn yet).
- **The waypoint graph** (`waypoints.ts`; PRD §8: hand-placed waypoint
  paths, not a pathfinding library). The layout places waypoints in the
  walkways (the lift, the corridor and the aisle, each desk just behind its
  chair, the Manager's office and desk, the meeting room and whiteboard,
  the wall board, the bookshelf, the coffee machine, the water cooler and
  the gym) and joins them with straight edges. `walk(graph, from, to)` is
  the shortest way (Dijkstra's, by length), `reachable` the waypoints
  reachable from one. `floorSpots` names the spots every Floor has.
- **CC0 models** (`model-catalogue.ts`, `models/`, `models.ts`): six
  models from Kenney's Furniture Kit 2.0 (CC0-1.0, an approved source):
  the coffee machine, fridge, bookcase, books, a laptop and potted plants.
  The other furniture is built from pieces, as the lobby is.
  - `apps/web/scripts/prepare-models.ts` prepares them per the spec's
    checklist: baked to real size, the origin at the centre of the
    footprint on the floor, facing +z; each kit material recoloured to a
    palette token and renamed `token/surface`; texture coordinates dropped
    (there are no textures); Meshopt-compressed. Each file is 4 to 7 kB.
    Running it again on the kit gives byte-identical files. It adds
    `@gltf-transform/core`, `/extensions`, `/functions` and
    `meshoptimizer` as dev dependencies of the web app.
  - At run time each model is loaded once (GLTFLoader with three's Meshopt
    decoder) and turned into plain geometry per material. The scene merges
    every placed model by shared material, like pieces, so models cost no
    draw calls of their own. A Floor draws its pieces at once, and its
    models when they arrive.
  - `THIRD-PARTY-NOTICES.md` has their row: the files, what they are used
    for ("modified": scaled, recoloured, compressed), the kit's page and
    version, Kenney, CC0-1.0.
- **The scene** (`floor.tsx`, `office-location.tsx`): the Floor the lift is
  at is drawn from its layout. Its pieces are merged into one mesh per
  material, then its models, then the lift. On **Low** a soft contact
  shadow (`shadow` at 35%, about 30 cm of blur) lies under each desk and
  chair, as the spec's shadow table says (#65 noted these were missing).
  `OfficeLocationScene` moved out of `lobby.tsx` into
  `office-location.tsx`, so the Floor and the lobby can share the lift
  without an import cycle. The bare-floor stand-in is gone.
- **The Office view** fetches the Agents of the Floor the lift is at
  (`GET /api/floors/:floorId/agents`). `agent.created` and `agent.removed`
  events on that Floor refetch them, so desks come and go as Agents join
  and leave. In the lobby no Agents are fetched.
- **Pieces** (`pieces.ts`): `piece`, `standing` and quarter-turn placement
  are shared (the lobby uses them too). A box's chamfer is now one flat
  1.5 cm bevel (108 triangles a box) rather than a two-step round (300).
  The spec asks for a chamfer, and the two-step round put a desk set over
  its budget. The lobby's pieces fall from 18,696 to 7,944 triangles.
- **README:** "The 3D Office" describes the Floor, desk sets, waypoints and
  models, and how to prepare the models again.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from the fresh clone (output below). `pnpm build` passes too.

      At the start of this issue, the branch's own head (`36ed9e6`) failed
      `pnpm typecheck`: the merge of the Review Loop (which made a Notice's
      `links` required) and the lobby left four lobby test fixtures without
      `links`. Commit `620f686` adds `links: []` to them; nothing else
      changes. In a full run at that head, three lobby tests in
      `office-view.test.tsx` also timed out at 5 s. They pass alone, and
      they passed in every full run after this issue's changes.
- [x] **Unit tests: layout places N desks without overlap for 1 to 12
      Agents; waypoints connect every desk.** In `floor-layout.test.ts`,
      for every team of 1 to 12 Agents:
  - **No overlap.** Each Agent gets exactly one desk, in order, and no two
    desk sets (desk and chair) overlap. This holds both with the Manager
    first and with no Manager.
  - **Clear of everything else.** No desk set overlaps anything else that
    stands on the Floor (furniture, props, walls, glass, models) or any
    walkway.
  - **In the right place.** Every desk is on the Floor. The Manager's desk
    is inside the glass office, and no other desk is in the office or the
    meeting room.
  - **Waypoints connect every desk.** Every desk's waypoint is in the
    graph. Every waypoint is reachable from the lift. `walk()` finds a way
    from every desk to every one of the nine spots.
  - **Paths are clear.** Each edge, sampled every 5 cm, stays on the Floor
    and at least 0.2 m (half an Agent's shoulders) from anything standing
    between the floor and 1.9 m.

  These are 72 parameterised tests (6 checks × 12 team sizes), plus:
  - **The spec's measurements** (read from
    [`art-direction.md`](../reference/art-direction.md)'s text and
    tables): desk spacing on the 0.1 m grid; the desk top, monitor and
    chair; the office, meeting room, whiteboard, doors, wall board and
    walkways (all at least 1.5 m, clear of furniture and props); and
    everything under the 3 m ceiling;
  - **Role dressing:** dual monitors for the designer; the laptop, tablet
    and phone for QA; books and a notebook for docs; printouts for the
    reviewer; a lamp for the Manager. Each Stage's stripe colour, the clear
    ticket-pile spot, and the Manager facing the door;
  - **Budgets:** each Role's desk set within Low's 1,500 triangles (the
    designer's is the largest, at 1,500), the architecture within Medium's
    20,000, and a 12-Agent Floor with room for 13 Avatars at 6,000 within
    a frame's 300,000;
  - **Adapting:** the grid for 0 to 12, a Floor that is deeper for more
    rows, and a Floor with no Agents that still has its rooms;
  - **Walks:** the shortest walk from the lift to a first-row desk.

  Also new:
  - `floor.test.tsx` (6 tests, `@react-three/test-renderer`):
    - rooms and desks as one mesh per shared material;
    - models merged into the palette's shared materials, casting shadows;
    - pieces drawn at once and the six model files fetched and drawn once
      they arrive;
    - desks added and removed as the team changes;
    - contact shadows on Low only, one per desk and chair, sized to them
      and above the carpet;
    - the cost of a 12-Agent Floor: 46 meshes, 33 casting shadows (about
      91 draw calls with the shadow pass and post-processing, against
      Medium's 200, leaving room for 12 Avatars) and 31,376 triangles.
  - `model-catalogue.test.ts` (21 tests): the six files and nothing else
    in `models/`. Each model is at its catalogue size (within 5 mm), on the
    floor, its footprint centred. Each has only palette `token/surface`
    materials, is within Low's per-asset triangle limit, needs
    `EXT_meshopt_compression` and is under 1 MB. The bookshelf's shelves
    are where the layout puts books, and THIRD-PARTY-NOTICES.md's row
    names every file, the kit's URL and version, Kenney and CC0-1.0.
  - `office-view.test.tsx` (2 new tests): on a Floor the scene gets its
    Agents, and an `agent.created` event on that Floor's stream adds the
    new one; in the lobby, no Agents are fetched.
  - `lobby.test.tsx` now takes `OfficeLocationScene` from its new module
    and gives the Floor its models from disk. What it checks is unchanged.

  **Negative checks** (each reverted afterwards):
  - The second desk column moved to 1.1 m from the first: 22 tests failed.
  - The first row's desks chained to a waypoint that does not exist: 23
    tests failed.
  - Desk waypoints 0.5 m closer to their chairs: 12 tests failed (paths
    within 0.2 m of chairs).
  - Contact shadows back at 4 mm, under the carpet: 1 test failed.

**Rendered in headless Chromium.** This uses #64's method: Playwright's
Chromium headless shell, its missing libraries unpacked from Debian
bookworm's packages into `/tmp` (nothing installed), and SwiftShader. A
throwaway page under Vite (deleted afterwards) rendered the real
`OfficeView` on a Floor at 1280 × 720, with a stubbed `fetch` for the
Floor and its Agents. The models were served by Vite.

- **Overview, Medium, the default team** (Manager, coder, reviewer, QA)
  and **13 Agents**: the glass office with the Manager's desk, the meeting
  room's table, chairs and whiteboard, the wall board, the bookshelf with
  books, the lift, the canteen, the gym and the water cooler all read from
  the high three-quarter view. The desks are in rows on the carpet, and
  the key light casts soft shadows. No page or shader errors appeared; the
  only console warning was R3F's `THREE.Clock` deprecation (see #64).
- **Close up of the desks:** the stripes in their Stage colours; QA's
  laptop, tablet and phone; the reviewer's printouts, pen and mug.
- **Close up of the meeting room:** ten chairs round the table, the
  whiteboard with its frame and tray, and the Manager's desk and lamp
  through the glass.
- **Close up of the canteen:** the coffee machine and mug on the counter,
  the fridge, the café table and chairs, and a plant.

  These views found two real problems, both fixed in `7a484b9`. Low's
  contact shadows were drawn 4 mm up, under the 1 cm carpet, so they never
  showed; a test now checks they are above it. The fridge, in brushed
  steel, read almost black (as #65 noted for the lift's metal), so its
  body is now `ceramic`.
- **Low:** soft blobs under each desk and chair.
- **Frame rate:** SwiftShader renders on the CPU, so its rate says nothing
  about a GPU and was not recorded.

### Verified on the host

- [ ] **A Floor with the default team matches the art spec and holds 60 fps
      at medium.** This cannot be verified here: there is no GPU or
      display.

      To check it on the host:
      1. Run `pnpm dev` and open http://localhost:3045 at 1080p.
      2. Add a Floor (its team is the default: Manager, coder, reviewer,
         QA), then pick it in the lift's floor picker.
      3. Turn on **Scene settings** → Medium and **Show frame rate**, and
         read the overlay for a minute in the Overview and Close up views.
      4. Check the look against
         [`docs/reference/art-direction.md`](../reference/art-direction.md):
         the palette, soft key shadows, glass at 25%, lamps blooming and
         walls not blooming, and desks, chairs and the coffee machine told
         apart at a glance.

      What can be measured here is within Medium's budgets: about 91 draw
      calls against 200 and 31,376 triangles against 300,000 with 12
      Agents. The default team draws fewer.

### Not verifiable in this sandbox

- **How it looks and how fast it runs on a real GPU**: the Floor's
  composition and colours as lit, soft shadows through the glass, how the
  lamps bloom, and the frame rate at each setting. The screenshots above
  were SwiftShader's.
- **The e2e suites** (no Docker). Signed-in tests that ride the lift to a
  Floor now also fetch that Floor's Agents, which the route serves to the
  session they already have.
- **The screenshot tests** of PRD §9 (a Floor at a fixed seed) are not part
  of this issue.

## Noticed, out of scope

- **Floor Template themes** (FR-57: stock shelves for an Online store,
  server racks for Infrastructure). Floors carry no template yet, and the
  Roles are still the fixed list of `@ai-office/shared` (#21) rather than
  a Role library with its own desk dressing (FR-98). The dressing here is
  keyed by those six Roles.
- **The red light at the Manager's office** for an action Notice, the
  ticket piles, the receiving monitor lighting up and the paused marker
  (FR-62 and FR-59) need state the layout does not have. The ticket pile's
  spot is kept clear on every desk.
- **What the wall board and whiteboard show** (FR-50, FR-57) and clicking
  them, the monitors or the bookshelf (#67, interactions) are not built.
  The wall board is a blank felt board.
- **Agents at their desks and walking the waypoints** are #70
  (characters). `walk()` gives the way; the meeting room's ten seats are
  in the layout (`meetingSeats`) for Kickoffs, but have no waypoints of
  their own yet.
- **More than 12 Agents** add rows, and the Floor grows towards the front.
  The overview camera does not move with it, so a large team's front rows
  can leave the default view.
- **The spec's per-asset triangle limits on Low.** With no LODs, a desk
  set must fit Low's 1,500. The designer's is exactly 1,500. Any more
  dressing would need LODs or instancing, which the spec asks for desks,
  chairs and monitors; here they are merged per material instead, which
  is as cheap in draw calls.
- **Glass** is one shared `MeshStandardMaterial` at 25% on every setting.
  The spec's `MeshPhysicalMaterial` with transmission on High is not done
  (it was not in the lobby either).
- **`@gltf-transform/functions`** brings `sharp` (with its prebuilt
  binaries) into the dev dependencies. It is only needed to prepare the
  models. The Docker image's build stage installs it with the other dev
  dependencies; its runtime stage (production dependencies only) does
  not.
- **The models' licence check** covers `apps/web/src/scene/models/` only.
  A test over every asset in the repository would enforce the spec's rule
  generally (also noted in #63).
- **The main chunk** is unchanged (840.2 kB → 840.5 kB). The lazy scene
  chunk grew from 1,319 kB to 1,409 kB (455 kB gzipped) for the GLTF
  loader, the Meshopt decoder and the layout. The six models are separate
  files of 4 to 7 kB.

## Output

`pnpm lint` (fresh clone):

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
 Test Files  153 passed (153)
      Tests  1591 passed | 256 skipped (1847)
   Duration  25.98s (import 40%, tests 38%, environment 11%, transform 9%, setup 2%)
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
dist/assets/index-Btuv7_TE.css              35.83 kB │ gzip:   7.29 kB
dist/assets/index-D6kYFabo.js              840.51 kB │ gzip: 255.55 kB
dist/assets/office-scene-ChjX4TNO.js     1,409.43 kB │ gzip: 455.31 kB
(!) Some chunks are larger than 500 kB after minification. Consider:
✓ built in 781ms
```

The new and changed scene test files, verbose (parameterised tests counted
once, with how many cases they have):

```text
✓ floor-layout.test.ts > a Floor's desks > gives each of N Agents a desk, none overlapping (×12, N = 1 to 12)
✓ floor-layout.test.ts > a Floor's desks > keeps the desks of N Agents clear of every other thing on the Floor, and of its walkways (×12)
✓ floor-layout.test.ts > a Floor's desks > keeps the desks of N Agents on the Floor, out of its rooms (×12)
✓ floor-layout.test.ts > a Floor's desks > puts open-plan desks 2.4 m apart side by side and 2.8 m front to back, on the 0.1 m grid
✓ floor-layout.test.ts > a Floor's desks > adapts to the team: rows of up to five, and a deeper Floor for more rows
✓ floor-layout.test.ts > a desk set > is at the spec's sizes: desk top, monitor and chair
✓ floor-layout.test.ts > a desk set > is dressed for its Role
✓ floor-layout.test.ts > a desk set > carries its Stage's colour on a stripe along the desk's edge; the Manager's has none
✓ floor-layout.test.ts > a desk set > keeps the ticket pile's spot on the desk's left clear for every Role
✓ floor-layout.test.ts > a desk set > puts the Manager's desk in the glass office, facing its door
✓ floor-layout.test.ts > a Floor's waypoints > connect every desk of N Agents to the lift and every spot (×12)
✓ floor-layout.test.ts > a Floor's waypoints > keep every path of N Agents' Floor clear of furniture and walls (×12)
✓ floor-layout.test.ts > a Floor's waypoints > put each desk's waypoint just behind its chair, in the walkway
✓ floor-layout.test.ts > a Floor's waypoints > walk the shortest way: from the lift down the aisle to a desk
✓ floor-layout.test.ts > a Floor's rooms and amenities > has the Manager's glass office and the meeting room at the spec's sizes
✓ floor-layout.test.ts > a Floor's rooms and amenities > has the wall board on the back wall at the spec's size and height
✓ floor-layout.test.ts > a Floor's rooms and amenities > has a bookshelf with books, a canteen with a coffee machine, a gym and a water cooler
✓ floor-layout.test.ts > a Floor's rooms and amenities > stands on its floor, under its 3 m ceiling
✓ floor-layout.test.ts > a Floor's rooms and amenities > keeps walkways at least 1.5 m wide, on the Floor and clear of furniture and props
✓ floor-layout.test.ts > a Floor's rooms and amenities > casts shadows from furniture and props only, never from walls
✓ floor-layout.test.ts > a Floor's cost > keeps each Role's desk set within the spec's Low budget, the tightest
✓ floor-layout.test.ts > a Floor's cost > keeps the architecture within Medium's budget, and a 12-Agent Floor well within a frame's
✓ floor.test.tsx > a Floor in the scene > draws its rooms and desks as one mesh per shared material
✓ floor.test.tsx > a Floor in the scene > merges the asset pack's models in, in the palette's shared materials
✓ floor.test.tsx > a Floor in the scene > draws its pieces at once, and its models when they have loaded
✓ floor.test.tsx > a Floor in the scene > adds a desk when an Agent joins, and takes one away when one leaves
✓ floor.test.tsx > a Floor in the scene > puts a soft contact shadow under each desk and chair on Low, and none on Medium or High
✓ floor.test.tsx > a Floor's cost > is within Medium's per-frame budgets with 12 Agents, leaving room for their Avatars
✓ model-catalogue.test.ts > the prepared models > are every file in models/, and nothing else is
✓ model-catalogue.test.ts > the prepared models > has <model> at its size, on the floor, its footprint centred (×6)
✓ model-catalogue.test.ts > the prepared models > recolours <model> to the palette, with shared material names (×6)
✓ model-catalogue.test.ts > the prepared models > keeps <model> within its triangle limit on Low, Meshopt-compressed and under 1 MB (×6)
✓ model-catalogue.test.ts > the prepared models > puts the bookshelf's shelves where the catalogue says
✓ model-catalogue.test.ts > the prepared models > are listed in THIRD-PARTY-NOTICES.md with their source and licence
✓ office-view.test.tsx > the lobby and the Floors > gives a Floor's desks its Agents, and keeps them as Agents join
✓ office-view.test.tsx > the lobby and the Floors > asks for no Agents in the lobby
  (and office-view.test.tsx's 13 earlier tests, unchanged)
 Test Files  4 passed (4)
      Tests  119 passed (119)
```
