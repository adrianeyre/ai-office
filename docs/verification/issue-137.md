# Issue #137: Above-head display, the Context Usage bar and tokens used today — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in the working tree of this branch, clean at
`b3ca3e1`. The code is in `9d3d4d6` (the display), `ade8932` (a fix to
it), `f51a8e9` and `b3ca3e1` (the screenshot test); the guide and README
are in `cf2498b` and `b3ca3e1`. The checks were `pnpm lint`,
`pnpm typecheck`, `pnpm test` and `pnpm scenes`. After them, only this
note changed.

The blockers are built on this branch:

- **#50**, token accounting and Token Caps ([`issue-50.md`](issue-50.md)):
  `GET /api/floors/:floorId/token-usage` lists each of the Floor's Agents
  with its tokens today and this month against the daily and monthly caps
  in force for it, which the tokens label reads.
- **#70**, the character kit ([`issue-70.md`](issue-70.md)): the Agents'
  figures, each in its own group that sits, walks and meets, which the
  display is a child of.
- **#120**, Context Usage ([`issue-120.md`](issue-120.md)):
  `GET /api/floors/:floorId/context-usage`, the `agent.context_usage`
  events, `withContextUsageEvent` and the colour bands
  (`contextUsageBand`, `contextUsageBandTokens`). Its note left "the bar
  above each Agent's head" to this work. #121's `agent.fresh_start`
  events drive the Fresh Start animation.

## What was built

### What it shows (`apps/web/src/scene/above-head.ts`)

- **`compactTokens`**: `999`, `1.2k`, `128k`, `3.4M` (and `B` past a
  billion). One decimal below 10 of a unit, none above, always rounded
  down, so the label never claims more than was used (`999,999` is
  `999k`, never `1000k`). `tokensTodayText` is `128k today`;
  `tokensThisMonthText` is `3.4M of 100M this month`.
- **`dailyCapState(used, cap)`**: the wall board's `capState` (#69):
  neutral below 80% of the daily cap, `warning` (amber) from 80%,
  `reached` (red) at 100%. With no cap (`null`) it is neutral, whatever
  was used.
- **`aboveHeads`**: each Agent's display from the two API bodies. Context
  Usage comes from the Agents with a session going; an Agent not listed
  has none, so no bar. Tokens come from the Floor's token usage; an Agent
  added since it was read has used nothing, against the caps its Floor
  gives its Agents.
- **`freshStartSignals`**: the Fresh Starts among a Floor's events.

### How it looks (`apps/web/src/scene/above-head.tsx`)

- **One HTML display per Agent** (drei's `Html`, centred, fixed CSS
  size), so its text stays sharp at any distance and faces the camera.
  It is a child of the Agent's own group in `DeskAgent`, 2.2 m up
  (`aboveHeadHeight`), so it goes with the Agent on Handoff walks, to
  meetings and on idle activities. That height is clear of a standing
  head (1.85 m at most) and of the paused or capped marker (centred at
  1.78 m over the seat).
- **The Context Usage bar**, while the Agent has a session going: a
  10-unit track on paper, filled to the percentage in `state-ok`,
  `state-warning` or `state-critical` (green below 60%, amber from 60%,
  red from 85%), with the whole percent beside it, or `Unknown` and no
  fill without a context window. With no session going, there is no bar.
- **The tokens label**, idle or not: `128k today` on paper below 80%,
  on `state-warning` from 80%, on `state-critical` with paper text at
  100% (the palette's foreground pairs, 4.5:1 or more). Hovering it shows
  `3.4M of 100M this month` above it. Only the label takes the pointer;
  the rest of the display lets it through to the scene.
- **At a Fresh Start** (an `agent.fresh_start` newer than the display),
  the bar empties from the Context Usage it ended at to nothing over
  1.2 s (`fresh-start-drain` in `styles.css`), in that usage's colour,
  saying "Fresh Start". It then hides until the new session's first call
  is counted. With reduced motion there is no animation. A Fresh Start
  from before the display was drawn is not played.
- **Hidden from assistive technology**, like the scene's other labels.
  The Agent card and the Agent live view say the same in 2D (FR-63,
  FR-85).

### Where its data comes from (`office-view.tsx`, `useFloorAboveHead`)

- On a Floor, the Office reads `GET /api/floors/:floorId/context-usage`
  and keeps it live with `agent.context_usage` events. It reads it again
  whenever the stream (re)connects.
- It reads `GET /api/floors/:floorId/token-usage` every minute
  (`tokenRefreshMs`, as the Agent card does).
- The `agent.context_usage` and `agent.fresh_start` events come on a
  stream of their own, keeping 50 events. On the team's stream they would
  push the Floor's Handoffs and meetings out of its 200: a meeting's
  `batch.kickoff_started` must stay there while the meeting lasts.
- `OfficeScene` → `OfficeLocationScene` → `Floor` → `DeskAgents` pass the
  displays and Fresh Starts down. Nothing is read in the lobby.

### The setting

**Scene settings** has a new checkbox, **Show Context Usage and tokens
above Agents** (`showAboveHead` in `useSceneSettings`). It is on by
default and kept in the browser's local storage, like the other scene
settings. Off, it hides every bar and label together, and the Office
reads and streams none of it. Reduced motion, the existing setting,
turns off the Fresh Start animation.

### A fix on the way (`ade8932`)

The screenshot first showed every Agent's display but the Manager's. Its
wrapper was in the page but empty. drei's `Html` puts its label in the
element the canvas takes its events from (`events.connected`). If that
element changes after the label is first drawn, drei moves the label by
making a second React root on the same element. The first root's late
first commit then empties it. The first Agent drawn (the Manager) was
drawn before R3F had connected the canvas's events, so it hit this.
Each display now waits for that element and pins it as its portal. A
unit test covers the waiting (none is drawn while nothing is connected),
and the screenshot test checks one display per Agent.

### The screenshot scene (`f51a8e9`, `b3ca3e1`)

- **The scene**: `above-head`, a new key scene on `apps/web/screenshots/`.
  It is the screenshot Floor of seven Agents at the Office's overview,
  which is the default camera distance. Its displays come from the
  Office's own `aboveHeads`, fed fixed Context Usage and token usage in
  the API's shapes (`scene-data.ts`; a test parses both with the API's
  schemas).
- **Who shows what**:
  - The busy coder (ada, typing at a lit monitor) has its bar, amber at
    62%, and `128k today`.
  - The idle designer (dieter) has `9.4k today` alone.
  - Linus is at 81% of the daily cap (`812k today`, amber) and the capped
    Agent at 100% (`1M today`, red).
  - The reviewer, also at work, has no bar: its calls are stateless
    (FR-84).
- **The test** (`e2e/scenes/scenes.spec.ts`) checks the page first:
  - seven displays;
  - the coder's bar (`amber`, `62%`) and `128k today`;
  - no bar over the designer, and `9.4k today`;
  - the amber and red labels.

  It then compares `[data-scene-view]`, the canvas and its HTML labels
  together, with the key scenes' tolerance (100 pixels at the 0.2
  threshold).
- **The page's styles**: the screenshot page now loads the app's
  Tailwind (`screenshots/styles.css`, with `@source "../src"`, since the
  page's Vite root is `screenshots/`). It sets its fonts to DejaVu, so
  the labels' text is drawn alike on every Linux (see Notes).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 on the clean tree (output below): 377 test files, 4183 tests
      passed, 557 skipped (Postgres and Mailpit, which need Docker).
      - Of the two full `pnpm test` runs at `b3ca3e1`, the first had one
        failure in `grilling-room.test.tsx`, the flaky test #133's and
        #134's notes record. The second passed.
      - An earlier full run, at `cf2498b`, failed once in
        `meeting-room.test.tsx`, another test of the same kind.
      - Neither file was changed here. Seeding `Math.random` showed both
        fail on exactly the same seeds on this branch and on the base
        commit `8062f10` (see "Noticed, out of scope").
- [x] **Unit tests: token formatting (999, 1.2k, 128k, 3.4M).**
      `above-head.test.ts` checks those four, and the edges around them:
      0, 1k, 1.2k from 1,299, 9.9k, 10k, 128k from 128,999, 999k, 1M,
      12M and 2.5B. It also checks `128k today` and
      `3.4M of 100M this month`.
- [x] **Unit tests: colour bands at 79/80/99/100% of the daily cap.**
      - `above-head.test.ts`: `dailyCapState` is neutral at 79% (and
        79.9999%), amber at 80%, 99% and 99.9999%, and red at 100% and
        120%.
      - `above-head-display.test.tsx` renders the label at 79%, 80%, 99%
        and 100%: `790k today` on paper, `800k today` and `990k today` on
        `state-warning`, and `1M today` on `state-critical`.
- [x] **Unit tests: an Agent with no cap stays neutral.** `dailyCapState`
      is neutral with no cap at 0 and at 5 billion tokens, and the label
      for `9M today` with no cap is on paper.
- [x] **Screenshot test: a Floor with a busy Agent (bar and tokens) and an
      idle Agent (tokens only).** `pnpm scenes` passes, **16 passed**
      (output below): the ten Floor-theme scenes and the five key scenes,
      all unchanged, and the new `above-head` scene.
      - **The picture** (`e2e/scenes/reference/above-head-linux.png`,
        new): I looked at it. Every Agent has its label, the coder has its
        amber bar at 62% beside `128k today`, and the designer has
        `9.4k today` alone. The labels read clearly at the overview and
        sit clear of the pause and cap markers.
      - **It is stable**: a second run of the same build compared equal.
      - **It catches a missing bar**: as a check, I removed the coder's
        session from `scene-data.ts` and the test's checks of the page,
        ran the comparison, then restored both. The picture differed by
        1,653 pixels (tolerance 100).

The rest of the behaviour is covered by tests, all passing (output
below):

- **The display** (`above-head-display.test.tsx`):
  - the bar's fill, colour and percentage at 59, 60, 84 and 85%;
  - `Unknown` with no fill;
  - no bar while idle;
  - the hover;
  - at a Fresh Start: the drain from 86% in red over 1.2 s, then the bar
    hidden; no animation with reduced motion; no replay of an older Fresh
    Start.
- **In the test renderer**: each display floats 2.2 m over its Agent
  seated, and stays over it as it walks a Handoff more than 0.5 m away.
  None is drawn before the canvas's events are connected. The setting
  hides and shows them all.
- **`office-view.test.tsx`** (4 new):
  - the checkbox;
  - the scene gets each Agent's Context Usage and tokens from the two
    API bodies;
  - an `agent.context_usage` event moves the coder to 86%, and an
    `agent.fresh_start` reaches the scene while its session's end
    removes the bar;
  - these events come on one stream of their own, not the team's;
  - with the setting off, nothing is read or streamed;
  - nothing is read in the lobby.
- **`stores.test.ts`**: the setting's default, storage and a bad stored
  value.
- **`scene-data.test.ts`**: the screenshot data is what the API sends,
  with a bar only over a typing, non-reviewer Agent and labels in all
  three colours.

### Verified on the host

- [ ] **Readable at the default camera distance, follows walking Agents,
      and the Floor keeps the frame-rate target.** Not verifiable here:
      there is no GPU or display, and SwiftShader's frame rate says
      nothing about a laptop's. What the sandbox shows:
      - **Readable**: the screenshot at the overview, 1280 × 720.
      - **Follows walking Agents**: the test-renderer test above.
      - **Cost**: the display adds no WebGL draw calls (it is HTML). Per
        frame, drei projects each Agent's display and moves its element
        only when it moved on screen. A Floor of 12 Agents is 12 such
        projections.
      - **To check on the host**: open the Office on a Floor with
        **Show frame rate**, at Medium, 1080p. Watch the labels while an
        Agent walks a Handoff or goes to the coffee machine. Toggle
        **Show Context Usage and tokens above Agents** to compare the
        frame rate. A real Fresh Start shows the drain.

## Not verifiable in this sandbox

- **How it looks and moves in a real browser on a GPU**: the labels'
  legibility on a real screen and DPI, over every theme, and how they
  overlap when Agents gather in the meeting room. The Fresh Start drain
  and the hover tooltip are checked only through the DOM.
- **CI's run of the new reference picture.** It was taken here, in
  Debian bookworm's Chromium headless shell 1248 with DejaVu fonts. CI
  runs Ubuntu. The page pins DejaVu, which Ubuntu ships too, so the
  labels should draw alike. Text hinting could still differ by a few
  pixels. If CI's **Screenshots** job differs only on the labels' text,
  retake `above-head-linux.png` there.
- **The end-to-end suites**, which need Docker. None was changed.

## Notes

- **"Idle" is "no session going."** FR-85 says the bar is shown "above
  each Agent with an active session" and "hidden while the Agent is
  idle". The bar is shown exactly while
  `GET /api/floors/:floorId/context-usage` lists the Agent. That covers a
  sandbox's run and the Manager chat (#120), and never a reviewer, whose
  calls are stateless.
- **The gap after a Fresh Start.** A Fresh Start ends the session
  (`agent.context_usage` with `active: false`) before the new one's first
  call is counted. So after its 1.2 s drain, the bar hides for that gap
  and comes back low when the new session's first call is counted. It
  is never shown at a made-up 0%.
- **Neutral is paper.** FR-62 says "neutral below 80%". The label is
  paper with ink text, like the scene's other labels, rather than the
  mid-grey `state-neutral` the wall board's cap meters use. Grey on the
  Floor's carpet and walls read poorly, and amber and red stand out
  against paper.
- **"No cap" cannot come from the API today.** The office's caps always
  exist (#50), so every Agent has a daily cap in force. The neutral case
  is for a null cap, which `dailyCapState` takes and is tested with.
- **Tokens are read every minute**, as the Agent card's and the wall
  board's are. `model_call.completed` is still not published (noted in
  #32, #68, #69 and #120), so no event says tokens changed.
- **The hover is for the pointer.** The label is not focusable. The
  Agent card has this month's tokens against the monthly cap for the
  keyboard (PRD §7: every action is also in 2D panels).
- **How Chromium was run here** (outside the repository, as for earlier
  issues): `playwright install chromium` (headless shell 1248). Its
  missing shared libraries came from Debian bookworm packages
  (`apt-get download` with lists in `/tmp/apt`), extracted to
  `/tmp/chromelibs` and put on `LD_LIBRARY_PATH`.

## Noticed, out of scope

- **Two flaky Floor tests**, neither touched here:
  `meeting-room.test.tsx > … a Kickoff over at once still gathers them
  for a moment …` and `grilling-room.test.tsx > … the Manager walks to
  the table …`. Each depends on the Floor's idle behaviours, which use an
  unseeded `Math.random`: an idle Agent can set off for an activity
  inside the test's window.
  - Unseeded, `meeting-room` failed 9 of 75 runs on this branch and 1 of
    75 on the base commit `8062f10`.
  - To tell chance from a change, I seeded `Math.random` in a scratch
    copy of each test (reverted, never committed) and ran 40 seeds on
    both commits. They fail on exactly the same seeds: `meeting-room` on
    3, 15, 16, 17 and 23, and `grilling-room` on 25 and 31. So the
    behaviour is unchanged, and both tests are flaky at about 12% and 5%.
  - Seeding the Floor's random in these tests (or passing a seeded one
    to `Floor`) would fix them.
- **drei's `Html` and a moving target.** The race fixed here for the
  displays (`ade8932`) could hit any of the scene's other HTML labels
  drawn in the same first commit as the canvas: the idle bubbles,
  Handoff tickets, the in-session sign and the lobby's bubbles. Each
  usually appears later, once its data or its moment comes, and I did
  not see one go missing, but none of them waits for the canvas's events
  as the displays now do.
- **One more event stream on a Floor.** The Office on a Floor now holds
  four streams: Notices, the team, the monitors, and this one. An open
  wall board or Agent card adds one more. Browsers allow six HTTP/1.1
  connections per origin, so a deployment without HTTP/2 (Caddy gives
  HTTP/2 over TLS) is close to that limit. One shared stream per Floor
  would be a separate change.
- **The label takes the pointer.** A click on a tokens label does not
  select the Agent under it, and a drag that starts on one does not turn
  the camera. Each label is small, but where several overlap, as at the
  meeting room's table, they cover more of the scene.
- **The desk monitor's gauge, the wall board's and the Agent card's**
  (#68, #69, #72) are out of scope, as the issue says. They can use
  `compactTokens` and `dailyCapState` from `scene/above-head.ts`.

## Output

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit=0

$ pnpm test   (first run at b3ca3e1; no Docker: Postgres and Mailpit tests skip with the reason)
 FAIL  |@ai-office/web| src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > the Manager walks to the table as it starts and sits there while it runs, with the door's sign lit and the whiteboard filled in; it walks back when the session pauses
AssertionError: reviewer: expected true to be false // Object.is equality
 Test Files  1 failed | 376 passed (377)
      Tests  1 failed | 4182 passed | 557 skipped (4740)
exit=1

$ pnpm test   (second run at b3ca3e1)
 Test Files  377 passed (377)
      Tests  4183 passed | 557 skipped (4740)
exit=0

$ pnpm test   (earlier, at cf2498b)
 FAIL  |@ai-office/web| src/scene/meeting-room.test.tsx > meetings on a Floor > a Kickoff over at once still gathers them for a moment; a Wrap-up gathers them for a while by itself
AssertionError: expected 1.6007810593582135 to be less than 0.000001
 ❯ src/scene/meeting-room.test.tsx:195:58
 Test Files  1 failed | 376 passed (377)
      Tests  1 failed | 4182 passed | 557 skipped (4740)

$ vitest run meeting-room.test.tsx -t "over at once"   (unseeded, 25 + 50 runs each)
this branch: 5 of 25, 4 of 50 failed
base 8062f10: 0 of 25, 1 of 50 failed

$ SEED=1..40 vitest run …   (Math.random seeded in a scratch copy of each test; reverted)
meeting-room  HEAD: ..F3 ...........F15 F16 F17 .....F23 .................
meeting-room  BASE: ..F3 ...........F15 F16 F17 .....F23 .................
grilling-room HEAD: ........................F25 .....F31 .........
grilling-room BASE: ........................F25 .....F31 .........

$ pnpm scenes   (LD_LIBRARY_PATH=/tmp/chromelibs/…)
  ✓   3 [chromium] › scenes/floor-themes.spec.ts:22:1 › covers every theme (10ms)
  ✓   1 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the office theme, from development (1.4m)
  ✓   2 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the stockroom theme, from online-store (1.4m)
  ✓   4 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the studio theme, from website-and-marketing (1.5m)
  ✓   6 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the library theme, from documentation (1.4m)
  ✓   5 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the editorial theme, from content-and-blog (1.5m)
  ✓   7 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the atelier theme, from design-system (1.4m)
  ✓  10 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the device-lab theme, from mobile-app (1.6m)
  ✓   8 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the observatory theme, from data-and-analytics (1.7m)
  ✓   9 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the data-centre theme, from infrastructure (1.7m)
  ✓  11 [key-scenes] › scenes/scenes.spec.ts:60:1 › the lobby (9.2s)
  ✓  12 [key-scenes] › scenes/scenes.spec.ts:65:1 › the lobby's reception desk, with a failing Connection's marker (10.6s)
  ✓  13 [key-scenes] › scenes/scenes.spec.ts:75:1 › a Floor (10.4s)
  ✓  16 [key-scenes] › scenes/scenes.spec.ts:117:1 › the Avatar Editor's preview (1.4s)
  ✓  14 [key-scenes] › scenes/scenes.spec.ts:80:1 › a Floor's Context Usage bars and tokens above its Agents' heads (7.9s)
  ✓  15 [key-scenes] › scenes/scenes.spec.ts:109:1 › the meeting room (7.7s)
  16 passed (5.1m)
exit=0

$ pnpm scenes --project=key-scenes -g "above"   (scratch: no session for the coder, page checks removed; reverted)
  ✘  1 [key-scenes] › scenes/scenes.spec.ts:80:1 › a Floor's Context Usage bars and tokens above its Agents' heads (10.1s)
    Error: expect(locator).toHaveScreenshot(expected) failed
      1653 pixels (ratio 0.01 of all image pixels) are different.

$ vitest run --reporter=verbose (this issue's tests)
 ✓ stores.test.ts > the scene settings > start on Medium, with the FPS overlay off and the displays above the Agents' heads on
 ✓ stores.test.ts > the scene settings > are kept in this browser's local storage
 ✓ stores.test.ts > the scene settings > read back what was stored, and drop what this version does not know
 ✓ above-head.test.ts > compactTokens > writes tokens short: 999, 1.2k, 128k, 3.4M
 ✓ above-head.test.ts > compactTokens > never shows more than was used, rounding down
 ✓ above-head.test.ts > compactTokens > labels today's and this month's tokens
 ✓ above-head.test.ts > dailyCapState > is neutral at 79% of the daily cap, amber from 80% and through 99%, red at 100%
 ✓ above-head.test.ts > dailyCapState > stays neutral for an Agent with no cap, however much it used
 ✓ above-head.test.ts > aboveHeads > gives each Agent its Context Usage while it has a session going, and its tokens
 ✓ above-head.test.ts > aboveHeads > keeps an unknown Context Usage unknown, and shows no tokens until they are read
 ✓ above-head.test.ts > freshStartSignals > picks the Fresh Starts out of a Floor's events, oldest first
 ✓ scene-data.test.ts > the screenshot scenes' data > floats a bar and tokens over a busy Agent and tokens alone over an idle one, from what the API sends (FR-62, FR-85)
 ✓ above-head-display.test.tsx > the display above an Agent's head > shows a busy Agent's Context Usage bar, filled and coloured, beside its tokens today
 ✓ above-head-display.test.tsx > the display above an Agent's head > colours the bar green below 60%, amber from 60% and red from 85%
 ✓ above-head-display.test.tsx > the display above an Agent's head > says Unknown, with no fill, when the Model's context window is not known
 ✓ above-head-display.test.tsx > the display above an Agent's head > hides the bar while the Agent is idle, and keeps its tokens
 ✓ above-head-display.test.tsx > the display above an Agent's head > colours the tokens against the daily cap: neutral at 79%, amber at 80% and 99%, red at 100%, neutral with no cap
 ✓ above-head-display.test.tsx > the display above an Agent's head > shows this month's tokens against the monthly cap while hovered
 ✓ above-head-display.test.tsx > the display above an Agent's head > shows nothing until there is something to show
 ✓ above-head-display.test.tsx > the display above an Agent's head > at a Fresh Start > briefly empties the bar from where it was, then hides it until the next session
 ✓ above-head-display.test.tsx > the display above an Agent's head > at a Fresh Start > does not animate with reduced motion
 ✓ above-head-display.test.tsx > the display above an Agent's head > at a Fresh Start > does not play a Fresh Start that happened before it was drawn
 ✓ above-head-display.test.tsx > the display above each Agent's head, in the scene > floats over each Agent, in HTML, and goes with it as it walks
 ✓ above-head-display.test.tsx > the display above each Agent's head, in the scene > waits for the canvas's event target before drawing, so drei never moves it
 ✓ above-head-display.test.tsx > the display above each Agent's head, in the scene > is switched off, bar and tokens alike, by the scene settings
 ✓ office-view.test.tsx > the Office's 3D view > with WebGL > switches the Context Usage bars and token labels above the Agents off and on
 ✓ office-view.test.tsx > what floats above the Agents' heads > gives the scene each Agent's Context Usage and tokens, and follows Context Usage and Fresh Starts live, on a stream of their own
 ✓ office-view.test.tsx > what floats above the Agents' heads > reads and shows none of it while the scene settings switch it off
 ✓ office-view.test.tsx > what floats above the Agents' heads > shows none in the lobby, nor reads it there
 Test Files  5 passed (5)
      Tests  89 passed (89)
```

The scene tests in the test renderer print three.js's
`THREE.Clock: This module has been deprecated` warning to stderr, as the
other scene tests do.
