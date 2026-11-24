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
approved, with the Notice and events described below; Agents get them
once giving each task its Guidelines ships. Specs and Hooks get their
sections here as they ship. A Floor without Guidelines, Specs or Hooks behaves
exactly as before.

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
  Guidelines** opens the Floor's settings. When the count changes, a new
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
before it changes a file the Plan did not expect. Intake creates a
`guideline:<name>` label for each `manual` Guideline on the Floor's
repository, as it does `role:<name>` labels.

### How they reach Agents

- **Sandboxes** (the coder and other work Roles, QA, docs and the
  designer) get them as read-only files in
  `/home/agent/.ai-office/guidelines/`, beside the
  [memory mount](batches-and-memory.md#office-wide-and-role-memory) and
  never in the clone (FR-106).
- **Reviewers and the Manager** get them quoted between `<guidelines>`
  markers they cannot close.
- Both say they are the Owner's rules for this repository.

**What comes first** (FR-107): the Owner's own words in the issue or Goal,
then Guidelines, then Office-wide memory. Role memory and repository
memory stay background, never rules.

**One budget.** The Guidelines one prompt quotes share a
[prompt budget](batches-and-memory.md#prompt-budgets) of 12,000
characters (FR-108). Over it, `fileMatch` Guidelines are dropped before
`always` ones, the largest first, and the Owner gets one action Notice
per Floor, "Guidelines on web-shop exceed the 12,000-character budget",
until they fit.

### Agents cannot change them

An Agent's pull request that changes anything under `.agents/guidelines/`
or `.agents/specs/` is never merged automatically: the Merge Policy sends
it to the Owner on any Floor, as it does for repository memory (FR-110).
An Agent may instead propose a change, with up to one
`<guideline name="…">` block in its Handoff or QA report. Proposals wait
in the Floor admin for the Owner, who can open one as a pull request; no
model accepts one, as no model accepts Role memory
([ADR 0005](../architectural-decision-record/0005-only-the-owner-accepts-role-memory.md)).

### Writing them: `/guidelines`

`/guidelines` is a Built-in Skill that starts a
[Grilling Session](events-and-chat.md#grilling-sessions) (FR-109). The
Manager reads the repository in its read-only sandbox, asks the Owner to
confirm the conventions it finds, and writes `product.md`, `tech.md` and
`structure.md` (all `always`) and any `fileMatch` Guidelines agreed, in
the session's pull request. Merging it is the Owner's approval. A Floor
with no Guidelines gets one info Notice suggesting `/guidelines`, once.

### Seeing them

The Floor admin's **Guidelines** card lists each Guideline with its
inclusion, patterns and approved version, and any version awaiting
approval or error (FR-111). Every approval, dismissal, proposal and
budget breach is an event in the Activity Feed under **Guidelines**:
`guideline.approved`, `guideline.awaiting`, `guideline.dismissed`,
`guideline.proposed` and `guideline.over_budget`.
