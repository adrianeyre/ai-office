# Issue #84: Whiteboard: Plan approval, editing and replanning — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `368afd6` (every
commit of the issue but this note), after `pnpm install --frozen-lockfile`.
The Postgres runs were made in that clone; the sabotage runs in the working
tree. This builds on #83 (a Batch command drafts a Plan, earlier on this
branch, [`issue-83.md`](issue-83.md)) and #67 (the inspectable objects,
[`issue-67.md`](issue-67.md)), whose whiteboard panel it fills.

## What was built

### The data (`packages/shared` `batches.ts`; `packages/db`; `packages/events`)

- **`planItemSchema`** gains `annotation`, the Owner's note on an issue
  from the whiteboard (redacted), present only when they wrote one.
- **`planSchema`** gains `editedFrom`: the version the Owner edited, which
  the Manager replanned as this one; null for a Plan the Owner did not
  edit. **Migration `0041_plan_edits`** adds `plans.edited_from`, checked
  to be an earlier version.
- **`planEditSchema`** (`{version, items: [{issue, annotation}]}`: the
  issues kept, in the new order; any other issue of the Plan is dropped;
  at least one; annotations trimmed, at most 500 characters) and
  **`planApprovalSchema`** (`{version}`).
- **`batchErrorCodes`**: `batch_not_awaiting_approval`, `plan_changed` and
  `invalid_plan_edit`, beside `batch_not_found`.
- **`whiteboardPath(floorId, batchId?)`**: `/floors/<floor>/whiteboard`
  (`?batch=<id>`), where a Notice sends the Owner.
- **Events**: `batch.planned` gains an optional `editedFrom`; a new
  `batch.approved` (Batch, the Plan version approved, its Manager). The
  Activity Feed reads them as "Tony replanned the Owner's edits to version 1
  as version 2 of Batch 1's Plan, by AI Office's rules: #3 and #1." and
  "The Owner approved version 2 of Batch 1's Plan, by Tony.", under its
  "Batches" filter group.

### Approval, editing and replanning (`packages/orchestrator` `batches/`)

- **"Plan awaiting approval"** (FR-49). A Batch made with plan approval on
  raises an action Notice, "Plan awaiting approval on web-shop: Batch 1, 3
  issues", linking its issues on GitHub. Its one action, **Open Plan**
  (`open_plan`), is a page action (`href`: the whiteboard on that Batch);
  its handler only checks the Plan is no longer awaiting approval, so the
  Notice closes, as acted on, when the Plan is approved, and taking it
  before then fails and leaves it up. The handler is registered by
  `createBatches` and released by `stop()`.
- **`edit(floorId, batchId, edit)`** (FR-25.3). Checks the Batch is the
  Floor's and awaits approval, and that `edit.version` is its Plan's
  latest; then that each issue is in the Plan, once, and that the edit
  changes something. Annotations are redacted. Dropped issues join the
  Plan's `leftOut` ("you dropped it from the Plan"), so the Batch no longer
  holds them and intake may take them again. Then the Manager replans:
  - **Its Model** (`models.complete`, through the AI Gateway with the
    Manager's own Gateway Key, as for the first draft). `planPrompt` takes
    an `edit`: the version edited, the Owner's order (which the answer must
    keep exactly), what that version said of each issue (coder, what it
    ran after, likely files, the Manager's note), the Owner's annotations,
    and the issues dropped. The issues kept are read again from GitHub,
    redacted, and quoted as untrusted text as before; the dropped ones are
    not quoted.
  - **Checked in plain code** (`replanFromDraft`): the Owner's order
    exactly, then everything `planFromDraft` checks; the Plan is completed
    as a draft is (overlaps sequenced in the new order, unassigned issues
    shared out, parallel groups), with the Owner's annotations. An answer
    that does not fit is sent back once, saying what is wrong.
  - **Or AI Office's rules** (`replanByRules`), when the Manager is paused
    or has no Model, the call fails, the Model answers twice with no Plan,
    or the issues cannot be read: the Owner's order, each issue keeping its
    likely files, its coder (while still one of the Floor's enabled
    coders; otherwise shared out again), its note and the dependencies that
    still come before it; overlaps are sequenced again in the new order.
  - The replan is kept as the next version (`editedFrom` = the version
    edited), and `batch.planned` records it.
- **`approve(floorId, batchId, version)`**: the same checks; then the Batch
  is marked in progress (once: `markInProgress` is conditional), a
  `batch.approved` event is published, and its work starts as the approved
  version says, in its order, through the same `advance` as with plan
  approval off (triage, then the pipeline at `needs-code`, queued for the
  Plan's coder; the rest wait for their dependencies). Then
  `batch.started`, the "Batch started" info Notice, and the approval Notice
  closed.
- **One edit or approval per Batch at a time** (a lock per Batch), so a
  second one sees the first's result: a newer version (`plan_changed`) or
  an approved Batch (`batch_not_awaiting_approval`). A refusal is a
  `BatchError` with its code.
- The chat's answer to "complete issues …" with plan approval on now says
  work starts "once you approve the Plan on the Floor's whiteboard, where
  you can first reorder, drop and annotate its issues, and I replan". Its
  answers to "skip" and "move" (not carried out from the chat yet) now
  point to the whiteboard instead of saying a Plan cannot be changed.

### The server (`apps/server` `batches/routes.ts`)

- `POST /api/floors/:floorId/batches/:batchId/plan` (`planEditSchema`):
  `201` with the Batch and every version of its Plan, once the Manager has
  replanned.
- `POST /api/floors/:floorId/batches/:batchId/approve`
  (`planApprovalSchema`): `200` with the same.
- Refusals: `400 invalid_request` (body), `400 invalid_plan_edit`, `404
  batch_not_found` / `floor_not_found`, `409 plan_changed`, `409
  batch_not_awaiting_approval`, `409 floor_archived`, and `503
  github_not_configured` without the GitHub App (Batches need it). A
  signed-in session with its CSRF token only, as every route.
- `server.ts` hands the routes the Batches made after the pipeline.

### The whiteboard (`apps/web` `whiteboard.tsx`, `router.tsx`, `scene/inspector-panels.tsx`)

- **`/floors/<floor>/whiteboard`** (`?batch=<id>`), linked from the Floor
  admin ("The whiteboard: Plans and Batch history") and from the Notice.
  The **meeting-room whiteboard** in the 3D Office (FR-58) opens the same
  `Whiteboard` in its inspector panel, with a link to the page; this
  replaces #67's placeholder entry for the whiteboard.
- **Current and past Plans.** It opens on the Batch awaiting approval (or
  the newest, or the one in the address) and lists every Batch of the Floor
  to pick from ("Batch 1: In progress"); the address follows. A Plan shows
  its summary and its issues in order: number (linking the issue on
  GitHub), title, "(started)", coder (linking the Agent), what it runs
  after, likely files, the Manager's note and "Your note: …"; then the
  parallel groups, the overlaps and what was left out. **Version** picks
  any earlier version, each described ("drafted", "replanned by AI
  Office's rules after your edits to version 1"). It stays live on
  `batch.planned`, `batch.approved` and `batch.started` events.
- **Editing** the latest version of a Plan awaiting approval: **Move #N
  up/down**, **Drop #N** / **Keep #N** (`aria-pressed`), **Your note on
  #N**, then **Save edits and replan** ("The Manager is replanning…") or
  **Undo edits**. **Approve Plan** is disabled while there are unsaved
  edits ("Save or undo your edits before approving."), and otherwise says
  what starts first. A refusal (such as a Plan that changed meanwhile) is
  shown, and the newer version read. Every control is a button, a text
  area or a select, so all of it works from the keyboard (PRD §7).

### Docs

README: "The whiteboard: approving, editing and replanning a Plan" (new),
"Batches and Plans" (plan approval on), the Manager chat's "skip" and
"move", and the 3D Office's inspector panels.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `368afd6` (output below). Without Docker
      the Postgres tests skip with the reason (2292 passed, 338 skipped).
      Against an embedded Postgres 18.4 the full suite passed, 2610 passed
      and 20 skipped (the real-App GitHub contract and the Docker image and
      compose checks), on the second run; the first run had one failure,
      the work-queue test #83 already reported as flaky in Postgres, which
      also fails on the base commit `a225ac6` (below).
- [x] **Playwright: edit then approve a Plan; work starts in the new
      order.** `e2e/tests/whiteboard.spec.ts`, against the built app,
      Postgres 18.4 and the fake GitHub. On a new Floor (plan approval on),
      the Owner opens #1 "Add a basket", #2 "Add a wish list" and #3 "Tidy
      the footer", and types "complete issues 1 to 3" in the Manager chat:
      1. The answer says work starts once the Plan is approved on the
         whiteboard; no task reaches the (stand-in) sandboxes.
      2. The Notice Board shows "Plan awaiting approval on web-shop: Batch
         1, 3 issues"; its **Open Plan** opens
         `/floors/web-shop/whiteboard?batch=1`: "Batch 1: Awaiting
         approval", #1, #2 and #3 in order, with the coder.
      3. The Owner clicks **Move #3 up** twice, **Drop #2**, and writes
         "Keep the basket small." on #1; **Approve Plan** is disabled. **Save
         edits and replan**: "Version 2, replanned by AI Office's rules
         after your edits to version 1" (there is no AI Account, so the
         rules replan), #3 then #1, the note kept, "#2 is left out: you
         dropped it from the Plan."; still no task started.
      4. **Approve Plan**: "Batch 1: In progress", and the sandbox tasks
         arrive **in the new order, #3 then #1** (`[3, 1]`, not sorted),
         both for the Plan's coder.
      5. `GET /api/floors/web-shop/batches`: `in_progress`, started `[3,
         1]`, Plan version 2, `draftedBy: "rules"`, `editedFrom: 1`, the
         items in order with the annotation, #2 left out.
      6. **Version** 1 still shows the three issues in their first order.
      7. The meeting-room whiteboard in the 3D Office
         (`/?floor=web-shop&inspect=whiteboard:web-shop`) shows the same
         Plan in its panel: "Batch 1: In progress", "#3 Tidy the footer
         (started)".
      8. The approval Notice is gone from the board; "Batch started on
         web-shop: 3 issues, work started on #3 and #1" is up; the Activity
         Feed has the replan and "The Owner approved version 2 of Batch 1's
         Plan, by …".

      The whole Playwright suite passes (25 tests, output below). With the
      approval sabotaged to start the first version instead of the latest,
      this test fails: the tasks arrive as `[1, 2, 3]`.

**Beyond the criteria**, the behaviour is covered by:

- `packages/orchestrator/src/batches/batches.test.ts`, in memory and in
  Postgres 18.4 (fake model, fake GitHub, the real triage, pipeline,
  intake, Notices and work queue):
  - **The Owner edits, the Model replans, approving starts the work in
    order.** #1, #3, #4 (after #1), #5 await approval; the Notice is raised
    with its links and **Open Plan**, whose action fails while the Plan
    awaits approval. The Owner moves #5 to the top and #4 above #1, drops
    #3, and annotates #5 and #1 (one note holding an Anthropic key). The
    Model's first answer ignores their order and is sent back with "Keep
    the Owner's order exactly: #5, #4, #1, …"; the prompt names version 1,
    the order, the dropped #3, what version 1 said of each issue and the
    notes, quotes #5, #4 and #1 but not #3, and no request holds the key.
    Version 2 is compared in full: the Owner's order, the annotations
    (`[REDACTED]`), #1 now after #4 (they share `src/basket.ts`), parallel
    groups `[[5, 4], [1]]`, #3 left out, `editedFrom: 1`; `batch.planned`
    carries `editedFrom`; nothing started; #3 is no longer held. Then
    refusals change nothing: approving or editing version 1 (`plan_changed`),
    an issue not in the Plan, an edit that changes nothing
    (`invalid_plan_edit`), another Batch (`batch_not_found`). Approving
    version 2 starts #5 and #4, in that order, through triage, and #1
    waits; `batch.approved`, `batch.started`, the approval Notice closed as
    acted on, the "Batch started" Notice up; a second approval or edit is
    `batch_not_awaiting_approval`; once #4 is closed, `check()` starts #1.
  - **The rules replan** when the Manager is paused (no model call):
    the Owner's order; #3 loses its dependency on #1, which now comes after
    it; #1 now runs after #4, with which it shares a file; files, coders,
    notes and the annotation kept.
  - The plan-approval-on scenario of #83 now also expects the Notice.
- `plan.test.ts`: `replanFromDraft` (refuses another order, an extra issue,
  or a draft `planFromDraft` would refuse; completes one in order with the
  annotations) and `replanByRules` (the order, dependencies still before,
  re-sequenced overlaps, a paused coder's issue shared out again).
- `prompt.test.ts`: the replan prompt, in full for its edits section.
- `apps/server/src/batches/routes.test.ts`, in memory and Postgres: edit
  (`201`, every version) and approve (`200`), the body passed on trimmed;
  malformed bodies refused before the Batches are asked; each `BatchError`
  answered with its status and message; non-numeric and zero ids `404`;
  `401` without a session and `403` without the CSRF token; `503
  github_not_configured` without the GitHub App.
- `apps/web/src/whiteboard.test.tsx` (the app's router, a stubbed server):
  opening from `?batch=2`; moving, dropping and annotating; the request
  sent (order, trimmed note, CSRF token); version 2 shown; approving;
  browsing version 1 and a past Batch read only (the address follows); and
  a refused approval of a Plan changed meanwhile, saying why and reading
  version 2. `scene/office-view.test.tsx` now expects the whiteboard's
  panel to link its page.

**Negative checks.** Each sabotage was applied to the working tree, run on
`src/batches` of `orchestrator` in memory and in Postgres (31 tests, or
the named test), and reverted with `git checkout` (`git status` clean
afterwards).

| Sabotage | Failed |
| --- | --- |
| Approving starts version 1, not the latest | 2: the edit scenario, in each store; and the Playwright test (`[1, 2, 3]` for `[3, 1]`) |
| The Owner's order is not enforced on the Model's replan | 3: `replanFromDraft`'s test and the edit scenario in each store |
| Dropped issues are not listed as left out | 2: the edit scenario, in each store |
| A stale version is not refused | 2: the edit scenario, in each store |
| Annotations are not redacted | 2: the edit scenario, in each store |
| The approval Notice is not closed on approval | 2: the edit scenario, in each store |
| No approval Notice is raised | 4: the edit and plan-approval-on scenarios, in each store |
| The rules keep dependencies that now come after | 3: `replanByRules`'s test and the rules scenario in each store |
| The whiteboard's Move buttons do nothing | 1: the whiteboard's editing test |

### Not verified by a test

- **A real Model's replan.** The replans were the fake model's (in the
  Playwright test, there is no AI Account, so the rules replanned). How
  well a real Manager's Model honours the Owner's annotations can only be
  seen on the host; plain code guarantees only the order, the dropped
  issues and a Plan that fits the Batch.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and of
  `pnpm e2e` needs Docker. Both ran against an embedded Postgres 18.4
  instead, and run in CI.
- **The 3D scene itself.** The whiteboard's HTML panel was exercised in
  headless Chromium; the GPU-rendered meeting room (and that the camera
  flies to the whiteboard) was not looked at. Nothing in the scene changed:
  per PRD §7 no text is drawn on the 3D whiteboard, and its filling in live
  during meetings is #85.
- **The real GitHub App.** Issues were the fake GitHub's; the replan reads
  them with `getIssue`, as triage and the first draft already do.

## Notes

- **Edits are saved, then approved.** Approving needs the latest version,
  so the Owner always sees the Manager's replan of their edits before work
  starts, and an approval can never land on a Plan that changed unseen.
- **Annotations are the Owner's instructions to the Manager**, so the
  replan prompt gives them in its system part (as the Manager's extra
  instructions are), redacted, rather than quoted as untrusted text like
  the issues.
- **Moving issues is by buttons**, not drag and drop: each move is one
  keyboard-reachable control, as PRD §7 asks; drag and drop could be added
  over the same state.
- **Dropped issues leave the Batch**, but stay in `batches.issues` (the
  issues as named) and in the Plan's `leftOut`, so the whiteboard says why.

## Outside this issue

- **Annotations do not reach the coder.** The Owner's note on an issue is
  kept on the Plan and given to the Manager to replan, but the coder's
  prompt (`coderPrompt`) does not quote it. Passing a started issue's
  annotation into its task would let it guide the work itself.
- **"skip" and "move" from the chat** (FR-24) are still not carried out;
  they now point to the whiteboard. They could reuse `edit`.
- **Mid-Batch replanning** (FR-25 (4)): once approved, a Plan cannot be
  edited (`batch_not_awaiting_approval`).
- **Kickoff acknowledgements and Wrap-up** (FR-25 (2), (6)) and the
  meetings' animations (#85). A Batch still never finishes, as #83 noted.
- **Manager decisions as issue comments** (FR-23): a replan is in the
  Activity Feed and on the whiteboard, not commented on each issue.
- **A flaky work-queue test in Postgres** (also in #83's notes):
  `src/work/queue.test.ts` > "two coders share four issues, the next going
  to whichever coder is free" failed once in the first full Postgres run
  here, and once in six runs alone on the base commit `a225ac6`.
- **`needs-code` vs `needs-work`.** As in #79 to #83, the code (and the
  README) keep `needs-code`; ADR 0003's rename should be its own issue.

## Output

### Fresh clone at `368afd6`

```text
$ pnpm install --frozen-lockfile
Done in 2.1s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  201 passed (201)
      Tests  2292 passed | 338 skipped (2630)
test exit=0
```

### Against the embedded Postgres 18.4 (same clone)

```text
$ SCRATCH_PG_URL=… pnpm test        # first run
     × two coders share four issues, the next going to whichever coder is free 681ms
 FAIL  |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > two coders share four issues, the next going to whichever coder is free
AssertionError: expected [ 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
 Test Files  1 failed | 200 passed (201)
      Tests  1 failed | 2609 passed | 20 skipped (2630)
exit=1

$ SCRATCH_PG_URL=… pnpm test        # second run
 Test Files  201 passed (201)
      Tests  2610 passed | 20 skipped (2630)
exit=0
```

The 20 skips, from a verbose run:

```text
     12  ↓ |@ai-office/github| src/contract.test.ts
      2  ↓ |deployment| docker/deployment.test.ts
      6  ↓ |deployment| docker/sandbox-images.test.ts
```

The flaky test alone, six times, on the base commit `a225ac6`:

```text
      Tests  4 passed | 32 skipped (36)
      Tests  4 passed | 32 skipped (36)
      Tests  1 failed | 3 passed | 32 skipped (36)
      Tests  4 passed | 32 skipped (36)
      Tests  4 passed | 32 skipped (36)
      Tests  4 passed | 32 skipped (36)
```

### The new and changed tests (verbose, Postgres 18.4)

`SCRATCH_PG_URL=… pnpm vitest run --project @ai-office/orchestrator
--project @ai-office/server --project @ai-office/events --project
@ai-office/web src/batches src/manager/chat.test.ts
src/manager-chat/routes.test.ts src/schema.test.ts src/whiteboard.test.tsx
src/scene/office-view.test.tsx --reporter=verbose`, the tests this issue
added or changed:

```text
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > replanning the Owner's edits > keeps the Manager's replan only in the Owner's order, with their annotations
✓ |@ai-office/orchestrator| src/batches/plan.test.ts > replanning the Owner's edits > by AI Office's rules: the Owner's order, keeping each issue's files, coder, note and the dependencies still before it
✓ |@ai-office/orchestrator| src/batches/prompt.test.ts > the Plan prompt > asks for a replan of the Owner's edits: their order, what was dropped, what the Plan said, and their annotations
✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > parses a batch.approved event
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in memory > says nothing changed for a command it cannot carry out yet, and why one failed
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > "complete issues 1 to 7": the Manager drafts a Plan, kept with all its fields, and with plan approval off work starts at once
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > with plan approval on, the Plan is kept and nothing starts: the Batch holds its issues
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > the Owner edits a Plan awaiting approval (reorders, drops, annotates), the Manager replans in their order, and approving starts the work in that order
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > when the Manager's Model cannot replan, AI Office's rules replan the Owner's edits, keeping what the Plan said of each issue
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > "complete issues 1 to 7": the Manager drafts a Plan, kept with all its fields, and with plan approval off work starts at once
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > with plan approval on, the Plan is kept and nothing starts: the Batch holds its issues
✓ |@ai-office/orchestrator| src/manager/chat.test.ts > the Manager chat, kept in Postgres 18 > says nothing changed for a command it cannot carry out yet, and why one failed
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > the Owner edits a Plan awaiting approval (reorders, drops, annotates), the Manager replans in their order, and approving starts the work in that order
✓ |@ai-office/web| src/scene/office-view.test.tsx > inspectable objects > opens the right panel for each type of object selected in the scene
✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > when the Manager's Model cannot replan, AI Office's rules replan the Owner's edits, keeping what the Plan said of each issue
✓ |@ai-office/web| src/whiteboard.test.tsx > the whiteboard > opens on the Batch a Notice names; the Owner moves, drops and annotates its issues, saves them to be replanned, then approves
✓ |@ai-office/web| src/whiteboard.test.tsx > the whiteboard > browses past Batches, read only, and says when a Plan changed under the Owner
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in memory > lists a Floor's Batches with their latest Plan, and gives one with every version
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in memory > edits a Plan awaiting approval and approves it, answering the Batch with every version, or why not
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in memory > without the GitHub App, Plans can be read but not edited or approved
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in Postgres 18 > lists a Floor's Batches with their latest Plan, and gives one with every version
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in Postgres 18 > edits a Plan awaiting approval and approves it, answering the Batch with every version, or why not
✓ |@ai-office/server| src/batches/routes.test.ts > the Batch API, in Postgres 18 > without the GitHub App, Plans can be read but not edited or approved
 Test Files  9 passed (9)
      Tests  153 passed (153)
```

### The sabotage runs (memory and Postgres)

```text
## order: approve starts version 1
      Tests  2 failed | 29 passed (31)
## owner order not enforced
      Tests  3 failed | 28 passed (31)
## dropped issues not listed as left out
      Tests  2 failed | 29 passed (31)
## stale version not refused
      Tests  2 failed | 29 passed (31)
## annotations not redacted
      Tests  2 failed | 29 passed (31)
## approval Notice not closed
      Tests  2 failed | 29 passed (31)
## no approval Notice raised
      Tests  4 failed | 27 passed (31)
## rules keep dependencies now after
      Tests  3 failed | 28 passed (31)
## web: Move does nothing (src/whiteboard.test.tsx)
      Tests  1 failed | 1 passed (2)
## e2e: approve starts version 1 (tests/whiteboard.spec.ts)
  ✘  1 [chromium] › tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: the Manager replans, and work starts in the new order (9.2s)
    - Expected  - 1
    + Received  + 2
    +   1,
    +   2,
    -   1,
  1 failed
```

### `pnpm e2e` (embedded Postgres 18.4, Chromium; same clone)

```text
Running 25 tests using 8 workers
  ✓  11 [chromium] › tests/batch.spec.ts:13:1 › "complete issues 1 and 2" with plan approval off: the Plan is kept, shown in the chat, and work starts (5.0s)
  ✓  14 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (5.1s)
  ✓  24 [chromium] › tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: the Manager replans, and work starts in the new order (15.2s)
  … (22 more ✓)
  25 passed (28.5s)
exit=0
```

### How Postgres and Chromium were run here

There is no Docker in this sandbox, so I used the method of the earlier
issues.

- **Postgres:** `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, outside the repository, on port 54329.
  - For the unit and integration tests, a scratch edit to
    `packages/db/src/testing/postgres.ts` (kept as `/tmp/scratch-pg.patch`)
    pointed `postgresTest` at that server through `SCRATCH_PG_URL`, with
    database names unique per worker. It was applied for each run and
    reverted with `git checkout` after it; nothing from it is committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`, which the harness supports.
- **Chromium:** installed with `playwright install chromium`. Its missing
  shared libraries were extracted from Debian bookworm's packages into
  `/tmp/chromelibs`, outside the repository, and used through
  `LD_LIBRARY_PATH`.
