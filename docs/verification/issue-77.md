# Issue #77: Accessibility pass — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `2fb7546` (every
code commit of the issue), after `pnpm install --frozen-lockfile`. The
first audit, the fixes and the negative checks were run in the working
tree. #77's blocker, #75 (the phone and tablet 2D view), is still open,
so this pass covers the 2D UI and panels that exist now, including the 3D
Office's HTML panels. It builds on #161 (`2563a6f`): the skip link, a
title per page, the focus outline, darker muted text and field borders,
reduced motion, forced colours and the footer's dialogs
(`components/ui/dialog.tsx`), none of which is redone here.

## What was built

### Automated checks in Playwright (`e2e/`)

- **`@axe-core/playwright`** (4.13.0) is a dev dependency of
  `@ai-office/e2e`.
- **`expectAccessible(page, what)`** (`support/accessibility.ts`) waits
  until nothing on the page says it is loading ("Loading…", "Reading
  the memory…") and no finite animation or transition is running. Then
  it runs axe with every rule axe runs by default: WCAG 2.0, 2.1 and 2.2
  A and AA, and axe's best practices. A serious or critical violation
  fails the test, naming the rule and the elements. The assertion is
  soft, so one run reports every page. Every violation of any impact is
  attached to the test's report.
  - The wait for animations matters. The first runs gave different
    contrast failures from run to run, because axe measured a policy
    dialog mid-fade (`#a6a6a6` text) and buttons mid-transition after the
    colour scheme changed (4.45:1).
- **`tests/accessibility.spec.ts`**: 11 tests and 77 axe checks.
  - **The setup and sign-in screens**, each also with its error shown,
    in light and dark mode (8 checks).
  - **Every page, in use** (one test per colour scheme; 12 pages each).
    The Office is given the web-shop Floor and its team, an action and
    an info Notice, the coder's sandbox output, tool call, diff and model
    call, three Gateway requests (200, 400 and 529), and a Batch whose
    Plan awaits approval. Planning the Batch is a fourth request: the
    Manager's own call, which the Gateway answers 503 with no AI
    Account. Then come the Office (lobby), Notice Board,
    Activity, Gateway requests, a Gateway request, Analytics, Admin, the
    Floor's admin, the coder's live view, the Manager chat, the
    whiteboard, and the not-found page.
  - **The 3D Office's panels** (one test per colour scheme). The lobby
    is checked with the lift's floor picker, **Inspect** and **Scene
    settings** open. Then each inspectable object's panel, opened from
    its address: the lobby's Notice Board, the coder's monitor, and the
    Floor's whiteboard, wall board and bookshelf.
  - **The editors and forms that open in place** (one test per colour
    scheme). The Agent editor, archiving a Floor's confirmation, and
    Admin with a Claude subscription's terms, a Gateway Key shown once
    and TOTP's QR step. Then each other way to add a Skill (**Import from
    Git**, **Write one**).
  - **Admin in every theme**: each of the six themes, picked in the
    Appearance card, in light and dark mode (12 checks).
  - **The Office in a browser without WebGL 2**, in both modes.
  - **The footer's four policy dialogs** in both modes, and **the
    navigation menu** at 390 px wide.
  - **The keyboard**, which axe cannot judge, in a real browser:
    - The skip link is the first Tab stop, in view, and Enter focuses
      `<main>`.
    - A policy dialog opened with Enter has focus on its close button.
      Twelve Tabs never land outside it, and come back into it. Escape
      closes it, with focus back on its button.
    - The lift's floor picker rides to web-shop. **Inspect** opens with
      Enter. ArrowDown, End, ArrowDown (wraps), ArrowUp (wraps) and Home
      move through its objects. Enter opens the second object's panel,
      with focus in it, and Tab reaches **Close panel**. Escape closes
      it, with focus back on that object in the list.

### What the audit found, and the fixes (`apps/web`)

The first runs of the spec found these. Each is fixed, and each has a
negative check below.

| Found | Where | Impact | Fix |
| --- | --- | --- | --- |
| `listitem`: `<li>` outside a list | Every form's problem list was `<ul role="alert">` (18 in 16 files). axe saw it on the setup page, whose error was showing. | serious | The alert wraps the list (`<div role="alert"><ul>`), so it is still announced and is read as a list (`e6de126`) |
| `color-contrast` 3.64:1 | Gateway requests: a 5xx status badge (`text-destructive` on `bg-destructive/15`) | serious | `text-red-800` (`dark:text-red-300`) on `bg-red-500/15`. The 4xx badge, at 4.49:1 by the same sum, and the 2xx badge go to their -800 shades too, as AI Accounts' valid-token badge already was. AI Accounts' expired-token badges follow (`71cfaad`) |
| `color-contrast` 1.5:1 and 1.01:1 | An Agent's live view, light mode: a diff's `+1 −1` header was the theme's `bg-muted/60` inside the always-dark terminal | serious | The header uses the terminal's own colours (`bg-zinc-900`, `text-zinc-200`, `border-zinc-800`) |
| `color-contrast` 3.42:1 | Dark mode: destructive buttons ("Archive web-shop"), white on dark mode's light red | serious | A `--destructive-foreground` token: white in light mode (4.76:1), `oklch(0.145 0 0)` in dark mode (6.84:1). `theme-contrast.test.ts` holds the pair to 4.5:1 in all 12 theme-and-mode cases |
| `color-contrast` 2.16:1 | Dark mode: the Office's message in place of the scene ("This browser cannot show the 3D Office: it has no WebGL 2.", and "Loading the Office…") was muted text on the scene's sky, `light-sky` (`#e4ecf5`), which is light in both modes | serious | Written in the palette's `ink` (`text-office-ink`) |
| `heading-order` | The whiteboard's page (h1, then the Batch's h3) and a Gateway request (h1, then the header tables' h3s) | moderate | `Whiteboard` takes `headingLevel` (3 under the 3D panel's h2, the default; its page asks for 2). The header tables are h2s, like the Bodies card beside them (`db44632`) |

After the fixes, all 77 checks report **no violations at any impact**
(below).

**Reduced motion**, audited by reading the code. Nothing needed changing:

- #161's rule in `styles.css` cuts every CSS animation and transition
  under `prefers-reduced-motion: reduce`: the dialog's fade-in, the
  buttons' and fields' transitions, and the Manager chat's
  `animate-pulse`.
- No code scrolls smoothly: `scrollIntoView` is always called without
  `behavior: "smooth"`.
- The 3D Office's camera and lift follow the scene's **Reduce motion**
  setting, which starts from `prefers-reduced-motion`.

**Keyboard and focus**, audited the same way, and now checked by the
keyboard test above:

- Every control on the pages and panels is a native button, link or
  form control.
- The policy dialogs are modal `<dialog>`s, and the 3D panels move focus
  in and back.
- **Inspect** has arrow, Home and End keys.

#### Docs

- README, "The footer and accessibility": what `pnpm e2e` checks, and
  that a new page or panel goes in the spec.
- The accessibility statement: a line saying every page, dialog and
  panel is checked automatically.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from the fresh clone at `2fb7546` (output below). Without
      Docker, the Postgres-backed tests skip with the reason (2333
      passed, 347 skipped). This issue changes only `apps/web` and `e2e`,
      not the server, orchestrator or database code those tests
      exercise, so they were not run again against an embedded Postgres.
      `theme-contrast.test.ts` now has 12 more cases, for the new
      destructive pair: 265 tests, from 253.
- [x] **axe reports no serious or critical issues on every page.** In
      the fresh clone, `pnpm e2e` (the built app, the real server,
      Chromium 156 and the embedded Postgres 18.4) passes all 36 tests,
      the 11 new ones among them (output below). The JSON reporter's
      attachments for the accessibility spec hold 77 axe checks with **0
      violations of any impact**: not only none serious or critical,
      none moderate or minor either. "Every page" is every route in
      `apps/web/src/router.tsx` (setup, sign-in, the Office, Notices,
      Activity, Gateway requests and one request, Analytics, Admin, a
      Floor's admin, an Agent, the Manager chat, the whiteboard), plus
      the not-found page, the footer's dialogs and the 3D Office's
      panels. Each signed-in page is checked in light and dark mode, and
      Admin in all six themes.

**What "What to build" asks, and how it was checked** (beyond the
criteria above):

- **Keyboard navigation, and focus for panels and modals**: the keyboard
  test above, in Chromium. The existing unit tests
  (`site-footer.test.tsx`, `scene/office-view.test.tsx`, `app.test.tsx`)
  cover the same in jsdom. jsdom has no `showModal`, so only the real
  browser can show that the page behind a policy dialog is inert.
- **Labels**: axe's `label`, `button-name`, `link-name`,
  `aria-input-field-name`, `select-name` and related rules, on every
  page and form state above. None fired, before or after the fixes.
- **Contrast with the palette**: axe's `color-contrast`, in both modes
  and all six themes. Five failures were found and fixed (above). The
  Office palette's colours in the 2D UI are the lift picker's
  action-Notice badge (`state-critical` and `paper`, checked in the
  lobby's panels, which show the count) and the scene's sky (`light-sky`,
  behind the scene's messages, now in `ink`).
- **Reduced motion respected everywhere**: by reading the code (above).
  The 3D tests and the keyboard test run with `reducedMotion: "reduce"`,
  and the lift and camera arrive at once.

**Negative checks.** Each defect was put back in the working tree, the
web app rebuilt, and the test meant to catch it run. Each was then
reverted with `git checkout` (`git status` clean of them afterwards;
output below).

| Put back | Test run | Result |
| --- | --- | --- |
| The setup page's problems as `<ul role="alert">` | the setup and sign-in screens | failed: `listitem (serious)`, light and dark |
| A 5xx badge red on its red tint | every page, in use | light failed: `color-contrast (serious)` on Gateway requests; dark passed (that pair passes in dark mode) |
| The diff header in the page's muted colour | every page, in use | light failed: `color-contrast (serious)` on the live view's `+1 −1` and path |
| Destructive buttons with white text | the editors and forms | dark failed: `color-contrast (serious)` on "Archive web-shop" |
| The scene's message in muted text | the Office without WebGL 2 | failed: `color-contrast (serious)`, dark |
| A policy dialog opened with `show()`, not `showModal()` | the keyboard | failed: Tab left the dialog for the page behind |
| No skip link | the keyboard | failed: the first Tab stop is not "Skip to main content" |
| An object's panel not taking focus as it opens | the keyboard | failed: the wall board's panel is not focused |

### Not verifiable in this sandbox

- **#75's views.** The phone and tablet 2D views are not built yet. When
  they land, each of their pages and panels must be added to
  `e2e/tests/accessibility.spec.ts`, at phone and tablet sizes. Today's
  spec checks only the narrow-screen navigation menu, at 390 px.
- **Screen readers.** No assistive technology (NVDA, JAWS, VoiceOver,
  TalkBack) was used here. axe checks names, roles and structure, not
  how a screen reader speaks them. Narration of the 3D scene is out of
  scope, as the issue says.
- **Other browsers.** The Playwright suite has one project, Chromium.
  Firefox and Safari (WebKit) were not run.
- **Windows Contrast Themes** (`forced-colors`) were not emulated. #161's
  rule for it is unchanged.
- **The 3D scene on a GPU.** Here it is drawn by SwiftShader on the CPU,
  which makes each axe run on the Office about 7 s while the scene
  renders. The 3D tests therefore draw it at Low quality with reduced
  motion. The HTML panels they check are the same at every quality and
  with or without motion. The look and frame rate are for the host
  (PRD §9).
- **Testcontainers.** `pnpm e2e` ran against an embedded Postgres 18.4
  (`@embedded-postgres/linux-x64@18.4.0-beta.17` in `/tmp/pg18`, port
  54329) through `E2E_POSTGRES_URL`, as in #89. CI runs it with
  Testcontainers.
- **Chromium's system libraries**, which the sandbox lacks, were
  extracted from Debian bookworm's packages into `/tmp/chromelibs` and
  used through `LD_LIBRARY_PATH`, as in #89. Nothing was installed or
  committed.

## Notes

- **The serious-or-critical gate.** The issue asks for no serious or
  critical issues, so the test fails on those. Moderate and minor
  findings are attached to the report rather than failing it. There are
  none today: the two moderate ones found (`heading-order`) were fixed
  too.
- **`light-sky` has no foreground in the palette.**
  `paletteForegrounds` (`packages/shared/src/palette.ts`) and its table in
  `docs/reference/art-direction.md` list a text colour only for the
  tokens that "ever carry a label". `light-sky` now carries the scene's
  messages, written in `ink` (12.6:1). The art direction's table is
  canon, and `palette.test.ts` holds the code to it, so neither was
  changed here. Adding `ink` as `light-sky`'s foreground in both would
  record it.
- **Destructive red in dark mode** is light (`oklch(0.704 0.191
  22.216)`), so its buttons now carry dark text there. That is the
  change most visible to the Owner: "Archive web-shop", "Yes, delete…"
  and the like are dark on red in dark mode.

## Outside this issue

- **The whiteboard spec's wait in the 3D Office.**
  `tests/whiteboard.spec.ts` waits 5 s for "Batch 1: In progress" in the
  3D Office's whiteboard panel. With the host's load average around 60,
  it failed in a full `pnpm e2e` run and alone. It failed the same way
  2 of 2 times on the untouched base commit `4b7dbf5` (everything of
  this issue stashed), and its screenshot shows the heading there,
  arrived late. With the load around 12 to 29, it passed in the fresh
  clone's full run below. #89 recorded the same. A longer timeout on
  that one assertion would steady it; it is not this issue's to change.
- **Postgres-backed unit tests**, as above, were not run again against
  an embedded Postgres, since this issue changes no code they cover.

## Output

### Fresh clone at `2fb7546`

```text
$ git clone -q /home/agent/workspace /tmp/clone77 && cd /tmp/clone77 && git log --oneline -1
2fb7546 docs: the accessibility checks in the end-to-end tests

$ pnpm install --frozen-lockfile
Done in 1.1s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  204 passed (204)
      Tests  2333 passed | 347 skipped (2680)
test exit=0
```

### Playwright, fresh clone at `2fb7546`

```text
$ LD_LIBRARY_PATH=/tmp/chromelibs/… E2E_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm e2e
✓   7 [chromium] › tests/accessibility.spec.ts:29:1 › the setup and sign-in screens (21.8s)
✓   6 [chromium] › tests/accessibility.spec.ts:371:3 › the editors and forms that open in place (light) (21.8s)
✓   5 [chromium] › tests/accessibility.spec.ts:371:3 › the editors and forms that open in place (dark) (21.8s)
✓   9 [chromium] › tests/accessibility.spec.ts:444:1 › the Office in a browser without WebGL 2 (9.3s)
✓  11 [chromium] › tests/accessibility.spec.ts:461:1 › the footer's dialogs, and the navigation on a narrow screen (18.6s)
✓   1 [chromium] › tests/accessibility.spec.ts:307:3 › every page, in use (light) (44.9s)
✓  12 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (16.0s)
✓  10 [chromium] › tests/accessibility.spec.ts:499:1 › the keyboard: the skip link, a policy dialog and an object's panel (25.4s)
✓   3 [chromium] › tests/accessibility.spec.ts:307:3 › every page, in use (dark) (47.2s)
✓   8 [chromium] › tests/accessibility.spec.ts:418:1 › Admin in every theme, in light and dark mode (47.2s)
✓  17 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (8.1s)
✓  15 [chromium] › tests/agent-live-view.spec.ts:10:1 › an Agent's events stream into its live view (8.3s)
✓  18 [chromium] › tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it (8.2s)
✓  14 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (10.6s)
✓   4 [chromium] › tests/accessibility.spec.ts:321:3 › the 3D Office's panels (light) (55.5s)
✓   2 [chromium] › tests/accessibility.spec.ts:321:3 › the 3D Office's panels (dark) (58.8s)
✓  19 [chromium] › tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests (3.4s)
✓  22 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (3.2s)
✓  21 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (3.2s)
✓  13 [chromium] › tests/activity.spec.ts:81:1 › the Activity Feed loads older events as it scrolls (18.2s)
✓  23 [chromium] › tests/gateway-keys.spec.ts:15:1 › makes a Gateway Key for a tool, uses it, then revokes it (3.2s)
✓  16 [chromium] › tests/agent-live-view.spec.ts:107:1 › the live view follows new output, and pauses while the Owner reads back (11.5s)
✓  20 [chromium] › tests/batch.spec.ts:13:1 › "complete issues 1 and 2" with plan approval off: the Plan is kept, shown in the chat, and work starts (3.2s)
✓  31 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (3.5s)
✓  29 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (3.6s)
✓  27 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (3.6s)
✓  30 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (3.6s)
✓  26 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (3.6s)
✓  25 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (3.6s)
✓  24 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (3.6s)
✓  28 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (3.6s)
✓  34 [chromium] › tests/status-report.spec.ts:13:1 › "status" in the Manager chat: the report lists the blocked issue and those needing the Owner, and is an info Notice (5.3s)
✓  36 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (4.6s)
✓  32 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (5.4s)
✓  33 [chromium] › tests/skills.spec.ts:35:1 › writes a Skill, and uploads one that is reviewed before it is enabled (5.4s)
✓  35 [chromium] › tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: the Manager replans, and work starts in the new order (11.9s)
  36 passed (1.3m)
e2e exit=0
```

### The accessibility spec's axe results, fresh clone at `2fb7546`

`pnpm --filter @ai-office/e2e exec playwright test
tests/accessibility.spec.ts --reporter=json`, then every `axe: …`
attachment read back and its violations counted:

```text
passed the setup and sign-in screens
passed every page, in use (light)
passed every page, in use (dark)
passed the 3D Office's panels (light)
passed the 3D Office's panels (dark)
passed the editors and forms that open in place (light)
passed the editors and forms that open in place (dark)
passed Admin in every theme, in light and dark mode
passed the Office in a browser without WebGL 2
passed the footer's dialogs, and the navigation on a narrow screen
passed the keyboard: the skip link, a policy dialog and an object's panel
77 axe checks; violations of any impact: 0
{'expected': 11, 'skipped': 0, 'unexpected': 0, 'flaky': 0}
```

### The first audit (working tree, before the fixes)

The violations axe reported on its first full pass, from a scratch
dump of each check (removed before committing). The dialog and button
contrast readings were measured mid-animation, which led to the wait
in `settled`.

```text
== setup, password refused (light)
   listitem serious 1   .space-y-1 > li | List item parent element has a role that is not role="list"
== Gateway requests (light)
   color-contrast serious 2   … contrast of 3.64 (foreground color: #e7000b, background color: #fbd9da, font size: 9.0pt (12px) …)
== an Agent's live view (light)
   color-contrast serious 2   .text-emerald-400 | … contrast of 1.5 (foreground color: #00d492, background color: #979797 …)
                              .text-red-400 | … contrast of 1.01 (foreground color: #ff6467, background color: #979797 …)
== a Gateway request (light)
   heading-order moderate 1   <h3 class="text-sm font-medium">Request headers</h3>
== the whiteboard (light)
   heading-order moderate 1   <h3 id="_r_4_-heading" class="font-semibold">Batch 1: Awaiting approval</h3>
```

Then, from the tests added after it:

```text
archiving a Floor (dark)
    color-contrast serious ['<button data-slot="button" …'] Element has insufficient color contrast of 3.42 (foreground color: #ffffff, background color: #e85c5f …)
the Office without WebGL 2 (dark)
    color-contrast serious … contrast of 2.16 (foreground color: #a1a1a1, background color: #e4ecf5, font size: 10.5pt …)
```

### Negative checks (working tree)

```text
== The setup page's problems are a <ul role="alert"> again  [-g setup and sign-in]  exit=1
    1 failed
    Error: axe's serious and critical violations on setup, password refused (light)
    +   "listitem (serious): <li> elements must be contained in a <ul> or <ol>, at .space-y-1 > li",
    Error: axe's serious and critical violations on setup, password refused (dark)
    +   "listitem (serious): <li> elements must be contained in a <ul> or <ol>, at .space-y-1 > li",
== A 5xx badge is red on its red tint again  [-g every page]  exit=1
    1 failed
    1 passed (37.5s)
    Error: axe's serious and critical violations on Gateway requests (light)
    +   "color-contrast (serious): Elements must meet minimum color contrast ratio thresholds, at tr[aria-label=\"Request 4\"] > td:nth-child(6) > .bg-destructive\\/15.text-destructive.rounded; tr[aria-label=\"Request 3\"] > td:nth-ch
== The diff header takes the page's muted colour again  [-g every page]  exit=1
    1 failed
    1 passed (22.9s)
    Error: axe's serious and critical violations on an Agent's live view (light)
    +   "color-contrast (serious): Elements must meet minimum color contrast ratio thresholds, at figcaption > span:nth-child(1); .text-emerald-400; .text-red-400",
== Destructive buttons are white text in dark mode again  [-g editors]  exit=1
    1 failed
    1 passed (13.6s)
    Error: axe's serious and critical violations on archiving a Floor (dark)
    +   "color-contrast (serious): Elements must meet minimum color contrast ratio thresholds, at .bg-destructive",
== The scene's messages are muted text again  [-g WebGL]  exit=1
    1 failed
    Error: axe's serious and critical violations on the Office without WebGL 2 (dark)
    +   "color-contrast (serious): Elements must meet minimum color contrast ratio thresholds, at .max-w-md",
== A policy dialog opens with show(), not showModal()  [-g keyboard]  exit=1
    1 failed
    Error: expect(received).toBe(expected) // Object.is equality
    Expected: false
    Received: true
== No skip link  [-g keyboard]  exit=1
    1 failed
    Error: expect(locator).toBeFocused() failed
    Locator: getByRole('link', { name: 'Skip to main content' })
    Expected: focused
    Error: element(s) not found
== An object's panel does not take focus as it opens  [-g keyboard]  exit=1
    1 failed
    Error: expect(locator).toBeFocused() failed
    Locator:  getByRole('dialog', { name: 'The wall board' })
    Expected: focused
    Received: inactive
```

(Request 4 is the Manager's own call to plan the Batch, which the
Gateway answered 503, so it has a 5xx badge too.)

### The whiteboard spec on the base commit, under load

```text
$ git stash -u && pnpm build   (base 4b7dbf5, nothing of #77)
$ pnpm --filter @ai-office/e2e exec playwright test tests/whiteboard.spec.ts   (twice)
  ✘  1 [chromium] › tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: … (17.2s)
  ✘  1 [chromium] › tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: … (15.4s)
$ cat /proc/loadavg
60.75 41.04 27.21 44/29942 33974
$ git stash pop
```
