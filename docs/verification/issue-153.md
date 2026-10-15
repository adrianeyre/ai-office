# Issue #153: 3D Floor themes and Role desk dressing — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display). `pnpm lint`, `pnpm typecheck` and `pnpm test`
ran in a fresh `git clone` of this branch at `3d1aeb4` (every code, test
and docs commit of the issue but the CI step after it, which changes
only `ci.yml`, a script and a paragraph of the guide), after `pnpm install
--frozen-lockfile`. The Postgres, end-to-end and screenshot runs were
made in the working tree at the same code.

The blockers are built on this branch:

- **#147, Floor Templates** ([`issue-147.md`](issue-147.md)): the
  template format, whose manifest already named a `theme` that nothing
  drew, the loader and adding a Floor from a template. #150 and #151
  added the eight other built-in templates, each with its theme id.
- **#66, the Floor layout** ([`issue-66.md`](issue-66.md)): the Floor
  generated from its Agents, its desk sets and their dressing, which
  were keyed by the built-in Roles. Its note put "Floor Template themes"
  out of scope for want of templates and a Role library.

## What was built

### Themes are data (`packages/shared`, `packages/db`, `packages/orchestrator`, `apps/server`)

- **`floorThemes`** (`shared/src/floors.ts`): the nine themes the Office
  can draw: `office`, `stockroom`, `studio`, `editorial`, `library`,
  `atelier`, `observatory`, `data-centre`, `device-lab`. A template's
  manifest is checked against it ("The 3D theme is one of …"), where it
  took any id before.
- **A Floor keeps its theme** (`theme` on `floorSchema` and
  `FloorRecord`; the `floors.theme` column with a check): its template's
  when it is added, Development's `office` when it is added without one.
  It is never read from the template again (PRD FR-97: "nothing depends
  on it later"), so a Floor keeps its look when its template is changed
  or removed, as it keeps its template's name.
- **Migration `0072_floor_themes`** (written as `0050`, renumbered after
  main's `0044`–`0049` in [the merge note](merge-main-into-131-to-153.md))
  gives every Floor from before it the theme of the template it was added
  from (`office` for Development, Blank and any other), and widens the
  Roles' desk-dressing check.

### Each desk is dressed by its Role (`apps/web/src/scene/desk-set.ts`, `office-view.tsx`)

- **The Role library's dressing** (PRD FR-57, FR-98): the Office view
  reads `GET /api/roles` on a Floor and gives each Agent its Role's
  `deskDressing`; the desk's stripe is the Agent's own Stage, from the
  Agent API. Before, both came from the five built-in Roles, so a
  merchandiser, a technical writer or any Role of the Owner's had a bare
  monitor and no stripe. Until the library loads, a built-in Role's desk
  is dressed as before, and any other gets a monitor.
- **Two new dressings** (`deskDressings`), as the issue names them:
  - `notebooks`: a copywriter's notebooks, two shut (the top one in the
    Stage's colour) and one open;
  - `product-samples`: a merchandiser's product box, a smaller box on it
    in the Stage's colour, and a jar.

  Online store's merchandiser now has product samples, and both
  copywriters notebooks. The Role library's editor offers them
  ("Notebooks", "Product samples"). Each fits the art direction's Low
  budget for a desk set (1,500 triangles), and keeps the ticket pile's
  spot clear.

### The themes (`apps/web/src/scene/floor-themes.ts`, new)

Each theme is a list of props (`floorThemeProps`), each of a kind, placed
and turned in the theme's zone: along the Floor's left wall, from the
corridor to the front of the smallest Floor, short of the left-most
desks' carpet (`themeZone`, x −10 to −7.5 m, z −0.4 to 4.4 m; since
merging main, z 4.4 to 8 m, in front of main's lounge: see the note
below). The Floor
grows forwards, never into it. Props are built from pieces in the
palette's colours and surfaces, and from the asset pack's bookcase and
books; no asset was added.

| Theme | Template | Its props |
| --- | --- | --- |
| `office` | Development, Blank | none: the Floor exactly as before |
| `stockroom` | Online store | two stock shelves of taped parcels and product boxes, a packing table with a half-packed parcel, a pallet of parcels |
| `studio` | Website & marketing | a paper backdrop on its roll and sweep, a product on a plinth, two softboxes, a camera on a tripod (and a mood board, dropped after merging main) |
| `editorial` | Content & blog | two bookcases of books, a printing press (three rollers, a red flywheel, paper in and printed sheets out), tied bundles of paper |
| `library` | Documentation | four bookcases in a row, a library ladder, a reading table with its lamp and a chair |
| `atelier` | Design system | a wall of twelve swatches of the palette, a layout table, an easel with a canvas of colour blocks, plinths with a sphere, a cylinder and a cube |
| `observatory` | Data & analytics | two dashboards on the wall (three before merging main), their bars, donuts and trend glowing on their screens, and a round table with stools and a laptop |
| `data-centre` | Infrastructure | a raised floor, five racks along the wall and three facing them across an aisle (three across the front before merging main), each with four servers and their status lights lit, under a cable tray |
| `device-lab` | Mobile app | a wall of 18 phones and two tablets over a test bench of phones on stands, a ring light, a charging cart of tablets |

- **Decoration only.** No Agent walks to a prop and nothing waits for
  one: `floorLayout(team, theme)` has the same desks, walkways,
  waypoints, meeting seats and bounds in every theme. Props stand on the
  floor or hang on the wall; those on the floor get Low's contact shadow.
- **Lying cylinders** (`lying` in `pieces.ts`): a piece's cylinder may lie
  along x or z, for the press's rollers and flywheel, the backdrop's
  roll, the dashboards' donuts and the ring light. A quarter turn swaps
  its axis as it swaps its size.
- The scene passes the Floor's theme from `GET /api/floors` through
  `OfficeScene` and `OfficeLocationScene` to `Floor`.

### Screenshot tests (`e2e/scenes/`, `apps/web/scene-fixtures.html`, new)

- **The fixture page** (`src/scene/scene-fixture.tsx`) draws a Floor added
  from one built-in template, with no server: it reads the template's
  `template.yaml` and Role files from `templates/` with the shared
  parsers, so the Floor has the template's own starting team, each desk
  dressed as its Role file says, and the template's theme. Fixed seeds:
  each Avatar seeded from its Agent's id, no monitor on, reduced motion
  holding the Agents and the camera still. Vite serves it for the tests;
  it is not in the built app (checked: `dist/` has only `index.html`).
- **`e2e/playwright.scenes.config.ts`**: headless Chromium forced onto
  SwiftShader (`--use-angle=swiftshader`), as CI draws with no GPU, at
  1280 × 720. `pnpm scenes` runs it; CI's end-to-end job runs it as its
  own step, even when an end-to-end test failed.
- **`floor-themes.spec.ts`**: a Floor in each of the nine themes, from the
  template each theme is first for, at Medium. Each is compared twice:
  from the default overview, and close up on the theme (960 × 540), where
  each prop is enough of the picture to count. A screenshot may differ in
  0.2% of its pixels, a pixel counting at a colour difference of 0.1. The
  18 screenshots are in `floor-themes.spec.ts-snapshots/` (4.2 MB).

### Docs

- README: the themes and desk dressing under "Floor Templates"; `pnpm
  scenes` in the commands table.
- [The web app and the 3D Office](../guide/web-app.md): desk sets dressed
  by the Role library, the themes' table, and "Screenshot tests of the 3D
  scenes".
- [Floors and Agents](../guide/floors-and-agents.md): a Floor keeps its
  template's theme; the manifest's theme ids; the two new dressings.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `3d1aeb4` (output below):
  - without Docker: **252 files, 2893 passed, 412 skipped** (the Postgres
    tests skip with the reason). Before, at `e42d558`
    ([`issue-151.md`](issue-151.md)): 250 files, 2871 passed, 411
    skipped;
  - against an embedded **Postgres 18.4**: **252 files, 3283 passed, 22
    skipped** (the GitHub contract against the real App, and the checks
    that need Docker). The migration's test passed, and so did the
    Floors' stores and the template tests in Postgres.
- [x] **Screenshot tests: a Floor in each theme.** `pnpm scenes`: **10
      passed** (the nine themes and "covers every theme"), each against
      its overview and close-up screenshots. SwiftShader draws a scene
      the same every time here: retaking all of them with
      `--update-snapshots=all` after the charging cart's colour changed
      rewrote only device-lab's, the others being pixel for pixel the
      same.

The new unit tests (all ✓, listed below) check what the pictures cannot:

- `floor-themes.test.ts` (10): every template's theme but `office` sets
  out at least three props, and `office` adds nothing (the layout equals
  the one from before themes, for 1, 4 and 12 Agents); no two themes have
  the same props; each has what its template is known by (stock shelves
  and more than ten parcels; bookcases and a press's three rollers; four
  bookcases and a ladder; dashboards with more than 15 glowing parts;
  eight racks with more than 16 lit status lights; a backdrop and
  softboxes; 12 swatches; 18 phones); every prop stands in the zone, on
  the floor and under the 3 m ceiling; nothing overlaps a desk, a
  walkway or the carpet, for teams of 1 to 12; desks, walkways and
  waypoints are the same in every theme; a 12-Agent Floor in each theme
  stays within a frame's triangles with 13 Avatars; lying cylinders.
- `floor-layout.test.ts`: a desk is dressed as the Role library says,
  built in or not (merchandiser, copywriter, a library reviewer's
  stripe, a coder dressed as books, an unknown Role); the ticket pile's
  spot is clear and the Low budget kept in every dressing.
- `floor.test.tsx`: the per-frame budget test (draw calls at most 200,
  triangles at most 300,000, with 12 Agents at work and every state
  shown) now runs in each of the nine themes; a Floor in a theme draws
  its props in the shared materials.
- `office-view.test.tsx`: the scene is given the Floor's theme and each
  Agent's dressing from the Role library; none in the lobby, which reads
  no Role library.
- The orchestrator's and the server's Floor tests: a Floor from Corner
  shop keeps `stockroom` through the API after the template is gone;
  Blank and Development are `office`. The shared manifest test refuses
  `theme: jungle`. The migration's test (Postgres) checks four Floors'
  themes and that the column refuses an unknown one.

**Negative checks.** Each sabotage was applied to the working tree, the
tests named run, then reverted with `git checkout`; `git status` was
clean after each.

| Sabotage | Failed |
| --- | --- |
| Stockroom loses its pallet of parcels | `floor-themes.test.ts` "is what its Floor Template is known by…"; and the stockroom screenshot test, its close-up 5,407 pixels (2%) different |
| The packing table moved onto the desks (x −7.0) | "keeps clear of every desk and every walkway", "stands in its zone…" |
| The ring light moved into the corridor (z −1.2) | the same two |
| Desks dressed by the built-in Roles only, as before | "is dressed as the Role library dresses its Role, built in or not" |
| Development's office given a bookcase | "…Development's office adds nothing", "puts a soft contact shadow under each prop…" |
| The Office view passes no theme | `office-view.test.tsx` "dresses a Floor in its theme…" |
| The Office view drops the library's dressing | the same |
| A Floor added from a template keeps `office` | two template tests (orchestrator, server), in memory |
| Migration 0056 without its backfill | the migration's test, in Postgres: `data-centre` and `stockroom` read `office` |

The screenshot sabotage first passed: from the overview alone, at
Playwright's default colour threshold of 0.2, the pallet's birch parcels
on the oak floor were too few pixels and too close in colour. That is why
each theme is also compared close up, at a threshold of 0.1
(`3d1aeb4`).

### Verified on the host

- [ ] **Each theme is recognisable at a glance and keeps the frame-rate
      target.** Not verifiable here: there is no GPU or display, and
      SwiftShader's frame rate says nothing of a laptop's. What the
      sandbox does show:
  - the 18 screenshots, drawn as CI draws them, in
    `e2e/scenes/floor-themes.spec.ts-snapshots/`; looked at here, each
    theme reads as its template's from the overview (shelves of parcels,
    the press's red flywheel, a wall of bookcases, glowing dashboards,
    black racks on a light floor, a studio's lights, a swatch wall, a
    wall of phones);
  - the budgets: a theme adds 2,484 (studio) to 8,472 (stockroom)
    triangles and at most 8 merged meshes to a 12-Agent Floor of 31,328
    triangles and 30 meshes; the render test keeps every theme within
    Medium's 200 draw calls and 300,000 triangles.

  On the host: add a Floor from each template, ride the lift to it at
  Medium with the FPS overlay on (Scene settings), and check the theme
  is plain from the default view and the overlay stays at 60 fps at
  1080p on a 2022-era integrated GPU; then at Low and High.

### `pnpm e2e`

The end-to-end suite (46 tests) ran with 4 workers against the embedded
Postgres, at `c41a1f3`: **42 passed, 4 failed**.

- Three are the failures recorded since #146 (`agent-editor.spec.ts`,
  `gateway-requests.spec.ts`, `manager-chat.spec.ts`), on the same
  lines as in [`issue-151.md`](issue-151.md#pnpm-e2e).
- The fourth, `notice-alerts.spec.ts`, never started: this sandbox's
  Chrome (not the headless shell) lacked `libcups.so.2`. With it added,
  the spec alone passed (1 passed).
- The specs touching what this issue changed pass: `floors.spec.ts`
  (adding a Floor from a template), `role-library.spec.ts`,
  `accessibility.spec.ts` (every page in use, the editors and forms, the
  3D Office's panels), `phone.spec.ts` (the 3D Office on a tablet).

### How Postgres and Chromium were run here

As for earlier issues, outside the repository:

- **Postgres**: `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4) in `/tmp/pg18`, on port 54329. For `pnpm test`, a
  scratch edit to `packages/db/src/testing/postgres.ts` pointed
  `postgresTest` at it through `SCRATCH_PG_URL`, with database names
  unique per test file; it was reverted with `git checkout` after each
  run and never committed. `pnpm e2e` used `E2E_POSTGRES_URL`.
- **Chromium**: `playwright install chromium` (Chromium 156, headless
  shell 1248). Its missing shared libraries came from Debian bookworm's
  packages, downloaded from `deb.debian.org`, extracted to
  `/tmp/chromelibs` and put on `LD_LIBRARY_PATH`. WebGL 2 reports
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))".

### Not verifiable in this sandbox

- **How the themes look, and the frame rate**, on a real GPU and display
  (above).
- **The screenshots on CI's machines.** SwiftShader drew the same picture
  twice here, pixel for pixel; whether CI's CPUs draw it within 0.2% of
  these is first seen in CI. If they do not, the screenshots are retaken
  there (`pnpm scenes --update-snapshots=all`) and committed.
- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`; they ran against the embedded Postgres instead.

## Notes

- **Where a theme stands.** The left wall beside the desks is the one
  stretch of every Floor that no room, amenity, walkway or desk uses, for
  any team, and it does not move as the Floor grows. The front of a small
  Floor is empty too, but the second row of desks takes it. (Since main's lounge, only its front part, z 4.4 to 8 m, is free:
  see below.)
- **No new colour.** Parcels are birch (`desk-top`) with `ceramic` tape,
  rather than a cardboard colour of their own: the art direction says a
  theme that needs one adds a token to `palette.ts` and the spec in one
  pull request, and `docs/` is the canon here. Screens, status lights,
  softboxes and the ring light glow in their own tokens, as the spec's
  emissive rule allows (screens, lamps, state lights).
- **Metal reads dark.** As the fridge's note in the model catalogue says,
  brushed steel (`metal-light`) reads almost black in the Office's dim
  environment light; the charging cart is enamel (`ceramic`) for that
  reason. The racks' servers, the press's rollers and the cable tray are
  steel, and read as dark metal.
- **Moved in front of the lounge, after merging main.** Main's lounge
  (#171: a fish tank, a sofa, a dartboard and its walkway) took the
  stretch of the left wall from the corridor to z 4.3, where the themes
  stood. Main also made every Floor at least 8 m deep (the games
  corner), so the zone moved to z 4.4 to 8 m: 3.6 m deep rather than
  4.8 m, the same 2.5 m wide, clear of the lounge, every desk and every
  walkway for teams of 1 to 12. Every theme was laid out again to fit:
  - the library's four bookcases stand edge to edge, and the stockroom's
    two stock shelves too;
  - the data centre's racks are two rows facing each other across a
    narrow aisle (five on the wall, three facing it), not five along the
    wall and three across the front;
  - two minor props were dropped where nothing fitted: the studio's mood
    board and the observatory's third wall dashboard.
  
  The Floor-theme screenshots (`e2e/scenes/floor-themes.spec.ts-snapshots/`)
  were not retaken: they need retaking on a machine that can run
  `pnpm scenes --project=chromium --update-snapshots`.
- **The theme is the Floor's, not the template's**, by the same rule as
  its template's name. A Floor added before this issue from a built-in
  template takes that template's theme from the migration.

## Noticed, out of scope

- **Role libraries from before this issue keep the old dressings** for
  Online store's merchandiser (printouts) and the copywriters (books): a
  template's Role joins the library only where it is missing, and the
  migration leaves the Owner's Roles as they are. The Owner changes them
  in the Role library.
- **A Role's new dressing reaches an open Office on its next read** of
  the Role library, not live: Role changes are not on the Floor's own
  event stream.
- **The Owner cannot change a Floor's theme** in the Floor admin; nothing
  in the PRD asks for it. FR-101's Owner-made templates will pick one of
  the nine.
- **The web build warns of chunks over 500 kB**, as it did before this
  issue (`office-scene` 502 kB, `index` 807 kB).
- **Every R3F test prints "THREE.Clock: This module has been
  deprecated"**, as before.

## Output

### `pnpm lint` and `pnpm typecheck`, fresh clone at `3d1aeb4`

```text
$ pnpm install --frozen-lockfile
Done in 369ms using pnpm v12.10.0
install exit=0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test`, without Docker, fresh clone at `3d1aeb4`

```text
$ pnpm test
 Test Files  252 passed (252)
      Tests  2893 passed | 412 skipped (3305)
test exit=0
```

### `pnpm test` against the embedded Postgres 18.4, at `c41a1f3`

The code the tests run is `3d1aeb4`'s: that commit changed only the
fixture page and the Playwright spec and config.

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test
 Test Files  252 passed (252)
      Tests  3283 passed | 22 skipped (3305)
exit=0
```

### `pnpm scenes`, at `3d1aeb4`

```text
$ pnpm scenes
  ✓   2 [chromium] › scenes/floor-themes.spec.ts:22:1 › covers every theme (5ms)
  ✓   1 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the office theme, from development (56.7s)
  ✓   3 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the studio theme, from website-and-marketing (59.6s)
  ✓   4 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the stockroom theme, from online-store (1.0m)
  ✓   5 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the editorial theme, from content-and-blog (57.2s)
  ✓   6 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the library theme, from documentation (59.3s)
  ✓   7 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the atelier theme, from design-system (56.9s)
  ✓   8 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the observatory theme, from data-and-analytics (50.6s)
  ✓  10 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the device-lab theme, from mobile-app (52.8s)
  ✓   9 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the data-centre theme, from infrastructure (54.2s)
  10 passed (3.0m)
exit=0
```

### This issue's tests (verbose), in memory

```text
$ vitest run src/scene/floor-themes.test.ts src/scene/floor-layout.test.ts src/scene/floor.test.tsx src/scene/office-view.test.tsx --reporter=verbose   # apps/web, these lines
 ✓ src/scene/floor-themes.test.ts > a Floor's 3D theme > is set out for every built-in template's theme, and Development's office adds nothing
 ✓ src/scene/floor-themes.test.ts > a Floor's 3D theme > gives each theme its own props, so no two look alike
 ✓ src/scene/floor-themes.test.ts > a Floor's 3D theme > is what its Floor Template is known by: stock and parcels, presses and books, dashboards, racks
 ✓ src/scene/floor-themes.test.ts > a Floor's 3D theme > stands in its zone along the left wall, on the floor and under the ceiling
 ✓ src/scene/floor-themes.test.ts > a Floor's 3D theme > keeps clear of every desk and every walkway, for teams of 1 to 12
 ✓ src/scene/floor-themes.test.ts > a Floor's 3D theme > is decoration only: the desks, walkways and waypoints are the same in every theme
 ✓ src/scene/floor-themes.test.ts > a Floor's 3D theme > puts a soft contact shadow under each prop that stands on the floor
 ✓ src/scene/floor-themes.test.ts > a theme's cost > leaves a 12-Agent Floor in every theme room for its Avatars within a frame's triangles
 ✓ src/scene/floor-themes.test.ts > a lying cylinder > is drawn along its axis, its size still its bounding box
 ✓ src/scene/floor-themes.test.ts > a lying cylinder > is laid along the other axis by a quarter turn
 ✓ src/scene/floor-layout.test.ts > a desk set > is dressed as the Role library dresses its Role, built in or not
 ✓ src/scene/floor-layout.test.ts > a desk set > keeps the ticket pile's spot on the desk's left clear for every Role and desk dressing
 ✓ src/scene/floor-layout.test.ts > a Floor's cost > keeps each Role's desk set within the spec's Low budget, the tightest, in every desk dressing
 ✓ src/scene/floor.test.tsx > a Floor in the scene > is dressed in its theme, its props merged into the shared materials
 ✓ src/scene/floor.test.tsx > a Floor's cost > is within Medium's per-frame budgets with 12 Agents at work, leaving room for their Avatars, in the office theme
 … (and in the stockroom, studio, editorial, library, atelier, observatory, data-centre and device-lab themes, all ✓)
 ✓ src/scene/office-view.test.tsx > the lobby and the Floors > dresses a Floor in its theme, and each desk as the Role library dresses its Role
 ✓ src/floor-templates.test.ts > a Floor Template's manifest > refuses a 3D theme the Office cannot draw   # packages/shared
```

### `pnpm e2e`, embedded Postgres 18.4, at `c41a1f3`

```text
$ E2E_POSTGRES_URL=postgres://postgres@localhost:54329/postgres pnpm e2e
  ✘  14 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (31.5s)
  ✘  29 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (11.3s)
  ✘  46 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (1.9s)
  ✘  31 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (30.3s)
    > 70 |   await account.getByLabel("Account type").selectOption("xAI API key");
    Error: browserType.launch: Target page, context or browser has been closed
    [pid=71513][err] …/chromium-1248/chrome-linux64/chrome: error while loading shared libraries: libcups.so.2: cannot open shared object file: No such file or directory
  4 failed
  42 passed (2.0m)

$ pnpm exec playwright test tests/notice-alerts.spec.ts   # with libcups2 on LD_LIBRARY_PATH
  ✓  1 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (4.6s)
  1 passed (6.6s)
```
