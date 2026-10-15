# Issue #67: Inspectable objects: fly-in and HTML overlay — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) against a fresh `git clone` of this branch at the
issue's last commit before this note (`e93b374`), after
`pnpm install --frozen-lockfile`.

The blocker, #64 (the 3D scene shell: canvas, camera rig and its named
views, the selection store, quality settings), is built on this branch
([`issue-64.md`](issue-64.md)). The objects made inspectable here are the
ones #65 (the lobby's Notice Board, [`issue-65.md`](issue-65.md)) and #66
(a Floor's monitors, whiteboard, wall board and bookshelf,
[`issue-66.md`](issue-66.md)) put in the scene.

## What was built

All of it is in `apps/web/src/scene/` unless named otherwise.

- **A generic `Inspectable`** (`inspectable.ts`, PRD FR-58): an object type
  (`monitor`, `whiteboard`, `notice-board`, `wall-board`, `bookshelf`) and
  an id: an Agent's for a monitor, the Floor's for its whiteboard, wall
  board and bookshelf, and `office` for the lobby's Notice Board. It is a
  kind of the existing `Selection`, so Agents' cards (FR-63) and
  inspectable objects are selected in one store. `lobbyInspectables()` and
  `floorInspectables(floorId, agents)` give each object where the lift is,
  with:
  - a **box** in world space over what is drawn there: each desk's screens
    (a designer's two together, from `DeskSet.screens`, new in
    `desk-set.ts`), the boards' faces and the bookshelf (whose place
    `floor-layout.ts` now exports);
  - a **camera view close in** (`viewOf`): from in front of it and a little
    above, as far back as the object needs to fill most of the view, at
    least 1.3 m. It is framed in the part of the canvas between the HTML
    controls on the left and the panel on the right;
  - a **label** for the list and the panel ("Ada's monitor", "The
    whiteboard").
- **Opening and closing** (`inspection.ts`): `openInspectable` selects the
  object, registers its view with the camera rig and flies there, keeping
  the view the camera was at (`returnView`, new in the selection store).
  Opening another object from an open one keeps the first return view.
  `closeInspectable` clears the selection and flies back, or leaves the
  camera alone when the lift is taking it.
- **In the scene** (`inspectable-hotspots.tsx`): an unseen box over each
  object (its material is not drawn, but three.js raycasts it) with R3F's
  pointer events. Pointing at one highlights it, with a veil of `paper` at
  20% outlined in `ink` (the palette's outline colour; no new colour), and
  a pointing cursor. Clicking it opens it. The highlight is not drawn while
  the object's panel is open, and an object leaving the scene with the
  pointer on it (the lift leaves) is no longer pointed at.
- **The panel** (`inspector.tsx`): an HTML `dialog` region over the scene,
  on the right, with the object's label as its heading and **Close panel**.
  Its body is the object type's entry in `inspectorPanels`
  (`inspector-panels.tsx`), so each type's own issue replaces one entry.
  Until then, each says what it will show and links to the 2D page that
  shows it today: a monitor to its Agent's live view, the wall board to
  the Floor's Notices, the lobby's Notice Board to the Notice Board. Links
  open without a reload. Focus moves into the panel as it opens and back
  to where it was as it closes.
- **The Office view** (`office-view.tsx`):
  - computes the objects where the lift is (the lobby's, or the Floor's
    from its live team) and gives the same list to the scene and the HTML;
  - **Escape** closes the open panel and flies back;
  - a ride in the lift closes it (the lift takes the camera), and so does
    its object leaving, such as an Agent removed with its monitor open.
- **The keyboard list** (`InspectablesList`): **Inspect**, under the floor
  picker, opens a list of every object where the lift is. Arrow keys,
  Home and End move through it (wrapping round). Focusing or pointing at
  an entry highlights its object in the scene, and Enter or a click opens
  the same panel and flies in, as clicking the object does (PRD §7: every
  action in the 3D office is reachable from the keyboard).
- **2D routes** (`router.tsx`, `pages.tsx`): the Office's address names
  the open object, `/?floor=web-shop&inspect=monitor:ada`, or
  `/?inspect=notice-board:office` in the lobby (`inspectHref`,
  `inspectSearch`, `inspectTargetOf`). Opened from a link, the view waits
  for the Floors, rides the lift to the object's Floor, waits for its
  Agents, then opens it. An address naming no object, or a Floor that is
  not one, opens nothing. As objects open and close, the address follows,
  replacing the history entry rather than adding one.
- **Pieces as data** (`pieces.ts`, new `piece-geometry.ts`): the three.js
  geometry (`pieceGeometry`, `mergePieces`, `triangles`) moved out of
  `pieces.ts`, so the layouts can be used by the Office's HTML (which the
  inspectables need) while three.js stays in the scene's lazy chunk (#64).
  Behaviour is unchanged; seven files' imports moved.
- **README:** "The 3D Office" describes the inspectable objects, the
  keyboard list, the address and the layouts being data.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from the fresh clone (output below). `pnpm build` passes too.
- [x] **Component tests: selection opens the right panel type; keyboard
      list opens the same panel.** In `office-view.test.tsx` (the real
      `OfficeView` against a stubbed server, with the canvas replaced by a
      stand-in that shows what it was given):
  - **Selection opens the right panel type.** On a Floor with a Manager
    and a coder, each of its five objects is selected as a click in the
    scene selects it (`openInspectable`, which the hotspot's `onClick`
    calls; the click itself is tested in `inspectable-hotspots.test.tsx`).
    Each time exactly one dialog is open, its `data-kind` is the object's
    type, its heading is the object's label, its text is that type's, and
    its links are that type's (the monitor's to
    `/floors/web-shop/agents/<agent>`, the wall board's to
    `/notices?floorId=web-shop`, none for the whiteboard and bookshelf).
    The camera is heading for that object's view. A separate test does the
    same for the lobby's Notice Board (linking to `/notices`).
  - **The keyboard list opens the same panel.** The wall board is opened
    by selection and its panel recorded, then closed. Then, by keyboard
    only: **Inspect** with Enter, Tab into the list, ArrowDown to "The
    wall board" (which highlights it in the scene), Enter. The panel is
    equal to the recorded one (type, heading, text and links), the camera
    flies in, the entry is marked current, and focus is in the panel.
    Escape closes it, the camera heads back to the overview, and focus is
    back on the list entry. End, ArrowDown (wrapping), ArrowUp and Home
    move through the list.
  - Also in that file: the list and the scene get the same objects (the
    lobby's one, then a Floor's five in order); **Close panel** flies back
    to the view the camera was at (Plan); a lift ride closes the panel and
    leaves the camera to the lift; an Agent removed (`agent.removed`)
    closes its monitor's panel; an address opens its object after riding
    the lift and loading the Agents, is not told of that opening, and is
    told of later ones and of closing; an address naming no object, or a
    Floor that does not exist, opens nothing and leaves the lift where it
    is.

  Also new:
  - `inspectable.test.ts` (32 tests, 24 of them over teams of 1 to 12):
    - one object of each type where the lift is, in order;
    - each monitor's box holds every one of its desk's screen pieces (two
      for a designer) and is narrower than the desk; the whiteboard's,
      wall board's and bookshelf's boxes hold their pieces or model; no two
      boxes overlap, so a click picks one object;
    - **every view, for teams of 1 to 12 and the lobby**, through the
      scene's own camera (35°, 16:9): every corner of the object's box is
      on screen, between the controls and the panel; the camera is inside
      nothing solid; and no piece or model stands between the camera and
      the object's box. Each view is also inside the Floor, above 0.5 m
      and under the ceiling. A monitor spans more than a fifth of the
      canvas;
    - the address round-trips (`inspectHref`, `inspectTargetOf`), an id
      may hold a colon, and malformed addresses give nothing.
  - `inspectable-hotspots.test.tsx` (7 tests, `@react-three/test-renderer`):
    a box over each object at its place and size, its material not drawn;
    a ray from the object's view hits it; pointer over and out highlight
    and unhighlight it with the cursor (and only it); a highlight from the
    keyboard list; a click opens it and flies in, and no veil is drawn over
    an open object; the lobby's Notice Board is the lobby's only object;
    an object leaving the scene with the pointer on it is no longer
    hovered.
  - `stores.test.ts` (4 new): opening selects and flies in to the object's
    own view; closing flies back to the view before; opening a second
    keeps the first return view; closing without flying back, and closing
    leaves an Agent's card selection alone.
  - `office-route.test.tsx` (4 tests, the app's router with the view
    stubbed): `?floor=…&inspect=…` and `?inspect=…` reach the Office view
    as the object; a malformed one gives none; opening and closing in the
    view rewrites the address, replacing the history entry.

  **Negative checks** (each reverted afterwards):
  - The whiteboard given the bookshelf's panel: 1 test failed.
  - Escape no longer closing: 2 tests failed.
  - The keyboard list's entries not opening their object: 1 test failed.
  - A click on a hotspot not opening its object: 2 tests failed.
  - A lift ride not closing the panel: 1 test failed.
  - Closing not flying back: 6 tests failed.
  - The address ignored by the route: 3 tests failed; the address added to
    history rather than replaced: 1 test failed.
  - On the first framing (beside the panel only): views with no sideways
    shift, from behind the object, or too close failed 13 tests each, and
    monitor boxes 10 cm smaller than the screens 12.
  - The hotspot's clean-up removed (a highlight left behind by the lift): 1
    test failed.

**Rendered in headless Chromium.** As in #64 and #66: Playwright's
Chromium headless shell, its missing libraries unpacked from Debian
bookworm's packages into `/tmp` (nothing installed), and SwiftShader. A
throwaway page under Vite (deleted afterwards) rendered the real
`OfficeView` at 1280 × 720 with a stubbed `fetch`, a Floor of five Agents
(Manager, coder, reviewer, QA, designer), and the models served by Vite.
Each object's box centre was projected to the screen with the camera's
pose, and real mouse events were sent there. It was run twice, before and
after the fixes below:

- **Lobby:** moving over the Notice Board highlighted it (the store's
  `hovered`, the pointer cursor, and the outlined veil in the screenshot).
  A click opened "The Notice Board" panel and flew in; Escape flew back to
  the overview.
- **Floor:** the whiteboard, wall board, bookshelf, and the Manager's, the
  coder's and the designer's monitors were each hovered, clicked, shown
  close in with their panel, and closed with **Close panel**, back to the
  overview. The monitors were seen from their Agent's side, the designer's
  two screens together, the Manager's through the glass office.
- **Keyboard:** **Inspect**, Tab, ArrowDown highlighted the wall board in
  the scene; Enter opened its panel and flew in.
- The only console output was R3F's `THREE.Clock` deprecation (see #64)
  and React's DevTools notice.

  This look found three real problems, fixed in `a1f1eb7` and `ff2c2d2`,
  each with a test:
  - the left-hand controls (view picker, floor picker, list) covered the
    top-left of an object flown in to: views were framed beside the panel
    only, and are now framed between the controls and the panel;
  - the hover veil stayed over an object while its panel was open, washing
    it out; an open object is no longer veiled;
  - an object hovered as the lift left stayed hovered, so it would have
    been highlighted with no pointer on it when the lift came back.

  The panel's close button was also renamed **Close panel**, apart from
  the **Close up** view.

### Not verifiable in this sandbox

- **How it looks and moves on a real GPU**: whether the highlight (a 1 px
  `ink` outline and a 20% `paper` veil) is strong enough at a glance on
  every object, the feel of the fly-in and fly-back, and the frame rate
  while flying. The screenshots were SwiftShader's, at a few frames a
  second.
- **Other canvas sizes.** Views are framed for the controls and panel on a
  1280-pixel-wide canvas (`controlsShare`, `panelShare`). On a wider
  canvas there is more room; on a narrow one the panel and the controls
  take more of it, and an object may sit partly under them.
- **Screen readers.** The panel is a labelled `dialog` region (not modal:
  the scene's controls stay usable), focus moves into it and back, and
  every control is a button or link with a name. It was not tried with a
  screen reader.
- **The e2e suites** (no Docker). Signed-in tests that land on `/` now
  see the **Inspect** button too; nothing they check is changed.

## Noticed, out of scope

- **Each object type's own panel** (the monitor's live activity, the
  whiteboard's Plans, the bookshelf's memory, the boards' Notices) is the
  issue's out of scope; each is one entry in `inspectorPanels`.
  `AgentLiveView` already exists for the monitor's.
- **PRD FR-58 also says "every entry links to GitHub and to other
  objects"**: entries are what those panels show. `inspectHref` is the
  link to another object for them to use.
- **Clicking an Agent** (FR-63, the Agent card) shares the selection store
  but is not built; `closeInspectable` leaves an Agent selection alone.
- **The Manager's office bookshelf** opens the Available Skills list
  (FR-73). The Floor has one bookshelf, for memory; the Manager's office
  has none yet.
- **`three-mesh-bvh` for picking** (PRD §8): not needed here. The hit
  areas are single boxes, never the merged room meshes, so a raycast tests
  a dozen boxes.
- **Bundle sizes.** The layouts moved into the main chunk with the
  inspectables (840.5 kB → 869.8 kB, 265.8 kB gzipped), and out of the
  scene's (1,409.4 kB → 1,390.1 kB). three.js is still only in the scene's
  chunk.
- **The camera does not follow a resize.** A view is computed once per
  object; on a canvas much narrower than 1280 pixels the framing above
  does not adapt.

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
 Test Files  156 passed (156)
      Tests  1647 passed | 256 skipped (1903)
   Duration  37.54s (import 39%, tests 37%, transform 11%, environment 11%, setup 1%)
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
dist/assets/index-gUeryewe.css              36.08 kB │ gzip:   7.34 kB
dist/assets/index-DBWrgkgC.js              869.84 kB │ gzip: 265.81 kB
dist/assets/office-scene-DAoPyAxp.js     1,390.14 kB │ gzip: 448.99 kB
(!) Some chunks are larger than 500 kB after minification. Consider:
✓ built in 728ms
```

The new and changed test files, verbose (parameterised tests counted once,
with how many cases they have):

```text
✓ inspectable.test.ts > a Floor's inspectable objects > are its whiteboard, wall board and bookshelf, then each Agent's monitor in order
✓ inspectable.test.ts > a Floor's inspectable objects > put a box over every screen of N Agents' desks, and over each board and the bookshelf (×12, N = 1 to 12)
✓ inspectable.test.ts > a Floor's inspectable objects > fly in to each of N Agents' Floor's objects, seeing it whole between the controls and the panel, with nothing in the way (×12)
✓ inspectable.test.ts > a Floor's inspectable objects > comes close in: a monitor fills a good part of the view
✓ inspectable.test.ts > the lobby's inspectable objects > are the office-wide Notice Board
✓ inspectable.test.ts > the lobby's inspectable objects > fly in to the Notice Board, seeing it whole between the controls and the panel, with nothing in the way
✓ inspectable.test.ts > an inspectable object's names > has a camera view of its own
✓ inspectable.test.ts > an inspectable object's names > are the five object types of FR-58
✓ inspectable.test.ts > an inspectable object's names > has an address in the Office, and is read back from it
✓ inspectable.test.ts > an inspectable object's names > reads nothing from an address that names no object
✓ inspectable-hotspots.test.tsx > the inspectable objects in the scene > put a box over each object, picked by the pointer but never drawn
✓ inspectable-hotspots.test.tsx > the inspectable objects in the scene > picks an object from a ray at its box
✓ inspectable-hotspots.test.tsx > the inspectable objects in the scene > highlights an object while the pointer is over it, with a pointing cursor
✓ inspectable-hotspots.test.tsx > the inspectable objects in the scene > is no longer highlighted once it leaves the scene with the pointer on it
✓ inspectable-hotspots.test.tsx > the inspectable objects in the scene > highlights the object focused in the keyboard list
✓ inspectable-hotspots.test.tsx > the inspectable objects in the scene > opens an object's panel and flies the camera in when it is clicked
✓ inspectable-hotspots.test.tsx > the inspectable objects in the scene > are where the lift is: in the lobby, its Notice Board
✓ office-view.test.tsx > inspectable objects > lists every object where the lift is, and gives the scene the same
✓ office-view.test.tsx > inspectable objects > opens the right panel for each type of object selected in the scene
✓ office-view.test.tsx > inspectable objects > opens the lobby's Notice Board panel, linking to the 2D Notice Board
✓ office-view.test.tsx > inspectable objects > opens the same panel from the keyboard list, and Escape closes it and flies back
✓ office-view.test.tsx > inspectable objects > closes with its close button, flying back to the view the camera was at
✓ office-view.test.tsx > inspectable objects > closes when the lift rides elsewhere, leaving the camera to the lift
✓ office-view.test.tsx > inspectable objects > closes an Agent's monitor when the Agent leaves the Floor
✓ office-view.test.tsx > inspectable objects > opens an object from the Office's address, riding the lift to its Floor first
✓ office-view.test.tsx > inspectable objects > opens nothing for an address that names no object, or a Floor that is not one
  (and office-view.test.tsx's 15 earlier tests, unchanged)
✓ stores.test.ts > opening an inspectable object > selects it, and flies the camera in to its own view
✓ stores.test.ts > opening an inspectable object > flies back to where the camera was when it closes
✓ stores.test.ts > opening an inspectable object > goes back to where it was before the first, when one opens another
✓ stores.test.ts > opening an inspectable object > leaves the camera where it is when told not to fly back, and does nothing with nothing open
  (and stores.test.ts's 10 earlier tests; the selection store's now resets with resetSelection)
✓ office-route.test.tsx > the Office's address > names an object on a Floor for the Office to open
✓ office-route.test.tsx > the Office's address > names the lobby's Notice Board without a Floor
✓ office-route.test.tsx > the Office's address > names nothing when it names no object
✓ office-route.test.tsx > the Office's address > follows what opens and closes in the Office, without adding to history
 Test Files  5 passed (5)
      Tests  81 passed (81)
```
