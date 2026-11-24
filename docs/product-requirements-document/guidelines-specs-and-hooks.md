# PRD: Guidelines, Specs and Hooks

| | |
|---|---|
| **Product** | AI Office |
| **Status** | Draft: Guidelines in progress; Specs and Hooks to follow |
| **Label** | `prd:guidelines-specs-and-hooks` |
| **Date** | 2026-11-24 |
| **Parent PRD** | [`ai-office.md`](./ai-office.md) |
| **Glossary** | [`GLOSSARY.md`](../../GLOSSARY.md) |
| **Decisions** | ADR 0014 (Guidelines), ADR 0015 (Specs) and ADR 0016 (Hooks), to come with each release |

## 1. Summary

Three additions that let the Owner steer a Floor's Agents up front, rather than only correcting them in review:

1. **Guidelines.** The Owner's written rules for a repository, kept in `.agents/guidelines/*.md`, each loaded always, only for the files the work touches, or only when an issue asks for it. Agents follow only the version the Owner approved.
2. **Specs.** A Grilling Session, `/spec`, that turns a Goal into requirements, then a design, then tasks, with the Owner's approval between each. Every requirement's Acceptance Criteria are numbered `WHEN … THE SYSTEM SHALL …` statements, which the issues cite, the reviewers check and QA tests one by one.
3. **Hooks.** The Owner's own rules for a Floor: when an event happens, an Agent runs a Skill.

They ship in that order, each useful on its own.

## 2. Problem

- **Agents learn the repository's conventions too late.** Today the Owner's standards reach Agents as Office-wide memory (one text for every Floor, read as background) or as review comments after the work is done. Nothing says "in this repository, migrations are written this way" and is followed as a rule, and nothing loads only the rules that matter for the files being changed.
- **The repository's own instruction files cannot be trusted.** Agents deliberately ignore `CLAUDE.md`, `AGENTS.md` and `.agents/` in the clone (pen-test finding P1-9), since anyone who can push could plant instructions there. The Owner has no safe way to give a repository rules.
- **A Goal becomes issues without a reviewed design.** A chat request is filed and worked with no requirements or design the Owner approved first, and an issue's acceptance criteria are free text that triage can only guess at, reviewers judge loosely and QA tests if it thinks of it.
- **The Owner cannot add their own automation.** The event bus drives AI Office's own steps and the Communications Agent's fixed toggles. "When a pull request touches migrations, have the reviewer run `/migration-check`" is impossible.

## 3. Goals

1. The Owner can write rules for a repository that every Agent follows, scoped to the files they apply to, without reopening P1-9.
2. A Goal can become a Spec the Owner approves in three steps, whose issues are clear, traceable to numbered criteria, and tested criterion by criterion.
3. The Owner can attach a Skill run to a chosen set of events, bounded so it can never run away.

## 4. Non-goals

- **Agents editing Guidelines, Specs or Hooks.** They may propose; only the Owner approves.
- **Hooks that run shell commands**, or Hooks stored in the repository.
- **Every event as a Hook trigger.** The list is fixed (FR-118).
- **Rewriting the PRD flow.** `/to-spec` keeps writing PRDs; `/spec` is separate.
- **Status kept in `tasks.md`.** Progress is read from the issues.

## 5. Key scenarios

1. **Rules for migrations.** The Owner merges `.agents/guidelines/migrations.md` with `inclusion: fileMatch` and `fileMatchPattern: "packages/db/**"`. A coder whose Plan touches `packages/db/schema.ts` gets it; a coder changing the web app does not, but has it listed, read-only, should it stray. The reviewer of a pull request that changes `packages/db/` gets it quoted.
2. **A collaborator edits a Guideline.** Someone with push access changes `tech.md` on the default branch. Agents keep the last version the Owner approved; the Floor admin shows the change awaiting approval with an action Notice until the Owner approves it.
3. **From Goal to Spec.** The Owner types `/spec checkout with saved cards`. The Manager grills requirements, the Owner says "confirm requirements", then the design, "confirm design", then the tasks become issue drafts. "file the issues of session 7" files them and starts a Batch in the tasks' order, already approved. QA's report lists `R1.1 pass, R1.2 pass, R2.1 fail`.
4. **A Hook.** The Owner adds a Hook: on a pull request opened that touches `**/*.sql`, any reviewer runs `/migration-check`. It runs once per pull request, at most 12 times an hour, and turns itself off after three failures in a row.

## 6. Functional requirements

### 6.1 Guidelines (first release)

- **FR-102 (what a Guideline is):** a Markdown file in `.agents/guidelines/` on the Floor's default branch, at most 12,000 characters, with an optional front matter header:
  - `inclusion: always` (the default), `fileMatch` or `manual`;
  - `fileMatchPattern`: one glob or a list of globs, required for `fileMatch`;
  - `description`: one line, shown in the Floor admin and in the list Agents get.

  Its name is its file name without `.md`, lowercase letters, digits and dashes. A file that breaks these rules is listed in the Floor admin with the reason and reaches no Agent.
- **FR-103 (only the version the Owner approved):** Agents get a Guideline only as the Owner approved it (ADR 0014). AI Office reads the folder from the default branch, through the GitHub App, at intake and before each task. A version is approved when:
  - the last commit that changed it reached the default branch through a pull request the Owner merged, or was pushed by the Owner; or
  - the Owner approves it in the Floor admin.

  Any other version is **awaiting approval**: Agents keep the last approved version (or none, for a new file), the Floor admin shows the difference with **Approve** and **Dismiss**, and the Owner gets one action Notice per Floor, "Guidelines changed on web-shop: 2 awaiting approval". A file deleted on the default branch by anyone stops reaching Agents at once. Approved versions are kept in AI Office's database with their content hash, so a later read with the same hash needs no new approval.
- **FR-104 (the clone stays hidden):** the P1-9 rule is unchanged. Agent tools still ignore `.agents/` in the clone; Agents see Guidelines only as AI Office gives them.
- **FR-105 (which Guidelines a task gets):**
  - `always`: every task.
  - `fileMatch`, for the work Stage and the designer: the Guidelines whose patterns match the files the Batch's Plan expects the issue to touch. The rest of the Floor's `fileMatch` Guidelines are mounted too, with a list of each one's patterns and description, which the prompt tells the Agent to read before changing a matching file.
  - `fileMatch`, for review, QA and docs: those matching the pull request's changed files.
  - `manual`: when the issue carries a `guideline:<name>` label. Intake creates one such label per `manual` Guideline on the Floor's repository, as it does `role:<name>` labels.
  - The Manager's triage, Plan and chat get the `always` Guidelines and the names and descriptions of the rest.
- **FR-106 (how they reach Agents):** coder, QA, docs and designer sandboxes get them as read-only files in `/home/agent/.ai-office/guidelines/`, beside the memory mount and never in the clone. Reviewers and the Manager get them quoted between `<guidelines>` markers they cannot close. Both say they are the Owner's rules for this repository.
- **FR-107 (precedence):** the Owner's own words in the issue or Goal come first, then Guidelines, then Office-wide memory. Role memory and repository memory stay background, never rules.
- **FR-108 (budget):** the Guidelines one prompt quotes share one budget of 12,000 characters, inside `promptBudgetFor`. Over it, `fileMatch` Guidelines are dropped before `always` ones, the largest first, and the Owner gets one action Notice per Floor, "Guidelines on web-shop exceed the 12,000-character budget", until they fit.
- **FR-109 (`/guidelines`):** a Built-in Skill that starts a Grilling Session. The Manager reads the repository in its read-only sandbox, asks the Owner to confirm the conventions it finds, and writes `product.md`, `tech.md` and `structure.md` (all `always`) and any `fileMatch` Guidelines agreed, in the session's pull request. Merging it is the Owner's approval. A Floor with no Guidelines gets one info Notice suggesting `/guidelines`, once.
- **FR-110 (Agents cannot change them):** an Agent's pull request that changes anything under `.agents/guidelines/` or `.agents/specs/` is never merged automatically: the Merge Policy sends it to the Owner on any Floor, as for repository memory (P1-3). Agents may propose a change with up to one `<guideline name="…">` block in a Handoff or QA report; proposals wait in the Floor admin for the Owner, who can open them as a pull request. No model accepts one.
- **FR-111 (visible):** the Floor admin's **Guidelines** card lists each Guideline with its inclusion, patterns, approved version, and any awaiting version or error. Every approval, dismissal, proposal and budget breach is an event in the Activity Feed under **Guidelines**: `guideline.approved`, `guideline.awaiting`, `guideline.dismissed`, `guideline.proposed`, `guideline.over_budget`.
- **FR-112 (never a credential):** a Guideline with a line that looks like a credential (`looksLikeSecret`) is not approved: the Floor admin names the line, never what it holds.

### 6.2 Specs (second release)

- **FR-113 (`/spec`):** a Built-in Skill that starts a Grilling Session in three phases, writing to `.agents/specs/<slug>/`:
  1. `requirements.md`: user stories, each with Acceptance Criteria. The Owner says "confirm requirements".
  2. `design.md`: architecture, data, error handling and testing approach. The Owner says "confirm design", or "skip design" on any Floor.
  3. `tasks.md`: ordered tasks, each naming the criteria it meets and the tasks it depends on. They become the session's issue drafts.

  Each confirmation commits its document to the session's branch. The Owner may reopen an earlier phase; later phases are then drafted again.
- **FR-114 (Acceptance Criteria):** each is `WHEN <trigger> THE SYSTEM SHALL <response>`, or its `IF … THEN`, `WHILE` or `WHERE` forms, with an id such as `R2.3` (requirement 2, criterion 3). Plain code checks every criterion's form and the ids' uniqueness before "confirm requirements" is accepted, and names each one that fails.
- **FR-115 (issues from tasks):** one task is one issue. Its body links the Spec, lists `Meets: R2.3, R4.1`, quotes those criteria as its task list, and says what it is blocked by. Triage takes an issue filed from a Spec as clear without asking a model. "file the issues of session N" starts a Batch whose Plan follows `tasks.md`'s order and dependencies and is approved already, unless the Owner edited the drafts after confirming the tasks. "… in one PR" starts a One-pull-request Batch.
- **FR-116 (what Agents get):** the coder gets the issue's criteria and the approved `design.md`; reviewers judge the pull request against the criteria; QA writes one property-based test per criterion where the repository has a property-testing library (fast-check in a TypeScript repository without one), or an example test otherwise, and its `<qa-report>` lists every criterion id as passed or failed. A criterion without a test fails. Agents get the Spec as approved in the session, never the file as it stands.
- **FR-117 (keeping it current):** `tasks.md` links each task's issue and holds no status. A Wrap-up that finds the code departing from `design.md` says so in its report, and `/spec amend <slug>` starts a session with the Spec loaded.

### 6.3 Hooks (third release)

- **FR-118 (triggers):** an issue moving to a Stage; a pull request opened; a push to the default branch touching files matching a pattern; a Batch's Wrap-up; a Spec's issues filed; and **Run now**. Each may be narrowed by label or file pattern.
- **FR-119 (action):** a named Agent, or any Agent in a named Role, runs one Skill of the Floor's Skill library, given the event's details as untrusted data. The run counts against that Agent's Token Caps. A Hook never fires on an event its own run caused. No shell commands.
- **FR-120 (limits):** at most 12 runs an hour per Hook by default (settable per Hook), never two at once on the same issue or pull request; a failed run raises an info Notice, and three failures in a row turn the Hook off with an action Notice.
- **FR-121 (where):** the Floor admin's **Hooks** card, stored in the database, made and changed only by the Owner, included in configuration export; every run and change is an event in the Activity Feed.

## 7. Verification

- Unit tests for front matter parsing, glob matching, approval detection, the budget and the Acceptance Criteria checker.
- Orchestrator scenarios with fake GitHub: a Guideline changed by someone else is not given to Agents until approved; a Spec's issues start an approved Batch; a Hook rate-limits and switches itself off.
- End to end: the Guidelines card's Approve flow.

## 8. Rollout

Each release is its own pull request with its ADR, glossary terms and guide section in `docs/guide/guidelines-specs-and-hooks.md`. A Floor without `.agents/guidelines/`, Specs or Hooks behaves exactly as before.
