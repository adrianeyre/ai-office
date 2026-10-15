# Issue #76: Screenshot tests for key 3D scenes — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code commit
(`c6b76c0`). The commits after it change only this file.

The blockers are on main: #17 (the 3D Office's canvas, lighting and
post-processing), #66 (a Floor's layout and its rooms, the meeting room
among them) and #71 (the Avatar Editor's preview).

## What was built

- **A page drawing each key scene from fixed data**
  (`apps/web/screenshots/`, PRD §9 Visual). It is built on its own by
  `vite.screenshots.config.ts` into `apps/web/screenshots/dist` (ignored),
  never into the app's `dist/`, so the server never serves it.
  `?scene=lobby`, `floor`, `meeting-room` or `avatar-editor` draws one
  scene with the Office's own components: `OfficeScene` (the canvas, its
  lights and post-processing) and `AvatarPreview`.
  - **Fixed seeds** (`screenshots/scene-data.ts`): a Floor of seven Agents
    (Manager, two coders, reviewer, QA, docs, designer). Each Avatar is
    `randomAvatar(seededRandom("screenshots:<id>"), the ones before)`, as
    a new Agent's is on its Floor. Their states cover every state FR-62
    draws: two working at lit, written-on monitors, one waiting on review,
    one paused, one capped, piles of tickets, and the Manager's red light.
    Five fixed Notices are on the lobby's Notice Board and the Floor's
    wall board, and the lift has three stops. Nothing comes from a server,
    the clock or `Math.random`.
  - **A fixed camera**: the Office's overview (`officeViews.overview`) for
    the lobby and the Floor; for the meeting room, a view from above its
    glass front of the table for ten, the chairs and the whiteboard
    (`meetingRoomView`); the preview's own camera, at turn 0, for the
    Avatar Editor.
  - **Nothing moves**: Medium quality (the default) with reduced motion,
    so Avatars hold their pose and monitors hold a steady glow. The models
    (`loadModels`/`provideModels`) and the lobby's logo are loaded before
    the scene mounts, so the first frame is complete. After ten frames the
    page stops R3F's frame loop (`setFrameloop("never")`), leaving the
    canvas on its last frame, and sets `data-scene="ready"` on `<html>`
    (or `"failed"` with `data-scene-error`).
- **The Playwright screenshot tests** (`e2e/screenshots/scenes.spec.ts`,
  `e2e/playwright.screenshots.config.ts`): one test per scene. Each
  compares the canvas with its reference picture in
  `e2e/screenshots/reference/<scene>-linux.png`.
  - **Headless Chromium with software WebGL**: Playwright's headless
    shell, launched with `--use-angle=swiftshader
    --enable-unsafe-swiftshader --ignore-gpu-blocklist`, at 1280 × 720, a
    device pixel ratio of 1 and reduced motion. Each test also checks that
    the page's WebGL 2 renderer is SwiftShader, so a GPU's picture is
    never compared.
  - Only the canvas is compared, never HTML, so fonts play no part. The
    Avatar Editor is compared by its 3D preview, drawn at the size the
    editor gives it (288 × 256): its form is HTML (PRD §7), and its
    fonts differ between machines.
  - **The tolerance, tuned on measurements** (below): `threshold: 0.2`
    (Playwright's default per-pixel colour distance) and `maxDiffPixels:
    100`. No retries: a flaky picture would show, not be hidden. In CI a
    missing reference fails and is never written.
  - The page is built and served on 127.0.0.1:3049 by the config's
    `webServer` (`pnpm --filter @ai-office/web screenshots:serve`).
- **`pnpm screenshots`** at the root runs them. `pnpm screenshots
  --update-snapshots` takes new reference pictures.
- **CI**: a **Screenshots** job (`.github/workflows/ci.yml`) installs
  Chromium with its system libraries and runs `pnpm screenshots`. It needs
  no Docker. A failure uploads the actual, expected and diff pictures as
  the `screenshot-differences` artifact.
- **A unit test of the fixed data** (`screenshots/scene-data.test.ts`, run
  by `pnpm test`): every Avatar is valid and unlike the others on the
  Floor; the team shows every desk state (`type`, `wait`, `sit`, paused,
  capped, tickets), with exactly the typing Agents' monitors lit and
  written on; the Notices parse as the API's and the lift stops count
  their action Notices; the meeting room camera looks into the room from
  outside it.
- **README**: a "Screenshot tests" section under "Getting started", the
  command in the table, and a pointer from "The 3D Office"'s Tests bullet.

## The tolerance: how it was tuned

All measured in this sandbox, at `threshold: 0.2`:

| Run | What changed | Pixels different |
| --- | --- | --- |
| 5 runs, 1, 4, 2, 4 and 1 workers (16 CPUs), at `threshold: 0, maxDiffPixels: 0` | nothing | 0 in every scene |
| 3 runs with `CI=1` (2 workers), pinned to 2 CPUs (`taskset -c 0,1`), at `threshold: 0, maxDiffPixels: 0` | nothing | 0 in every scene |
| The reviewer stops working (its monitor dark, its hands off the keyboard) | Floor | 252 |
| The coder's hair colour (`#2e6fd8` ↔ `#d64f8f`) | Avatar Editor | 418 |

Run to run, the same build drew the same pixels, even under CPU
contention. The smallest change that should fail is 252 pixels, so the
limit is 100. That is below both changes and leaves room for a scatter of
edge pixels if another x86-64 CPU rounds differently. **Negative check:**
with those two changes in `scene-data.ts` and the final tolerance, "a
Floor" and "the Avatar Editor's preview" failed (252 and 418 pixels) and
the other two passed. The changes were reverted.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 at `c6b76c0` (output below). Not every full `pnpm test`
      run passed. Of five with this change, three failed, all with
      `Test timed out in 5000ms` in older CPU-heavy web tests; the worst,
      seven tests, came at a load average of 94. The other two passed,
      including the one below. The same timeouts happen without this
      change (see "Noticed, out of scope").
- [x] **What to build: Playwright screenshot tests of the lobby, a Floor,
      the meeting room and the Avatar Editor, at fixed seeds and fixed
      camera, in headless Chromium with software WebGL, with a tolerance
      tuned to avoid flakes.** `pnpm screenshots` passed 4 of 4 in all 12
      runs here with the committed scenes, 8 of them at zero tolerance
      (output of the last three below). The tolerance was tuned as
      described above. The pictures were looked at: the lobby (entrance,
      reception desk with the logo, Notice Board, lift, waiting area); the
      Floor (Manager's glass office with its red light, meeting room, wall
      board, bookshelf, lift, canteen, gym, seven Agents at their desks
      with lit monitors, markers and tickets); the meeting room (table,
      ten chairs, whiteboard); the Avatar Editor's preview (the coder on
      its turntable beside its mascot on the plinth).
- [x] **Runs in CI.** The **Screenshots** job is in `ci.yml` (the file
      parses, with jobs `check`, `e2e`, `screenshots`). It runs the same
      command, `CI=1 pnpm screenshots`, which passed here three times in a
      row with CI's settings (2 workers, no retries, references never
      written) at load averages of 96 to 116. The slowest test took 34 s
      against a 90 s timeout.

### Verified on the host

- [ ] **The CI job is green and stable across three re-runs.** Not
      verifiable here: this run has no GitHub access. On the host: push
      the branch, and re-run the **Screenshots** job three times. The
      references were taken in this sandbox, with the same Chromium build
      CI installs (`@playwright/test` 1.64.0 pins chromium-headless-shell
      156.0.8078.4, v1248). SwiftShader is part of that build, and the
      pictures use no fonts. So CI should draw the same pixels, but only
      the first CI run can show it. If it fails by fewer than a few hundred
      scattered pixels, the `screenshot-differences` artifact shows
      where. Then either retake the references from that artifact's
      actual pictures, or raise `maxDiffPixels` in `scenes.spec.ts` above
      the measured scatter and below 252.

## How Chromium was run here

`pnpm --filter @ai-office/e2e exec playwright install chromium`
downloaded Chromium headless shell 156.0.8078.4. Its system libraries
(NSS, ATK, GBM, X11 and the rest that `--with-deps` installs in CI) were
fetched as Debian bookworm `.deb` files from deb.debian.org, extracted
with `dpkg -x` to `/tmp/chromedeps`, and put on `LD_LIBRARY_PATH`. The
renderer reported `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
(Subzero) (0x0000C0DE)), SwiftShader driver)`. Nothing of this is in the
repository.

## Not verifiable in this sandbox

- **The CI job on GitHub's runners**, three times (above).
- **How the scenes look on a real GPU**: the pictures are SwiftShader's.
  The look and feel of the Office on the host is PRD §9's "on the host"
  check, outside this issue.
- **Frame rate**: out of scope, as the issue says.

## Noticed, out of scope

- **Flaky timeouts in older web tests.** Under load, full `pnpm test` runs
  sometimes fail with `Test timed out in 5000ms`, always in the same
  CPU-heavy tests: `src/scene/floor-layout.test.ts` "keep every path of
  N Agents' Floor clear of furniture and walls" (N = 7 to 11),
  `src/whiteboard.test.tsx` "opens on the Batch a Notice names…" and two
  Avatar tests in `src/floors.test.tsx`. The same happened on a clean
  checkout of `47b77b5` (this change stashed): one run of two failed, in
  `floor-layout.test.ts` and `whiteboard.test.tsx`. Each file passes
  alone (`floor-layout.test.ts`: 77 tests in 19.5 s). These tests may
  need a longer `testTimeout`, or lighter cases.
- **Kickoff and Wrap-up in 3D (FR-60)** are not drawn yet: Agents do not
  gather in the meeting room, and the whiteboard shows no Plan. So the
  meeting room picture is the room alone. When they are built, a Kickoff
  scene (Agents in `meetingSeats`, the whiteboard filled in) belongs in
  `scene-data.ts`.
- **The README's status line** still says "planning. Nothing is built
  yet."
- **The reference pictures are Linux's.** On macOS or Windows the tests
  fail as missing rather than compare, by design (`{platform}` in
  `snapshotPathTemplate`). Run them in Linux, as CI does.
- React Three Fiber logs `THREE.Clock: This module has been deprecated`
  in the browser's console (three r186). It is harmless.

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

`pnpm test`, without Docker (the Postgres and Docker tests skip):

```text
 Test Files  231 passed (231)
      Tests  2710 passed | 366 skipped (3076)
   Duration  62.63s (tests 42%, import 37%, transform 12%, environment 8%, setup 1%)
```

The new unit test, verbose:

```text
 ✓ |@ai-office/web| screenshots/scene-data.test.ts > the screenshot scenes' data > gives every Agent a valid Avatar, unlike every other's on the Floor 5ms
 ✓ |@ai-office/web| screenshots/scene-data.test.ts > the screenshot scenes' data > shows every state the Office draws at a desk (FR-62) 1ms
 ✓ |@ai-office/web| screenshots/scene-data.test.ts > the screenshot scenes' data > has Notices as the API lists them, counted on the lift's stops 2ms
 ✓ |@ai-office/web| screenshots/scene-data.test.ts > the screenshot scenes' data > looks into the meeting room from outside it 0ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

`CI=1 pnpm screenshots`, three runs in a row, with the sandbox at load
averages of 96 to 116 (Chromium headless shell 156.0.8078.4, SwiftShader):

```text
--- run 1 (load 96.04)
Running 4 tests using 2 workers
  ✓  1 [chromium] › screenshots/scenes.spec.ts:53:1 › the lobby (33.2s)
  ✓  2 [chromium] › screenshots/scenes.spec.ts:58:1 › a Floor (34.2s)
  ✓  4 [chromium] › screenshots/scenes.spec.ts:71:1 › the Avatar Editor's preview (4.0s)
  ✓  3 [chromium] › screenshots/scenes.spec.ts:63:1 › the meeting room (31.1s)
  4 passed (1.2m)
--- run 2 (load 115.78)
Running 4 tests using 2 workers
  ✓  2 [chromium] › screenshots/scenes.spec.ts:58:1 › a Floor (20.2s)
  ✓  1 [chromium] › screenshots/scenes.spec.ts:53:1 › the lobby (22.0s)
  ✓  4 [chromium] › screenshots/scenes.spec.ts:71:1 › the Avatar Editor's preview (1.6s)
  ✓  3 [chromium] › screenshots/scenes.spec.ts:63:1 › the meeting room (12.1s)
  4 passed (44.1s)
--- run 3 (load 106.30)
Running 4 tests using 2 workers
  ✓  1 [chromium] › screenshots/scenes.spec.ts:53:1 › the lobby (24.4s)
  ✓  2 [chromium] › screenshots/scenes.spec.ts:58:1 › a Floor (29.9s)
  ✓  4 [chromium] › screenshots/scenes.spec.ts:71:1 › the Avatar Editor's preview (2.5s)
  ✓  3 [chromium] › screenshots/scenes.spec.ts:63:1 › the meeting room (25.0s)
  4 passed (58.1s)
```

## After merging `main` (#165, #166)

`main` gained its own `pnpm screenshots` and
`e2e/playwright.screenshots.config.ts`, which retake the README's pictures in
`docs/images/`. Both used `e2e/screenshots/` as their test directory, so this
issue's suite moved to keep them apart:

| Before                                 | After                             |
| -------------------------------------- | --------------------------------- |
| `pnpm screenshots`                     | `pnpm scenes`                     |
| `e2e/playwright.screenshots.config.ts` | `e2e/playwright.scenes.config.ts` |
| `e2e/screenshots/scenes.spec.ts`       | `e2e/scenes/scenes.spec.ts`       |
| `e2e/screenshots/reference/`           | `e2e/scenes/reference/`           |
| `e2e/test-results/screenshots/`        | `e2e/test-results/scenes/`        |

CI's **Screenshots** job runs `pnpm scenes`. The README's section is now
"Scene screenshot tests", next to the end-to-end tests. The rest of `main`'s
README moved to `docs/guide/`.
