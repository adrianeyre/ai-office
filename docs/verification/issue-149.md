# Issue #149: Ordered work Roles for one issue in a Plan — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker). `pnpm lint`, `pnpm typecheck` and `pnpm test` ran in a fresh
`git clone` of this branch at `b8089b2` (every code and docs commit of the
issue), after `pnpm install --frozen-lockfile`. The Postgres runs were
made in that clone. The sabotage and Playwright runs were made in the
working tree at the same code. Both blockers are built on this branch.
#148, routing between work Roles, is in [`issue-148.md`](issue-148.md):
the triage's `role`, `role:` labels, and dispatch within a Role. #84,
the whiteboard's Plan approval, editing and replanning, is in
[`issue-84.md`](issue-84.md).

## What was built

### The model (`packages/shared`)

- **`batches.ts`**: `maxPlanRoles` (5).
  - The Manager's draft (`planDraftSchema`) may give an issue **`roles`**:
    work Roles by name, in the order they take turns. It is optional, so
    every draft that was valid still is.
  - A Plan's item (`planItemSchema`) keeps **`roles`**: library Role ids,
    present only when the Plan gives any.
  - The whiteboard's edit (`planEditSchema`) may carry each issue's
    **`roles`**: the ones to keep, in their new order, at least one.
- **`routing.ts`**: `routeJudges` gains **`plan`**, so `issue.routed` can
  say a Batch's Plan chose. The Activity Feed reads it as "Ada gave #4 to
  the copywriter Role (by its Batch's Plan)."

### The database (`packages/db`): migration `0070_work_turns`

(Written as `0048`, renumbered after main's `0044`–`0049` in
[the merge note](merge-main-into-131-to-153.md).)

**`issue_work_turns`**, one row per issue (Floor and issue as primary
key). It holds:

- `batch_id`;
- `roles` (jsonb, ids in order);
- `turn` (checked to index into `roles`);
- `reviewing` (false while the Roles take their first turns);
- `files` (jsonb, the files each Role's commits changed, by Role id);
- `updated_at`.

No existing table changes. A Plan's `roles` live in `plans.items`, which
is jsonb already.

### Turns (`packages/orchestrator`, `work/turns.ts`, new)

- **`afterDelivery(record, files)`**: records the files the Role whose
  turn it is changed. It answers the next Role's turn, or review after
  the last. Once reviewing, a delivery (a fix) goes back to review and
  leaves the last Role's turn next.
- **`fixRole(record, paths)`**: the Role a Review Loop fix goes to. That
  is the one Role whose commits changed every file the blocking comments
  are on. The fix goes to the last Role when that is unclear: comments on
  several Roles' files, on a file two Roles changed, on a file no Role
  changed, or no file at all. `clear` says which.
- **`createWorkTurns({store})`** gives:
  - `plan`: start the issue's turns at the first Role, replacing any;
  - `get` and `role`: the Role whose turn it is, or null;
  - `delivered` and `sendBack`.

  Memory and Drizzle stores, registered in `OfficeStores` as
  `workTurns`.

### The Plan (`batches/plan.ts`, `prompt.ts`, `batches.ts`)

- **The prompt.** On a Floor with more than one work Role, it lists them
  under "## The Floor's work Roles", each with its routing description
  and its coders. It asks for each issue's `roles` in turn: "Give most
  issues one Role… Name several only when the issue needs each one's own
  work… An issue's `agent` must be a coder in its first Role". Its
  answer example then has `roles`. With one work Role or none, the
  prompt is as it was, character for character (tested).
- **`planFromDraft` checks them.** Each must be one of the Floor's work
  Roles, by name or id in any case, and each once. The `agent` must be a
  coder of the first Role, with the problem said in sentences the Model
  can act on. An issue with Roles but no coder gets the least busy coder
  of its first Role. A Floor with one work Role keeps none.
- **Replanning.** `replanFromDraft` sends back a replan whose Roles
  differ from the Owner's: "Keep the Owner's work Roles for #1 exactly,
  in turn: the copywriter, then the merchandiser." `replanByRules` and
  `replanMidBatch` keep each issue's Roles (the Owner's, as edited). An
  issue keeps its coder only while that coder is in its first Role;
  otherwise one is chosen there. The rules' summary mentions work Roles
  only when the Plan has some.
- **Edits.** `checkEdit` lets an issue's Roles be reordered or cut down,
  never added to or repeated ("#1's work Roles can only be reordered or
  removed, each kept once: it has merchandiser, copywriter."). A change
  of Roles counts as an edit. "skip" and "move" before approval keep
  each issue's Roles.
- **Starting an issue.** The issue's Roles go to triage as `planned`.
  Once triage lets it proceed, its turns are recorded (`turns.plan`),
  before it is picked up for the Plan's coder, who is in the first Role.
- **The chat's answer** names them: "1. #1 Add the autumn range: Mia
  (merchandiser, then copywriter)."
- `Batches` takes the Floor's work Roles from `triage.workRoles`, and a
  `turns` option.

### Triage (`manager/triage.ts`)

`check(floor, issue, {planned})`: the Plan's Roles that are still on the
Floor's team settle the issue's Role, ahead of any `role:` label. The
Model is not asked to choose. The triage record's `role` is the first
Plan Role.

- The comment has "### Role: merchandiser, then copywriter" and "Its
  Batch's Plan gives this issue to the **merchandiser**, then the
  **copywriter**: they take turns on its one branch, and review starts
  after the last."
- `issue.routed` records the first Role, `routedBy: "plan"`.
- An issue already waiting for the Owner's choice of Role is settled, and
  its Notice closed, with no second model call.
- An unclear issue still waits.
- A Floor with one work Role is unchanged.

### The coder flow (`coder/coder.ts`, `prompt.ts`), the Review Loop, progress

- **The work queue** dispatches by the Role whose turn it is. The server
  wires `issueRole` as `turns.role(…) ?? triage.role(…)`.
- **Handing on.** When the Role whose turn it is is not the last, the
  coder flow:
  1. lists the files its commits changed (`git show --name-only` on the
     run's own commits);
  2. pushes the branch as it is (not rebased: that is for review), each
     commit authored as the Owner with this Agent's `Agent:` trailer;
  3. records its Handoff (stage `needs-work`) and keeps memory proposals
     as a delivery does;
  4. advances the turn, lets the issue go at `needs-work` and queues its
     work again.

  The queue adds the new work once this run ends, for an Agent in the
  next Role. The progress comment ends "Handed on: to the copywriter, who
  works on the same branch next". No pull request is opened.
- **The next Role's prompt** has "## Work Roles taking turns": every Role
  in order, "This is turn 2 of 2: yours, as the copywriter", to do its
  Role's part only and keep the Roles before. It also quotes the Handoff
  before it between `<previous-handoff>` markers it cannot close. That
  Handoff is published as a `handoff` event as the Agent starts: the
  ticket's walk from desk to desk. The prompt asks for a Handoff "for the
  copywriter, who works on it next", or for the reviewers after the last
  Role. While the Roles take their turns, review and QA feedback are not
  looked for.
- **After the last Role** the delivery is as before: rebase, one pull
  request, `needs-review`. The turns are marked `reviewing`.
- **Review Loop fixes** (`review/reviewer.ts`): when a round sends the
  issue back, `turns.sendBack` gets the blocking comments' paths, so the
  fix is queued for the Role `fixRole` names. A fix goes straight back to
  review. QA, and anything else sending the issue back, reach the last
  Role.

### The whiteboard (`apps/web/src/whiteboard.tsx`)

- An issue's Roles are named from the Role library (`rolesQuery`): "Work
  Roles, in turn: merchandiser, then copywriter", or "Work Role:
  copywriter".
- Editing an issue with several lists them under "Work Roles on #4, in
  turn" with three buttons:
  - **Move the copywriter up/down on #4**;
  - **Remove the merchandiser on #4**, an `aria-pressed` toggle that
    reads **Keep** once removed;
  - the last Role kept cannot be removed.
- A change of Roles is an edit: **Approve Plan** is disabled until it is
  saved or undone. **Save edits and replan** sends each issue's kept
  Roles in their order.

### Docs

- README ("Roles and Stages").
- The Batches guide: "Several work Roles on one issue" (new), plus the
  Plan, the whiteboard's editing and its API.
- The issue pipeline guide: routing, delivering a turn, Review Loop fixes
  and Handoffs.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `b8089b2` (output below):
  - without Docker, **247 files, 2834 passed, 409 skipped** (the Postgres
    tests skip with the reason);
  - against an embedded **Postgres 18.4**:
    - the first run had **1 failed, 3220 passed, 22 skipped**. The
      failure is the work-queue test #83 and #84 recorded as flaky in
      Postgres. It fails on the base commit `047cb38` too: 3 of 6 runs
      there, against 1 of 6 at `b8089b2` (below);
    - the second run passed in full: **247 files, 3221 passed, 22
      skipped**. The skipped tests are the GitHub contract against the
      real App, which needs `GITHUB_APP_ID`, and the checks that need
      Docker.
- [x] **Scenario test: "add the autumn range" runs merchandiser then
      copywriter on one branch, then review; commits carry each Agent's
      `Agent:` trailer.**
      `packages/orchestrator/src/batches/work-roles.test.ts`, in memory
      and in Postgres 18.4. It is wired as the server wires it:
  - the real Batches, triage, work queue, coder, review and merge flows;
  - the fake model for the Manager and the reviewer;
  - the fake GitHub over a local bare repository;
  - the sandbox runner with a fake sandbox in which each Agent is a
    script that commits.

  The `shop-theme` Floor has a Manager, a merchandiser, a copywriter and
  a reviewer (no coder, no QA). The Owner files "Add the autumn range"
  and hands it to the Manager in a Batch. The Plan gives it `["merchandiser",
  "copywriter"]`, and the Owner approves it:
  - **The Plan** keeps `roles: ["merchandiser", "copywriter"]` with the
    merchandiser as its coder. The Manager's prompt listed the work Roles
    with their descriptions. The chat's answer reads "1. #1 Add the
    autumn range: <merchandiser> (merchandiser, then copywriter)…".
  - **Turns:** the sandbox ran the merchandiser, then the copywriter,
    once each.
    - The merchandiser's prompt says "This is turn 1 of 2: yours, as the
      merchandiser" and asks for a Handoff for the copywriter.
    - The copywriter's prompt says turn 2 of 2, "<merchandiser>, the
      merchandiser, handed it to you", and quotes "What changed: feat:
      the autumn coats' product data, take 1." It asks for a Handoff for
      the reviewers, with no review feedback.
  - **One branch, each Agent's trailer.** `main..ai-office/1-add-the-autumn-range`
    on the remote holds exactly two commits:
    - the merchandiser's, with `Agent: <merchandiser> (merchandiser,
      Claude claude-opus-5-5)` and no mention of the copywriter;
    - then the copywriter's, with its own trailer and no mention of the
      merchandiser.

    Both are authored as the Floor's Git identity. The branch has both
    Roles' files at their content.
  - **Then review**, in this event order: `needs-work`; pushed by the
    merchandiser; `handoff` merchandiser → copywriter (`needs-work`);
    pushed by the copywriter; the pull request opened by the copywriter;
    `needs-work → needs-review`; `handoff` copywriter → reviewer; the
    reviewer's review.
    - One pull request.
    - The reviewer's request held both files.
    - `issue.routed` is `{role: "merchandiser", routedBy: "plan"}`.
    - The comment has "### Role: merchandiser, then copywriter".
    - The Manager made 2 model calls (the Plan and triage), the
      triage's without "## Which Role works it".
    - The issue then reached the Merge Policy: "PR #2 awaiting your
      approval" is open.
    - The turns end `{turn: 1, reviewing: true, files: {merchandiser:
      ["products/autumn.json"], copywriter: ["copy/autumn.md"]}}`.
- [x] **Whiteboard test: reordering the work Roles in a Plan changes the
      order run.** Two tests:
  - **The order run**: `work-roles.test.ts`, "reordering the work Roles
    on the whiteboard changes the order they run; removing one leaves it
    out", in memory and Postgres. Through `batches.edit`, the
    whiteboard's API:
    1. An edit adding a Role (`coder`) is refused with its sentence.
    2. The Owner puts the copywriter first. The Manager's first replan
       keeps the old order and is sent back with "Keep the Owner's work
       Roles for #1 exactly, in turn: the copywriter, then the
       merchandiser."; its prompt had said "**the Owner's, keep them
       exactly, in this order**".
    3. Version 2 has `roles: ["copywriter", "merchandiser"]` and the
       copywriter as its coder.
    4. Approved, the sandbox runs **the copywriter, then the
       merchandiser**. The commits' trailers are in that order, the
       `handoff` goes copywriter → merchandiser, and the merchandiser
       opens the pull request.

    A companion case, "a Plan whose work Roles the Owner cut down to one
    runs only that Role, then review": the Manager is paused, so the
    rules replan, keeping `["merchandiser"]`. Only the merchandiser runs,
    with no Role-to-Role Handoff.
  - **The whiteboard itself**: `apps/web/src/whiteboard.test.tsx`,
    "reorders an issue's work Roles, saved for the Manager to replan in
    that order before approving; the last Role cannot be removed". It
    uses the app's router and a stubbed server serving the Role library.
    1. #4 lists "Merchandiser", "Copywriter", while #5 has "Work Role:
       Copywriter" with nothing to reorder.
    2. **Move the Copywriter up on #4** reorders them, and Approve is
       disabled.
    3. Removing the Merchandiser disables removing the Copywriter. Keep
       and the move back undo the edit, re-enabling Approve.
    4. Moved again and saved: the request body is `{version: 1, items:
       [{issue: 4, annotation: "", roles: ["copywriter",
       "merchandiser"]}, {issue: 5, annotation: "", roles:
       ["copywriter"]}]}` with the CSRF token. Version 2 shows the new
       order.
    5. Approved, the Plan reads "Work Roles, in turn: Copywriter, then
       Merchandiser".

Also, beyond the criteria:

- **Review Loop fixes** (the issue's last sentence): `work-roles.test.ts`,
  "Review Loop fixes go back to the work Role whose changes the blocking
  comments concern, or to the last one when that is unclear", in memory
  and Postgres.
  - Round 1 blocks on `products/autumn.json`, and the fix is the
    merchandiser's, prompted with round 1's comment and no turns section.
  - Round 2 blocks on both Roles' files, so it is unclear and the fix is
    the copywriter's.
  - Round 3 approves.
  - The `needs-work` Handoffs are merchandiser → copywriter, reviewer →
    merchandiser, reviewer → copywriter. The four commits carry
    merchandiser, copywriter, merchandiser, copywriter trailers.
- `turns.test.ts`: `afterDelivery` (three Roles in order, then review; one
  Role straight to review; a fix back to review), `fixRole` (one Role's
  file; several Roles' files; a file two Roles changed; a file none
  changed; none) and the store in memory and Postgres 18.4.
- `plan.test.ts`, "work Roles in turn (FR-25 (1))" (4 tests): Roles kept
  with a coder of the first Role; each problem's sentence; none on a
  one-work-Role Floor; the replan and the rules keep the Owner's Roles.
- `prompt.test.ts` (Plan), `coder/prompt.test.ts`, `progress.test.ts`:
  the Roles section (and none with one Role), the turns section and the
  quoted Handoff, and "Handed on".
- `routing.test.ts`, "a Batch's Plan gives an issue its work Roles: the
  Model is not asked to choose, a label gives way, and a waiting choice
  is settled", in memory and Postgres. Every #148 routing case passes
  unchanged.
- `apps/server` `batches/routes.test.ts`: an edit's `roles` reach the
  Batches as sent, and an empty `roles` is `400 invalid_request`.
  `activity-feed.test.tsx`: the text of `routedBy: "plan"`.

**Negative checks.** Each sabotage was applied to the working tree, run in
memory on `src/batches`, `src/work` and `src/manager/routing.test.ts` of
`orchestrator` (or the whiteboard test), and reverted with `git checkout`
(`git status` clean afterwards).

| Sabotage | Failed |
| --- | --- |
| The coder flow never hands on (always opens the pull request) | 3: the autumn range, Review Loop fixes, reordering |
| `turns.role` always null (dispatch by triage only) | 4: the three above and the turns' store |
| `fixRole` always answers the last Role | 3: Review Loop fixes, `fixRole`'s test, the turns' store |
| The reviewer never sends a fix to a Role | 1: Review Loop fixes |
| The Owner's Roles are not enforced on the Manager's replan | 2: reordering, the replan's `plan.test.ts` |
| An edit may add Roles | 1: reordering |
| Triage ignores the Plan's Roles | 5: every `work-roles` case and the routing case |
| A Batch records no turns | 3: the autumn range, Review Loop fixes, reordering |
| No Handoff published to the next Role | 3: the autumn range, Review Loop fixes, reordering |
| No files recorded per Role | 2: the autumn range, Review Loop fixes |
| The rules replan forgets the Owner's Roles | 2: cut down to one, the replan's `plan.test.ts` |
| Whiteboard: moving a Role does nothing | 1: the whiteboard's Roles test |
| Whiteboard: Roles not sent with the edit | 1: the whiteboard's Roles test |

### `pnpm e2e`

The whole suite (46 tests) ran with 4 workers against the embedded
Postgres: **42 passed, 4 failed**. `whiteboard.spec.ts` (edit then approve
a Plan; work starts in the new order) passed.

- Three failures are the ones recorded since #146 (`agent-editor.spec.ts`,
  `gateway-requests.spec.ts`, `manager-chat.spec.ts`), on the same lines.
  They look on the Admin page for what #165 moved to AI Settings
  ([`issue-147.md`](issue-147.md#pnpm-e2e)).
- The fourth, `notice-alerts.spec.ts`, never started. It launches the
  full Chrome, which needed `libcups.so.2`, missing in this sandbox. With
  it added, that spec passed on its own (1 passed).

No spec covers work Roles in turn. The harness has no Model, and AI
Office's rules give a Plan no Roles.

### How Postgres and Chromium were run here

As for earlier issues, outside the repository:

- **Postgres**: `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, on port 54329.
  - For `pnpm test`, a scratch edit to `packages/db/src/testing/postgres.ts`
    pointed `postgresTest` at it through `SCRATCH_PG_URL`, with database
    names unique per test file. It was reverted with `git checkout` after
    each run and never committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`.
- **Chromium**: from `playwright install chromium`. Its missing shared
  libraries came from Debian bookworm's packages (downloaded from
  `deb.debian.org`, extracted to `/tmp/chromelibs`, on
  `LD_LIBRARY_PATH`).

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`. Both ran against the embedded Postgres 18.4 instead; they run in
  CI.
- **Real sandboxes and agent tools.** The Agents are scripts in the fake
  sandbox. A real merchandiser's and copywriter's runs in Claude Code,
  Codex or opencode, on real images, are for the host.
- **A real Model.** The Manager and the reviewer are a fake model. How
  well a real Model chooses Roles in turn from their descriptions, and
  keeps to its Role's part, is for the host.
- **Real GitHub.** Branches, commits and the pull request went to a
  local bare repository behind the fake GitHub, through the same
  `publishBranch` used for every push.
- **The Handoff's walk in 3D.** The 3D Office animates `handoff` events
  as before, and the event between two work Agents is
  `stage: "needs-work"`, as the reviewers' Handoff to a coder is. How the
  walk looks needs a display.

## Notes

- **One work Role is the default.** An issue the Plan gives no Roles is
  routed by triage as before (#148). A Floor with one work Role never has
  Roles in its Plans, prompts, comments or events. Development Floors
  behave exactly as before (Phase 8's exit criterion): every earlier
  Batch, plan, prompt, triage, routing, coder and Review Loop test passes
  unchanged.
- **Where the turns live.** In `issue_work_turns`, apart from the Plan,
  so the work queue, coder flow and Review Loop read one record by issue,
  and a restart loses nothing. The Plan keeps the Roles as approved; the
  turns keep the progress.
- **A turn's push is not rebased.** Rebasing happens once, before review,
  as for every delivery (FR-25.5).
- **A Role's commits.** The files a turn changed are those its own
  commits changed (`git show --name-only` in the run's clone), so a later
  rebase or another Role's commits never blur whose change a file was.
- **A run that fails, or stops at a Token Cap,** leaves the turn where it
  was: the same Role works it again. The turn advances only after its
  push succeeded.
- **The Plan's Roles beat a `role:` label**, since the Owner approved the
  Plan after it was drafted. A label still decides for an issue the Plan
  gives no Roles.
- **The Roles take turns once.** A Review Loop fix goes to one Role, then
  straight back to review, not through the Roles after it.

## Noticed, out of scope

- **AI Office's rules** (no Model) never give an issue several Roles: an
  issue with several `role:` labels still asks the Owner which one, as
  in #148. Reading an order from labels was left out.
- **QA failures** go to the last Role, by the "unclear" rule. QA reports
  carry no files, so they cannot be sent by whose change failed. The
  issue names Review Loop fixes only.
- **`issue.routed` names the first Role** only; the order is in the
  triage's comment and the Plan.
- **A Role with no Agent left** on the Floor when its turn comes falls
  back, as dispatch does (#148), to any work-Stage Agent. The prompt
  still says it is that Role's turn.
- **Turns outlive their Batch.** An issue worked again outside a Batch,
  such as relabelled by hand after `needs-human`, keeps its last turns
  until another Plan replaces them.
- **The flaky work-queue test** in Postgres ("two coders share four
  issues…") still fails now and then on the base commit, as #83 and #84
  recorded.
- **`notice-alerts.spec.ts`** launches the full Chrome, which needs
  `libcups.so.2` beside the headless shell's libraries. The README's
  end-to-end section says nothing of Chromium's system libraries, which
  `playwright install --with-deps` would bring on a host with root.

## Output

### `pnpm lint` and `pnpm typecheck`, fresh clone at `b8089b2`

```text
$ pnpm install --frozen-lockfile
Done in 430ms using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test`, without Docker, fresh clone at `b8089b2`

```text
$ pnpm test --maxWorkers=4
 Test Files  247 passed (247)
      Tests  2834 passed | 409 skipped (3243)
test exit=0
```

### `pnpm test` against the embedded Postgres 18.4, fresh clone at `b8089b2`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=4
   (first run)
 FAIL  |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > two coders share four issues, the next going to whichever coder is free
AssertionError: expected [ 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
 ❯ setup.limit.current src/work/queue.test.ts:243:26
    243|       expect(graceQueue).toEqual([1, 0, 1, 0]);
 Test Files  1 failed | 246 passed (247)
      Tests  1 failed | 3220 passed | 22 skipped (3243)
exit=1

   (second run)
 Test Files  247 passed (247)
      Tests  3221 passed | 22 skipped (3243)
exit=0
```

### The flaky work-queue test alone, six times each, in Postgres 18.4

```text
$ vitest run src/work/queue.test.ts -t "two coders share four issues"   # at b8089b2
      Tests  4 passed | 34 skipped (38)
      Tests  4 passed | 34 skipped (38)
      Tests  4 passed | 34 skipped (38)
      Tests  4 passed | 34 skipped (38)
      Tests  4 passed | 34 skipped (38)
      Tests  1 failed | 3 passed | 34 skipped (38)
--- base 047cb38
      Tests  1 failed | 3 passed | 34 skipped (38)
      Tests  4 passed | 34 skipped (38)
      Tests  1 failed | 3 passed | 34 skipped (38)
      Tests  1 failed | 3 passed | 34 skipped (38)
      Tests  4 passed | 34 skipped (38)
      Tests  4 passed | 34 skipped (38)
```

### This issue's tests (verbose), in memory and Postgres 18.4

```text
$ SCRATCH_PG_URL=… vitest run src/batches/work-roles.test.ts src/work/turns.test.ts src/manager/routing.test.ts src/batches/plan.test.ts src/batches/prompt.test.ts src/coder/prompt.test.ts src/progress/progress.test.ts --reporter=verbose   # packages/orchestrator
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in memory > "add the autumn range" runs the merchandiser then the copywriter on one branch, then review; each commit carries its Agent's trailer
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in memory > Review Loop fixes go back to the work Role whose changes the blocking comments concern, or to the last one when that is unclear
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in memory > reordering the work Roles on the whiteboard changes the order they run; removing one leaves it out
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in memory > a Plan whose work Roles the Owner cut down to one runs only that Role, then review
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in Postgres 18 > "add the autumn range" runs the merchandiser then the copywriter on one branch, then review; each commit carries its Agent's trailer
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in Postgres 18 > Review Loop fixes go back to the work Role whose changes the blocking comments concern, or to the last one when that is unclear
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in Postgres 18 > reordering the work Roles on the whiteboard changes the order they run; removing one leaves it out
 ✓ src/batches/work-roles.test.ts > ordered work Roles for one issue, in Postgres 18 > a Plan whose work Roles the Owner cut down to one runs only that Role, then review
 ✓ src/work/turns.test.ts > taking turns > hands the issue to each Role in order, then to review; a fix goes back to review
 ✓ src/work/turns.test.ts > taking turns > one Role goes straight to review
 ✓ src/work/turns.test.ts > taking turns > a fix goes to the one Role whose changes its comments concern, else to the last
 ✓ src/work/turns.test.ts > the turns' store > in memory keeps each issue's work Roles, whose turn it is and the files each changed
 ✓ src/work/turns.test.ts > the turns' store > in Postgres 18 keeps each issue's work Roles, whose turn it is and the files each changed
 ✓ src/manager/routing.test.ts > routing between work Roles, in memory > a Batch's Plan gives an issue its work Roles: the Model is not asked to choose, a label gives way, and a waiting choice is settled
 ✓ src/manager/routing.test.ts > routing between work Roles, in Postgres 18 > a Batch's Plan gives an issue its work Roles: the Model is not asked to choose, a label gives way, and a waiting choice is settled
 ✓ src/batches/plan.test.ts > work Roles in turn (FR-25 (1)) > keeps each issue's work Roles in order, giving it a coder of its first Role
 ✓ src/batches/plan.test.ts > work Roles in turn (FR-25 (1)) > says what is wrong with an issue's work Roles
 ✓ src/batches/plan.test.ts > work Roles in turn (FR-25 (1)) > gives none on a Floor with one work Role
 ✓ src/batches/plan.test.ts > work Roles in turn (FR-25 (1)) > the Manager's replan keeps the Owner's work Roles exactly; the rules keep them too
 ✓ src/batches/prompt.test.ts > the Plan prompt > on a Floor with several work Roles, lists them and asks for each issue's Roles in turn; with one, says nothing of Roles
 ✓ src/coder/prompt.test.ts > the coder's prompt > names the work Roles taking turns, whose turn it is, and the Handoff before, quoted; and asks for a Handoff to the next Role
 ✓ src/progress/progress.test.ts > progress comments > says which work Role the issue was handed on to (FR-25 (1))
 … (every #148 routing case, in memory and Postgres, and the files' other tests, all ✓)
 Test Files  7 passed (7)
      Tests  68 passed (68)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.4, Chromium), at `b8089b2`

```text
$ pnpm e2e --workers=4
  ✓  44 [chromium] › tests/whiteboard.spec.ts:15:1 › edit then approve a Plan on the whiteboard: the Manager replans, and work starts in the new order (16.8s)
  4 failed
    [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses
    [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens
    [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in
    [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not
  42 passed (2.1m)

   (notice-alerts: "error while loading shared libraries: libcups.so.2"; with
   libcups2 added)
$ playwright test tests/notice-alerts.spec.ts
  ✓  1 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (3.0s)
  1 passed (4.7s)
```
