# Issue #69: Floor wall board — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code commit
(`0835525`), with the README commits around it changing only Markdown.

The blockers are built on this branch:

- #50, token accounting and Token Caps ([`issue-50.md`](issue-50.md)):
  `GET /api/floors/:floorId/token-usage`, each Agent's tokens against the
  cap in force for it, which the panel shows;
- #66, a Floor's layout with its wall board on the back wall
  ([`issue-66.md`](issue-66.md));
- #67, the inspectable objects, whose wall board panel this issue fills
  ([`issue-67.md`](issue-67.md)).

**The scope addition is not built.** The comment on the issue adds PRD
FR-85's Context Usage, colour-coded, for each Agent in the wall board's
panel, "using the API from #120". As #68 found ([`issue-68.md`](issue-68.md)),
that API is not on this branch: nothing serves an Agent's Context Usage
(FR-84), and the only Context Usage in the code is the `agent.fresh_start`
event's field, which nothing publishes. Showing it would mean inventing
#120's API, so it waits for #120 (below).

## What was built

- **The wall board's data** (`createWallBoard`,
  `packages/orchestrator/src/wall-board/wall-board.ts`; PRD FR-50, FR-57).
  `floorBoard(floorId)` reads:
  - **every issue in progress**: each piece of the Floor's work that is
    queued or running in the work queue, working first, then waiting,
    oldest first. Each has its stage, whether it is being worked or
    waits, and the Agent working it or that it waits for (a review
    round's work is for no one Agent, so it names the Floor's required
    reviewers);
  - **its links**: the issue's address as intake saw it (its
    `issue.picked_up` event; `https://github.com/<repository>/issues/<n>`
    without one) and its latest pull request (its `pull_request.opened`
    event);
  - **the rounds it has used**: its rounds of review (from the Review
    Loop's verdicts) and of QA (QA's reports), with the Floor's Round Cap
    and QA's;
  - **the Floor's queues**: work waiting and working at each stage that
    queues work, in the pipeline's order, and how much waits for each of
    the Floor's Agents.

  A Floor that does not exist is a `FloorError` (`floor_not_found`); an
  archived Floor's board can still be read.
- **The API** (`apps/server/src/wall-board/routes.ts`): `GET
  /api/floors/:floorId/wall-board`, for signed-in sessions, answering
  `floorWallBoardSchema` (`packages/shared/src/wall-board.ts`), or `404`.
  `buildApp` takes the work queue's store (`workQueue`); the server passes
  the `work_queue` table it already keeps, now made before the app.
- **The panel** (`apps/web/src/scene/wall-board-panel.tsx`, PRD FR-58).
  Inspecting a Floor's wall board (a click on it, the keyboard list or the
  Office's address, as #67 built) flies the camera in and opens it, in
  place of #67's placeholder:
  - **Health**: "Running smoothly", "Worth watching" or "Needs you", with
    a dot in `state-ok`, `state-warning` or `state-critical` and the
    reasons in words (`floorHealth`, `apps/web/src/wall-board.ts`). It
    needs the Owner while an action Notice is open or an Agent has reached
    a Token Cap; it is worth watching while an Agent has used 80% of a cap,
    an issue has one round of review or QA left, or work waits with no
    Agent to do it.
  - **Notices**: the Floor's open Notices, each with its kind, title and
    links (issue, pull request, CI run, its further links) and its Agent,
    and **Open this Floor's Notices**, the 2D board where they are
    dismissed and acted on.
  - **In progress**: each issue, linked to GitHub, with its stage in its
    Stage's colour (`stage-work`, `stage-review`, `stage-qa`,
    `stage-docs`), "Working" or "Waiting", its Agents, its pull request,
    and "Review rounds 2 of 3" (and "QA rounds 1 of 3" once QA has had a
    round).
  - **Queues**: a table of waiting and working work by stage, and how many
    tasks wait for each Agent.
  - **Tokens against caps**: each Agent, with its Role, and its tokens
    today and this month against the cap in force for it, as text and a
    meter coloured as FR-62 colours tokens: `state-neutral` below 80%,
    `state-warning` from 80%, `state-critical` at 100% ("(reached)").
  - **Links to other objects** (FR-58): every Agent's name is a button
    that opens its monitor in the Office (and closing that flies back to
    where the camera was before the wall board).
  - **Live**: the panel follows one stream of the Floor's events (Notices,
    work assigned, labels, statuses, sandboxes, pull requests, reviews,
    QA, model calls, caps, configuration), reading its board, Notices and
    tokens again at each, and at each (re)connection; tokens are read
    again once a minute besides. It scrolls within `min(30rem, 60vh)`.
  - A part that cannot be read says so, and the rest is shown.
- **The wall board in the scene** (`floor.tsx`, `lobby.tsx`,
  `office-view.tsx`). On a Floor, the wall board pins up that Floor's own
  open Notices, as the lobby's Notice Board does every Floor's: the same
  cards (`NoticeBoardCards`, now given a name and a centre), on the wall
  board's felt. The Office gives the scene the board where the lift is:
  every Notice in the lobby, the Floor's own on a Floor.
- **`PageLink`** moved to `scene/page-link.tsx`, so the panels can share
  it without importing each other.
- **README:** "The 3D Office" says what the wall board shows, and a new
  section, "The wall board", describes its panel and its API.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too.
- [x] **Component tests for the panel with seeded data.**
      `apps/web/src/scene/wall-board-panel.test.tsx` renders the real
      `FloorWallBoardPanel` against a stubbed server seeded with a Floor
      at work (a Manager, a coder, a reviewer and a QA Agent; an action
      and an info Notice; three issues in progress at work and review; the
      Agents' tokens), with the event streams stubbed:
  - "shows the Floor's Notices, with their links": both Notices, and
    every link in order (issue, pull request, a Review Loop round, CI
    run), each opening in a new tab, then **Open this Floor's Notices**,
    which navigates without a reload; each Notice's Agent by name.
  - "shows every issue in progress with its Agent, its stage, its links
    and its rounds": `#4 Work Working By Bo Review rounds 0 of 3`, `#7
    Review Waiting PR #12 For Cy Review rounds 1 of 3 · QA rounds 1 of 3`,
    `#9 …`; the issue and pull request links; the review badge in
    `bg-office-stage-review`.
  - "shows the Floor's queues, by stage and by Agent": the table's rows
    (Work 1/1, Review 1/0, QA 0/0, Docs 0/0) and "Bo: 1 task waiting".
  - "shows each Agent's tokens against its caps, coloured as the Office
    colours them": meters at 10% (neutral), 85% and 90% (warning) and 100%
    (reached, red, "(reached)"); each named with its Role.
  - "the Floor's health": "Needs you" with an action Notice and an Agent
    at its cap (reasons in order); "Worth watching" at 80% of a cap, with
    one round of review and of QA left, and with work no Agent can do;
    "Running smoothly" otherwise, with empty Notices and work.
  - "opens an Agent's monitor from its name": the monitor is the open
    inspectable afterwards.
  - "reads the board again as the Floor's events come, and as its Notices
    change": the panel opens one stream, for the Floor, carrying the
    board's and the Notices' event types; an `issue.assigned` brings a
    fourth issue and the new tokens; a `notice.dismissed` takes a Notice
    off.
  - "says so when the board cannot be read, and shows the rest".

  In the Office (`office-view.test.tsx`, the real `OfficeView`):
  - "shows the Floor's wall board in its panel, whose Agents open their
    monitors": it reads `/api/notices?floorId=web-shop`, the wall board and
    the token usage; shows "Needs you" and the Floor's Notice, not another
    Floor's; the Notice's Agent opens its monitor, and closing that flies
    back to the default view.
  - "gives a Floor's wall board only that Floor's Notices" (the scene is
    given `shop-action` and `shop-info`, not the blog's or the Office's).
  - #67's tests of the panels and the keyboard list still pass: the wall
    board's panel now says "In progress" (in place of the placeholder's
    "tokens against caps") and keeps its one link at first; the helper
    reads the dialog's own heading (`level: 2`), as the panel now has
    headings of its own; the keyboard test waits for the panel to have
    read the Floor before comparing it with the same panel opened again.

  In the scene (`floor.test.tsx`, React Three Fiber's test renderer):
  - "pins its own Notices on its wall board, over the board's felt": an
    action card (two pins) and an info card (one), every card inside the
    board and in front of the felt; none without Notices.
  - The per-frame budget test now runs with a full wall board too (six
    cards and a stack of three): still within Medium's draw calls and
    triangles, with room for Avatars.

  Behind the panel:
  - `wall-board.test.ts` (orchestrator): the board's issues, in order
    (working before an older waiting item), with their Agents (a review
    round's required reviewers), addresses (intake's, or GitHub's), latest
    pull request and rounds; queues by stage and Agent; another Floor's
    work left out; finished and cancelled work left out; an archived
    Floor's board readable; an unknown one `floor_not_found`. In memory
    here; the same case in Postgres 18 is skipped without Docker.
  - `routes.test.ts` (server): `GET /api/floors/web-shop/wall-board`
    answers the coder's work on #4; an unknown Floor is `404`
    `floor_not_found`; signed out is `401`. The route-access test passes
    with the new route declaring `owner`.
  - `wall-board.test.ts` (web): a cap's state at 799, 800, 999, 1,000 and
    1,500 of 1,000, and the palette tokens for caps and health.

  **Negative checks** (each reverted afterwards):
  - Working work not listed first: 1 test failed (the test was first
    missing it: its working item was also the oldest, so it was given an
    older waiting one, `f5d070c`).
  - A review round naming no reviewers: 1 failed.
  - Rounds miscounted: 1 failed.
  - Other Floors' work on the board: 1 failed.
  - Health ignoring action Notices: 1 failed.
  - The warning at 90% instead of 80%: 3 failed.
  - The panel not reading again at events: 1 failed.
  - The Notice events left off the panel's stream: 1 failed.
  - Every Notice on a Floor's wall board: 1 failed.
  - No cards on the wall board: 2 failed.
  - Agents' names opening nothing: 2 failed.
  - The placeholder panel kept: 3 failed.

### The scope addition: Context Usage on the wall board (PRD FR-85)

- [ ] **Each Agent's Context Usage, colour-coded, in the wall board
      panel.** Not built: it uses the API from #120, which this branch
      does not have (see the top of this note). Once it exists, it is one
      more meter beside each Agent's tokens in "Tokens against caps", in
      `state-ok` below 60%, `state-warning` from 60% and `state-critical`
      from 85%.

### Rendered in headless Chromium

As in #64 to #68: Playwright's Chromium headless shell, its missing
libraries unpacked from Debian bookworm's packages into `/tmp` (nothing
installed), and SwiftShader. A throwaway page under Vite (deleted
afterwards) rendered the real `OfficeView` at 1280 × 720 on a Floor with a
Manager, a coder, a reviewer and a QA Agent, with a stubbed `fetch` and
event streams: three Notices (two action, one info), four issues in
progress at work, review and QA, and the Agents at 4%, 85%, 100% and 12%
of their daily caps (one at 92% of its monthly).

- **Overview:** the Floor, its wall board on the back wall beside the
  bookshelf, three cards pinned on it.
- **The wall board, opened:** the camera close in on the board, three
  cards (red stripe and two pins, blue and one, red and two) with their
  lines of "writing"; beside it the panel: "Needs you" with a red dot and
  its five reasons, then the Notices with their links.
- **Scrolled:** each issue with its stage badge (Work blue, Review purple,
  QA teal), "Working" or "Waiting", its pull request, "By Bo", rounds; the
  queues; each Agent's two meters, grey, amber (85%, and 92% this month)
  and red ("(reached)").
- **An Agent's name:** clicking "Bo" flew to Bo's monitor, whose panel
  opened.
- The only console output was R3F's `THREE.Clock` deprecation (see #64),
  React's DevTools notice and Vite's.

### Not verifiable in this sandbox

- **The Postgres cases** (no Docker): the wall board's orchestrator and
  route tests in Postgres 18 skip here; they run in CI.
- **A real Floor at work** (no Docker, no GitHub App): the work queue,
  verdicts and events were seeded, in the shapes the coder, review and QA
  flows write them.
- **How it looks on a real GPU**, and whether the panel's text and meters
  read comfortably beside the scene on the Owner's screen.
- **The e2e suites** (no Docker): nothing they check changes; a signed-in
  test that opens a Floor's wall board would now also read its board and
  token usage.

## Noticed, out of scope

- **The 3D board shows Notices only.** Text is never drawn in the scene
  (PRD §7), so the wall board in 3D pins up the Floor's Notices as cards,
  and its health, queues, rounds and tokens are in its panel. A stylised
  health lamp or a ticket per issue on the board could follow; FR-62's
  desk tickets and the Manager's red light are their own issues.
- **`needs-code`, not `needs-work`.** ADR 0003 renames the work Stage's
  label `needs-work`; the pipeline on this branch still uses
  `needs-code` (Phase 8). The wall board names the stage "Work" whatever
  its label, from `stageNames` in `@ai-office/shared`.
- **Issues out of the work queue.** An issue waiting at `needs-human`, or
  at `ready-to-merge` for the Owner, has no work queued, so it is not "in
  progress" on the board; its Notice ("Round Cap reached", the pull
  request awaiting approval) is.
- **Tokens between events.** `model_call.completed` is not published yet,
  so tokens are read again at the Floor's other events and once a minute.
- **Event streams per page.** With the wall board open, the Office keeps
  four streams (the Notices, the Floor's team, its monitors, the wall
  board), within browsers' six per host over HTTP/1.1.

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
 Test Files  179 passed (179)
      Tests  1859 passed | 297 skipped (2156)
   Duration  65.73s (tests 47%, import 28%, transform 16%, environment 8%, setup 1%)
```

`pnpm build` (the web app's scripts):

```text
dist/assets/index-DXl_CB4Y.js              895.27 kB │ gzip: 273.34 kB
dist/assets/office-scene-B6yl1wRO.js     1,393.19 kB │ gzip: 450.29 kB
✓ built in 1.32s
```

The new and changed tests, verbose:

```text
✓ orchestrator src/wall-board/wall-board.test.ts > a Floor's wall board > shows its issues in progress and its queues, in memory
↓ orchestrator src/wall-board/wall-board.test.ts > a Floor's wall board > shows its issues in progress and its queues, in Postgres 18 [Docker is not available]
✓ server src/wall-board/routes.test.ts > GET /api/floors/:floorId/wall-board > answers a Floor's issues in progress and its queues, in memory
↓ server src/wall-board/routes.test.ts > GET /api/floors/:floorId/wall-board > answers a Floor's issues in progress and its queues, in Postgres 18 [Docker is not available]
✓ web src/wall-board.test.ts > a cap's state > is neutral below 80% of the cap, a warning from 80%, and reached at 100%
✓ web src/wall-board.test.ts > a cap's state > is coloured from the palette's states
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > shows the Floor's Notices, with their links
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > shows every issue in progress with its Agent, its stage, its links and its rounds
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > shows the Floor's queues, by stage and by Agent
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > shows each Agent's tokens against its caps, coloured as the Office colours them
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > the Floor's health > needs the Owner with an action Notice open, or an Agent at its cap
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > the Floor's health > is worth watching near a cap, with one round left, or with work no Agent can do
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > the Floor's health > is running smoothly otherwise
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > opens an Agent's monitor from its name
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > reads the board again as the Floor's events come, and as its Notices change
✓ web src/scene/wall-board-panel.test.tsx > a Floor's wall board panel > says so when the board cannot be read, and shows the rest
✓ web src/scene/floor.test.tsx > a Floor in the scene > pins its own Notices on its wall board, over the board's felt
✓ web src/scene/floor.test.tsx > a Floor's cost > is within Medium's per-frame budgets with 12 Agents at work, leaving room for their Avatars
✓ web src/scene/office-view.test.tsx > the lobby and the Floors > gives a Floor's wall board only that Floor's Notices
✓ web src/scene/office-view.test.tsx > inspectable objects > shows the Floor's wall board in its panel, whose Agents open their monitors
✓ web src/scene/office-view.test.tsx > inspectable objects > opens the right panel for each type of object selected in the scene
✓ web src/scene/office-view.test.tsx > inspectable objects > opens the same panel from the keyboard list, and Escape closes it and flies back
  (and the 26 other tests in office-view.test.tsx and 6 in floor.test.tsx, unchanged)
```
