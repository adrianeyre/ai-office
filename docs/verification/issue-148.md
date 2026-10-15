# Issue #148: Route issues between work Roles — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker). `pnpm lint`, `pnpm typecheck` and `pnpm test` ran in a fresh
`git clone` of this branch at `5e3cc4d` (every code and docs commit of the
issue), after `pnpm install --frozen-lockfile`. The Postgres and
Playwright runs were made in the working tree at the same code. The
blockers are built: Roles as data on four Stages (#145,
[`issue-145.md`](issue-145.md)), the Manager's triage (#79,
[`issue-79.md`](issue-79.md)) and its dispatch (#80,
[`issue-80.md`](issue-80.md)).

## What was built

### The model (`packages/shared`)

- **`routing.ts`** (new): `roleLabelPrefix` (`role:`), `roleLabelName`
  and **`roleLabel(role)`**, the label each work Role gets on its Floor's
  repository (`role:<name>`, `#bfdadc`, "AI Office: work this issue as
  the <name>"); **`rolesLabelled(labels, roles)`**, the Roles an issue's
  `role:` labels name (by name or id, in any case); `routeJudges`
  (`model`, `label`, `owner`); and **`routingActions`**, the four actions
  a Notice asking the Owner offers (`route_issue_to_role_1` … `_4`, one
  per candidate Role, in order), so `maxRoleCandidates` is 4: a Notice
  offers at most four actions.
- **`triage.ts`**: the Manager's answer (`triageVerdictSchema`) may add
  **`roles`** (Role ids, best first, at most 10) and **`roleReason`**.
  Both are optional, so every answer that was valid still is.

### The event (`packages/events`, `apps/web`)

**`issue.routed`** (version 1): Floor, issue, the Manager, `role` (the
Role's id), `roleName` (as it was then) and `routedBy`. The Activity
Feed lists it under Issues, as "Issue routed": "Ada gave #4 to the
copywriter Role.", with "(by its role label)" or "(the Owner's choice)".

### The database (`packages/db`): migration `0069_issue_routing`

(Written as `0047`, renumbered after main's `0044`–`0049` in
[the merge note](merge-main-into-131-to-153.md).)

`issue_triage` gains **`role`** (the work Role chosen, a library Role's
id; null until one is) and **`candidates`** (jsonb, the Roles the Owner
is asked to choose from), and its status check takes a third value,
**`routing`**: clear, but waiting for the Owner to choose its Role.
Existing rows keep `role` null and `candidates` `[]`.

### Routing (`packages/orchestrator`, `manager/triage.ts`, `triage-prompt.ts`, `triage-store.ts`)

`createTriage` takes the Role library (`roles`) and gives two more
things: `role(floorId, issue)`, the Role chosen for an issue, and
`workRoles(floor)`, the Roles of the Floor's work-Stage Agents (leaving
ones aside), in the library's order.

- **The Floor's work Roles** are read at each triage, so a team change
  applies to the next issue.
- **A `role:<name>` label** naming one of them forces it. The Manager's
  Model still triages the issue (clarity and priority), but is not asked
  to choose a Role.
- **Otherwise, with two or more work Roles**, the triage prompt gains
  "## Which Role works it": each Role as `` `id` (name): routing
  description ``, the rule to choose by what the issue asks to change,
  and to list every Role it could be when it cannot tell. Roles are
  trusted input (ADR 0003), so they are in the system prompt; the issue
  stays quoted as untrusted in the user turn. The answer's form gains
  `roles` and `roleReason`. With one work Role or none, the prompt is as
  it was, character for character.
- **Settling the Role** (`routingOf`, plain code):
  1. no work Role on the Floor: none (work goes by Stage, as before);
  2. one `role:` label: that Role (`label`);
  3. several `role:` labels: the Owner is asked between them;
  4. one work Role: that Role, silently (no comment, no event);
  5. the Model named exactly one of the Floor's work Roles: that Role
     (`model`), with its `roleReason`;
  6. otherwise (it named several, none, or only unknown ids; or AI
     Office's rules triaged the issue): the Owner is asked, between the
     Roles it named when there are two or more, else every work Role;
     at most four.
- **A clear issue with its Role** is kept `clear` with `role`, an
  `issue.routed` event is published, and the triage's comment gains a
  `### Role: <name>` section with who chose and why (the Model's reason
  as a quote; the label's sentence).
- **When the Owner is asked**, the issue waits out of the pipeline
  (intake reports it `waiting`, with nothing queued): an action Notice
  "Choose the Role to work #N <title>", linking the issue and the
  Manager, with a button per candidate ("Give it to the copywriter"); the
  record is `routing` with the candidates and the Notice; and the
  triage's comment gains "### Role: waiting for the Owner", the reason,
  each candidate with its routing description, and how to choose (the
  Notice, or a `role:<name>` label). Later checks ask nothing more while
  the issue is unchanged.
- **The Owner's choice** (each routing action's handler): the record
  becomes `clear` with that Role, an `issue.routed` event (`owner`), and
  a comment, "The Owner chose the **copywriter** Role for this issue, on
  its Notice in AI Office." A stale Notice (the record is no longer
  waiting on it) just closes.
- **A waiting issue the Owner labels** `role:<name>` goes on at the next
  check: the Notice is dismissed, and an event and a comment say the
  label chose. So does a waiting issue whose team is down to one work
  Role.
- **Edited issues** are triaged again, as before, and the earlier
  Notice (unclear or routing) is closed.
- **"Work it as it is"** (#79) on an unclear issue leaves it clear with
  no Role; the next check settles one as above, asking the Owner if
  needed (no model is asked again).
- Every comment is redacted, as triage's were.

### Dispatch by Role (`manager/dispatch.ts`, `work/queue.ts`, `manager/watchdog.ts`)

- **`inRole(agents, role)`**: the Agents of a Stage that may take an
  issue's work: those in its Role while the Floor has any in it, every
  one otherwise (a Role no Agent fills any more, or none chosen).
- **`chooseAgent`/`chooseAgentByLoad`** and **`freeAgent`** take the
  issue's `role`; **`rebalance`** takes `roleOf(issue)` and moves waiting
  work-Stage work only to a free Agent its Role may give it to (each free
  Agent takes the first such piece, in the order work starts).
- **The work queue** takes `issueRole(floorId, issue)` (the server gives
  it `triage.role`), read for work at `needs-work` only: as work is queued
  without a named Agent (intake, and the Review Loop and QA sending an
  issue back), and for the queued work `rebalance` may move.
- **The watchdog** reassigns stalled or failing work-Stage work only to a
  free Agent in its Agent's Role (dispatch gave it to that Role).
- QA, docs and review are unchanged: routing is for the work Stage only
  (FR-23, ADR 0003).

### Intake (`intake/intake.ts`)

- **Role labels**: with triage, each Floor's repository gets a
  `role:<name>` label for every work Role on its team; one is made for a
  work Role that joins the team later (checked each round, made once per
  process). A label the repository has already is left as it is.
- **`wake()`**: polls now, or straight after a round in progress; nothing
  unless started.

### Two fixes in the work queue (`work/queue.ts`, its own commit `0af5a81`)

Routing added a few awaits to the queue's search, which exposed two
latent races, each failing a test of `queue.test.ts` deterministically
once the timing moved:

- **A lost wake-up.** A `wake()` (or a finished task's) that came after
  the search's last check, but before it had ended, set `again` and was
  then dropped: nothing looked again until the 30-second poll. The search
  now looks again as it ends when asked to. ("starts waiting work by
  Floor priority, then oldest first" failed without it.)
- **Work for a removed Agent.** Work queued for an Agent removed from its
  Floor was not held (only Agents still listed were), so it could start
  for the removed Agent. It is now held, and moves to a free Agent. ("a
  coder removed mid-task finishes it, starts no more…" failed without
  it.)

Each was checked necessary: with the other fix in place, removing it
fails its test.

### `apps/server`

`startOffice` gives triage the Role library, gives the work queue
`issueRole`, and wakes intake on an `issue.routed` event with `routedBy`
`owner`, so the Owner's choice dispatches the issue at once.

### Docs

README ("Roles and Stages"); the issue pipeline guide ("Routing between
work Roles", new, and dispatch); Floors and Agents (the routing
description); the setup guide (the `role:<name>` labels, in prose: its
label table is checked against `pipelineLabels`).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `5e3cc4d` (output below):
  - without Docker, **245 files, 2817 passed, 403 skipped** (the Postgres
    tests skip with the reason);
  - against an embedded **Postgres 18.4** (below), **245 files, 3198
    passed, 22 skipped** (the GitHub contract against the real App, which
    needs `GITHUB_APP_ID`, and the checks that need Docker).
- [x] **Scenario tests with a fake Model: a product-data issue goes to
      the merchandiser and a copy issue to the copywriter;
      `role:copywriter` overrides triage; an ambiguous issue raises one
      Notice, and choosing in it dispatches.**
      `packages/orchestrator/src/manager/routing.test.ts`, each case run
      in memory and in Postgres 18. A `shop-theme` Floor's coder is
      swapped for a merchandiser ("Changes product data: prices,
      variants, stock and collections.") and a copywriter ("Writes the
      words: …"), both added to the Role library; `createFakeModel` is
      the Manager's Model; the fake GitHub, Notices, intake and the work
      queue are wired as the server wires them (`issueRole` from
      triage).
  - **"a product-data issue goes to the merchandiser, and a copy issue
    to the copywriter"**: the copy issue is filed first, so dispatch by
    load alone would give it to the merchandiser (the Floor's oldest
    work Agent) and the product data to the copywriter. The Manager
    names one Role for each; both are picked up and queued for the
    copywriter's and the merchandiser's Agents. One model call per
    issue, as the Manager, whose system prompt lists both Roles with
    their routing descriptions and asks for `roles`. Each issue's
    comment has "### Role: …", "<Manager> (the Manager) gave this issue
    to the **merchandiser** Role." and the reason quoted; two
    `issue.routed` events (`model`); no Notice; the repository has
    `role:copywriter` and `role:merchandiser`, each with its colour and
    description.
  - **"a role:copywriter label overrides the Manager's triage"**: a
    product-data issue labelled `role:copywriter`, whose Model answer
    names the merchandiser, is queued for the copywriter. The prompt
    has no Roles section; the comment says the label chose, and never
    names the merchandiser; the event is `label`; no Notice.
  - **"an ambiguous issue raises one Notice; choosing in it
    dispatches"**: the Manager names both Roles. The issue stays at
    `ai-office` only, with nothing queued and no `issue.routed` event.
    One open action Notice, "Choose the Role to work #1 Get the winter
    sale ready", linking the issue and the Manager, offering "Give it
    to the merchandiser" and "Give it to the copywriter" (the Model's
    order). The comment has the reason, both candidates with their
    descriptions, and how to choose. A second poll adds no model call,
    Notice or comment. Then, wired as the server is (intake started,
    and woken on the Owner's `issue.routed`), the Owner takes "Give it
    to the copywriter": the issue is at `needs-work`, queued for the
    copywriter, with no further poll by the test; the Notice is closed;
    one `issue.routed` event (`owner`); the last comment says the Owner
    chose; still one model call.
  - Companion cases: **"a waiting issue labelled role:<name> goes on,
    and its Notice is closed"** (the Manager names no Role, so both are
    offered; the Owner labels it `role:merchandiser`; the next poll
    queues it for the merchandiser, closes the Notice, and comments);
    **"when no model judges, AI Office's rules ask the Owner which
    Role"** (the Gateway refuses with 503: one Notice, and the comment
    says the rules do not choose between Roles).
- [x] **A Floor with one work Role never asks.** "a Floor with one work
      Role never asks" (same file, memory and Postgres): two coders (one
      work Role), three issues, the Model answering with no `roles`,
      then naming two Roles the Floor does not have, then refused (503,
      so the rules judge). All three are picked up and queued for the
      coders; no Notice; no `issue.routed` event; the prompt has no
      Roles section and no `roles` in its answer form; each issue has
      its one triage comment with no "### Role"; and the repository has
      `role:coder`. Every #79 triage scenario (`triage.test.ts`, on a
      Development Floor) passes unchanged, comments included.

Also, beyond the criteria:

- `dispatch.test.ts`, "within the work Role the Manager's triage chose"
  (4 tests): new work goes only to the issue's Role (balanced within it;
  waiting for it when its Agent is paused in the editor); by Stage when
  the Floor has no Agent in the Role; waiting work moves only to a free
  Agent of its issue's Role; the watchdog's `freeAgent` stays within the
  Role. Every earlier dispatch test passes unchanged (with no Role
  chosen, work-Stage Agents still share the work as one team).
- `triage-prompt.test.ts` (3 tests): the Roles section and answer form
  with several Roles, none with one or none, and reading `roles`.
- `intake.test.ts`, "polls at once when woken, after a round in
  progress, and not when stopped".
- `activity-feed.test.tsx`: the text of `issue.routed`.

**Negative checks.** Each sabotage was made in a copy of the file and
reverted from it afterwards. Each was run on `src/manager/routing`,
`dispatch` and `triage`, `src/work/queue` and `src/intake` of
`orchestrator`, in memory:

| Sabotage | Failed |
| --- | --- |
| The queue ignores the issue's Role (`issueRole` unread) | 3 tests: "a product-data issue…", "a role:copywriter label…", "an ambiguous issue…" |
| `role:` labels force nothing | 2 tests: "a role:copywriter label…", "a waiting issue labelled role:<name>…" |
| The first Role the Model names is taken: it never asks | 1 test: "an ambiguous issue…" |
| A Floor with one work Role asks too | 7 tests: "a Floor with one work Role never asks" and six of #79's triage scenarios |
| `rebalance` ignores the issue's Role | 1 test: "moves waiting work only to a free Agent in its issue's Role" |
| No `role:<name>` labels are made | 2 tests: "a product-data issue…", "a Floor with one work Role never asks" |
| The Owner's choice records no Role | 1 test: "an ambiguous issue…" |
| A waiting issue raises a new Notice at every check | 1 test: "an ambiguous issue…" |
| `intake.wake()` during a round is dropped | 1 test: "polls at once when woken…" |

The first sabotage first failed only two tests: with the product-data
issue filed first, dispatch by load happened to give both issues to the
right Agents. The test now files the copy issue first, and the sabotage
fails it too.

### `pnpm e2e`

The whole suite (46 tests) ran with 4 workers against the embedded
Postgres: **43 passed, 3 failed**. The three are the ones #146 and #147
recorded as failing before them (`agent-editor.spec.ts`,
`gateway-requests.spec.ts`, `manager-chat.spec.ts`), on the same lines:
they look on the Admin page for what #165 moved to AI Settings
([`issue-147.md`](issue-147.md#pnpm-e2e)). No spec covers routing: the
harness has no Model, and no Floor there has two work Roles.

### How Postgres and Chromium were run here

As for earlier issues, outside the repository:

- **Postgres**: `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
  18.4) in `/tmp/pg18`, on port 54329.
  - For `pnpm test`, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at it
    through `SCRATCH_PG_URL`, with database names unique per test file.
    It was reverted with `git checkout` after each run and never
    committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`.
- **Chromium**: from `playwright install chromium`. Its missing shared
  libraries came from Debian bookworm's packages, extracted to
  `/tmp/chromelibs`.

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`, both run against the embedded Postgres 18.4 instead; they run in
  CI.
- **A real Model.** The Manager's Model is a fake model in the
  scenarios; no live AI Provider was called (PRD §9). How well a real
  Model chooses between Roles from their routing descriptions is for
  the host.
- **Real GitHub.** The `role:<name>` labels, comments and issue labels
  went to the fake GitHub; the App creates labels with the same
  `ensureLabel` the pipeline's labels use.
- **The server's wake on the Owner's choice** is not under a test that
  runs `startOffice`: the e2e harness has no Model, and no Floor there
  has two work Roles. The routing scenario wires the same subscription
  itself, and `pnpm typecheck` covers the server's. Without it, the
  issue is picked up at intake's next check (60 seconds by default).

## Notes

- **One model call.** Routing is part of the triage the Manager already
  makes (FR-23: "the Manager's triage picks the Role"), so it costs no
  extra call and counts against the Manager's Token Caps as triage did.
  Choosing from labels, settling a one-Role Floor, and asking the Owner
  are plain code.
- **Where the Role lives.** With the issue's triage, beside its
  priority, which the queue already read the same way. The work queue
  keeps no Role of its own: it reads the issue's when work is queued and
  when it moves waiting work, so work sent back to `needs-work` by a
  review or QA goes to the same Role.
- **A Role with no Agent left** on the Floor (the Owner removed them
  after the issue was routed) does not strand the work: it goes to any
  work-Stage Agent, as with no Role chosen. An Agent paused in the Agent
  editor still holds its Role's work, as before.
- **"Cannot tell"** is the Model naming more than one Role, none, or only
  Roles the Floor does not have; and any triage the rules made, since
  rules cannot read routing descriptions. The candidates are the Roles it
  named, best first, or else every work Role, at most four (a Notice
  offers four actions). With more work Roles than that, the comment says
  a `role:<name>` label chooses any of them.
- **One Notice.** The waiting issue keeps one Notice until it is chosen,
  labelled, edited (then triaged again) or the team changes to one work
  Role. Dismissing it leaves the issue waiting, as with triage's.
- **Several `role:` labels** on one issue ask the Owner to choose between
  them: one Role works an issue here (several in order is #149).
- **The comments** are one per decision, as FR-23 asks: the triage
  comment carries the Role decision with it, and the Owner's choice or a
  label's on a waiting issue is a comment of its own.
- **Development Floors behave as before** (Phase 8's exit criterion):
  one work Role, so no Roles in the prompt, no extra comment, event or
  Notice; the only change is a `role:coder` label on the repository.

## Noticed, out of scope

- **A Batch's Plan** (#83) gives each issue to a work-Stage Agent by
  load (`plannableCoders`), not by the issue's Role; its issues are
  triaged, so one the Manager cannot place waits for the Owner's choice,
  but the Plan's Agent then works it. Plans giving issues to Roles, and
  ordered lists of work Roles on one branch, are #149.
- **A renamed Role** gets a new `role:<name>` label; the old one stays on
  the repository, and counts only if it is the Role's id.
- **A template's own labels** (`floorTemplateLabelSchema`) are not
  refused a `role:` prefix, as the pipeline's names are.
- **"Work it as it is"** (#79) still waits for intake's next check; it
  could wake intake as the Owner's Role choice now does.
- **The QA and docs Stages** dispatch by Stage only: a Floor with two QA
  Roles shares QA between them. FR-23 and ADR 0003 route the work Stage
  only.

## Output

### `pnpm lint` and `pnpm typecheck`, fresh clone at `5e3cc4d`

```text
$ pnpm install --frozen-lockfile
Done in 2.4s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
typecheck exit=0
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

### `pnpm test`, without Docker, fresh clone at `5e3cc4d`

```text
$ pnpm test --maxWorkers=4
 Test Files  245 passed (245)
      Tests  2817 passed | 403 skipped (3220)
test exit=0
```

### `pnpm test` against the embedded Postgres 18.4, at `5e3cc4d`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=4
 Test Files  245 passed (245)
      Tests  3198 passed | 22 skipped (3220)
exit=0
```

### This issue's tests (verbose), in memory and Postgres 18.4

```text
$ SCRATCH_PG_URL=… vitest run src/manager/routing.test.ts src/manager/dispatch.test.ts src/manager/triage-prompt.test.ts src/manager/triage.test.ts src/intake src/work --reporter=verbose   # packages/orchestrator
 ✓ src/manager/dispatch.test.ts > within the work Role the Manager's triage chose (FR-23) > gives new work only to an Agent in the issue's Role
 ✓ src/manager/dispatch.test.ts > within the work Role the Manager's triage chose (FR-23) > goes by Stage when the Floor no longer has an Agent in the Role
 ✓ src/manager/dispatch.test.ts > within the work Role the Manager's triage chose (FR-23) > moves waiting work only to a free Agent in its issue's Role
 ✓ src/manager/dispatch.test.ts > within the work Role the Manager's triage chose (FR-23) > reassigns stalled work only within its Role
 ✓ src/manager/triage-prompt.test.ts > choosing between work Roles (FR-23) > lists the work Roles by their routing descriptions, and asks for the Roles that could work it
 ✓ src/manager/triage-prompt.test.ts > choosing between work Roles (FR-23) > asks nothing of Roles when there is one or none to choose
 ✓ src/manager/triage-prompt.test.ts > choosing between work Roles (FR-23) > reads the Roles named, and their reason
 ✓ src/intake/intake.test.ts > issue intake > polls at once when woken, after a round in progress, and not when stopped
 ✓ src/manager/routing.test.ts > routing between work Roles, in memory > a product-data issue goes to the merchandiser, and a copy issue to the copywriter
 ✓ src/manager/routing.test.ts > routing between work Roles, in memory > a role:copywriter label overrides the Manager's triage
 ✓ src/manager/routing.test.ts > routing between work Roles, in memory > an ambiguous issue raises one Notice; choosing in it dispatches
 ✓ src/manager/routing.test.ts > routing between work Roles, in memory > a waiting issue labelled role:<name> goes on, and its Notice is closed
 ✓ src/manager/routing.test.ts > routing between work Roles, in memory > when no model judges, AI Office's rules ask the Owner which Role
 ✓ src/manager/routing.test.ts > routing between work Roles, in memory > a Floor with one work Role never asks
 ✓ src/manager/routing.test.ts > routing between work Roles, in Postgres 18 > a product-data issue goes to the merchandiser, and a copy issue to the copywriter
 ✓ src/manager/routing.test.ts > routing between work Roles, in Postgres 18 > a role:copywriter label overrides the Manager's triage
 ✓ src/manager/routing.test.ts > routing between work Roles, in Postgres 18 > an ambiguous issue raises one Notice; choosing in it dispatches
 ✓ src/manager/routing.test.ts > routing between work Roles, in Postgres 18 > a waiting issue labelled role:<name> goes on, and its Notice is closed
 ✓ src/manager/routing.test.ts > routing between work Roles, in Postgres 18 > when no model judges, AI Office's rules ask the Owner which Role
 ✓ src/manager/routing.test.ts > routing between work Roles, in Postgres 18 > a Floor with one work Role never asks
 … (the triage, queue and intake files' other tests, all ✓)
 Test Files  7 passed (7)
      Tests  113 passed (113)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.4, Chromium), at `5e3cc4d`

```text
$ pnpm e2e --workers=4
    > 70 |   await account.getByLabel("Account type").selectOption("xAI API key");
    > 82 |   await expect(storage).toBeChecked();
    > 121 |   await form.getByLabel("Name").fill("Work");
  3 failed
    [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses
    [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens
    [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in
  43 passed (2.2m)
```
