# Issue #108: Designer Agent — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's commits (`42246fe` to
`25c461f`).

## What was built

- **The designer flow** (`createDesignFlow`,
  `packages/orchestrator/src/design/design.ts`; PRD FR-10, FR-18, FR-19).
  On a Floor with a designer Agent, the designer reviews a pull request's
  UI once the QA Agent has passed it:
  - **On the QA Stage's label.** ADR 0003 keeps four fixed Stages, so the
    designer works `needs-qa`, after the QA Agent, rather than at a new
    label. `stageRoles` (`pipeline/pipeline.ts`) names the Roles that work
    each stage in turn (`needs-qa`: QA, then the designer). QA's pass keeps
    the issue at `needs-qa`, lets it go, records QA's Handoff for the
    designer and queues the designer's work. On a Floor with a designer but
    no QA Agent, the reviewers' approval queues it instead.
  - **Its work names its Role.** `work_queue` gains a nullable `role`
    (migration `0058_design_reviews`). A designer's work at `needs-qa` is
    `role: designer`, and the stage's own Role is assumed otherwise. The
    Manager's dispatch (`chooseAgent`, `rebalance`, `freeAgent`), the work
    queue and the watchdog's retries and reassignments keep a designer's
    work to designers and never hand it to QA. `executeByStage` runs work
    that names a Role through that Role's flow.
  - **In a sandbox, on the pull request's branch.** It holds the issue and
    takes QA's Handoff (or the reviewers'), emitted as a `handoff` event and
    quoted in its prompt. The prompt (`designPrompt`) asks it to:
    - find the repository's style guide (a style guide or design document,
      design tokens, a theme or Tailwind configuration, the components the
      UI already uses; without one, the UI's existing look);
    - read the branch's diff, start the UI as the repository does, and
      take screenshots with Playwright of each screen the change touches,
      at 1280 px and 390 px and in each state it adds, keeping them in
      `/tmp/design-review/` and never committing them;
    - review them against the guide;
    - commit small styling fixes itself (`style`/`fix` commits) and leave
      anything larger as findings for the coder;
    - pass when the repository has no UI or the change touches none;
    - end with a `<design-review>` block (`Result: pass|changes`,
      `Summary:`, `Findings:`), read by `parseDesignReport`.
  - **Its fixes are pushed** by AI Office as the Owner's commits with its
    `Agent:` trailer (`createPushRun`). The App comments its result on the
    pull request: "**Design approved**" or "**Design changes requested**"
    by …, design round N of 3, with the fixes it made and "### Changes for
    the coder". Each round is kept in `design_reviews` and recorded as a
    `design.reported` event.
- **Findings return to the coder.** Changes go back to `needs-code` as a
  Handoff (`designChangesHandoff`: what it found, the changes to make, the
  rounds of design review left). The coder's next prompt has a "Design
  feedback to fix (after design round N of 3)" section quoting what the
  designer found and the changes. The coder's own Handoff to the reviewers
  falls back to "That the design changes the designer asked for are made".
  The fix goes through review and QA again, then the designer.
- **A pass** moves the issue on (`stageAfter`: `needs-docs` when the Floor
  has a docs Agent, otherwise `ready-to-merge`). Its Handoff
  (`designPassedHandoff`) carries what QA handed it.
- **Caps.** The designer has its own Round Cap of 3 (`designRoundCap`).
  Changes still asked for in round 3 hand the pull request to the Owner, as
  QA's cap does: `needs-human` on the issue and the pull request, and an
  action Notice "Design Round Cap reached: …" linking each round of review,
  QA and design in order (`everyRoundLinks` now takes design rounds).
- **Also:**
  - A run with no report blocks the Agent ("Agent blocked: … gave no
    design review on PR #N") and leaves the issue at `needs-qa`.
  - A designer paused at a Token Cap keeps its fixes, and its work waits.
  - An archived Floor's work stops.
  - Its report may propose repository and Role memory, as QA's does.
  - The progress comment has a "**Design:** approved / changes requested"
    line.
- **The server** runs a designer's work through the designer flow.
- **The Activity Feed** lists `design.reported` under Pull requests
  ("Dee reviewed the UI of pull request #14 for #4 (design round 2):
  changes requested.") with a link to the comment.
- **The guide.** [The issue pipeline](../guide/issue-pipeline.md#the-designer)
  has a "The designer" section, and its stage, work queue and Handoff
  lists mention the designer.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (3258 passed, 409 skipped).
- [x] **Scenario test: designer findings return to the coder.**
      `packages/orchestrator/src/design/design-loop.test.ts`, "returns its
      findings to the coder as a Handoff, then passes the fix after review
      and QA". It runs end to end through intake, the coder, both reviewers,
      QA and the designer from one work queue, with real Sandcastle `run()`
      in the fake sandbox (scripts stand in for each Agent's Claude Code)
      and a local bare repository as GitHub's remote. The designer asks for
      changes in round 1 and passes in round 2. Checked:
  - its prompt: the designer, pull request #2, design round 1 of at most
    3, the style guide, Playwright screenshots in `/tmp/design-review/`
    never committed, its own `style`/`fix` commits vs findings for the
    coder, the branch, QA's Handoff, `<design-review>`;
  - the coder ran twice, and its second prompt has "Design feedback to fix
    (after design round 1 of 3)", what the designer found, the changes to
    make, the designer's Handoff and "2 rounds of design review are left",
    and no review or QA feedback;
  - the comments: "**Design changes requested** by Dee (designer, Claude
    claude-opus-5-5) … design round 1 of 3" with "### Changes for the
    coder", then "**Design approved** … design round 2 of 3"; and the
    `design.reported` events (round 1 changes, round 2 pass) linking them;
  - the stages `needs-review → needs-qa → needs-code → needs-review →
    needs-qa → ready-to-merge`;
  - the `handoff` events QA → designer (`needs-qa`) and designer → coder
    (the only one to `needs-code`); the designer's Handoff kept for
    `ready-to-merge`;
  - the work: QA's, then the designer's (`needs-qa (designer)`), each
    round;
  - only the Merge Policy's "PR #2 awaiting your approval" Notice.

  The same file also checks:
  - **its own fix:** a `style:` commit pushed with the trailer `Agent: Dee
    (designer, Claude claude-opus-5-5)`, between the coder's and the docs
    Agent's commits; "Design fixes made: 1 commit"; the docs Agent took its
    Handoff;
  - **its Round Cap:** three rounds of changes, then `needs-human` and
    "Design Round Cap reached: PR #2 (#1) still needs design changes after
    3 rounds." linking Review/QA/Design rounds 1–3 in order;
  - **a Floor without QA:** the designer works after the reviewers, with
    their Handoff, and the prompt says "It has passed review.";
  - **no report:** the Agent is blocked and the issue stays at `needs-qa`.

  **Mutation checks** (each reverted). Each change below made the tests
  named fail:

  | Change | Tests that failed |
  | --- | --- |
  | QA never hands to a designer | 4 of the 5 scenarios (all but the Floor without QA) |
  | The coder ignores the designer's findings | the findings-return and Round Cap scenarios |
  | The designer's Round Cap one larger | the Round Cap scenario |
  | The watchdog drops a work item's Role | the watchdog's designer case |
  | Rebalancing by stage, not Role | dispatch's "moves a designer's waiting work only to a free designer, never to QA" |

  Also covered:
  - `design/report.test.ts`: the last block, multi-line parts, memory left
    out, "none" findings, results that are neither, cut parts.
  - `design/prompt.test.ts`: the asks, a Floor without QA, quoting of the
    issue and the Handoff, the Owner's instructions.
  - `design/design.test.ts`: the comment and both Handoffs.
  - `coder/prompt.test.ts`: the design feedback section, quoted.
  - `pipeline.test.ts`: `stageRoles`, `nextRoleAt`, `roleOfQueued`,
    `stageAfter` with a designer.
  - `dispatch.test.ts`: choosing, rebalancing and finding a free designer.
  - `work/queue.test.ts`: a designer's work waits for QA's to end, keeps its
    Role and goes to the designer (also in Postgres).
  - `watchdog.test.ts`: a stuck designer's review is reassigned to another
    designer, never to the free QA Agent.
  - `progress.test.ts`: the design outcome.
  - `review/store.test.ts`: designers' results, one per round, in memory
    and in Postgres.
  - The events schema: `design.reported`.
  - The Activity Feed's text and link.

### Verified on the host

- [ ] **A real designer run on a UI repository produces useful findings.**
      Not verifiable here. It needs:
  - Docker, for the sandbox image (none in this sandbox: `docker info`
    fails);
  - a real AI Account for Claude Code through the AI Gateway;
  - a browser for Playwright inside the sandbox;
  - the GitHub App and a Floor on a repository with a UI and a style
    guide (#18).

  Nothing here was faked to stand in for it. To verify on the host: add a
  designer to such a Floor in the Team card, work an issue that changes
  its UI, and check that the "Design …" comment's findings name real
  screens and the style guide.

## Not verifiable in this sandbox

- **Postgres** (Docker): migration `0058_design_reviews` applied to
  Postgres 18, and the Postgres runs of the Review Loop store, work queue
  and watchdog tests (each includes the new cases), are skipped here with
  the reason. The migration was written by `drizzle-kit generate` from
  `schema.ts`.
- **Docker sandboxes and a real agent tool:** the designer really starting
  a UI, installing Playwright's browser (the sandbox images do not ship
  one; the prompt suggests `pnpm dlx playwright install chromium`), taking
  and reading screenshots, and committing CSS.
- **Real GitHub:** the real comment and pushed commits.

## Notes, and disagreements with the canon

- **"After QA" with four fixed Stages.** FR-18's labels have no designer
  stage, and ADR 0003 fixes the Stages. So the designer works on
  `needs-qa` as the QA Stage's second Role. This uses the "several Roles
  in turn on one stage" shape that ADR 0003 describes for work Roles.
- **The designer's desk colour.** The 3D desk's Stage stripe gives the
  designer the work Stage's colour (`roleStageToken` in
  `apps/web/src/scene/desk-set.ts`), though it now works in the QA Stage.
  This is decoration, outside this issue, and left as it was.
- **"Floors with a UI"** is not detected by AI Office. A Floor has a
  designer when the Owner adds one (a new Development Floor starts without
  one, FR-10). The prompt tells the designer to pass when the repository
  has no UI or the change touches none. Floors without a UI are out of
  scope.
- **The designer's Round Cap (3) is not in the PRD.** FR-28 names QA's cap
  and an overall cap. Without a cap of its own, a designer could send work
  back without bound, because review approval and QA passes never reach
  their caps (Goal 3). Design rounds are not counted in the overall cap,
  which stays review and QA as #57 set it. The Merge Policy's gate
  (`heldBack`) and its "awaiting your approval" links do not count or show
  design rounds, and neither does the wall board.
- **The designer's own commits are not reviewed again** before the issue
  moves on, as with QA's tests and the docs Agent's commits. The Merge
  Policy then decides.
- **No Role conflict rule for the designer** (FR-30 covers QA and the
  reviewers). Reviewers rejecting a change the designer asked for go
  through the Review Loop as usual.
- **Screenshots stay in the sandbox.** AI Office has no file storage, so
  they are not shown in AI Office or attached to the comment. The
  designer's findings describe them in words.
- **`needs-qa`'s label description** still reads "waiting for QA". It also
  covers the designer's work now.
- **ADR 0003** renames `needs-code` to `needs-work`. The code still uses
  `needs-code`, as before this issue.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  277 passed (277)
      Tests  3258 passed | 409 skipped (3667)
```

The new and changed tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ |@ai-office/orchestrator| src/design/design-loop.test.ts > the designer > returns its findings to the coder as a Handoff, then passes the fix after review and QA
 ✓ |@ai-office/orchestrator| src/design/design-loop.test.ts > the designer > passes with a styling fix of its own pushed, before docs
 ✓ |@ai-office/orchestrator| src/design/design-loop.test.ts > the designer > hands the pull request to the Owner at its Round Cap
 ✓ |@ai-office/orchestrator| src/design/design-loop.test.ts > the designer > reviews the UI after the reviewers on a Floor without a QA Agent
 ✓ |@ai-office/orchestrator| src/design/design-loop.test.ts > the designer > blocks, leaving the issue at needs-qa, when it gives no review
 ✓ |@ai-office/orchestrator| src/design/report.test.ts > parseDesignReport > reads the last <design-review> block's result, summary and findings
 ✓ |@ai-office/orchestrator| src/design/report.test.ts > parseDesignReport > keeps no findings for a pass, or for none given
 ✓ |@ai-office/orchestrator| src/design/report.test.ts > parseDesignReport > finds no report without a block, or without a pass or changes
 ✓ |@ai-office/orchestrator| src/design/report.test.ts > parseDesignReport > cuts long parts
 ✓ |@ai-office/orchestrator| src/design/prompt.test.ts > designPrompt > asks for the style guide, Playwright screenshots kept out of the repository, a review against the guide, and a report
 ✓ |@ai-office/orchestrator| src/design/prompt.test.ts > designPrompt > says only the reviewers passed it on a Floor without QA
 ✓ |@ai-office/orchestrator| src/design/prompt.test.ts > designPrompt > quotes the issue and the Handoff it takes so neither can close its quote
 ✓ |@ai-office/orchestrator| src/design/design.test.ts > the designer's comment > says what it found, the fixes it made and the changes for the coder
 ✓ |@ai-office/orchestrator| src/design/design.test.ts > the designer's Handoffs > asks the coder for the changes, and says the rounds left
 ✓ |@ai-office/orchestrator| src/design/design.test.ts > the designer's Handoffs > passes on what QA handed it, or says what to check without
 ✓ |@ai-office/orchestrator| src/coder/prompt.test.ts > the coder's prompt > gives the design changes a designer asked for and its Handoff when the designer sent the work back, quoted
 ✓ |@ai-office/orchestrator| src/pipeline/pipeline.test.ts > the Roles that work each stage in turn > has QA, then a designer, at needs-qa
 ✓ |@ai-office/orchestrator| src/pipeline/pipeline.test.ts > the Roles that work each stage in turn > names the Role on queued work only when it is not the stage's first
 ✓ |@ai-office/orchestrator| src/pipeline/pipeline.test.ts > stageAfter > goes on to QA for a designer alone, and past it once QA and the designer are done
 ✓ |@ai-office/orchestrator| src/pipeline/pipeline.test.ts > stageAfter > goes on to QA, then docs, then ready-to-merge, skipping a stage the Floor has no Agent for
 ✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > a stage worked by more than one Role in turn (QA, then a designer) > gives a designer's work at needs-qa to a designer, and QA's to the QA Agent
 ✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > a stage worked by more than one Role in turn (QA, then a designer) > moves a designer's waiting work only to a free designer, never to QA
 ✓ |@ai-office/orchestrator| src/manager/dispatch.test.ts > a stage worked by more than one Role in turn (QA, then a designer) > finds a free designer for the watchdog's designer work
 ✓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in memory > a designer's work at needs-qa waits for QA's to end, keeps its Role and goes to the designer
 ↓ |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > a designer's work at needs-qa waits for QA's to end, keeps its Role and goes to the designer 0ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in memory > a stuck designer's review is reassigned to a free designer, never to the free QA Agent
 ↓ |@ai-office/orchestrator| src/manager/watchdog.test.ts > the Manager's watchdog, in Postgres 18 > a stuck designer's review is reassigned to a free designer, never to the free QA Agent 0ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/orchestrator| src/progress/progress.test.ts > progress comments > says what a designer found, and where the issue went
 ✓ |@ai-office/orchestrator| src/review/store.test.ts > the Review Loop's store > in memory keeps verdicts by round, one per reviewer, QA's and designers' results, and the latest Handoff to each stage
 ↓ |@ai-office/orchestrator| src/review/store.test.ts > the Review Loop's store > in Postgres 18 keeps verdicts by round, one per reviewer, QA's and designers' results, and the latest Handoff to each stage 2ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > covers Floor, Agent, issue, Manager decision, Batch, memory, sandbox, branch, pull request, review, QA, design review, Handoff, model call, Notice, cap, AI Account, config, Skill and sign-in events
 ✓ |@ai-office/events| src/schema.test.ts > officeEventSchema > parses a design.reported event
 ✓ |@ai-office/web| src/activity-feed.test.tsx > event text > says what a designer found in the UI, and links its comment on GitHub
```
