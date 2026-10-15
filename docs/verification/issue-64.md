# Issue #64: 3D scene shell: canvas, camera, quality settings — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) against a fresh `git clone` of this branch at the
last code commit of the issue (`9bcf099`), after
`pnpm install --frozen-lockfile`.

The blocker, #8 (the React app shell: Vite, TanStack Router and Query,
Zustand, Tailwind and shadcn/ui), is built on this branch
([`issue-8.md`](issue-8.md)); the scene also follows the art direction spec
of #63 ([`issue-63.md`](issue-63.md)).

## What was built

All of it is in `apps/web/src/scene/`.

- **Dependencies:** `three` 0.186, `@react-three/fiber` 9.8, `@react-three/drei`
  10.7, `@react-three/postprocessing` 3.1 and `postprocessing` 6.39 (PRD §8,
  3D), with `@types/three`. They are in a chunk of their own
  (`office-scene-*.js`) that loads only when the Office page is opened; the
  main chunk grew from 697.5 kB to 707.9 kB.
- **The canvas** (`office-scene.tsx`), on the Office page (`/`):
  - the art direction's lights: the key light (`light-key`, 2.4, 50° up and
    35° to the left of the default view, the only light casting shadows,
    bias −0.0005 and normal bias 0.02), the fill (`light-fill`, 0.6,
    opposite, 25° up), the hemisphere light (`light-sky` over
    `light-ground`, 0.8), and drei's `Environment` at 64 px and intensity
    0.4, drawn once from three `Lightformer` panels, so nothing is
    downloaded and it is never a background;
  - the bare floor (`floor-wood`, roughness 0.7), receiving shadows, under
    a `light-sky` background. No rooms: those are #65 and #66;
  - the post-processing stack, in the spec's order: N8AO (`aoRadius` 0.5,
    `distanceFalloff` 0.5, `intensity` 2, colour `shadow`, half or full
    resolution), Bloom (threshold 0.9, smoothing 0.2, intensity 0.4,
    `mipmapBlur`, radius 0.6), `ToneMapping` (Neutral), the colour grade
    (`HueSaturation` +0.05, `BrightnessContrast` +0.05, and
    `ColourGradeEffect`, a small effect of our own that lifts shadows
    towards `shadow` and warms highlights towards `light-key`), Vignette
    (offset 0.3, darkness 0.35) and SMAA, with the composer's
    multisampling. The renderer's own tone mapping is off (`flat`);
  - the camera rig, advanced each frame (`useFrame`).
- **Quality settings** (`quality.ts`): Low, Medium (the default) and High,
  each with its shadows (none on Low; 1024² and radius 4 on Medium; 2048²
  and radius 6 on High), where contact shadows go (for the rooms to use),
  its post-processing (AO off, half or full; bloom; vignette; SMAA;
  multisampling 0, 0 or 4) and its most pixel ratio (1, 1.5, 2; the canvas
  gets `dpr={[1, max]}`). A new setting makes a new canvas (`key`), so
  shadows, multisampling and the pixel ratio start afresh; the camera keeps
  its place because the rig lives in a store.
- **The camera rig** (`camera-rig.ts`, pure functions): named views and a
  transition queue.
  - `flyTo` drops whatever is queued; a move under way turns towards the
    new view from wherever the camera is. A view the camera already rests
    at, or is already flying to, changes nothing.
  - `queueMove` adds a move after the queued ones (dropping one to where
    the last already ends). Queued moves fly one after another, and time
    left over when one lands carries into the next.
  - Moves are eased in and out (cubic), taking 0.8 to 1.8 s by distance (a
    move that goes nowhere takes none).
  - With reduced motion, every move, including one under way, is cut to the
    last view at once.
- **Zustand stores:**
  - `useCameraStore` (`camera-store.ts`): the views (Overview, a high
    three-quarter view; Plan, from above; Close up) and the rig.
    `registerView` lets rooms add their own; an unknown view throws. A rig
    at rest sets nothing, so it notifies nobody each frame.
  - `useSelectionStore` (`selection-store.ts`): what is selected (an Agent,
    or a monitor, whiteboard, Notice Board, wall board or bookshelf of
    FR-58) and what is hovered, for the panels to come.
  - `useSceneSettings` (`scene-settings.ts`): quality, reduced motion and
    the FPS overlay, kept in this browser's local storage
    (`ai-office:scene-settings`), like the browser notification settings.
    Reduced motion starts as `prefers-reduced-motion` says. A stored value
    this version does not know (a quality setting since removed, say) is
    dropped and its default kept.
  - `useFpsStore` (`fps.ts`): the frame rate, read twice a second.
- **HTML panels outside the canvas** (`office-view.tsx`), positioned over
  it: the view picker (`aria-pressed` on the view the camera is at or going
  to), **Scene settings** (a disclosure with a Quality radio group, **Reduce
  motion** and **Show frame rate**) and the FPS overlay (`60 fps · 16.7
  ms`). Each is a button or a form control, so it works from the keyboard.
  The space between the panels leaves the pointer to the scene.
- **Without WebGL 2** the page says "This browser cannot show the 3D Office:
  it has no WebGL 2", and loads no three.js. If the scene fails to start (a
  WebGL context refused, say), an error boundary says so instead.
- README: a "The 3D Office" section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from the fresh clone (output below); `pnpm build` passes too.
- [x] **Unit tests for the camera transition queue and quality presets.**
  - `camera-rig.test.ts` (13 tests): at rest it does nothing (and returns
    the same object); a flight eases (a quarter of the time covers
    `easeInOutCubic(0.25)` of the way, half the time half) and lands exactly
    on the view; queued moves fly in order with time carried over between
    them, and one long frame lands them all; `flyTo` mid-flight drops the
    queue and starts from the mid-air pose; moves to where the camera is or
    is going are ignored; going back to a view after a move away; reduced
    motion cuts a queue, a flight, and a flight with a queue behind it to
    the last view; negative time; a move that goes nowhere; durations
    (bounded, longer for further, counting the target's move); the easing.
  - `quality.test.ts` (9 tests): the three settings in order, Medium
    first; each step up costs more; the canvas's `dpr`; and, like
    `palette.test.ts`, the presets match
    `docs/reference/art-direction.md`: they are read against its shadow
    table (map size, radius, contact shadows), its post-processing table
    (AO, bloom, vignette, anti-aliasing and multisampling; tone mapping and
    grading on at every setting, which is why the presets have no switch
    for them) and its pixel ratio row.
  - Also: `stores.test.ts` (10 tests: the camera, selection and settings
    stores, including local storage and dropping unknown stored values),
    `fps.test.ts` (3), `lighting.test.ts` (2: the key light 50° up and 35°
    to the camera's left, the fill opposite at 25°) and
    `office-view.test.tsx` (6, in jsdom with the canvas replaced by a
    stand-in: the no-WebGL message, panels outside the canvas, the view
    picker by mouse and keyboard, the quality radio group re-drawing the
    scene at the new setting, reduced motion, and the FPS overlay).

  **Negative checks** (each reverted afterwards):
  - Leftover time no longer carried into the next move: 2 tests failed.
  - Reduced motion cutting to the flight's view rather than the queue's
    last: 1 test failed.
  - Medium given 2048² shadows and a pixel ratio of 2: 4 tests failed.

**Rendered in headless Chromium.** There is no GPU, but with Playwright's
Chromium (its missing system libraries fetched from Debian's bookworm
mirror into `/tmp`, nothing installed) and SwiftShader, the real
`OfficeView` was rendered from a throwaway page under Vite (deleted
afterwards) at 1280 × 720:

- Low, Medium and High each draw the floor and background with no shader
  compile error or page error; Medium shows the vignette.
- Flying to Plan, sampled every 400 ms, went `[14,16,18]` →
  `[13.74,16.29,17.68]` → `[9.75,20.85,12.69]` → `[4.07,27.35,5.59]` →
  `[0.09,31.9,0.61]` → resting at `plan` `[0,32,0.5]`: slow, fast, slow.
- With reduced motion on, Close up was reached at once.
- The FPS overlay showed the measured rate. It was 0.5 to 7 fps: this is
  the CPU rendering every pixel, and says nothing about a GPU.
- The only console output was R3F's use of `THREE.Clock`, which this
  three.js deprecates (see below).

### Verified on the host

- [ ] **Medium quality holds 60 fps on an empty scene on the reference
      laptop.** Not verifiable here: there is no GPU. On the host: `pnpm
      dev`, open http://localhost:3045 at 1080p, then **Scene settings** →
      Medium and **Show frame rate**, and read the overlay over a minute
      (also while flying between views).

### Not verifiable in this sandbox

- **How it looks and how fast it runs** on a real GPU: the lighting, the
  softness of the shadows, the strength of AO, bloom and the grade, and
  the frame rate at each setting. The colour grade's amounts (shadows
  lifted 0.2 of the way towards `shadow` at black, highlights tinted 0.1 by
  `light-key`) are starting values; the spec gives none.
- The e2e suites (no Docker). Several sign in and land on `/`, which now
  loads the scene in Playwright's Chromium; the page's `<h1>Office</h1>`
  is unchanged, and if that Chromium has no usable WebGL the page should
  show the "could not start" message rather than fail (the error boundary
  was not exercised with a refused context here).

## Noticed, out of scope

- **The spec and three.js disagree on shadows.** The art direction names
  `PCFSoftShadowMap`, which three.js r186 has removed: it falls back to
  `PCFShadowMap` with a console warning. The scene uses `PCFShadowMap`
  directly with the spec's map sizes and radii (its `radius` now softens
  the edge, which `PCFSoftShadowMap`'s never did). The spec's shadow table
  should say `PCFShadowMap`; this issue does not change `docs/`.
- `@react-three/fiber` 9.8.1 uses `THREE.Clock`, which three r186
  deprecates, so each new canvas logs a deprecation warning. It goes away
  with a later R3F.
- `@react-three/fiber` 9.8's peer range is React `>=19 <19.4`. The web app
  asks for `react ^19.3.0`, which the lockfile holds at 19.3.0; a lockfile
  refresh that took React 19.4 would need a newer R3F.
- The scene's chunk is 1.3 MB (422 kB gzipped), loaded with the Office
  page; most of it is three.js and postprocessing.
- The shadow camera covers a fixed 32 m × 32 m around the Floor's centre.
  The spec fits it to what the camera sees, which needs the rooms.
- There is no free orbit or pan: the camera goes between named views only.
- Phones still get the 3D Office on `/`; the 2D view for phones (PRD §7) is
  a later issue.
- Nothing yet uses the selection store; the panels of FR-58 and FR-63 come
  with the rooms. Contact shadows and glass transmission on High wait for
  the props and glass that need them.
- The FPS overlay shows frame rate only, not draw calls or triangles
  against the spec's per-setting budgets.

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
 Test Files  132 passed (132)
      Tests  1311 passed | 239 skipped (1550)
   Duration  36.51s (import 41%, tests 35%, transform 11%, environment 10%, setup 2%)
```

`pnpm build` (the web app's assets):

```text
dist/assets/icon-BQiMWJ90.svg             1.45 kB │ gzip:   0.63 kB
dist/assets/index-Dazb0M_N.css           35.15 kB │ gzip:   7.21 kB
dist/assets/index-DSFQD-s2.js           707.88 kB │ gzip: 214.31 kB
dist/assets/office-scene-VL3Qagrq.js  1,302.12 kB │ gzip: 422.46 kB
(!) Some chunks are larger than 500 kB after minification. Consider:
✓ built in 1.74s
```

The new tests, verbose:

```text
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > starts at rest at its view, with nothing to do
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > flies to a view, eased, and comes to rest exactly at it
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > flies queued moves one after another, carrying time over between them
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > lands every queued move it can within one long frame
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > turns a move under way towards a new view from where the camera is, dropping the queue
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > ignores a move to where the camera already rests or is already going
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > goes back to a view it left, after a move away
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > cuts straight to the last view with reduced motion, even mid-flight
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > ignores negative time
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the camera transition queue > makes a move that goes nowhere at once
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > a move's duration > is longer the further the camera goes, within its bounds
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > a move's duration > counts the target's move as well as the camera's
 ✓ |@ai-office/web| src/scene/camera-rig.test.ts > the easing > starts and ends still, and is symmetric
 ✓ |@ai-office/web| src/scene/lighting.test.ts > the lights' positions > put the key light 50° up and 35° to the left of the default view, and the fill opposite it, 25° up
 ✓ |@ai-office/web| src/scene/lighting.test.ts > the lights' positions > measure a view's bearing from +Z towards +X
 ✓ |@ai-office/web| src/scene/fps.test.ts > the FPS meter > reads the frame rate once an interval, from the frames in it
 ✓ |@ai-office/web| src/scene/fps.test.ts > the FPS meter > starts each interval afresh
 ✓ |@ai-office/web| src/scene/fps.test.ts > the FPS meter > reads a long stall as the slow frame it was
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets > are Low, Medium and High, starting on Medium
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets > cost more at each step up
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets > give the canvas a pixel ratio from 1 to the preset's most
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets match docs/reference/art-direction.md > low: shadows and contact shadows
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets match docs/reference/art-direction.md > medium: shadows and contact shadows
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets match docs/reference/art-direction.md > high: shadows and contact shadows
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets match docs/reference/art-direction.md > post-processing: ambient occlusion, bloom, vignette and anti-aliasing
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets match docs/reference/art-direction.md > post-processing: tone mapping and colour grading at every setting
 ✓ |@ai-office/web| src/scene/quality.test.ts > the quality presets match docs/reference/art-direction.md > pixel ratio
 ✓ |@ai-office/web| src/scene/stores.test.ts > the camera store > starts at rest at the overview
 ✓ |@ai-office/web| src/scene/stores.test.ts > the camera store > flies to a named view over frames, and to one registered later
 ✓ |@ai-office/web| src/scene/stores.test.ts > the camera store > cuts to the view with reduced motion
 ✓ |@ai-office/web| src/scene/stores.test.ts > the camera store > refuses a view it does not know
 ✓ |@ai-office/web| src/scene/stores.test.ts > the camera store > notifies no one while the camera is at rest
 ✓ |@ai-office/web| src/scene/stores.test.ts > the selection store > selects, hovers and clears, and changes nothing for the same selection
 ✓ |@ai-office/web| src/scene/stores.test.ts > the scene settings > start on Medium, with the FPS overlay off
 ✓ |@ai-office/web| src/scene/stores.test.ts > the scene settings > start with reduced motion as the browser asks for it
 ✓ |@ai-office/web| src/scene/stores.test.ts > the scene settings > are kept in this browser's local storage
 ✓ |@ai-office/web| src/scene/stores.test.ts > the scene settings > read back what was stored, and drop what this version does not know
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > says so when the browser has no WebGL 2, and loads no scene
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > renders the scene, with its panels beside the canvas rather than in it
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > flies the camera to the view picked, and shows where it is going
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > changes the quality setting, which the scene is drawn at
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > turns reduced motion on and off
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > the Office's 3D view > with WebGL > shows the frame rate over the scene when asked
 Test Files  6 passed (6)
      Tests  43 passed (43)
```
