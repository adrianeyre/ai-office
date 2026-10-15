# Issue #72: Agent cards and fly-to-Agent — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code
commit (`8d50fb1`, then the e2e spec's update), with the README commit
before it changing only Markdown.

The blockers are built on this branch:

- #67, the inspectable objects ([`issue-67.md`](issue-67.md)): one
  mechanism for clicking an object in the scene, flying the camera in and
  opening its HTML panel, its keyboard list, and the Office's address
  (`?floor=…&inspect=…`). Its `Selection` already named Agents' cards
  (FR-63) as a kind to select.
- #70, the character kit ([`issue-70.md`](issue-70.md)): the Agents sat
  at their desks as their Avatars, which #71 made inspectable (the
  `agent` kind, with its hit box and its over-the-shoulder view). The
  card takes over that panel.

**The scope addition is not built.** The comment on the issue adds PRD
FR-85's Context Usage, colour-coded, and FR-87's "Fresh start" action on
the card, "calling the API from #121". That API is not on this branch:
nothing serves an Agent's Context Usage (FR-84) or starts a Fresh Start,
and the only Context Usage in the code is the `agent.fresh_start` event's
field, which nothing publishes. #68 and #69 found the same for their
Context Usage additions ([`issue-68.md`](issue-68.md),
[`issue-69.md`](issue-69.md)). Building it would mean inventing #121's
API, so it waits for #121 (below).

## What was built

- **An Agent's card** (`apps/web/src/scene/agent-card.tsx`; PRD FR-63).
  Clicking an Agent where it sits in the Office (or picking it in
  **Inspect**, or from the address) flies the camera to it, as before,
  and its panel is now its card:
  - its **name** (the panel's heading; the keyboard list now names the
    Agent "Ada" rather than "Ada's Avatar"), **Role**, **AI Provider**
    and **Model** ("(default)" when it uses its AI Provider's);
  - its **current issue**: the issue it is working, or else the oldest
    waiting for it (`currentIssueOf` in `wall-board.ts`), from the
    Floor's wall board (`GET /api/floors/:floorId/wall-board`), with its
    stage in its Stage's colour, "Working" or "Waiting", and its issue
    and pull request on GitHub; "None" without one. A review round's
    issue is each of its required reviewers';
  - its **tokens against caps**, today and this month, against the cap in
    force for it (`GET /api/floors/:floorId/token-usage`), as the wall
    board's meters: neutral below 80%, amber from 80%, red at 100%
    ("(reached)" in words too);
  - kept live by the Floor's event stream (the wall board's,
    `useLiveWallBoard`), and its tokens read again once a minute.
- **Its links:**
  - **Open Ada's monitor** flies on to the Agent's desk monitor and opens
    its live view there (whose panel links to the live view's page);
  - **Open Ada's config** opens the Floor admin with the Agent's editor
    open and brought into view: the Floor admin's address takes
    `?agent=<id>` (`/admin/floors/web-shop?agent=ada`);
  - **Open Ada's Avatar Editor** shows the editor (#71) in the card's
    place, with **Back to Ada's card** above it.
- **Every Agent's name flies the camera to it** (FR-63, §5 scenario 2).
  `AgentLink` now links to `/?floor=<floor>&inspect=agent:<id>`: the
  Office rides the lift to the Agent's Floor, flies the camera to the
  Agent and opens its card. That covers every Agent name in the 2D UI:
  the Notice Board, the Activity Feed, the Gateway's request history,
  Analytics' top consumers (which linked to the live view directly), the
  Floor admin's Agents table, Admin's Token Caps ("nearest its cap"), and
  now the live view's and the Manager chat's headings. Inside the Office,
  the wall board's names (Notices, issues in progress, queues, tokens)
  fly to the Agent and open its card at once, where they opened its
  monitor before.
- **README**: "Agent cards and flying to an Agent" under the 3D Office;
  the Avatar Editor, the live view and the wall board say where they are
  reached from now.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below), and `pnpm build` and `pnpm e2e` too.
- [x] **Component tests for the card.**
      `apps/web/src/scene/agent-card.test.tsx` renders the card as the
      Office shows it (the `agent` panel in `InspectorPanel`) against a
      stubbed server with a Floor at work:
      - a coder's name, Role, AI Provider, overridden Model (no
        "(default)"), current issue (#4, Work, Working, PR #12, each
        linked to GitHub) and its tokens today (850 of 1,000, amber) and
        this month (2,000 of 10,000, neutral);
      - a reviewer waiting for a review round (#7, Review, Waiting), its
        default Model, and a daily cap reached (red, "(reached)");
      - "None" for an Agent on no issue;
      - what cannot be read is said so, and the rest still shows;
      - live: an `issue.assigned` event on the Floor's stream reads the
        board and tokens again, and the new issue and tokens show;
      - **Open Bo's monitor** selects its monitor and sets the camera
        heading to `inspect:monitor:bo`;
      - **Open Bo's config** links to `/admin/floors/web-shop?agent=bo`,
        opened without a reload;
      - **Open Bo's Avatar Editor** shows the editor in its place, and
        **Back to Bo's card** returns.

      **Negative check:** with `currentIssueOf` answering nothing, three
      of them fail. Reverted afterwards.
- [x] **A name link sets the camera target.**
      `apps/web/src/agent-link.test.tsx` runs the real app and router,
      with the Office's real view and stores (only the canvas is a
      stand-in, jsdom having no WebGL): on the Notice Board, "Agent: Bo"
      on a Notice links to `/?floor=web-shop&inspect=agent%3Abo`;
      clicking it opens the Office, whose lift is called to web-shop;
      once it arrives, the camera's destination is `inspect:agent:bo`, its
      registered view is exactly Bo's view from `floorInspectables`, Bo
      is selected, and his card opens. In the Office,
      `wall-board-panel.test.tsx` checks the same of a name on the wall
      board, and `office-view.test.tsx` that it opens the card and flies
      back on close.

      **Negative check:** with `AgentLink` pointed back at the live view,
      both tests in `agent-link.test.tsx` fail. Reverted afterwards.

### Other tests added or changed

- `apps/web/src/wall-board.test.ts`: `currentIssueOf` gives the issue
  worked before one waiting, the oldest waiting otherwise, a review
  round's issue to each of its reviewers, and none without work.
- `apps/web/src/floors.test.tsx`: `/admin/floors/web-shop?agent=linus-id`
  opens Linus's editor (and only his) and brings it into view; an Agent
  not on the Floor opens nothing.
- Changed with the behaviour, not weakened:
  - `activity-feed.test.tsx`, `notice-board.test.tsx` and
    `analytics-page.test.tsx` expect an Agent's name to link to the
    Office's address for it, where they expected the live view;
  - `scene/office-view.test.tsx`: the Agent's panel is its card (its
    heading the name, "Current issue", the config link), the wall board's
    names fly to the Agent's card, and the keyboard list names the
    Agents;
  - `scene/wall-board-panel.test.tsx`: a name opens the Agent, checking
    the camera's view too, where it opened the monitor;
  - `scene/inspectable.test.ts` and `scene/inspectable-hotspots.test.tsx`:
    the Agents' labels, and the hotspot test's title (its checks, the
    selection and the camera's destination, are unchanged);
  - `e2e/tests/agent-live-view.spec.ts`: both specs reached the live view
    by clicking the coder's name in the Floor admin. They now check that
    the name links to the Office for that Agent, then open the live view
    at its own address. What they check of the live view is unchanged.

### The scope addition: Context Usage and Fresh start (PRD FR-85, FR-87)

- [ ] **Context Usage, colour-coded, on the card.** Not built: it uses the
      API from #121, which this branch does not have (see the top of this
      note). Once it exists, it is one more fact on the card, in
      `state-ok` below 60%, `state-warning` from 60% and `state-critical`
      from 85%.
- [ ] **A "Fresh start" action on the card calling #121's API.** Not
      built, for the same reason; it would sit beside the monitor, config
      and Avatar Editor actions.

### Rendered in headless Chromium

Chromium's headless shell 156 (Playwright's), its missing libraries
unpacked from Debian bookworm's packages into `/tmp` (nothing installed),
with SwiftShader. A throwaway page under Vite (deleted afterwards) ran the
real app at 1280 × 800, starting on the Notice Board, with a stubbed
`fetch` for the API: a Floor with a Manager, a coder (Bo), a ChatGPT
reviewer (Cy) and a QA Agent, Bo working #4 with PR #12, Cy waiting to
review #7, and Bo at 85% and Cy at 100% of their daily caps.

- **From a Notice:** clicking "Agent: Bo" opened the Office, rode the lift
  to web-shop and flew to a view over Bo's shoulder at his desk; the card
  beside him showed Coder, Claude, `claude-opus-5-5 (default)`, "#4 Work
  Working PR #12", an amber bar for today and a grey one for the month,
  and the three actions.
- **The Avatar Editor:** opened in the card's place, its preview drawing
  Bo on the turntable. The first render showed **Back to Bo's card**
  below the scrolling editor, clipped by the Office's frame; it was moved
  above the editor (`8d50fb1`) and rendered again, in view.
- **The monitor:** flew in close on Bo's screens, its panel the live view.
- **From the wall board:** "Cy" flew to Cy's desk and opened his card
  (ChatGPT, `gpt-5.5-codex`, "#7 Review Waiting", today's bar red with
  "(reached)", this month's amber at 95%).
- **The config:** **Open Cy's config** opened the Floor admin with "Edit
  Cy" open below the Agents table.
- The only console output was R3F's `THREE.Clock` deprecation (see #64)
  and Vite's and React's notices.

### How Postgres and Chromium were run here

As for earlier issues: `@embedded-postgres/linux-x64@18.3.0-beta.16` in
`/tmp/pgpkg` (port 54329; its library symlinks made by hand from its
`pg-symlinks.json`), with `E2E_POSTGRES_URL` for `pnpm e2e`; Chromium
from `playwright install chromium chromium-headless-shell`, with Debian
bookworm's libraries extracted to `/tmp/chromelibs`. The first e2e run
failed one spec (`notice-alerts.spec.ts`) before it started, because
full Chromium was not installed yet and then lacked `libcups`; with
both, all 23 passed (below). Nothing of this is in the repository.

## Not verifiable in this sandbox

- **How it looks on a real GPU**, and whether the card reads comfortably
  beside the scene on the Owner's screen. On the host: `pnpm dev`, click
  an Agent's name on the Notice Board, and watch the lift ride and the
  camera fly to it; then try the card's three actions.
- **A real Floor at work** (no Docker, no GitHub App): the card's issue
  and tokens came from a stubbed or seeded wall board and token usage, in
  the shapes the server answers.
- **The Postgres cases of `pnpm test`** skip without Docker; nothing on
  the server changed in this issue.

## Noticed, out of scope

- **#121's Context Usage and Fresh Start API** is needed for the scope
  addition (above), as it was for #68's and #69's.
- **A Floor that is archived** is not a lift stop, so a name linking to
  one of its Agents (in an old Notice or the Activity Feed) leaves the
  Office in the lobby with nothing opened. Its live view is still at its
  own address.
- **Names that stay plain text:** the Agent editor's and the Avatar
  Editor's own headings and Save buttons ("Edit Ada", "Save Ada"), the
  Activity Feed's Agent filter options, and Agents named inside event
  sentences (whose entries link the Agent beside them). Each is a form
  or a filter about the Agent rather than a mention of it.
- **The Agent editor's pronouns** for "they": "work they has started
  carries on" (from #47) should be "they have".
- **The card shows no status** (paused, capped, waiting on review); FR-62's
  state visuals are #73's.
- **Event streams per page.** With an Agent's card open, the Office keeps
  four streams (the Notices, the Floor's team, its monitors, the card's
  Floor events), as with the wall board open, within browsers' six per
  host over HTTP/1.1.

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
 Test Files  196 passed (196)
      Tests  2321 passed | 306 skipped (2627)
   Duration  36.45s (tests 41%, import 36%, environment 12%, transform 9%, setup 1%)
```

`pnpm build` (the web app's scripts):

```text
dist/assets/office-scene-sBbYW2vL.js     484.09 kB │ gzip: 210.36 kB
dist/assets/index-D_RzrnDC.js            944.52 kB │ gzip: 286.62 kB
✓ built in 2.19s
```

`pnpm e2e` (embedded Postgres 18.3, Chromium 156.0.8078.4):

```text
  ✓   1 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (8.2s)
  ✓   7 [chromium] › tests/activity.spec.ts:81:1 › the Activity Feed loads older events as it scrolls (8.1s)
  ✓   8 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (7.9s)
  ✓   5 [chromium] › tests/agent-live-view.spec.ts:108:1 › the live view follows new output, and pauses while the Owner reads back (8.1s)
  ✓   3 [chromium] › tests/agent-live-view.spec.ts:11:1 › an Agent's events stream into its live view (8.1s)
  ✓   2 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (8.1s)
  ✓   6 [chromium] › tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it (8.1s)
  ✓   4 [chromium] › tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests (8.1s)
  ✓  16 [chromium] › tests/avatar-editor.spec.ts:10:1 › an Agent's new hair colour and outfit outlast a reload (6.9s)
  ✓   9 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (8.4s)
  ✓  11 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (7.0s)
  ✓  10 [chromium] › tests/gateway-keys.spec.ts:15:1 › makes a Gateway Key for a tool, uses it, then revokes it (12.4s)
  ✓  14 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (7.0s)
  ✓  13 [chromium] › tests/manager-chat.spec.ts:101:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (7.0s)
  ✓  23 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (4.2s)
  ✓  15 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (6.9s)
  ✓  12 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (7.0s)
  ✓  17 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (6.5s)
  ✓  18 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (6.3s)
  ✓  20 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (6.3s)
  ✓  19 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (6.3s)
  ✓  21 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (15.3s)
  ✓  22 [chromium] › tests/skills.spec.ts:35:1 › writes a Skill, and uploads one that is reviewed before it is enabled (6.3s)
  23 passed (32.0s)
```

The new and changed tests, verbose:

```text
 ✓ |@ai-office/web| src/scene/inspectable.test.ts > a Floor's inspectable objects > are its whiteboard, wall board and bookshelf, then each Agent's monitor, then each Agent, in order
 ✓ |@ai-office/web| src/wall-board.test.ts > an Agent's current issue > is the issue it works, or else the oldest waiting for it
 ✓ |@ai-office/web| src/wall-board.test.ts > an Agent's current issue > is a review round's issue for each of its reviewers
 ✓ |@ai-office/web| src/wall-board.test.ts > an Agent's current issue > is none for an Agent with no work
 ✓ |@ai-office/web| src/scene/inspectable-hotspots.test.tsx > the inspectable objects in the scene > opens an Agent's card, flying to it, when the Agent is clicked (PRD FR-63)
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > shows its name, Role, AI Provider, Model, current issue and tokens against its caps
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > shows the issue an Agent waits for when it works none, its default Model, and a cap reached
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > says when an Agent is on no issue
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > says so when its issue or tokens cannot be read
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > follows the Floor's events: a new issue and new tokens show at once
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > opens the Agent's monitor, flying the camera to it
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > links to the Agent's config, in the Floor admin, without a reload
 ✓ |@ai-office/web| src/agent-link.test.tsx > an Agent's name > links to the Agent in the Office
 ✓ |@ai-office/web| src/notice-board.test.tsx > the Notice Board > lists every Floor's open Notices with their links and actions
 ✓ |@ai-office/web| src/scene/agent-card.test.tsx > an Agent's card > opens the Avatar Editor in its place, and goes back to the card
 ✓ |@ai-office/web| src/activity-feed.test.tsx > the Activity Feed > lists every event newest first, each linked to its source
 ✓ |@ai-office/web| src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > flies to an Agent from its name, opening its card (PRD FR-63)
 ✓ |@ai-office/web| src/agent-link.test.tsx > an Agent's name > sets the camera's target to the Agent, from a Notice, and opens its card
 ✓ |@ai-office/web| src/analytics-page.test.tsx > the analytics dashboards > names the top consumers and the AI Accounts close to their limits
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > inspectable objects > lists every object where the lift is, and gives the scene the same
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > inspectable objects > opens the right panel for each type of object selected in the scene
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > inspectable objects > shows the Floor's wall board in its panel, whose Agents' names fly to them
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > inspectable objects > opens the same panel from the keyboard list, and Escape closes it and flies back
 ✓ |@ai-office/web| src/floors.test.tsx > the Floor admin page > opens an Agent's editor from the address, as its card links to its config (PRD FR-63)
  (and the other 133 tests in those 11 files, unchanged)
 Test Files  11 passed (11)
      Tests  157 passed (157)
```
