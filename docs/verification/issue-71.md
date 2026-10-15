# Issue #71: Avatar Editor — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code commit
(`f75175c`), with the README commit before it changing only Markdown.

The blockers are built on this branch:

- #47, the Agent config editor ([`issue-47.md`](issue-47.md)):
  `PATCH /api/floors/:floorId/agents/:agentId`, the Floor admin's Agents
  table and its editor, which the Avatar Editor sits beside, and the
  pronouns that follow an Avatar's presentation (FR-14);
- #70, the character kit ([`issue-70.md`](issue-70.md)): the strict
  `avatarSchema`, `randomAvatar` keeping a Floor's Avatars distinct, the
  shared rig, a part for every FR-13 option, the animations, and the
  Agents sat at their desks as their Avatars, which the preview and the
  Office draw.

## What was built

- **Saving an Avatar** (`packages/shared/src/agents.ts`,
  `packages/orchestrator/src/agents/`, PRD FR-13): the Agent API's PATCH
  takes `avatar`, checked part by part by `avatarSchema` (an unknown part
  or field is `400 invalid_request`). `Agents.update` stores it (in memory
  and in the `agents` table's existing `avatar` column; no migration) and
  publishes a `config.changed` event naming `avatar`, never its parts.
  Saving the same Avatar (`sameAvatar`, whatever order its accessories
  come in) changes nothing and publishes nothing.
- **The Avatar Editor** (`apps/web/src/avatar-editor.tsx`):
  - every FR-13 option: presentation (male, female or androgynous, with
    their pronouns), body shape, face, hairstyle, hair colour, skin tone,
    facial hair, glasses, accessories, outfit style, the outfit's two
    colours, and the desk mascot. Each colour is a radio-button swatch
    with a name ("Blue", "Mustard"), so none is told by colour alone; a
    stored colour the swatches lack is offered as "Its own colour";
  - **a live, rotatable 3D preview** (`scene/avatar-preview.tsx`, loaded
    with three.js only when the editor opens): the Avatar's own figure at
    LOD0, standing idle on a turntable beside its mascot (on a plinth at
    desk height, at twice its size), lit with the Office's key, fill and
    sky lights. It draws the draft, so each change shows before it is
    saved. Dragging orbits the camera (drei's `OrbitControls`, no pan,
    zoom bounded); **Left** and **Right** turn the Avatar 30° a press,
    from the keyboard too. Reduced motion holds the pose. Without WebGL 2
    it says so, and the rest of the editor works;
  - **Randomise** (`randomAvatar` with the Floor's other Agents' Avatars
    and the current draft as `others`, so the new look differs from all
    of them in at least two features), **Reset** (back to the saved
    Avatar) and **Save**;
  - the text speaks of the Agent as he, she or they as the presentation is
    chosen (FR-14); the Agent editor follows once it is saved.
- **Opened from the Floor admin**: an **Avatar** action beside **Edit**
  in each Agent's row ("Open Ada's Avatar Editor"), opening the editor
  below the table as **Edit** opens the Agent editor.
- **Opened by clicking an Agent in the Office** (`scene/inspectable.ts`,
  `scene/inspector-panels.tsx`): each seated Agent is now an inspectable
  object of kind `agent`, through the same mechanism as the monitors and
  boards (FR-58): a hit box from its knees under the desk's front edge to
  its chair's back and up past its head; a camera view over its right
  shoulder, or, when that is blocked (the Manager's back is to the
  wall), the first of five other angles with nothing solid in the way;
  the keyboard list ("Ada's Avatar"); and an address
  (`/?floor=web-shop&inspect=agent:<id>`). Its panel is the editor in one
  column, scrolling, with a link to the Floor admin.
- **Saving updates the Agent in the scene immediately**: the editor puts
  the saved Agent straight into the Agents query the Office draws its
  desks from (`setQueryData`), then refetches. The Office also refetches
  a Floor's team on its `config.changed` events, so a save in another
  window reaches it too.
- **The Avatar never reaches a prompt**: no prompt builder reads it; a
  test holds them to it (below).
- `webgl` (whether the browser has WebGL 2) moved to `scene/webgl.ts`, so
  the editor can ask without loading the Office view; `office-view.tsx`
  re-exports it.
- **README**: "The Avatar Editor" under Agents; the PATCH's `avatar`;
  Agents as inspectable objects in "The 3D Office".

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 at `f75175c` (output below).
- [x] **Playwright: change hair colour and outfit, save, reload, the change
      persists.** `e2e/tests/avatar-editor.spec.ts` passed in headless
      Chromium against the built app, Postgres 18 and a fake GitHub (see
      "How Postgres and Chromium were run here"). It:
      1. adds web-shop as a Floor and opens its coder's Avatar Editor from
         the Floor admin;
      2. picks a hair colour, an outfit style and an outfit colour the
         coder does not have (Blue or Pink, Overalls or Dress, Mustard or
         Sage), saves, and sees "Saved. The Office shows …'s new look";
      3. reloads, opens the editor again, and finds those three chosen and
         nothing left to save;
      4. reads the Agent from the API: its Avatar is the old one with
         exactly those three changes, and nothing else about the Agent
         changed.

      The whole suite, 23 tests, passed with it (`pnpm e2e`, below).
      **Negative check:** with the store no longer saving the Avatar
      (`avatar` dropped from `configOf` in
      `packages/orchestrator/src/agents/store.ts`), the test fails: the
      refetched Agent comes back with its old look, so the save never
      settles. Reverted afterwards.
- [x] **Unit test: prompt builders never include Avatar fields.**
      `packages/orchestrator/src/avatar-never-in-prompts.test.ts` gives
      every prompt builder whole Agents, Avatars and all, as the flows have
      them (the reviewer and the Manager's chat spread the Agent into their
      input): `coderPrompt` (fresh, and with reviewers' and QA's feedback),
      `reviewerPrompt` (system and user), `qaPrompt`, `docsPrompt`,
      `managerSystemPrompt` (the Manager and its team) and `triagePrompt`
      (system and user).
      - With an Avatar whose every part is a word no prompt otherwise uses
        (androgynous, curvy, braids, goatee, cat-eye, headphones, overalls,
        rubber-duck, its hex colours…), no prompt holds any of them, nor
        the word "avatar"; the Agents' names are there, so the Agents were
        read.
      - Over 50 Floors of random Avatars, every prompt is the same text as
        with the telltale one.

      **Negative check:** with the coder's prompt made to start with the
      Agent's Avatar as JSON, both tests fail. Reverted afterwards.

### Other tests added or changed

- `packages/shared/src/avatar.test.ts`: `sameAvatar` ignores the
  accessories' order and the colours' case, and tells apart a change to
  any one part.
- `packages/orchestrator/src/agents/agents.test.ts`, in memory and in
  Postgres 18: an Avatar change is stored, changes nothing else, and its
  `config.changed` event names `avatar` and holds none of its colours;
  the same Avatar again publishes nothing.
- `apps/server/src/agents/routes.test.ts`, in memory and in Postgres 18:
  the PATCH round trip with an Avatar, its one event; a `mohawk` hairstyle
  and an unknown `cape` field refused with `400 invalid_request`.
- `apps/web/src/floors.test.tsx` (the Floor admin, against a stubbed
  server):
  - every option of FR-13 is offered, each colour named, the Agent's own
    chosen; every part changed, then saved as one PATCH with `{"avatar"}`
    alone (accessories in the kit's order); pronouns following the
    presentation in the editor and, once saved, in the Agent editor;
  - Randomise, five times, saves Avatars unlike every other Agent on the
    Floor and unlike the one before; Reset goes back to the saved one;
  - with WebGL (the preview stood in), the preview shows the draft's hair
    and outfit as they change, and the turn buttons turn it 30°, from
    the keyboard too;
  - no Avatar action on an archived Floor.
- `apps/web/src/scene/avatar-preview.test.tsx` (React Three Fiber's test
  renderer): the Avatar at LOD0 (finer than LOD1) on its turntable, its
  mascot on the plinth; rebuilt when the draft's look changes and not for
  the same look; turned as the editor says; moving while idle, still with
  reduced motion.
- `apps/web/src/scene/inspectable.test.ts`: for Floors of 1 to 12 Agents,
  each Agent's box takes in its chair's four pieces, reaches past 1.4 m
  and under its desk's front edge; no two objects' boxes overlap (so a
  click picks one); and the view of every object, Agents included, shows
  it whole between the controls and the panel, from inside the Floor,
  with nothing solid in the way. Its address reads back.
- `apps/web/src/scene/inspectable-hotspots.test.tsx`: clicking an Agent's
  box highlights it, opens it (`agent`, `inspect:agent:<id>`).
- `apps/web/src/scene/office-view.test.tsx`: the Floor's list and the
  scene have each Agent after the monitors, and an Agent's panel is its
  Avatar Editor with a link to the Floor admin.
- **Changed expectations.** Four existing tests asserted what this issue
  changes, and now assert the new behaviour: the list of inspectable
  kinds (now with `agent`), the Floor's objects in the list and the scene
  (now with each Agent), `agent:ada` as an address that names nothing
  (now it names the Agent), and closing an "Agent's card" leaving it
  selected (now the Agent is an inspectable object, closed like any
  other; the "nothing open" half of that test is kept). The Floor admin's
  table test now finds the **Avatar** action beside **Edit**.

### Rendered in headless Chromium

A throwaway Playwright spec (deleted afterwards) ran the real app under
SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader`) at
1600 × 900:

- **The Floor admin's editor**: the preview drew the coder standing on
  its turntable beside its mascot; after three presses of **Right**, a
  pink hair colour, overalls and a rubber duck, the preview showed them,
  turned 90°, before saving.
- **The Office**, opened at `/?floor=web-shop&inspect=agent:<coder>`: the
  lift rode to web-shop, the camera flew to a view over the coder's
  shoulder at its desk, and the panel showed its Avatar Editor. Saving a
  new hair colour and a blazer from the panel redrew the seated Agent at
  once, with no reload.
- The first renders showed two faults the tests could not: in the
  panel's one column, a field spanning two columns made a second, so the
  swatches, selects and the **Right** button were clipped; and the
  preview's camera cut off the turntable's rim. Both were fixed
  (`8b71572`) and rendered again: the panel fits its 20 rem, and the
  turntable is whole.

### How Postgres and Chromium were run here

As for earlier issues: `@embedded-postgres/linux-x64@18.3.0-beta.16` in
`/tmp/pgpkg` (port 54329), `E2E_POSTGRES_URL` for `pnpm e2e`; for the
Vitest Postgres cases, a scratch patch to `postgresTest` (applied only
for the run, then reverted) pointed it at that server, with the two test
files run one after the other. Chromium from `playwright install
chromium`, with Debian bookworm's libraries extracted to `/tmp/chromelibs`.
Nothing of this is in the repository.

## Not verifiable in this sandbox

- **How the preview and the Office look on a real GPU**: the lighting and
  shadows on the turntable, whether the over-the-shoulder view reads well
  for every desk, and the drag to orbit with a real mouse or touch. On the
  host: `pnpm dev`, open a Floor's admin, **Avatar** on an Agent, and
  drag and turn the preview; then ride the lift to that Floor, click the
  Agent, change and save, and watch it change at its desk.
- **The frame rate** with the editor's preview open beside the Office (two
  WebGL canvases).
- **Docker**: the Testcontainers Postgres and the compose stack. The
  Postgres cases ran against the embedded Postgres 18 instead (below).

## Noticed, out of scope

- **FR-63's Agent card.** Clicking an Agent should show a card (name,
  Role, AI Provider, Model, current issue, tokens) with links to its
  monitor, its config and the Avatar Editor. Until that issue, clicking
  an Agent opens its Avatar Editor directly, as this issue asks; the card
  can take over the `agent` panel in `inspector-panels.tsx` and link to
  the editor.
- **The Communications Agent's Avatar** (FR-90) is not editable: that
  Agent does not exist yet.
- **PRD §9's screenshot tests** name the Avatar Editor among the 3D
  scenes to snapshot at fixed seeds; there is no screenshot-test harness
  yet, so none was added here.
- **The art direction** has no lighting spec for a lone preview; it uses
  the Office's key, fill and sky lights without post-processing. Worth a
  line in `docs/reference/art-direction.md` (not changed: `docs/` is the
  canon).
- **An editor left open** keeps its draft when the same Agent's Avatar is
  saved elsewhere; **Reset** then goes to the newly saved one.
- Paid asset packs for the character kit (#116) are out of scope, as the
  issue says.

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
 Test Files  194 passed (194)
      Tests  2307 passed | 306 skipped (2613)
   Duration  34.25s (tests 40%, import 38%, environment 11%, transform 9%, setup 1%)
```

The two Postgres cases, against the embedded Postgres 18.3 (with the
scratch patch above):

```text
$ SCRATCH_PG_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm vitest run --no-file-parallelism packages/orchestrator/src/agents/agents.test.ts apps/server/src/agents/routes.test.ts
 ✓ |@ai-office/orchestrator| src/agents/agents.test.ts > Agents, kept in Postgres 18 > changes an Agent's Avatar, and nothing else, naming it but never its parts 181ms
 ✓ |@ai-office/server| src/agents/routes.test.ts > the Agent API, in Postgres 18 > changes an Agent's Avatar from the Avatar Editor, at once 172ms
 Test Files  2 passed (2)
      Tests  46 passed (46)
```

`pnpm e2e` (embedded Postgres 18.3, Chromium headless shell 156.0.8078.4):

```text
  ✓   1 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in
  ✓   4 [chromium] › tests/activity.spec.ts:81:1 › the Activity Feed loads older events as it scrolls
  ✓   8 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses
  ✓   7 [chromium] › tests/agent-live-view.spec.ts:107:1 › the live view follows new output, and pauses while the Owner reads back
  ✓   2 [chromium] › tests/agent-live-view.spec.ts:10:1 › an Agent's events stream into its live view
  ✓   3 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor
  ✓   6 [chromium] › tests/ai-accounts.spec.ts:48:1 › adds an AI Account, pauses it, then deletes it
  ✓   5 [chromium] › tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests
  ✓  16 [chromium] › tests/avatar-editor.spec.ts:10:1 › an Agent's new hair colour and outfit outlast a reload
  ✓  10 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page
  ✓  12 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it
  ✓   9 [chromium] › tests/gateway-keys.spec.ts:15:1 › makes a Gateway Key for a tool, uses it, then revokes it
  ✓  11 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens
  ✓  14 [chromium] › tests/manager-chat.spec.ts:101:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in
  ✓  23 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not
  ✓  13 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked
  ✓  15 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed
  ✓  17 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it
  ✓  21 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page
  ✓  19 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in
  ✓  20 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out
  ✓  18 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session
  ✓  22 [chromium] › tests/skills.spec.ts:35:1 › writes a Skill, and uploads one that is reviewed before it is enabled
  23 passed (38.9s)
```

An earlier full run, before `f75175c`, failed two tests:

- `agent-editor.spec.ts`: its lookup of the button "Edit Frances" also
  matched the new "Edit Frances's Avatar". The action was renamed "Open
  Frances's Avatar Editor" (`f75175c`), and the spec passed unchanged.
- `sign-in.spec.ts`'s "signs out everywhere": `Test timeout of 30000ms
  exceeded` while every test in that run took 20 to 30 seconds with the
  sandbox loaded. Alone it passed in 21.7 s, and in the run above too.

The new tests, verbose:

```text
✓ |@ai-office/orchestrator| src/avatar-never-in-prompts.test.ts > the Avatar in prompts > is in no prompt: none of its parts, nor the word
✓ |@ai-office/orchestrator| src/avatar-never-in-prompts.test.ts > the Avatar in prompts > changes no prompt, whatever the Agents look like
✓ |@ai-office/orchestrator| src/agents/agents.test.ts > Agents, kept in memory > changes an Agent's Avatar, and nothing else, naming it but never its parts
✓ |@ai-office/server| src/agents/routes.test.ts > the Agent API, in memory > changes an Agent's Avatar from the Avatar Editor, at once
✓ |@ai-office/shared| src/avatar.test.ts > the same Avatar > is the same whatever order its accessories are listed in, or its colours' case
✓ |@ai-office/shared| src/avatar.test.ts > the same Avatar > differs in any one part
✓ |@ai-office/web| src/floors.test.tsx > the Floor admin page > edits every part of an Agent's Avatar, and saves the Avatar alone
✓ |@ai-office/web| src/floors.test.tsx > the Floor admin page > randomises an Avatar unlike the Floor's others, and resets it to the saved one
✓ |@ai-office/web| src/floors.test.tsx > the Floor admin page > shows the draft in a preview that turns, live, before it is saved
✓ |@ai-office/web| src/scene/avatar-preview.test.tsx > the Avatar Editor's preview > stands the Avatar on a turntable at its finest LOD, its mascot on a plinth beside it
✓ |@ai-office/web| src/scene/avatar-preview.test.tsx > the Avatar Editor's preview > rebuilds the Avatar as the draft changes, and only then
✓ |@ai-office/web| src/scene/avatar-preview.test.tsx > the Avatar Editor's preview > turns as the editor says
✓ |@ai-office/web| src/scene/avatar-preview.test.tsx > the Avatar Editor's preview > stands idle, breathing, and holds still with reduced motion
✓ |@ai-office/web| src/scene/inspectable.test.ts > a Floor's inspectable objects > put a box over each of 1 … 12 Agents sat at their desks: their chairs, and up past their heads (12 cases)
✓ |@ai-office/web| src/scene/inspectable-hotspots.test.tsx > the inspectable objects in the scene > opens an Agent's Avatar Editor when the Agent is clicked (PRD FR-13)
✓ |@ai-office/web| src/scene/stores.test.ts > opening an inspectable object > opens and closes an Agent as it does any object (its Avatar Editor)
```
