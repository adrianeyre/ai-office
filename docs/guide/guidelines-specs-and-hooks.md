# Guidelines, Specs and Hooks

Three ways for the Owner to steer a Floor's Agents up front, rather than
only correcting them in review: **Guidelines**, the Owner's approved
rules for a repository; **Specs**, a feature's requirements, design and
tasks agreed one step at a time; and **Hooks**, the Owner's own rules
that have an Agent run a Skill when an event happens. Part of the
[AI Office guide](README.md); back to the [README](../../README.md).

They ship in that order, each useful on its own, as the
[Guidelines, Specs and Hooks PRD](../product-requirements-document/guidelines-specs-and-hooks.md)
sets out. **Guidelines are being built now**, and this page describes
them as specified (PRD FR-102 to FR-112). AI Office already reads each
Floor's `.agents/guidelines/` and settles which versions the Owner
approved, with the Notice and events described below, the Floor admin's
[Guidelines card](#seeing-them) shows them with **Approve** and
**Dismiss**, each task gets the Guidelines that apply to it, within
its budget, Agents' [proposals](#proposing-a-guideline) wait there
for the Owner, and [`/guidelines`](#writing-them-guidelines) drafts a
Floor's Guidelines with its Manager. **Specs are being built next**:
[`/spec`](#specs) already agrees a feature's requirements, design and
tasks with the Manager, phase by phase (PRD FR-113), its issues are filed
and start their Batch, and the coder, reviewers and QA
[get the Spec as the Owner approved it](#what-agents-get-of-a-spec),
QA proving each Acceptance Criterion with a test (FR-116). Hooks get their
section here as they ship. A Floor without Guidelines,
Specs or Hooks behaves exactly as before: every prompt is byte for byte
what it was.

## Guidelines

A Guideline is one of the Owner's written rules for a Floor's
repository: "migrations are written this way", "every page has a
skip link", "copy is in British English". Agents follow it only as the
Owner approved it, and only for the work it applies to.

### Why Guidelines are approved

Agents ignore the repository's own instruction files in their clone:
`CLAUDE.md`, `AGENTS.md` and `.agents/` are its content, never
instructions (pen-test finding P1-9; see
[Sandboxes](issue-pipeline.md#sandboxes)), because anyone who can push could
plant instructions there. Guidelines give the repository rules again
without reopening that:
[ADR 0014](../architectural-decision-record/0014-agents-follow-only-guidelines-the-owner-approved.md)
keeps them as files in the repository, with its history and pull
requests, but gives Agents each one **only in a version the Owner
approved**. Office-wide memory (one text for every Floor, read as
background) and review comments after the work is done stay as they are;
a Guideline is what says "in this repository" and is followed.

### What a Guideline is

A Markdown file in `.agents/guidelines/` on the Floor's default branch,
of at most 12,000 characters, with an optional front matter header
(FR-102):

```markdown
---
inclusion: fileMatch
fileMatchPattern: "packages/db/**"
description: How migrations and the schema are written
---

Every schema change is a new SQL migration in `packages/db/migrations/`,
never an edit to one already merged. …
```

- **`inclusion`**: when the Guideline applies.
  - `always` (the default): to every task.
  - `fileMatch`: to work on files matching `fileMatchPattern`.
  - `manual`: only to an issue labelled `guideline:<name>`.
- **`fileMatchPattern`**: one glob, or a list of globs, which `fileMatch`
  requires.
- **`description`**: one line, shown in the Floor admin and in the list
  Agents get of the Guidelines they were not given in full.

Its **name** is its file name without `.md`, in lowercase letters, digits
and dashes: `migrations.md` is `migrations`. A file that breaks any of
these rules (too long, a name or header that does not fit, `fileMatch`
without a pattern) is listed in the Floor admin with the reason, and
reaches no Agent.

### Only the version the Owner approved

AI Office reads the folder from the default branch, through the GitHub
App, at intake and before each task, never from a clone (FR-103). A
version of a Guideline is **approved** when:

- the last commit that changed it reached the default branch through a
  pull request the Owner merged, on GitHub or with **Approve and merge**
  in AI Office, or was pushed by the Owner; or
- the Owner approves it in the Floor admin.

Who merged or pushed is what GitHub records, never a commit's author:
AI Office authors every commit as the Owner (ADR 0002), and anyone can
put any name in a commit. The last commit is the newest on the default
branch that changed the file, as `git log -1 -- <file>` finds it; who
merged its pull request is GitHub's record of that pull request, and who
pushed it is the default branch's activity on GitHub (its newest hundred
pushes; an older push, or one GitHub no longer keeps, waits for the
Owner's approval in the Floor admin). **Approve and merge** in AI Office
counts as the Owner's merge, as AI Office's own record of it says. The
Owner is the GitHub login in General Settings' **Intake** card, as for
intake. An automatic merge by the Merge Policy never approves a
Guideline. The GitHub App needs no more permissions for this than
**Contents** and **Pull requests**, which it has.

Any other version is **awaiting approval**:

- Agents keep the last version the Owner approved, or get nothing for a
  new file.
- The Floor admin shows the difference from the approved version, with
  **Approve** and **Dismiss**.
- The Owner gets one action Notice per Floor, such as "Guidelines changed
  on web-shop: 2 awaiting approval", until none is left. Its **Open
  Guidelines** opens the Floor admin at its
  [Guidelines card](#seeing-them) (`/floor-settings/<id>#guidelines`). When the count changes, a new
  Notice takes the old one's place; once none waits (each approved,
  dismissed or deleted), it leaves the Notice Board. One the Owner
  dismisses is not raised again until the count changes.
- A dismissed version waits no more, and stays dismissed should it come
  back; Agents keep the last approved version.

Approved versions are kept in AI Office's database
(`approved_guidelines`) with their content hash (the SHA-256 of the whole
file) and how they were approved (`owner_merge`, `owner_push` or
`owner_admin`), so a later read of the same content needs no new
approval, and a file put back as it was approved is approved again.
Versions awaiting approval or dismissed are kept beside them
(`guideline_changes`), so each is raised once, as an event and in the
Notice, however often the folder is read. A file deleted on the
default branch, by anyone, stops reaching Agents at once: a deletion gives
them nothing new to follow.

A Guideline with a line that looks like a credential is never approved:
the Floor admin names the line, never what it holds (FR-112). Nor is a
file that breaks the other rules of FR-102; for either, Agents keep the
last version of it the Owner approved.

### Which Guidelines a task gets

Each task gets the Guidelines that apply to its work (FR-105):

| Inclusion   | Work Stage and the designer                                          | Review, QA and docs                             | The Manager (triage, Plan, chat) |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------- |
| `always`    | every task                                                           | every task                                      | in full                          |
| `fileMatch` | those matching the files the Batch's Plan expects the issue to touch | those matching the pull request's changed files | by name and description          |
| `manual`    | when the issue is labelled `guideline:<name>`                        | when the issue is labelled `guideline:<name>`   | by name and description          |

In the work Stage and for the designer, the Floor's other `fileMatch`
Guidelines are there too, read-only, with a list of each one's patterns
and description: the prompt tells the Agent to read the matching one
before it changes a file the Plan did not expect. An issue no open
Batch's Plan holds (one intake took on its own), or whose Plan names no
files, matches no `fileMatch` Guideline, so its work Stage and designer
have every one of them listed instead. Intake creates a
`guideline:<name>` label for each `manual` Guideline the Owner approved
on the Floor's repository, as it does `role:<name>` labels, and one for
a `manual` Guideline approved later; the label asks for the Guideline in
any case, and one naming no approved `manual` Guideline is ignored.

- **Patterns** are globs from the top of the repository, read as Node's
  `path.matchesGlob` reads them: `*` within one folder, `**` across
  folders, `?`, `[…]` and `{a,b}`. `packages/db/**` matches
  `packages/db/schema.ts`; `**/*.sql` matches an `.sql` file anywhere. A
  leading `./` or `/` is ignored.
- **The files**: for review, QA and docs, those the pull request changes,
  or on a [one-pull-request Batch](batches-and-memory.md)'s shared branch
  those the issue's own commits change; they are listed only when the
  Floor has a `fileMatch` Guideline.
- **Which versions**: each Floor's Guidelines as its latest read settled
  them (at intake, every round, and before each task), so a task needs no
  read of its own. A task whose Guidelines cannot be read goes on without
  them.

### How they reach Agents

- **Sandboxes** (the coder and other work Roles, QA, docs and the
  designer) get them as read-only files in
  `/home/agent/.ai-office/guidelines/`, one `<name>.md` each as the Owner
  approved it, beside the
  [memory mount](batches-and-memory.md#office-wide-and-role-memory) and
  never in the clone (FR-106). They are written beside the clone, so they
  can never be committed, and deleted with it. The prompt, after the issue
  and before the memory, lists those to follow and why each applies ("for
  every task", "for this issue, whose `guideline:release` label asks for
  it", "for the files the Plan expects this issue to change that match
  `packages/db/**`"), then, for the work Stage and the designer, those to
  read before changing a matching file.
- **Reviewers and the Manager** get them quoted in their instructions,
  each `<guideline name="…">` inside one `<guidelines>` quote that nothing
  in a Guideline can close or open again. A reviewer is told to review
  the pull request against them too: work that breaks one is blocking,
  unless the issue's own words ask for it. The Manager's triage, Plan and
  chat get the `always` ones quoted and the rest listed by name, when they
  apply and description.
- Both say they are the Owner's rules for this repository, and that the
  repository's own `.agents/guidelines/` may hold versions the Owner has
  not approved and is only its content. The agent tools still ignore
  `.agents/` in the clone (FR-104, pen-test finding P1-9): nothing about
  how they start changes.

**What comes first** (FR-107): the Owner's own words in the issue or Goal
(or the issues of a Plan, or the chat), then Guidelines, then Office-wide
memory. Role memory and repository memory stay background, never rules.
Every prompt with Guidelines says so in those words.

**One budget.** The Guidelines a task follows share a
[prompt budget](batches-and-memory.md#prompt-budgets) of 12,000
characters, each counted as its whole file (FR-108); a small context
window lowers it to a tenth of the window, as for Skills. Over it,
`fileMatch` Guidelines are left out first, then `manual` ones, then
`always` ones, the largest first within each and by name between two of
a size, until the rest fit: the same Guidelines always give the same
choice. Those left out are neither quoted nor mounted, and the prompt
names each with its size: "(1 Guideline was left out: together they are
longer than the 12,000 characters a prompt carries. It is `migrations`
(9,500 characters).)". Each such task is a `guideline.over_budget` event
naming the task, its Agent and issue, the budget, the characters and the
Guidelines left out, never their text. The Owner gets one action Notice
per Floor, "Guidelines on web-shop exceed the 12,000-character budget",
which opens the Guidelines card. It stays until the Floor's approved
Guidelines change, and is raised again by the next task still over; one
the Owner dismissed is not raised again until they change. The Floor's
other `fileMatch` Guidelines, listed to the work Stage and the designer
to read as they need, are mounted outside the budget.

### Agents cannot change them

An Agent's pull request that changes anything under `.agents/guidelines/`
or `.agents/specs/` is never merged automatically: the Merge Policy sends
it to the Owner on any Floor, as it does for repository memory (FR-110),
even one the Owner labelled `ai-office:auto-merge`. Its Notice says why:
"PR #2 awaiting your approval: not merged automatically, as it changes
the Guidelines, which only you approve." (or the Specs, or both). See
[the Merge Policy](issue-pipeline.md#the-merge-policy).
An Agent may instead [propose a change](#proposing-a-guideline), which
waits for the Owner.

### Proposing a Guideline

Agents notice when a rule is missing or wrong, and may say so; only the
Owner changes a Guideline (FR-110, FR-111). The coder (every work Role),
the docs Agent and QA may end their Handoff, or QA's `<qa-report>`, with
one `<guideline name="…">` block, just before its closing marker, holding
the whole file of a new or changed Guideline, front matter and all:

```
<handoff>
Changed: Added the orders table and its migration.
Check: That the migration runs on an empty database.
Risks: None.
<guideline name="migrations">
---
inclusion: fileMatch
fileMatchPattern: "packages/db/**"
description: How migrations are written.
---

Write each migration as plain SQL, never edited once merged.
</guideline>
</handoff>
```

Agents given Guidelines are told how, in their prompt; one given none is
not, so its prompt is as it was.

- **Read by plain code, never a model.** The name is the Guideline's file
  name without `.md`; a name the Floor has no Guideline of proposes a new
  one. The block's common indentation is taken away. A block with no
  name, a name that is not lowercase letters, digits and dashes, an empty
  file, or one that breaks [a Guideline's rules](#what-a-guideline-is)
  is dropped. One with a line that looks like a credential is dropped
  whole, never kept redacted: nothing of it is kept, shown, committed or
  in the Activity Feed. With more than one block, only the last counts.
- **Kept per Floor, once.** The same version of a Guideline waits once,
  whichever Agent or issue proposed it again. Each kept proposal is a
  `guideline.proposed` event, naming the Agent, the issue, the Guideline
  and its version by hash (never its text), and whether it is new.
- **Seen by no Agent.** The block is no part of the Handoff the next
  Agent gets, nor of QA's report on the pull request. No model accepts a
  proposal, as no model accepts Role memory
  ([ADR 0005](../architectural-decision-record/0005-only-the-owner-accepts-role-memory.md)).
- **Opened as a pull request, or rejected, by the Owner** in the
  [Guidelines card](#seeing-them). **Open as pull request** has the
  GitHub App commit only that one file, `.agents/guidelines/<name>.md`,
  on a branch of its own, `ai-office/guideline-<name>-<id>`, made from
  the default branch, authored as the Owner with the proposing Agent's
  `Agent:` trailer
  ([ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md)),
  and open a pull request for the Owner to merge. It closes no issue and
  the Merge Policy never merges it. Merging it is the Owner's approval of
  that version, as for any Guideline
  ([ADR 0014](../architectural-decision-record/0014-agents-follow-only-guidelines-the-owner-approved.md)):
  until then no Agent gets it, and a merge by anyone else leaves it
  awaiting approval. A proposal the default branch already holds opens
  nothing. **Reject** turns it down.

### Writing them: `/guidelines`

`/guidelines` is a Built-in Skill that starts a
[Grilling Session](events-and-chat.md#grilling-sessions) (FR-109). It is
AI Office's own, like `/grilling`
(`packages/orchestrator/src/skills/built-in/guidelines/SKILL.md`), and,
like every Skill that starts a session, no other Skill of its name takes
its place and the Manager never runs it of its own accord.

- **Finding the conventions.** The Manager has what the repository does
  found in its read-only sandbox (the session's facts): the README and
  docs, the package manifests, the build, lint and test configuration,
  CI, the top-level folders and a few files of each kind. The clone never
  shows `.agents/`.
- **Confirming them.** Its first round puts each convention it found to
  the Owner as a question with its recommended answer ("Tests sit beside
  the code they test: is that a rule?"), and asks which areas deserve a
  `fileMatch` Guideline of their own. A convention the Owner drops is
  written nowhere.
- **Writing them.** As answers settle them, the Manager writes
  `product.md`, `tech.md` and `structure.md`, each `always`, and any
  `fileMatch` Guidelines agreed, each with its globs, one given again
  replacing the one of its name. AI Office writes each file in
  `.agents/guidelines/` on the session's branch, `ai-office/grilling-<id>`,
  with its front matter (`inclusion`, any `fileMatchPattern` and its
  `description`), and checks it as it reads every Guideline: a name or
  header that does not fit is refused before the Model's turn is kept,
  and one with a line that looks like a credential (even one AI Office
  has already redacted) is left out of the turn, the chat naming it and
  the line, never what it held. A Guideline of the Floor's own of that
  name is replaced, which the pull request shows. The session writes no
  PRD, ADRs, glossary terms or process docs.
- **Approving them.** When the Owner confirms, the GitHub App opens one
  pull request with them, listing each with its inclusion and
  description, and the Manager drafts no issues. **Merging it is the
  Owner's approval** ([ADR 0014](../architectural-decision-record/0014-agents-follow-only-guidelines-the-owner-approved.md)):
  from the next read, at intake or before a task, every Guideline in it
  is approved as merged by the Owner, and Agents follow it. A merge by
  anyone else leaves them awaiting approval.
- **The suggestion.** A Floor that has never had Guidelines (none on its
  default branch when they are read, and none ever approved or seen
  awaiting approval) gets one info Notice, "No Guidelines on web-shop
  yet: run /guidelines in the Manager chat to draft them from the
  repository". It is raised at most once per Floor, ever: the Floor is
  kept in `guideline_suggestions`, so neither later reads, a restart nor
  dismissing it brings it back.

### Seeing them

The Floor admin's **Guidelines** card (`/floor-settings/<id>#guidelines`,
FR-103, FR-111) reads the Floor's `.agents/guidelines/` afresh each time
it opens, and lists each Guideline by name:

- **When it applies**: **Always**, **File match** with its patterns, or
  **Manual** with its `guideline:<name>` label, and its description, as
  Agents get it (for one never approved, as the version awaiting approval
  says).
- **The approved version**: "Agents get version 1a2b3c4", with how the
  Owner approved it (in a pull request the Owner merged, pushed by the
  Owner, or approved here), and whether a later version on the default
  branch is waiting; or "No version approved: Agents get nothing from it."
- **A version awaiting approval**, marked **Awaiting approval**: its
  commit, and its difference from the approved version line by line
  (lines taken out with `-`, lines put in with `+`; a new Guideline is all
  put in), with **Approve** and **Dismiss**. **Approve** makes exactly the
  version shown the one Agents get. **Dismiss** leaves Agents with the
  approved one and stops counting it as waiting; a dismissed version
  stays on the card, and can still be approved.
- **An error**, marked **Invalid**: why the file on the default branch
  reaches no Agent (a name or header that does not fit, too long, or
  the line that looks like a credential, by number, never what it holds).
  Agents keep the last version approved before it broke.

- **Proposed by Agents**, below the list, while any wait: each by its
  name, marked **Change** or **New Guideline**, with the Agent and issue
  that proposed it, shown line by line against the version Agents get
  (a new one whole), with **Open as pull request** and **Reject**. Once
  opened, the card links the pull request and says no Agent gets it
  until the Owner merges it.

How many Guidelines await approval is said above the list. If the version
on the default branch changed after the card was opened, **Approve** and
**Dismiss** are refused with the reason ("has changed since: look at its
version now") and the card shows the version as it is now, so the Owner
never approves a version unseen. An archived Floor's card changes
nothing. A Floor without Guidelines says so, and how to add them.

- **API.** `GET /api/floors/:floorId/guidelines` answers
  `{"guidelines","awaitingCount"}`, a Guideline each by name:
  `{"name","path","inclusion","fileMatchPatterns","description","approved","awaiting","error"}`.
  `approved` is `{"contentHash","approval","content","current"}` or
  `null` (`approval` is `owner_merge`, `owner_push` or `owner_admin`;
  `current` says whether it is the version on the default branch);
  `awaiting` is `{"contentHash","status","content","commitSha"}` or `null`
  (`status` is `awaiting` or `dismissed`); `error` is
  `{"refusal","reason","secretLines"}` or `null` (`refusal` is
  `holds_secret` or `invalid`). `inclusion` is `null` when no version can
  be read. `POST /api/floors/:floorId/guidelines/:name/approve` and
  `POST /api/floors/:floorId/guidelines/:name/dismiss`, each with
  `{"contentHash"}` (the SHA-256 of the whole file the Owner saw, 64
  hexadecimal characters), approve or dismiss that version and answer the
  list as `GET` does. A hash that is not the version waiting (it changed
  meanwhile, was approved already, or, for dismiss, was dismissed
  already) is `409 guideline_changed`; a Guideline the default branch
  does not have is `404 guideline_not_found`; an unknown Floor is
  `404 floor_not_found`; a body without a hash is `400 invalid_request`.
  Without the GitHub App every route answers `503 github_not_configured`,
  and with GitHub out of reach `502 github_unavailable`. Each route needs
  the Owner's session.
- **Proposals API.** `GET /api/floors/:floorId/guideline-proposals`
  answers `{"proposals"}`, those waiting, oldest first, each
  `{"id","name","path","content","contentHash","agentId","agentName","issue","proposedAt"}`
  (`agentName` is `null` for an Agent no longer on the Floor).
  `POST /api/floors/:floorId/guideline-proposals/:id/open` opens one as a
  pull request and answers `{"pullRequest":{"number","url"},"proposals"}`;
  `POST /api/floors/:floorId/guideline-proposals/:id/reject` rejects one
  and answers `{"proposals"}`. A proposal the Floor does not have is
  `404 guideline_proposal_not_found`; one opened or rejected already is
  `409 guideline_proposal_settled`; one the default branch already holds
  is `409 guideline_proposal_unchanged`; an archived Floor is
  `409 floor_archived`. Opening needs GitHub, as above; listing and
  rejecting do not.

Every approval, dismissal, proposal and budget breach is an event in the
Activity Feed under **Guidelines**: `guideline.approved`,
`guideline.awaiting`, `guideline.dismissed`, `guideline.proposed` and
`guideline.over_budget`.

## Specs

A Spec is a feature's requirements, design and tasks, agreed with the
Owner one step at a time in a
[Grilling Session](events-and-chat.md#grilling-sessions), whose tasks
become the issues of one Batch. It is how a Goal becomes issues the
Owner approved first
([ADR 0015](../architectural-decision-record/0015-a-spec-is-a-grilling-session.md)).

### Writing one: `/spec`

`/spec <words>` is a Built-in Skill that starts a Grilling Session in
three phases (FR-113), such as `/spec checkout with saved cards`. It is
AI Office's own, like `/grilling`
(`packages/orchestrator/src/skills/built-in/spec/SKILL.md`), and, like
every Skill that starts a session, no other Skill of its name takes its
place and the Manager never runs it of its own accord. It is not
`/to-spec`, which still writes a PRD from the conversation so far.

The session runs the usual rounds of numbered questions with recommended
answers, and the Manager has facts found in the repository rather than
asking for them, but each phase has its document, which the Manager
drafts as the answers come and gives again, whole, whenever they change
it:

1. **Requirements** (`requirements.md`): user stories ("As a …, I want
   …, so that …"), each with its Acceptance Criteria, numbered statements
   such as `R2.3 WHEN a shopper removes a saved card THE SYSTEM SHALL stop
   offering it at checkout` (requirement 2, criterion 3). The Owner ends
   it with **"confirm requirements"**.
2. **Design** (`design.md`): its architecture, data, error handling and
   testing approach, built on the approved requirements. The Owner ends
   it with **"confirm design"**, or **"skip design"**, on any Floor, for a
   change that needs none: the Spec then has no `design.md`.
3. **Tasks** (`tasks.md`): the work in the order it should be built, each
   task naming the Acceptance Criteria it meets (by id) and the earlier
   tasks it depends on. It holds no status: progress is read from the
   issues. The Owner ends it with **"confirm tasks"** (or "confirm").

Only the Owner moves the Spec on, in those words, read by plain code; the
Manager never does. A confirmation is refused, saying why, while a
question of the phase is open, before the phase is drafted, for a
phase the Spec is not on, or, for the requirements, while any
[Acceptance Criterion fails the check](#acceptance-criteria-are-checked);
so is "skip design" outside the design.
Once nothing is left to ask, the chat says which words end the phase.

- **Each confirmation commits its document.** The draft becomes the
  phase's approved copy, kept with the session, and the GitHub App
  commits it at once, as plain code writes it from that copy, in
  `.agents/specs/<slug>/` on the session's branch,
  `ai-office/grilling-<id>`, authored as the Owner with the Manager's
  `Agent:` trailer; the chat names the file. The next phase is then
  drafted. The folder is named from the words given to `/spec`
  (`checkout-with-saved-cards`), or with the session's number after them
  when the Floor already has a Spec of that name, or `spec-<id>` with no
  words.
- **Reopening a phase.** **"reopen requirements"** or **"reopen design"**
  (or "go back to the design") returns the Spec to that phase: the
  Manager redrafts it from its last draft, every later phase is drafted
  again from nothing once it is confirmed, questions still open are
  withdrawn, and the approved copies from that phase on are dropped. The
  session's branch holds exactly the approved documents, so those
  documents leave it until they are confirmed again.
- **The approved copy is what counts.** Every later prompt of the session
  quotes the approved documents word for word, and the Manager's turns
  can change only the current phase's draft. Agents given the Spec get
  that copy, never the file as it stands in the repository.
- **The pull request and the issues.** "confirm tasks" commits
  `tasks.md`, has the GitHub App open one pull request with the Spec,
  listing each document as confirmed, skipped or not written, and ends
  the session. Each task then becomes one of the session's
  [issue drafts](events-and-chat.md#grilling-sessions), in the tasks'
  order, with no model asked: its title and description, the Acceptance
  Criteria it meets quoted from the approved requirements (or named by
  id, for one they lack), and blocked by the tasks it depends on. The
  Owner edits them as any session's drafts, and
  [files them](#filing-a-specs-issues), which starts their Batch; merging
  the pull request is the Owner's alone, as the
  [Merge Policy](issue-pipeline.md#the-merge-policy) never merges a change
  under `.agents/specs/`.
- **Ending early.** **End session** opens the pull request with whatever
  is confirmed, or none if nothing is, and drafts issues only from
  confirmed tasks.
- **Reading it.** The session, under **Read** in the Grilling Sessions
  list, shows the phase it is on and each of `requirements.md`,
  `design.md` and `tasks.md` as approved, as drafted, skipped or not yet
  drafted, in place of the PRD's outline. Its API
  (`GET /api/floors/:floorId/grilling-sessions/:id`) sends it as `spec`:
  `{"slug","phase","drafts","approved","designSkipped","confirmedAt"}`,
  null for every other session.

### Filing a Spec's issues

**"file the issues of session 7"** (or **Approve** under the session's
Issues) files a Spec's issue drafts and starts their Batch at once
(FR-115, FR-117):

- **One task, one issue.** The GitHub App files each, labelled
  `ai-office`, after the issues it is blocked by. Its body is written by
  plain code (`specIssueBody` in
  `packages/orchestrator/src/grilling/issues.ts`):
  - **Spec**: a link to `.agents/specs/<slug>/` on the session's branch,
    the Spec's pull request, and which task of `tasks.md` it is;
  - **What to build**: the task's description;
  - **Acceptance criteria**: `Meets: R2.1, R2.2`, the ids of the criteria
    it meets, then those criteria quoted as its task list
    (`- [ ] R2.1 WHEN …`);
  - **Blocked by**: the issues filed for the tasks it depends on, or
    "None: it can start at once."
- **`tasks.md` links them.** Once every issue is filed, `tasks.md` is
  committed again on the session's branch with `- **Issue:** [#12](…)`
  under each task, so the pull request shows them. It still holds no
  status: progress is read from the issues.
- **The Batch.** Its Plan follows `tasks.md`: the tasks' order, each issue
  after the issues its task depends on, the rest in parallel. AI Office's
  rules draft it, with no model asked, and share it out across the
  Floor's coders; the Kickoff and Wrap-up are as for any Batch. The tasks
  the Owner confirmed stand as the Plan's approval, recorded as the
  Owner's: `batch.approved` names the session (`specSessionId`), and the
  Activity Feed says "Approved by the tasks you confirmed in the Spec of
  Grilling Session 7". Work starts at once, whatever the Floor's plan
  approval says.
- **Drafts edited after confirming the tasks.** If the Owner changed,
  added, dropped or reordered any draft after "confirm tasks", the drafts
  are no longer what was confirmed, so the Plan follows the Floor's
  [plan approval](batches-and-memory.md) as a "complete issues …" Batch
  does: on, it waits on the whiteboard for the Owner's approval; off,
  work starts with no approval recorded. Its order is then the drafts'.
- **"… in one PR".** **"file the issues of session 7 in one PR"** starts a
  [One-pull-request Batch](batches-and-memory.md): the issues are worked
  one at a time, in the Plan's order, on one branch. It goes only with a
  Spec's issues; for another session's, file them, then say "complete
  issues … in one PR".
- **Triage asks no model.** An issue filed from a Spec is clear by
  construction, so the Manager's triage takes it as clear, at normal
  priority, by AI Office's rules: neither the Manager's Model nor the
  Decision Model is asked, and its triage comment says why.

If filing stops part-way, the issues filed are kept and the Batch waits
until "file the issues of session 7" has filed the rest. If the Batch
cannot be started, the chat says why and which "complete issues …" starts
it.

### Acceptance Criteria are checked

An Acceptance Criterion is useful to reviewers and QA only as one
testable statement they can name, so plain code checks every one before
"confirm requirements" is accepted (FR-114;
`packages/shared/src/acceptance-criteria.ts`). Each criterion:

- **starts with its id**, a capital `R`, its own requirement's number, a
  dot and a number from 1: requirement 2's criteria are `R2.1`, `R2.2`
  and on, in any order (the id may be in bold, and followed by a colon);
- **has an id no other criterion of the Spec has**;
- **is in one of four forms**, its keywords in capitals:
  `WHEN <trigger> THE SYSTEM SHALL <response>`,
  `IF <condition> THEN … SHALL <response>`,
  `WHILE <state> … SHALL <response>` or
  `WHERE <option> … SHALL <response>`, each part said;
- **says `SHALL` once**: one behaviour per criterion, so "keep the token
  and email the shopper" is two.

Prose that is not such a statement (context, notes, examples) belongs in
the user story or the introduction. While any criterion fails,
"confirm requirements" is refused with a list of **every** failing
criterion, not just the first: where it is, what it says (cut short when
long) and each reason it fails, such as

```text
- Requirement 1, criterion 3, "Saved cards are kept safe.": it has no id: start it with one, such as R1.3; it is not in a criterion's form: …
- Requirement 2, criterion 2 (R1.4), "R1.4 IF a saved card is declined THEN …": its id R1.4 is not one of requirement 2's: they are R2.1, R2.2 and on.
```

The draft stays as it was and nothing is committed. The chat says so as
soon as such a draft is complete, in place of asking the Owner to
confirm, and the Manager's next turn is given the same list to fix; the
Owner says what to change, or asks for them to be fixed. The `/spec`
instructions teach the Manager these rules from its first draft.

### What Agents get of a Spec

An issue filed from a Spec is worked and reviewed against the Spec the
Owner approved, not only its own text (FR-116;
`packages/orchestrator/src/grilling/issue-spec.ts`):

- **The coder** (every work Role) gets, after the issue, a **The Spec**
  section: which task of which Spec the issue is, its Acceptance Criteria
  (those its draft names, by id) and the Spec's `design.md`, quoted
  between `<spec>` markers nothing in them can close. It is told to meet
  every criterion and build it as the design says. A Spec whose design the
  Owner skipped says so in place of the design.
- **Reviewers** get the issue's Acceptance Criteria in their
  instructions, quoted the same way, and judge the pull request against
  each: a criterion it does not meet is blocking, with a blocking comment
  that starts with its id ("R1.2 not met: …"), and the verdict's summary
  names every one not met ("Not met: R1.2, R2.1"). They approve only when
  it meets every one. The design is the coder's; reviewers are not given
  it.
- **QA** gets the issue's Acceptance Criteria, quoted the same way after
  the issue, and proves each with a test of its own, its id in the test's
  name: **one property-based test per criterion**, with the repository's
  property-testing library, or fast-check, added as a dev dependency, in
  a TypeScript repository with none; an **example test** where a property
  does not fit the criterion, or in a repository in another language with
  no such library. Its `<qa-report>` gains a `Criteria:` part listing
  every criterion's id with pass or fail, a line each ("R1.1 pass"), and
  it passes only when every criterion passes its test
  (`packages/orchestrator/src/qa/report.ts`). Plain code reads the list:
  - a criterion listed as failed fails; one not listed, or listed with
    neither pass nor fail, has **no test, so fails** too; a failure said
    anywhere in the list outweighs a pass, and ids the issue does not
    have are ignored;
  - any criterion failed **fails the round**, whatever its `Result:`
    says, and the issue goes back to the coder, as any QA failure does,
    its Handoff naming the criteria failing their tests and those with no
    test ("Acceptance Criteria with no test: R1.2; each needs a test of
    its own that passes");
  - QA's comment on the pull request lists each criterion, "R1.1 passed",
    "R1.2 failed" or "R1.2 failed: no test reported".

  The design is the coder's; QA is not given it.
- **As approved in the session, never as the file stands.** All three come
  from the approved copy kept with the `/spec` session in AI Office's
  database: each criterion as the approved requirements word it (a
  criterion the Owner wrote in a draft, with no id the requirements have,
  as the draft has it), and `design.md` as plain code writes it from the
  approved design. AI Office never reads `.agents/specs/` to give a Spec
  to an Agent, so an edit to it on the default branch after the Owner
  approved it, or to the issue's text on GitHub, reaches no Agent; the
  prompt says the repository's own `.agents/specs/` is only its content,
  and the agent tools still ignore `.agents/` in the clone.
- **Within a budget.** What one prompt quotes of a Spec has a
  [prompt budget](batches-and-memory.md#prompt-budgets) of 12,000
  characters, a tenth of a small context window: the criteria first, each
  whole, in order, then as much of the design as is left room for, cut
  there. The prompt says what was cut: "… (the design cut here: with the
  criteria, it is longer than the 12,000 characters a prompt carries of a
  Spec)", or which criteria were left out, by id.

An issue filed from no Spec gets none of this: the coder's, the
reviewers' and QA's prompts are byte for byte as before, and QA's report
is read as before, with no `Criteria:` part.
