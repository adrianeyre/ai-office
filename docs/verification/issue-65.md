# Issue #65: Lobby with the 3D Notice Board and floor picker — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) against a fresh `git clone` of this branch at the
last code commit of the issue (`d696d80`), after
`pnpm install --frozen-lockfile`.

The blockers are built on this branch: #27, Notices and the 2D Notice Board
([`issue-27.md`](issue-27.md)); #63, the art direction spec
([`issue-63.md`](issue-63.md)); and #64, the 3D scene shell
([`issue-64.md`](issue-64.md)).

## What was built

All of it is in `apps/web/src/scene/`.

- **The board preview mapping** (`notice-board-preview.ts`, PRD FR-50 and
  FR-57). `boardPreview(notices)` turns the open Notices into what the
  lobby's 3D Notice Board shows:
  - the latest six as cards, newest first (ties by id), filling a 3 × 2 grid
    from the top left; closed Notices (dismissed or acted on) are left off;
  - each card's kind as a colour and a shape: an action card is
    `state-critical` with two pins, an info card `state-info` with one;
  - each title as one to three lines of "writing", as long as the title (28
    characters a line), so no text is drawn in the scene (PRD §7);
  - a tilt of up to 3° from a hash of the Notice's id, so a card keeps its
    look as others come and go;
  - the Notices beyond six as a stack of up to three sheets under the last
    card, and the counts by kind with a sentence for the HTML ("The Notice
    Board has 3 action Notices and 5 info Notices; the latest 6 are pinned
    up.").
- **The lift's stops** (`lift-stops.ts`): the lobby, then each Floor in use
  in the API's order, each with its open action Notices (the lobby counts
  those about the whole Office).
- **The lift's ride** (`lift.ts`, pure functions like the camera rig): a
  call closes the doors (0.6 s), the car travels, eased, for 0.8 s to 2.4 s
  depending on how far it goes, and the doors open on the new stop. The
  scene shows the stop the car is at, so it changes behind closed doors when
  the car arrives. A call while the doors close goes to the new stop
  instead, a call back to the stop being left opens the doors again, a call
  mid-travel turns the car from where it is, and a call to where it is or is
  going changes nothing. With reduced motion it is there at once.
- **`useLiftStore`** (`lift-store.ts`): the lift and whether the floor
  picker is open. A call flies the camera to a `lift` view in front of the
  doors; on arrival the camera goes back to the overview while the doors
  open.
- **The lobby as data** (`lobby-layout.ts`, `lift-layout.ts`, `pieces.ts`):
  16 m × 12 m, cut away so the back and left walls stand and the default
  view looks in from the front right. It has:
  - the entrance: double glass doors, two 0.9 m × 2.1 m doors in a dark
    frame, with a mat;
  - the Communications Agent's reception (FR-96): a counter, the desk, a
    monitor facing the chair, the out-tray, a desk lamp and the chair, sized
    as the spec sizes a desk; a `wall-feature` wall behind it;
  - the Notice Board on the back wall: 1.6 m × 0.9 m felt (`floor-carpet`)
    in a wooden frame, its centre 1.6 m up;
  - a waiting area (two `sofa` sofas, a coffee table with a mug and a
    magazine, a rug) and four plants;
  - the lift core, the same in the lobby and on a Floor: the wall round a
    0.9 m × 2.1 m doorway, its frame and sill, the shaft and the car with
    its light, and the call panel;
  - four walkways, from the entrance to the lift doors and to the Notice
    Board and reception.

  Each piece is a simple shape (a box with a 1.5 cm chamfer, a cylinder or
  a sphere) in a palette token and a surface. The scene merges pieces that
  share a material into one mesh.
- **Shared materials** (`materials.ts`): one `MeshStandardMaterial` per token
  and surface, named `token/surface`. Each surface has the finish of its row
  in the spec's table. Screens and lamps glow in their token, at 1.2 and 1.6,
  and glass is the only see-through material, at 25% opacity.
- **The scene** (`lobby.tsx`; `office-scene.tsx` now shows where the lift
  is):
  - the lobby: its merged pieces, the board's cards as three instanced
    meshes (paper sheets, writing and stripes, pins, each tinted per
    instance), and the lift;
  - a Floor: the bare floor of #64 and the same lift core (its rooms are
    #66);
  - the lift's moving parts: two sliding doors; a lamp over them for each
    stop (at most 8), the car's lit in `lamp`, the others `screen-off`; a
    red (`state-critical`) marker under the lamp of a stop with an action
    Notice; and the lit call button. Clicking the doors or the button opens
    the floor picker. `LiftDriver` advances the ride each frame.
- **HTML panels** (`lobby-panels.tsx`, `office-view.tsx`):
  - **Lift** (a disclosure, open at first) holds the floor picker. It lists
    the lobby and every Floor, each Floor's repository as its tooltip. A
    stop with action Notices shows a badge with a bell and the count, and a
    screen reader hears "Web shop, 2 action Notices". The current stop has
    `aria-current="location"`, and a status line says "You are in Lobby." or
    "Going to Web shop…".
  - In the lobby only, the board's sentence and **Open the Notice Board**,
    which opens `/notices` without a reload.
  - The Office view fetches the Floors and the open Notices. `notice.*`
    events and each reconnection of the stream refetch them
    (`useLiveNotices`, from #27). A Floor archived while it is shown sends
    the lift back to the lobby.
- **Tests without WebGL:** `@react-three/test-renderer` 9.1.1 (dev
  dependency) renders scene components in tests.
- **README:** "The 3D Office" describes the lobby, the board, the lift and
  the new store.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from the fresh clone (output below). `pnpm build` passes too.
- [x] **Component tests for the board preview data mapping.**
  - `notice-board-preview.test.ts` (14 tests) covers the mapping itself:
    - an empty board;
    - newest first, filling the grid from the top left, whatever order the
      Notices arrive in, with a stable order for ties;
    - at most six cards, the rest a stack of up to three sheets, and the
      sentence for each case;
    - action and info told apart by colour and by their pins;
    - every Floor's Notices and the Office's own, but not closed ones;
    - every turned card and its pins within the board, and no two cards
      overlapping;
    - a card's tilt not changing with the rest of the board;
    - titles as line lengths only: none of a title's words end up in a card;
    - the line rule and the hash.
  - `lobby.test.tsx` (10 tests, the R3F components rendered by
    `@react-three/test-renderer`):
    - **The board:** bare with no Notices. Two Notices give two sheets,
      pins `state-critical`, `state-critical`, `state-info`, and the
      writing as a kind-coloured stripe then ink lines (two lines for the
      29-character title). Felt, stacked sheets, cards, writing and pins are
      each in front of the one before, and the felt's face matches the
      layout. Eight Notices give six cards and two sheets, and the board
      follows `update`s as Notices come and go.
    - **The lift:** a lamp per stop, the lobby's lit, and a red marker
      under Blog's lamp only. Clicking the doors or the call button opens
      the picker. Riding to a Floor closes the doors while the lobby is
      still shown, then shows the Floor and not the lobby, with the doors
      open again and Web shop's lamp lit. With reduced motion it is there
      in one frame.
    - **The cost** with a full board: 27 meshes, 12 casting shadows and
      19,372 triangles. That is about 51 draw calls with the shadow pass
      and a dozen post-processing passes, against Medium's 200, and far
      under its 300,000 triangles.
  - `office-view.test.tsx` (7 new tests, in jsdom against a stubbed
    server):
    - the scene stand-in gets the board preview of the open Notices, and
      the panel says what the board shows;
    - a streamed `notice.raised` refetches, and the board pins the latest
      six of eight;
    - the link opens `/notices` without a reload;
    - the picker lists Lobby, Web shop (2 action Notices) and Blog with
      their indicators, the lobby current;
    - picking Web shop flies the camera to the lift and says "Going to Web
      shop…". The lobby panel stays until arrival; then the Floor is
      current and the camera goes back to the overview. Going back down
      works from the keyboard;
    - the **Lift** button hides and shows the picker;
    - an archived Floor sends the lift back to the lobby.

    The six earlier tests now render with a `QueryClientProvider` and the
    stubbed server; what they check is unchanged.
  - Also:
    - `lift.test.ts` (18 tests: the stops and their action counts; every
      case of the ride; the store's camera moves, its silence while idle,
      and reduced motion);
    - `materials.test.ts` (12 tests: each surface's metalness and
      roughness read from the spec's Materials table; binary metalness;
      shared, named materials; emissives; glass at 25%);
    - `lobby-layout.test.ts` (12 tests). They check against the spec's
      text and tables:
      - palette tokens on fitting surfaces;
      - everything on the floor and under the 3 m ceiling, and furniture
        inside the walls;
      - the board's size and height;
      - the doors' size;
      - the reception's seat, desk-top and monitor heights and the
        monitor's 0.45 m;
      - walkways at least 1.5 m wide, clear of furniture and joined from
        the entrance to the lift doors;
      - only furniture and props casting shadows;
      - architecture under Medium's 20,000 triangles, in fewer than 30
        merged meshes;
      - the lift core in the back wall with its doorway clear.

  **Negative checks** (each reverted afterwards):
  - Cards ordered oldest first: 7 tests failed (mapping, 3D and view).
  - One pin for both kinds: 2 tests failed.
  - Dismissed and acted-on Notices kept on the board: 1 test failed.
  - The scene switched to the new stop as the doors start to close: 6 tests
    failed.
  - The writing and pins put back at the card-relative depth this issue
    first had (see below): the layering test failed.

**Rendered in headless Chromium.** The method of #64: Playwright's
Chromium headless shell, with its missing system libraries fetched from
Debian's bookworm mirror into `/tmp` (nothing installed), and SwiftShader.
A throwaway page under Vite (deleted afterwards) rendered the real
`OfficeView` with a stubbed `fetch` (3 Floors, 0 to 8 Notices) at
1280 × 720:

- **Low, Medium and High** each drew the lobby with no page error and no
  shader error. The only console output was R3F's `THREE.Clock` deprecation
  (see #64), and 502s from the event stream, which had no server behind it.
- **Overview, Medium:** the entrance, reception, the board, the lift and
  the waiting area all read from the high three-quarter view, with soft key
  shadows on the floor.
- **Close up of the board:** six cards, red action cards with two pins and
  blue info cards with one, lines of writing and the stacked sheets.

  This view found a real bug: the stripes, writing and pins had been placed
  at card-relative depths, behind the felt, so only blank cards showed. It
  was fixed, and the layering test was added for it.
- **Close up of the lift:** a lamp per stop, the lobby's lit, with red
  markers under the two Floors with action Notices, and the lit call
  button. It also showed a gap under the doorway where the background came
  through, now closed by a sill. Behind the wall, the shaft had been a dark
  metal box over the wall top; it is now plastered like the wall.
- **A ride:** clicking **Web shop** in the picker went `closing` →
  `travelling` → `opening` (on `web-shop`) → `idle`. The arrival showed
  Web shop's bare floor with the lift core, and the picker said "You are in
  Web shop.".
- **The lift frozen mid-ride:** both doors shut, Web shop's lamp lit, and
  "Going to Web shop…".
- **Frame rate:** SwiftShader renders every pixel on the CPU, so the rate
  says nothing about a GPU and was not recorded.

### Verified on the host

- [ ] **The lobby matches the art spec and holds 60 fps at medium.** This
      cannot be verified here: there is no GPU or display. On the host, run
      `pnpm dev` and open http://localhost:3045 at 1080p. Add a Floor or two
      and raise some Notices, or use real ones. Then turn on **Scene
      settings** → Medium and **Show frame rate**, and read the overlay for
      a minute in the Overview and while riding the lift. Check the look
      against [`docs/reference/art-direction.md`](../reference/art-direction.md):
      the palette, soft key shadows, emissive lamps blooming and walls not
      blooming, and that it is readable from the high three-quarter view.

      In the sandbox, what can be measured is within Medium's budgets: about
      51 draw calls against 200, 19,372 triangles against 300,000, and the
      architecture under 20,000.

### Not verifiable in this sandbox

- **How it looks and how fast it runs on a real GPU:** the lobby's
  composition and colours as lit, the soft shadows, how much the lamps and
  red markers bloom, and the frame rate at each setting. The screenshots
  above were SwiftShader's.
- **The e2e suites** (no Docker). Signed-in tests land on `/`, which now
  also fetches `/api/floors` and `/api/notices` when the browser has WebGL
  2. Both routes exist and need only the session those tests already have.
- **The 3D scene's screenshot tests** of PRD §9, at fixed seeds in CI, are
  not part of this issue.

## Noticed, out of scope

- **Contact shadows on Low.** The spec gives Low "a soft dark blob under
  each desk, chair and Agent", and `qualityPresets.low.contactShadows.props`
  says so. The reception desk and chair have none yet. A shared blob for
  every room's desks and chairs would suit the issue that builds the
  Floors' desks (#66).
- **The Communications Agent** is not at its desk yet: there is no Avatar or
  rig in the scene. Its envelope into the out-tray and its failing-Connection
  marker (FR-96) need it and the Communications work.
- **Clicking the Notice Board** does nothing yet; flying in and opening its
  panel is #67 (FR-58). The lobby's board links to the 2D board instead.
- **Floors are bare floors** with the lift core. Their rooms and Floor
  Template themes are #66; Floors do not carry a template yet.
- **Metal reads almost black** (the lift doors, frames and call panel) under
  #64's environment at intensity 0.4: metal shows mostly reflections. It
  would be worth a look on the host. If it is too dark, the spec's
  environment intensity is the place to change it, not the tokens.
- **Seams between wall pieces.** Each wall piece is chamfered, so where two
  meet (the back wall and the lift core) a faint groove shows.
- **The lift's lamps show at most 8 stops.** With more Floors, the picker
  still lists every one, but stops past the eighth have no lamp.
- A stop's place in the run follows the API's order of Floors, so adding or
  archiving a Floor moves the others' lamps.
- **The 2D Notice Board** marks action Notices in Tailwind's amber; the 3D
  board and the picker use `state-critical`, as the art direction says. The
  2D board could take the `office-state-*` colours (also noted in #63).
- `@react-three/test-renderer` loads three.js through `require`, so the
  test run prints three's CJS deprecation warning once.
- The main chunk grew from 707.9 kB to 717.6 kB: the Office view, outside
  the lazy scene chunk, now holds the queries, the lift store and the
  panels. three.js stays in the scene chunk (1,319 kB, 428 kB gzipped).

## Output

`pnpm lint` (fresh clone):

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

`pnpm test`, without Docker (the Postgres and Docker tests skip):

```text
 Test Files  137 passed (137)
      Tests  1384 passed | 239 skipped (1623)
   Duration  34.10s (import 42%, tests 35%, transform 12%, environment 10%, setup 1%)
```

`pnpm build` (the web app's assets):

```text
dist/assets/icon-BQiMWJ90.svg             1.45 kB │ gzip:   0.63 kB
dist/assets/index-f-YvDwdM.css           35.34 kB │ gzip:   7.24 kB
dist/assets/index-hHnAdOJV.js           717.59 kB │ gzip: 217.66 kB
dist/assets/office-scene-Bspv10ll.js  1,319.04 kB │ gzip: 428.29 kB
(!) Some chunks are larger than 500 kB after minification. Consider:
✓ built in 521ms
```

The new and changed tests, verbose:

```text
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > is empty, and says so, with no open Notices
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > pins the latest Notices newest first, filling the grid from the top left
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > orders by when each was raised, whatever order they come in
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > shows at most six cards; the rest are a stack of up to three sheets
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > tells an action Notice from an info one by colour and by its pins
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > shows every Floor's Notices, and those about the whole Office
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > leaves off a Notice already dismissed or acted on
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > keeps every card, turned and pinned, on the board
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > gives a card the same tilt whatever else is on the board
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the Notice Board's preview > writes a card's title as lines as long as the title, never as text
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > a title's lines of writing > are one full line per line's worth of characters, then the rest
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > a title's lines of writing > are at most three, however long the title
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > a title's lines of writing > make even a very short title a word, not a dot
 ✓ |@ai-office/web| src/scene/notice-board-preview.test.ts > the hash that turns a card > is stable and between 0 and 1
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give paint the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give wood the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give fabric the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give plastic the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give metal the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give screen the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give lamp the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > give glass the metalness and roughness of its row in the spec
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > are binary in metalness, and none shinier than 0.3 but glass and screens
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > are made once for each token and surface, and named for them
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > make only screens and lamps glow, in their own token
 ✓ |@ai-office/web| src/scene/materials.test.ts > the shared materials > make glass the only see-through one, at 25% opacity
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's stops > are the lobby, then each Floor in use, in order
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's stops > count each Floor's open action Notices, and the lobby the Office's own
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's stops > tell places apart
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > waits in the lobby, doors open, with nothing to do
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > closes its doors, travels and opens them on the new stop, which is shown only on arrival
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > eases the car between stops
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > takes longer the further it goes, within its bounds
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > carries time left over from one phase into the next
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > ignores a call to where it is, or is already going
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > goes to a new stop if called while its doors close
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > opens its doors again if called back to the stop it is leaving
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > turns towards a new stop from where the car is, mid-travel
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > is there at once with reduced motion, even mid-ride
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift's ride > ignores negative time
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift store > starts in the lobby with the floor picker open
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift store > flies the camera to the lift doors when called, and back to the overview on arrival
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift store > notifies no one while the lift is idle
 ✓ |@ai-office/web| src/scene/lift.test.ts > the lift store > is on the new stop by the next frame with reduced motion
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > is coloured from the palette only, each token on a surface that suits it
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > stands on its floor, under its 3 m ceiling
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > keeps its furniture inside its walls
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > has the Notice Board on the back wall at the spec's size and height
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > has doors of the spec's size: the entrance two, the lift one
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > seats the Communications Agent's reception as the spec sizes a desk
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > keeps walkways at least 1.5 m wide, and clear of furniture and props
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > has walkways from the entrance to the lift's doors
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > casts shadows from furniture and props only, never from walls
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lobby > is within the spec's Medium budgets, in few draw calls
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lift core > is in the lobby's back wall, the wall running up to it on both sides
 ✓ |@ai-office/web| src/scene/lobby-layout.test.ts > the lift core > leaves the doorway open, between its frame
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lobby's Notice Board > is bare when there are no Notices
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lobby's Notice Board > pins a card for each Notice: an action card red with two pins, an info card blue with one
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lobby's Notice Board > layers the board: felt, stacked sheets, cards, then their writing and pins
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lobby's Notice Board > stacks the Notices beyond six behind the last card
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lobby's Notice Board > changes as Notices are raised and closed
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lift > has a lamp for each stop, the car's lit, and a red marker for a stop with an action Notice
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lift > opens the floor picker when its doors or its call button are clicked
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lift > closes its doors, rides to a Floor and shows it, then opens them
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lift > is on the Floor in one frame with reduced motion
 ✓ |@ai-office/web| src/scene/lobby.test.tsx > the lobby's cost > is within the spec's per-frame budgets at Medium, with a full Notice Board
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > says so when the browser has no WebGL 2, and loads no scene
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > renders the scene, with its panels beside the canvas rather than in it
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > flies the camera to the view picked, and shows where it is going
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > changes the quality setting, which the scene is drawn at
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > turns reduced motion on and off
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > shows the frame rate over the scene when asked
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the lobby > gives the 3D Notice Board the latest open Notices, and says what it shows
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the lobby > pins up only the latest six, as the Notices change live
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the lobby > opens the 2D Notice Board from the lobby, without a reload
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the lobby > lists the lobby and every Floor in the lift's floor picker, with their action Notices
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the lobby > rides the lift to the Floor picked, then shows it
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the lobby > hides and shows the floor picker with the Lift button
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the lobby > goes back to the lobby when the Floor it shows is archived
 Test Files  6 passed (6)
      Tests  79 passed (79)
```
