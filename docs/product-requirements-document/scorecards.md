# PRD: Scorecards, Sizes, Owner-only Paths and Recurring Goals

| | |
|---|---|
| **Product** | AI Office |
| **Status** | Draft |
| **Label** | `prd:scorecards` |
| **Date** | 2026-11-27 |
| **Parent PRD** | [`ai-office.md`](./ai-office.md) |
| **Glossary** | [`GLOSSARY.md`](../../GLOSSARY.md): Scorecard, Size, Owner-only Path, Recurring Goal |
| **Decisions** | [ADR 0018](../architectural-decision-record/0018-a-recurring-goals-plan-waits-for-the-owner.md) (Recurring Goals) |

## 1. Summary

Four additions that tell the Owner how the work turns out, and let them act on it:

1. **Owner-only Paths.** Paths the Owner chooses for a Floor, and a changed-lines limit, that keep a pull request from being merged automatically, whatever the Merge Policy.
2. **Scorecards.** How each Agent's, Role's and Model's work turned out: issues merged, rounds needed, failures, stalls, hand-offs to the Owner, and what each merged issue cost.
3. **Sizes.** Triage judges each issue small, medium or large, and each Agent takes only the Sizes the Owner chose for it, so cheap Models can take small work.
4. **Recurring Goals.** A Goal the Owner saves with a schedule, such as "every Monday, find modules without tests and file issues", whose Plan waits for the Owner.

They ship in that order, each useful on its own.

## 2. Problem

- **The Owner cannot tell which Model is worth its cost.** Analytics shows tokens, cost, latency and errors for each Agent and Model, but not whether their work merged, how many Review Loop rounds it took, or how often it stalled or reached the Owner. Choosing a Model for an Agent is a guess.
- **Every issue costs the same Model.** An Agent has one Model, and dispatch gives a Role's work to any free Agent of it, so a one-line fix is worked by the same frontier Model as a feature.
- **Automatic merging cannot be narrowed.** A Floor on "Merge automatically" merges anything that passes its gate, except what AI Office itself never merges (CI definitions, memory, Skills, Guidelines, Specs). The Owner cannot say "never merge changes to `src/auth/**` or migrations without me", or "not when a change is this large".
- **Recurring work needs the Owner every time.** "Find modules without tests and file issues" has to be typed again each week. A Hook cannot do it: its run is one model call with no clone, whose answer is only posted as a comment (ADR 0016).

## 3. Goals

1. The Owner can keep chosen paths, and changes over a size, from being merged automatically on a Floor.
2. The Owner can compare Agents, Roles and Models by how their work turned out and what it cost, over the same ranges as Analytics.
3. The Owner can have small issues worked by cheaper Agents, at every Stage, and see on the Scorecard whether that holds up.
4. The Owner can save a Goal that comes round on a schedule, files issues, and proposes a Plan for the Owner to approve.

## 4. Non-goals

- **Risk scores.** Owner-only Paths are plain rules on paths and line counts; no model or heuristic scores a diff.
- **A Model per task.** An Agent still uses one Model; Size chooses the Agent, not its Model.
- **Learning from the Scorecard.** Nothing changes routing, Models or Combos by itself; the Owner reads it and decides.
- **Scheduled Hooks.** Hooks stay event-driven; schedules belong to Recurring Goals.
- **Recurring Goals that start work.** A Recurring Goal's Plan never stands approved by the Goal (ADR 0018).
- **Cron expressions.** Schedules are daily or weekly at a time.

## 5. Key scenarios

1. **Auth stays the Owner's.** The Owner adds `src/auth/**` to a Floor's Owner-only Paths and sets the changed-lines limit to 500. A coder's pull request changing `src/auth/session.ts` passes review, QA and CI on a Floor that merges automatically; it is not merged, and the Notice reads "PR #12 awaiting your approval: not merged automatically, as it changes `src/auth/session.ts`, an Owner-only Path (`src/auth/**`)."
2. **Is Opus worth it?** The Owner opens Analytics, last 30 days, by Model: Opus merged 14 issues at 1.2 rounds and $0.91 an issue; Sonnet merged 21 at 1.6 rounds and $0.34 an issue, with three stalls.
3. **Small issues to Haiku.** The Owner adds a second coder on Haiku that takes only small issues, and limits the Opus coder to medium and large. Triage sizes "Fix typo in the footer" small; the Haiku coder works it. A month later the Scorecard by Size shows how both did on small issues.
4. **Weekly test gaps.** The Owner saves a Recurring Goal, "find modules without tests and file an issue for each", every Monday at 09:00, with a per-run Token Cap. On Monday the Manager adds a research Contractor, files four issues (none it filed before and still open), and proposes a Plan. The Owner gets an action Notice and approves the Plan on the whiteboard; only then does the Batch start.

## 6. Functional requirements

### 6.1 Owner-only Paths (first release)

- **FR-122 (what they are):** each Floor's Merge Policy settings hold a list of Owner-only Paths, globs matched as Guidelines' `fileMatchPattern` is (FR-102), and an optional changed-lines limit. Both are empty by default, so nothing changes until the Owner sets them. They are included in configuration export.
- **FR-123 (what they hold back):** a pull request that changes a file matching an Owner-only Path (a renamed file's old path too), or whose changed lines exceed the limit, is never merged automatically: the Merge Policy sends it to the Owner, as for the paths AI Office never merges (`owner-only.ts`). Changed lines are lines added plus lines removed, leaving out files GitHub marks as generated and well-known lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `poetry.lock` and the like).
- **FR-124 (no loosening):** no label or per-issue setting overrides them.
- **FR-125 (told):** the Notice says why: "… not merged automatically, as it changes `src/auth/session.ts`, an Owner-only Path (`src/auth/**`)", or "… as it changes 812 lines, over the Floor's limit of 500". Each pull request held back is an event in the Activity Feed, and each change to the settings a `config.changed` event.

### 6.2 Scorecards (second release)

- **FR-126 (what is recorded):** when a piece of work ends (its issue merged or closed, or handed to the Owner), AI Office records it for the Scorecard: the issue, its Floor, each Agent that worked a Stage of it (Contractors included) with its Role and the Model that actually served its requests, the outcome, the Review Loop rounds until approval, the QA rounds that failed, the stalls and failures the watchdog recorded (each charged to the Agent holding the work at the time), and the tokens and estimated cost of its Gateway requests, attributed as Analytics attributes them.
- **FR-127 (kept on its own):** these records are their own store, with their own retention rule (365 days by default) in General Settings' **Retention** card and a row in **Storage**, so the Scorecard outlives the events and Gateway requests it was built from. Cost is summed while the requests are still kept.
- **FR-128 (work Stages):** for work, QA and docs Agents, the Scorecard shows issues merged, mean Review Loop rounds until approval, QA rounds failed, stalls and failures, issues handed to the Owner, and tokens and estimated cost per merged issue.
- **FR-129 (reviewers):** for reviewers, it shows rounds reviewed and blocking comments per round.
- **FR-130 (where):** a **Scorecard** section on the Analytics page, using its range (24 hours, 7, 30 or 90 days), its widget grid, its table views, and its "by": Agent, Role, Model or Floor, and Size once Sizes ship (FR-135).
- **FR-131 (Agent cards, follow-up):** each Agent's card shows a one-line Scorecard for the last 30 days, such as "12 merged · 1.4 rounds · $0.38 an issue".

### 6.3 Sizes (third release)

- **FR-132 (judged at triage):** triage gives each issue a Size, `small`, `medium` or `large`, with its priority: from the Decision Model when it judges, in the same judgement, otherwise from the Manager's Model (`triageVerdictSchema`). A `size:<small|medium|large>` label forces it, as `role:` labels force a Role; intake creates the three labels. An issue filed from a Spec takes the Size given to its task when the Spec's tasks were written. When no model judges, AI Office's rules say `medium`. The Size is in the triage comment and its event, and kept with the triage.
- **FR-133 (which Agents take it):** each Agent, at every Stage, takes the Sizes the Owner chooses in the Agent editor, all three by default. Dispatch gives an issue's work only to Agents of its Role that take its Size; when none of the Role's Agents takes that Size, any of them may, and the triage comment says so. When those that take it are busy, the work waits for them.
- **FR-134 (Plans win):** a Batch's Plan that assigns an issue to an Agent that does not take its Size stands, as the Owner approved it, but the whiteboard flags it ("Ada takes only small issues") before approval.
- **FR-135 (measured):** the Scorecard breaks down by Size, and each record keeps the issue's Size.

### 6.4 Recurring Goals (fourth release)

- **FR-136 (what one is):** a Goal saved on a Floor with a schedule, daily or weekly on chosen days at a time, in the Office's time zone. The Floor admin's **Recurring Goals** card makes, changes, turns off and deletes them, with **Run now**; only the Owner may, as for Hooks (ADR 0016). They are included in configuration export.
- **FR-137 (a run):** the Manager works the Goal's words as a Goal from the Owner, filing issues by the path a chat request's issues take (ADR 0004), and proposes a Plan for them. The Plan is never approved by the Goal: it waits on the whiteboard, with an action Notice, until the Owner approves it (ADR 0018).
- **FR-138 (research):** a run may add at most one research Contractor, which changes nothing in the repository, and lets it go once the run has filed its issues. Each Recurring Goal has a per-run Token Cap, by default the office's per-issue Token Cap, that bounds the run's Manager calls and its Contractor.
- **FR-139 (no duplicates):** the Manager is given the open issues filed by earlier runs of the same Recurring Goal and told not to file them again; plain code refuses an issue whose title matches one of them.
- **FR-140 (skips and failures):** a run is skipped, as an event, while the previous run's Plan awaits approval or its Batch is running, or while the Manager is paused or has no Model. A failed run raises an info Notice; three failed runs in a row turn the Recurring Goal off with an action Notice, until the Owner turns it on again.
- **FR-141 (visible):** every change and every run (started, skipped, finished, failed) is an event in the Activity Feed; the card shows each Recurring Goal's last and next run.

## 7. Verification

- Unit tests for Owner-only Path matching (renames, case, depth), the changed-lines count and its exclusions, the Scorecard's aggregates, Size in the triage schema and its fallbacks, dispatch by Size, and schedule calculation.
- Orchestrator scenarios with fake GitHub: a pull request touching an Owner-only Path goes to the Owner on an automatic-merge Floor; a merged issue worked by two Agents is recorded for both, with the Model that served each; a small issue goes to the Agent that takes small issues; a Recurring Goal files issues once and its Plan waits for approval, and a second run is skipped while it waits.
- Route and component tests for the Merge Policy settings, the Agent editor's Sizes, the Scorecard widgets and the Recurring Goals card; configuration export and import round-trip the new settings.

## 8. Rollout

Each release is its own pull request, with its guide sections: Owner-only Paths in [the issue pipeline](../guide/issue-pipeline.md#the-merge-policy), the Scorecard in [the AI Gateway](../guide/ai-gateway.md#analytics), Sizes in [the issue pipeline](../guide/issue-pipeline.md#triage) and [Floors and Agents](../guide/floors-and-agents.md), and Recurring Goals in [Batches, Plans and memory](../guide/batches-and-memory.md). Schema changes ship with their migration (ADR 0017). A Floor that sets none of this behaves exactly as before.
