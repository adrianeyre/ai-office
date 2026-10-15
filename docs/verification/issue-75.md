# Issue #75: 2D view on phones, tablet support — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code
commit (`0f92444`; the README commit after it changes only Markdown).

Both blockers are built on this branch:

- #27, Notices and the 2D Notice Board ([`issue-27.md`](issue-27.md)):
  the phone's Notice Board section shows its Notices, with their actions
  and **Dismiss**;
- #29, the Activity Feed page ([`issue-29.md`](issue-29.md)): the phone's
  Activity section is its latest page, with its entries and live stream.

It also stands on the 3D Office's camera rig and inspectable objects
(#64 to #67), the Floors' wall boards (#69, #73) and the Agents' states
in the Office (#73), whose rules the phone's words for each Agent's state
reuse.

## What was built

- **Which screen is a phone's** (`apps/web/src/phone-view.ts`):
  `phoneQuery` is `(max-width: 599px), (max-height: 479px) and (pointer:
  coarse)`. That is a screen under 600 CSS pixels wide (Material's compact
  width), or a phone on its side, under 480 high with a finger for a
  pointer. `usePhoneView()` follows it with `useSyncExternalStore`, so
  turning the phone or resizing the window switches views. A desktop
  window under 600 pixels wide gets the 2D view too: the 3D view and its
  panels would not fit it.
- **The Office in 2D** (`apps/web/src/office-2d.tsx`, `Office2D`): on a
  phone, the Office route (`OfficePage` in `pages.tsx`) shows it in place
  of `OfficeView`. The canvas is never mounted, and the scene's chunk
  (three.js) is never loaded. One page, with a list at the top
  ("Office sections") whose links bring each section into view and move
  focus to it:
  - **Notice Board**: every open Notice, by the Notice Board's own
    `NoticeItem` (now exported): links, actions and **Dismiss**. A link
    opens the full board.
  - **Activity**: the latest 10 events (`GET /api/events?limit=10`), by the
    Activity Feed's own entry (`ActivityEntry`, now exported), with new
    events streaming in at the top. A link opens the full feed.
  - **Floors**: each Floor is a section with:
    - its repository and its health (`floorHealth`, as on its wall
      board);
    - links to its Notices, its Manager chat and its settings;
    - its Agents, each with its Role, AI Provider and Model, its state in
      words, the issue it is on (`currentIssueOf`, as on its card) and
      links to its live view and config;
    - its issues in progress, each with its stage, its Agents (each name
      brings that Agent's entry into view), its pull request and its
      rounds.

    `agentStateText` gives an Agent's state through `agentLook`, the rule
    the 3D Office draws it by (FR-62). It reads "Working", "Waiting on
    review" or "Idle", then "paused" or "paused at a Token Cap", then how
    many tasks wait. A paused Agent finishing its task still works; a
    capped one never does.
  - **Admin**: Admin, each Floor's settings, Gateway requests and
    Analytics.
  - **Live**: one stream for the Notices and the Floors' events. Each
    Notice event reads the Notices again. Each Floor event reads that
    Floor's Agents, wall board and tokens again (`["floors", floorId]`),
    and the list of Floors too for a Floor event or a configuration
    change. An office-wide event reads every Floor again. Each
    (re)connection reads everything again. A second stream carries the
    activity.
  - **The Office's address**: Agents' names link to
    `/?floor=…&inspect=agent:…` everywhere. On a phone that address
    brings the Agent's entry into view, focuses it and marks it
    `aria-current` (`office2dTargetId`). An Agent's monitor does the same.
    A Floor's whiteboard, wall board or bookshelf brings its Floor into
    view, and the lobby's Notice Board brings the Notice Board.
- **The camera by touch on a tablet**:
  - The gestures are pure functions of a pose
    (`scene/camera-gestures.ts`):
    - `orbit`: one finger turns the camera around what it looks at, the
      scene following the finger. Dragging the screen's height turns it
      half a turn, from straight down to 80° from it, never under the
      Floor.
    - `dolly`: a pinch moves it closer or further, along its line of
      sight, from 1 m to 60 m.
    - `pan`: two fingers slide it across the Floor at its height and
      angle, the scene under the fingers following them, within 30 m of
      the centre.
    - `gesturePose` turns fingers' moves into one of these.
  - `attachTouchCamera` (`scene/touch-camera.ts`) feeds the canvas's
    pointer events to those functions, fingers only, so a mouse and a pen
    work as before. Gestures are ignored while the lift has the camera.
    `TouchCamera` in `office-scene.tsx` attaches it, and the canvas is
    `touch-action: none`, so the page does not scroll or zoom under the
    fingers.
  - The camera store's `placeByHand` rests the camera where the fingers
    leave it, as the view `by-hand`. Closing an object's panel flies
    back there, and a view from the picker flies on from there.
  - A touch that moves less than `tapSlop` (8 px) is a tap, which opens
    what is under it. A drag is never a click: the inspectable hotspots
    and the lift's doors and call button ignore a click whose pointer
    moved further (R3F's `event.delta`).
- **Panels fit a tablet**: where the Office's view is under 39rem wide
  (an iPad Mini upright, beside the navigation), an open object's panel
  cannot sit beside the controls. It now lies across the view, scrolling,
  until it is closed. The overlay is a CSS container
  (`@container`/`@max-[39rem]:` in `office-view.tsx` and
  `inspector.tsx`). The Scene settings panel shrinks to its column rather
  than push past the view.
- **A fingertip's size**: on a coarse pointer (`pointer-coarse:`), every
  `Button` is at least 44 × 44 px, and every `Input`, select
  (`selectClass`) and navigation link at least 44 px high. A mouse sees
  no change.
- **Admin pages fit a phone**:
  - Admin and the Floor admin scrolled sideways on a phone. The cause
    was each table's screen-reader-only "Actions" header (`sr-only`,
    `position: absolute`). It escaped its `overflow-x-auto` box, which
    was not positioned, and widened the page by 17 px and about 390 px.
  - Those boxes (Agents, Model prices, request history and Analytics'
    tables) are now `relative`, so wide tables scroll within their cards.
  - Skills' "How to add" buttons wrap.
- **README**: "Phones and tablets", under the 3D Office.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too (run by `pnpm e2e`).
- [x] **Playwright at a phone viewport: no canvas, every 2D section
      reachable.** `e2e/tests/phone.spec.ts` ran in real Chromium (Chrome
      for Testing 156.0.8078.4) against the built app, the real server
      and Postgres 18.3. Postgres was the embedded binary through
      `E2E_POSTGRES_URL`, as in #17, with Chromium's missing libraries
      unpacked from Debian bookworm's packages into `/tmp` (nothing
      committed). The device was Playwright's Pixel 7 (412 × 839,
      touch, mobile) on a Floor added in Admin, with an action Notice
      raised:
  - **"the Office is in 2D, with no canvas, and every section is in
    reach":**
    - the 2D view shows, with **no `<canvas>`**, and the page is no
      wider than the screen;
    - tapping each of "Notice Board", "Activity", "Floors" and "Admin" in
      the list at the top brings its heading into the viewport and
      focuses its section;
    - the Notice shows with its action, the activity shows the Floor
      being added, and the Floor shows "Needs you" and its four Agents
      (the first "Idle"), with no issue in progress;
    - every button in the view is at least 44 px high;
    - tapping an Agent's "live view" opens
      `/floors/web-shop/agents/<id>`, and going back returns to the 2D
      view;
    - tapping "Office settings" opens Admin, still without a canvas.
  - **"an Agent's name brings its entry into view, and the phone on its
    side stays 2D":** `/?floor=web-shop&inspect=agent:<id>` (where an
    Agent's name links) focuses that Agent's entry, in the viewport, with
    `aria-current`. Turned to 839 × 412, the Office stays 2D with no
    canvas.
  - **"the Notice Board, the Activity Feed and the admin pages fit the
    screen":** `/notices`, `/activity`, `/admin`,
    `/admin/floors/web-shop`, `/gateway` and `/analytics` are each no
    wider than the screen. Before the fix above, it failed at `/admin`,
    429 px wide. A probe (deleted afterwards) measured
    `/admin/floors/web-shop` at 809 px.
  - **Tablet: "the Office is the 3D one, with every panel inside its
    view, upright or on its side":** the device was the iPad Mini (768 ×
    1024, touch, at one pixel to a CSS pixel so SwiftShader keeps up).
    The Office has a canvas and no 2D view. The Notice Board opened from
    **Inspect** by taps lies within the canvas both upright and turned to
    1024 × 768, with its **Close panel** and **Scene settings** in view.
    Close panel closes it. Before the panel fix, the upright panel's
    right edge was at 849 px, past the view's 743, and the test fails.
  - **Negative check:** with `phoneQuery` changed to `(max-width: 1px)`
    and the app rebuilt, both 2D Office tests fail ("expect(locator).
    toBeVisible() failed" on the 2D view). The tablet and fit tests still
    pass. The query was restored.
  - The whole e2e suite passes with it: 27 of 27 (below).
- [x] **Also unit-tested** (jsdom and `@react-three/test-renderer`):
  - `office-2d.test.tsx` (16 tests), at `/` with `matchMedia` stubbed to
    a phone:
    - the 2D view and never the 3D one, its four section links and
      sections, and focus moving to a section from its link;
    - the Notice with its action and Dismiss, and the latest activity
      with a streamed event arriving at the top (and `limit=10`);
    - each Agent's state ("Working · 2 tasks wait", "Idle · paused at a
      Token Cap · 1 task waits", "Idle · paused"), its Role and Model,
      its issue, and its live view and config links;
    - the issues in progress, with an Agent's name bringing its entry
      into view, and the Floor's links and health ("Needs you");
    - a Floor read again at its `agent.queue_changed` event, and its
      name at its `config.changed` event. Without refreshing the Floor
      list, the rename test fails; that was checked, then restored;
    - every admin link, and the address bringing an Agent into view;
    - switching to the 3D view as the screen stops being a phone's and
      back, and the 3D view on a tablet or desktop;
    - `office2dTargetId` for every kind of object, and `agentStateText`'s
      rules.
  - `scene/camera-gestures.test.ts` (15 tests):
    - orbit keeps the distance and turns half a turn for the screen's
      height, and comes back for the reverse drag;
    - the finger's direction is followed, and orbit is clamped at
      straight down and at 80°;
    - dolly halves the distance for fingers twice as far apart, and is
      clamped at 1 m and 60 m;
    - pan keeps height and angle, moves the scene by exactly what the
      fingers move at the target's distance, works looking straight
      down, and is clamped at 30 m;
    - one finger orbits and two pinch and pan.
  - `scene/touch-camera.test.ts` (7 tests): pointer events on an element
    move the camera store as the functions say, and it rests at
    `by-hand`. A tap under 8 px, a mouse, a pen, a disabled camera (the
    lift) and a detached listener all leave it be. A flight under way is
    dropped, and a view flies on from where the fingers left it.
  - `scene/stores.test.ts`: closing a panel flies back to where fingers
    left the camera.
  - `scene/inspectable-hotspots.test.tsx` and `scene/lobby.test.tsx`: a
    click 9 px from where it went down opens nothing, and the floor
    picker does not open; 8 px still opens.

### Rendered in headless Chromium

The same browser rendered the real app with SwiftShader (screenshots in
`/tmp`, not committed):

- **Pixel 7, the Office:** the four section buttons in two columns, the
  Notice Board with its Notice and Dismiss, the activity, the Floor
  ("Running smoothly" with an info Notice only) with its four Agents
  ("manager · Claude claude-opus-5-5", "Idle", "Issue: None", **Live
  view** and **Config**), "In progress (0)" and the Admin links. All of
  it fits 412 px. The site-wide sticky footer stays at the bottom of the
  screen as it scrolls.
- **iPad Mini upright, the Office:** the 3D lobby beside the
  navigation, with the controls and Scene settings in view. With the
  Notice Board open, its panel spans the view across the top, over the
  floor picker, with its close button in reach.
- **iPad Mini on its side:** the panel sits beside the controls, as on a
  desktop.

### Verified on the host

- [ ] **Usable on a real phone and tablet.** Run `pnpm dev`, make the
      Vite server reachable from the devices (for example `pnpm --filter
      web dev --host`, or `PUBLIC_URL` behind the Caddy proxy), and sign
      in.
  - On a phone (iOS Safari and Android Chrome), the Office is the 2D view,
    upright and on its side. Each section button scrolls to its section,
    and nothing scrolls sideways. A Notice's action and Dismiss work by
    tap. The Floor's Agents change state as work moves (label an issue
    `ai-office`). An Agent's name in the Activity Feed brings its entry
    into view. Admin, the Floor admin, the Agent editor, the Notice
    Board and the Activity Feed can all be used by thumb.
  - On a tablet (iPad and an Android tablet), the Office is the 3D one:
    - one finger turns the camera, two pinch and slide it, and the page
      does not scroll or zoom meanwhile;
    - a tap on a monitor, an Agent or the lift opens it, and a drag that
      ends on one does not;
    - closing a panel flies back to where the fingers left the camera;
    - held upright, a panel lies across the view and closes with its
      button.

    Judge whether the gestures' speeds feel natural (half a turn for the
    screen's height; the slide matching the fingers) and whether the
    frame rate holds on the tablet's GPU.

### Not verifiable in this sandbox

- **Real devices and real touch**: Playwright emulates a touch screen
  (taps, `pointer: coarse`, the viewport) in desktop Chromium. It did not
  run Safari, a real browser's touch handling, or the browser's own
  gestures, such as Safari's double-tap zoom, which `touch-action: none`
  should stop on the canvas.
- **The camera gestures in a browser**: the camera store is not
  reachable from the page, so the gestures are tested on the DOM listener
  in jsdom and as pure functions, not dragged in Chromium. How they feel
  is for the host.
- **How the 3D Office runs on a tablet's GPU**: SwiftShader took about a
  minute for the tablet test at 1×, which says nothing about a GPU.
- **The Postgres unit tests** (no Docker): skipped in `pnpm test`, as
  before. The e2e suite ran against the embedded Postgres instead.

## Noticed, out of scope

- **The site-wide footer is sticky** (an earlier change, so the Office
  keeps it above the fold): on a phone it keeps about 60 px of the
  screen on every page. A phone might rather let it scroll away.
- **The Avatar Editor's live preview is 3D** (#71), and the Floor admin
  opens it on a phone too. It is an admin panel, not the 3D Office, and a
  browser without WebGL 2 is told so and can still edit. Whether a phone
  should get a 2D preview is not decided anywhere.
- **On a narrow view, the open panel covers its object**: inspectable
  views are framed between the controls and a panel beside them
  (`controlsShare`, `panelShare`), and across the view the panel hides
  part of the object. On a tablet held on its side, it is as on a
  desktop.
- **The camera has no keyboard or mouse equivalent of the gestures**:
  the named views are its keyboard way (PRD §7, "every action in the 3D
  office is also reachable from 2D panels and the keyboard"). Mouse
  dragging was not asked for, so a mouse and a pen are left as they
  were.
- **The whiteboard and the bookshelf** have nothing to show on a phone
  yet: their panels in 3D only say what they will show (Plans and memory
  are later issues). On a phone, their address brings their Floor into
  view.
- **R3F highlights an object as a finger touches it** (its pointer-over),
  briefly, before the tap opens it or the drag moves on. It does no harm.

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
 Test Files  203 passed (203)
      Tests  2452 passed | 306 skipped (2758)
   Duration  46.26s (tests 40%, import 35%, environment 13%, transform 10%, setup 2%)
```

`pnpm e2e` (embedded Postgres 18.3 through `E2E_POSTGRES_URL`; this
issue's tests, then the summary):

```text
  ✓  17 [chromium] › tests/phone.spec.ts:53:3 › on a phone › the Office is in 2D, with no canvas, and every section is in reach (7.4s)
  ✓  18 [chromium] › tests/phone.spec.ts:131:3 › on a phone › an Agent's name brings its entry into view, and the phone on its side stays 2D (7.4s)
  ✓  19 [chromium] › tests/phone.spec.ts:157:3 › on a phone › the Notice Board, the Activity Feed and the admin pages fit the screen (7.4s)
  ✓  20 [chromium] › tests/phone.spec.ts:185:3 › on a tablet › the Office is the 3D one, with every panel inside its view, upright or on its side (49.0s)

  27 passed (1.3m)
```
