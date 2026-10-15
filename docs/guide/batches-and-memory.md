# Batches, Plans and memory

Batches and Plans on the whiteboard, and repository, office-wide and Role memory. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## Batches and Plans

"complete issues 1 to 5" in the [Manager chat](events-and-chat.md#the-manager-chat) hands
the Floor's Manager a **Batch** (PRD FR-25, §5 scenario 1;
`createBatches` in `@ai-office/orchestrator`). The Manager reads the
issues and drafts the Batch's **Plan**, which is kept, versioned, and
shown in the chat's answer.

- **Which issues.** Each issue named is read with the Manager's own
  GitHub client. Only the Owner's issues go in (opened by the Owner, or
  labelled `ai-office` by them, as for intake), and those the GitHub App
  filed as the Owner approved them in a Grilling Session (FR-81; see
  [Grilling Sessions](events-and-chat.md#grilling-sessions)), which
  intake leaves alone. An issue that is closed,
  not found, already in the pipeline or waiting in another open Batch is
  left out, and the Plan says why. With none left, no Batch is made.
- **The Manager's Model drafts the Plan**, through the AI Gateway with
  the Manager's own Gateway Key (so it counts against its Token Caps). Its
  prompt names the Floor's coders and the work each has, and quotes each
  issue as untrusted text, redacted first. Its answer must be one JSON
  object (`planDraftSchema` in `@ai-office/shared`): a `summary`, and every
  issue once, in the order to work them, each with the issues it
  `dependsOn` (only ones before it), the `files` it is likely to change, the
  coder (`agent`) to work it or null, and a `note`. On a Floor with
  several work Roles it may also give an issue its `roles`, in turn
  ([below](#several-work-roles-on-one-issue)). An answer that is not
  one, or does not fit the Batch, is sent back once, saying what is wrong.
- **Plain code completes it** (`planFromDraft`):
  - two issues likely to change the same file are an **overlap**, and run
    one after another: the later depends on the earlier;
  - an issue given to no coder goes to the one with the least work, queued,
    running or given out by the Plan, as dispatch chooses
    ([above](issue-pipeline.md#the-work-queue));
  - issues with no dependency between them form **parallel groups**: each
    group runs once every issue it depends on is done.
- **AI Office's rules plan** when the Manager is paused or has no Model,
  the Gateway refuses the call, or the Model answers twice with no Plan:
  the issues in the order named, all at once, shared out across the
  coders (`planByRules`). The Plan says so, and why.
- **Kept and versioned.** A Batch is a row in `batches` (the issues in the
  order named, its status and its Manager); each version of its Plan is a
  row in `plans` (version 1 is the Manager's draft): who drafted it, its
  summary, its issues in order with their titles, dependencies, likely
  files, coders and notes, its overlaps, its parallel groups and the
  issues left out. `batch.planned` records each version in the Activity
  Feed.
- **Plan approval on** (a new Floor's default): the Batch awaits approval,
  and nothing starts until the Owner approves its Plan on the Floor's
  [whiteboard](#the-whiteboard-approving-editing-and-replanning-a-plan),
  editing it there first if they like. Then its work starts as below.
- **Plan approval off:** work starts at once. Each issue whose
  dependencies are done (closed, as a merged pull request closes them)
  goes through the Manager's [triage](issue-pipeline.md#triage) into the pipeline at
  `needs-work`, queued for the coder its Plan gives it to. The rest wait in
  the Batch, which checks every minute and starts each as its
  dependencies close, so its branch starts from their merged work. The
  start is a `batch.started` event and an info Notice, "Batch started on
  web-shop: 5 issues, work started on #1, #3 and #5", linking the chat and
  the issues. Which issues have started is kept in `batch_issues`, so none
  starts twice, across restarts too.
- **Overlapping issues run one after another** (FR-25.5): the later
  starts only once the earlier is closed by its merged pull request, from
  a default branch that has its work, and before review every branch is
  [rebased onto the work merged meanwhile](issue-pipeline.md#from-issue-to-pull-request).
- **API.** `GET /api/floors/:floorId/batches` lists a Floor's Batches,
  newest first, each with its latest Plan and the issues started; `GET
  /api/floors/:floorId/batches/:batchId` gives one with every version of
  its Plan (`404 batch_not_found` otherwise).

### Batches from the Manager chat

A request the Owner makes in the Manager chat, such as "add a status to
orders and show it on the orders page", is a Batch too (PRD FR-24, FR-25;
[ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md)).
The Manager files its issues and hands them over with the Plan it settled
in the chat ([how](events-and-chat.md#requests-batches-and-contractors)).

- **Its issues are the Owner's.** The GitHub App opened them, so intake
  leaves them alone, but the Batch takes them as the Owner's, as it does a
  Grilling Session's: they enter work only through their Batch.
- **Its Plan** is the chat's, by issue number: order, dependencies, likely
  files, work Roles and, for an issue in a one-off Role, its Contractor.
  Plain code checks and completes it as any draft (`planFromDraft`); if it
  does not hold, the Manager drafts one as usual. Only a chat request's
  Batch plans with the Contractors in one-off Roles: a Batch handed over
  by "complete issues …" never gives them work.
- **It starts at once**, whatever the Floor's plan approval: the request
  stands as the Plan's approval, once a check that read only the Owner's
  own words and the Plan has found the Plan does what the Owner asked and
  nothing else (P2-3,
  [how](events-and-chat.md#requests-batches-and-contractors)); without
  that, nothing is filed; nor when it names a file only the Owner may ask
  for and the Owner did not (ADR 0009). Its pull requests always go to
  the Owner to merge, whatever the Floor's Merge Policy, unless the Owner
  adds `ai-office:auto-merge` to an issue themselves. The Plan is still on the whiteboard, and
  the Kickoff and Wrap-up are held as for any Batch; its Contractors
  acknowledge the Plan with the rest.
- **Several at once.** Each request is its own Batch (`chat_message_id` on
  `batches` names the Owner's message), running alongside the Floor's
  other Batches, with its own Plan and Wrap-up. "pause", "skip 4" and
  "move 5 up" work on it as on any other.
- **When it finishes**, the Manager posts its Wrap-up's summary in the
  chat, and its Contractors leave once idle
  ([Contractors](floors-and-agents.md#contractors)).

### Several work Roles on one issue

On a Floor with more than one work Role, such as an Online store's
merchandiser and copywriter, a Plan may give an issue an **ordered list
of work Roles**, which take turns on its one branch before review (PRD
FR-25 (1), §5 scenario 11;
[ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md);
`work/turns.ts` in `@ai-office/orchestrator`). "Add the autumn range" can
go to the merchandiser for the product data, then to the copywriter for
its words.

- **The Manager drafts them.** Its Plan prompt lists the Floor's work
  Roles with their routing descriptions and the coders in each, and asks
  for each issue's `roles` by name, in the order they take turns: one by
  default, several only when the issue needs each one's own work. Plain
  code checks them: each one of the Floor's work Roles, once (at most
  five), and the issue's coder one of its first Role's (a coder is
  chosen there by load when the Plan names none). An issue given no Roles
  gets its one Role from the Manager's [triage](issue-pipeline.md#routing-between-work-roles)
  as it starts, as before. AI Office's rules give none. A Floor with one
  work Role never has them: its prompt says nothing of Roles.
- **Kept in the Plan.** Each issue of a Plan keeps its Roles' ids,
  `roles` in `plans.items`; the chat's answer says "Mia (merchandiser,
  then copywriter)" and the whiteboard "Work Roles, in turn: merchandiser,
  then copywriter".
- **Starting the issue.** Its Roles settle its triage's routing, ahead of
  any `role:` label, without asking the Manager's Model to choose or the
  Owner with a Notice (a choice the Owner was asked for meanwhile is
  settled, and its Notice closed). The triage's comment says "### Role:
  merchandiser, then copywriter", and `issue.routed` records the first,
  "(by its Batch's Plan)". The turns are kept in `issue_work_turns`: the
  Roles, whose turn it is, and the files each Role's commits changed.
- **Taking turns.** The work queue gives the issue's `needs-work` work to
  an Agent in the Role whose turn it is. When that Role is not the last,
  its Agent's commits are pushed to the branch (each with that Agent's
  own `Agent:` trailer), its Handoff is kept, the issue is let go at
  `needs-work`, and its work is queued again, for the next Role. That
  Agent's prompt names every Role in order, says whose turn it is, and
  quotes the Handoff before it as untrusted; the Handoff is a `handoff`
  event as it starts, which is the ticket's walk between their desks. The
  issue's progress comment says it was "Handed on". Only after the last
  Role is the branch rebased, the pull request opened and review queued.
- **Review Loop fixes** go back to the work Role whose changes the
  blocking comments concern: the one Role whose commits changed every
  file they are on. When that is unclear (they are on files several
  Roles changed, or none did), the fix goes to the last Role. A fix goes
  straight back to review; anything else that sends the issue back, such
  as QA, goes to the last Role.

Parallel work Roles on one issue are out of scope: the Roles always take
turns.

### One pull request for a Batch

"complete issues 1 to 10 in one PR" (or "in one pull request", "as one
PR", "in a single PR") hands the Manager a Batch whose issues all go in
**one pull request** (PRD FR-25a;
[ADR 0010](../architectural-decision-record/0010-a-batch-may-ship-as-one-pull-request.md);
`batches/one-pull-request.ts` in `@ai-office/orchestrator`). Without it,
each issue has its own pull request, as before.

- **Kept on the Batch.** `one_pull_request` on `batches` (false by
  default) says so; the API's Batch has `onePullRequest`, the whiteboard
  shows "One pull request" with the branch's name, and the Plan in the
  chat says so.
- **One at a time, in the Plan's order.** The Plan's parallel groups are
  one issue each. An issue starts once every issue before it in the Plan
  is `ready-to-merge` (or closed), rather than once its dependencies are
  closed: nothing of the Batch merges until all of it does. The chat's
  answer says "#3 starts once #1 and #2 are ready to merge."
- **One branch.** Every issue is worked on `ai-office/batch-<id>`, each
  building on the commits of the issue before it. As an issue starts, the
  branch's head is kept as its base (`base_sha` on `batch_issues`; none
  for the first): the issue's own work is what comes after it. The
  branch is not rebased before review, so the commits earlier issues'
  reviewers approved stay as they were.
- **Every Stage, for every issue.** Each issue still has its own labels,
  Review Loop, QA, docs and design review. Each Stage's prompt says the
  branch is the Batch's and where this issue's work begins; the
  reviewers are shown only the issue's own diff (from its base), and the
  docs Agent and designer read `git diff <base>...HEAD`. Review comments
  go on the pull request's own diff.
- **One pull request**, opened as the first issue goes to review and
  written again (title and body) each time an issue goes to review and
  when the Merge Policy considers it. Its title is "Batch 7: #1, #2 and
  #3" (or "Batch 7: 10 issues, #1 to #10"). Its body follows the `pr`
  Skill's shape: a **Summary** with a tree of the Batch's issues and where
  each is, a sketch of the files it changes (`+` added, `-` removed) and
  `Closes #N` for each issue that has joined it; **Evidence**, before and
  after, for each issue (its review round and verdict, QA's result and its
  stage); and the **Merge Danger**: a two-way door (one-way when it
  changes database migrations) and its blast radius (small, moderate or
  wide, by the files it changes), saying when it goes to the Owner
  whatever the Merge Policy. Each issue's joining is a
  `pull_request.opened` event, so the Wrap-up links the pull request for
  each, once.
- **Merged together.** The Merge Policy waits until every issue still
  open is `ready-to-merge`: until then each issue that gets there simply
  waits. An issue at `needs-human` holds the whole pull request, and an
  action Notice says "Batch 7's pull request is held: #4 is handed to
  you, and its issues merge together." Once all are ready, the gate asks
  of each issue what it asks of one: its required reviewers approved its
  own work as it stood when the next issue began (or the head), no
  blocking comments remain, and no cap was exceeded. An issue whose
  reviewers approved before commits were pushed on it goes back to them,
  as for one pull request. Any issue's `ai-office:manual`, or a chat
  request's issue, sends it to the Owner; "Approve and merge" merges only
  while every issue is still ready. The merge is a `pull_request.merged`
  event for each issue, and GitHub closes them all.
- **"skip" and "move"** change only the issues still to start, as for any
  Batch; an issue that has started stays in the pull request, and
  skipping it is refused. A skipped issue never joins the pull request.

A one-pull-request Batch's branch is one lane on the
[Branches page](events-and-chat.md#the-branches-page), drawn heavier than an
issue's, naming the issue at work on it now and where each of its issues
stands.

### Changing a Batch mid-way: "skip" and "move"

In the [Manager chat](events-and-chat.md#the-manager-chat), "skip 4" (or "skip 4 and 6")
and "move 5 up" (or "down") change the Floor's open Batch whose latest
Plan holds the issues (PRD FR-24, FR-25.4; `change` in `createBatches`).
The answer names the new version and lists the Plan, marking the issues
started.

- **Before approval** they are edits like the whiteboard's
  ([below](#the-whiteboard-approving-editing-and-replanning-a-plan)): the
  Manager replans, and a skipped issue is left out ("you skipped it").
  Work still starts only once the Plan is approved.
- **Once work is under way**, AI Office's rules replan the Batch as the
  next version (`replanMidBatch`), **without restarting finished work**:
  - the issues whose work has started come first, exactly as they were
    (coder, likely files, note, dependencies), and their work carries on
    untouched: nothing is queued, triaged or started again;
  - only the issues still to start are skipped or reordered: "move 5 up"
    swaps #5 with the issue still to start before it;
  - they keep their likely files, coders (while still the Floor's enabled
    coders) and notes, and the dependencies still before them; overlaps
    are sequenced again in the new order, so an issue moved above one it
    shares a file with now runs first, and the other waits for it. An
    issue that has started is never given something new to wait for;
  - a skipped issue is left out ("you skipped it while the Batch was
    under way"), so the Batch no longer holds it and it never starts;
  - whatever the new version lets start starts at once, through triage.

  It is a `batch.planned` event with `editedFrom`. The Manager's Model is
  not asked: the Owner's command says what changes, and the rest is the
  Plan's own rules.
- **Refused, changing nothing:** skipping or moving an issue whose work
  has started ("#3's work has started, so it is not skipped: work that
  has started carries on"), moving the first issue still to start up (or
  the last down), skipping every issue of a Plan, an issue in none of the
  Floor's open Batches, or issues in different Batches at once.
- A change, an edit, an approval and the minute's check never overlap on
  one Batch, so nothing starts twice.

### The whiteboard: approving, editing and replanning a Plan

Each Floor's **whiteboard** (PRD FR-25 (3), FR-58; §5 scenario 1) shows
its Batches' Plans, current and past, at `/floors/<floor>/whiteboard`
(linked from Floor Settings), and in the meeting room of the 3D Office
(`/?floor=<floor>&inspect=whiteboard:<floor>`), which opens the same
panel (`Whiteboard` in `apps/web/src/whiteboard.tsx`).

- **What it shows.** It opens on the Batch awaiting approval (or the
  newest; `?batch=<id>` names one), and lists every Batch of the Floor to
  pick from. A Batch's Plan is shown issue by issue, in order: its title
  (linking the issue on GitHub), its work Roles in turn (if the Plan
  gives it any), its coder (linking the Agent), what it runs after, its
  likely files, the Manager's note and the Owner's, then
  the parallel groups, the overlaps and what was left out, and which
  issues have started. **Version** goes back through every earlier
  version, each saying how it came to be ("drafted", or "replanned after
  your edits to version 1", and whether by AI Office's rules). It
  changes live, on `batch.*` events.
- **A Grilling Session.** While one runs, the whiteboard shows it above
  the Plans: its live outline, the decisions settled so far and where its
  documents are kept (PRD FR-80; see
  [Grilling Sessions](events-and-chat.md#grilling-sessions)).
- **"Plan awaiting approval".** A Batch made with plan approval on raises
  an action Notice, "Plan awaiting approval on web-shop: Batch 3, 5
  issues", linking its issues; its **Open Plan** opens the whiteboard on
  that Batch (FR-49). It closes, as acted on, once the Plan is approved.
- **Editing.** While the Plan awaits approval, its latest version can be
  edited: **Move up** and **Move down** reorder its issues, **Drop**
  takes one out of the Batch (**Keep** puts it back), and **Your note on
  #N** annotates one (up to 500 characters). An issue given several
  [work Roles](#several-work-roles-on-one-issue) lists them in turn, and
  **Move the merchandiser up/down on #N** reorders them while **Remove the
  merchandiser on #N** takes one out (**Keep** puts it back; the last
  cannot be removed). **Save edits and replan** sends them; **Undo
  edits** goes back. A Plan cannot drop every issue, and must be saved or
  undone before it is approved.
- **The Manager replans** (`edit` in `createBatches`): its Model, through
  the AI Gateway as for the first draft, is told the version edited, the
  Owner's order (which it must keep exactly), what that version said of
  each issue, the Owner's notes and the issues dropped, and quotes the
  issues kept, read again from GitHub. Its answer is checked as a draft is,
  and must keep the Owner's order, and each issue's work Roles as the
  Owner left them, or it is sent back once (`replanFromDraft`). When the
  Model cannot be asked, or answers twice with no Plan, AI Office's rules
  replan (`replanByRules`): the Owner's order, each issue keeping its
  likely files, its work Roles as the Owner left them, its coder (while
  still one of the Floor's enabled coders, in its first work Role) and
  note, and the dependencies that still come before it. Either way, issues that share a likely file are
  sequenced again in the new order. The replan is the next version
  (`plans.edited_from` names the version edited), with the Owner's notes
  (redacted) on its issues, and the dropped issues in what it leaves out
  ("you dropped it from the Plan"), so they leave the Batch and intake
  may take them again. `batch.planned` records it, with `editedFrom`.
- **Approving** starts the work as the latest version says, in its order:
  each issue whose dependencies are done goes through triage into the
  pipeline, queued for its coder, and the rest wait, as with plan approval
  off. An issue's work Roles take their turns in the order approved. It is a `batch.approved` event, then `batch.started` and the
  "Batch started" Notice.
- **Versions.** Edits and approvals name the version they were made on.
  One made on a version that is no longer the latest is refused (`409
  plan_changed`), so a Plan is never approved unseen; one on a Batch
  already approved is `409 batch_not_awaiting_approval`. One Batch's edits
  and approvals are made one at a time.
- **API.** `POST /api/floors/:floorId/batches/:batchId/plan` with
  `{"version","items":[{"issue","annotation","roles"}]}` (the issues to
  keep, in the new order; `annotation` empty for none; `roles`, optional,
  the issue's work Roles' ids to keep, in their new order) keeps the
  Owner's edits and answers `201` with the Batch and every version, once
  the Manager has replanned; an issue not in the Plan, one named twice,
  work Roles the issue's Plan does not give it (or one twice), or an edit
  that changes nothing is `400 invalid_plan_edit`, and removing every
  work Role is `400 invalid_request`. `POST
  /api/floors/:floorId/batches/:batchId/approve` with `{"version"}`
  approves it, answering the same. Without the GitHub App, both answer
  `503 github_not_configured`.

### The Kickoff

Once the Manager has drafted a Batch's Plan, it holds the **Kickoff**
(PRD FR-25 (2), FR-60): the Plan is presented in the meeting room, and
each Agent it assigns acknowledges it **once**, with "OK" or one concern.
Agents do not converse.

- **Who acknowledges:** each coder the Plan gives an issue to, in the
  Plan's order, one after another (`kickoff` in `createBatches`). The
  Manager presents; it does not acknowledge.
- **Through its own Model.** Each is asked once, alone, through the AI
  Gateway with its own Gateway Key (so the call is counted against its
  Token Caps), given the Plan: its summary and each issue's number,
  title (quoted as data: issue titles are untrusted), coder, dependencies,
  likely files and the Manager's note. Never an issue's body. It must
  answer exactly `OK`, or `CONCERN:` and one sentence (`kickoffPrompt` in
  `batches/kickoff.ts`).
- **Read in plain code** (`parseAcknowledgement`): "OK" (any case, with or
  without a full stop) is OK; anything else is one concern, its first line
  on one line, without its `CONCERN:` label, cut to 300 characters and
  redacted.
- **AI Office's rules** acknowledge "OK" for an Agent that is paused,
  paused at a Token Cap, has no Model, or whose call fails.
- **Once:** `batch_acknowledgements` keeps one per Agent per Batch (its
  primary key), and a Kickoff is held only for a Batch's first draft:
  replans and approval hold none.
- **Events:** `batch.kickoff_started` (the version presented and the
  Agents assigned), one `batch.acknowledged` per Agent (`ok`, or `concern`
  with its text, and whether by its Model or the rules), then
  `batch.kickoff_ended` (how many concerns). With plan approval on, the
  "Plan awaiting approval" Notice follows the Kickoff, so its concerns are
  on the whiteboard when the Owner opens it; with it off, work starts
  after it.
- **On the whiteboard,** "Kickoff: 1 concern" lists each Agent's
  acknowledgement as it comes in, a concern marked in amber. In the 3D
  Office the Agents walk to the meeting room for it ([The web app and the
  3D Office](web-app.md#kickoffs-and-wrap-ups-in-the-meeting-room)).

### The Wrap-up

A Batch **finishes** when none of its issues can move on without the
Owner (PRD FR-25 (6), FR-60; `batches/wrap-up.ts`):

- each issue of its latest Plan is **closed** (by its merged pull request,
  or otherwise), or **blocked** at `needs-human`, or has **not started**
  because an issue it depends on is blocked (or never starts);
- an issue being worked, waiting at `ready-to-merge` for the Owner's
  approval, or not yet started though it could be, keeps it in progress.

The minute's check looks for finished Batches, as it looks for issues to
start, and so does a merge or an issue moved to `needs-human`, at once.
A Batch that finishes:

- **keeps its Wrap-up's results** (`batches.wrap_up`; `wrapUpSchema`):
  each issue in the Plan's order, with its title, outcome (`merged`,
  `closed`, `blocked` or `not_started`), pull request (from AI Office's
  `pull_request.opened` events), coder, rounds of the Review Loop and of
  QA (the most rounds its `review.posted` and `qa.reported` events
  reached), tokens (input plus output) and estimated cost (the AI
  Gateway's request history for that issue on that Floor since the Batch
  was made); the issues left out; and the totals. A pull request merged on
  GitHub itself, not by AI Office, counts as merged.
- becomes `finished` (with `finished_at`), and leaves the open Batches.
- publishes `batch.finished` (the counts and tokens, and the Agents the
  Plan assigned, who gather again in the meeting room), which the
  Communications Agent sends as work complete
  ([Communications](notices-and-skills.md#communications-and-connections)).
- raises an **info Notice**, "Batch 3 finished on web-shop: 2 of 5 issues
  merged, 1 closed, 1 blocked, 1 not started; 250k tokens", linking the
  Wrap-up on the whiteboard and each pull request (FR-49).
- is curated as ended by the Manager's repository memory curation, though
  a blocked issue is still open.

It finishes once: a later check or a restart changes nothing. The
whiteboard shows a finished Batch's **Wrap-up** above its Plan: "Wrap-up:
2 of 5 merged", when it finished, its tokens and estimated cost, a table
of each issue (outcome, pull request, rounds, tokens, estimated cost) and
what is blocked. The API's Batches carry `acknowledgements`, `finishedAt`
and `wrapUp`.

## Repository memory

Each Floor's repository keeps what its Agents have learned about it in
`.agents/MEMORY.md`, one entry per line (PRD FR-53; `@ai-office/orchestrator`'s
`createRepositoryMemory` and `createMemoryCuration`).

- **Every Agent reads it** at the start of a task, from the Floor's default
  branch, through the GitHub App: the coder, the reviewers, QA and the docs
  Agent, and the Manager for triage, a Batch's Plan and its chat. It is
  untrusted input, like issue text (FR-56): redacted, cut at 12,000
  characters, and quoted between `<memory>` markers it cannot close, as
  background, never as rules. A repository without one, or memory that
  cannot be read, leaves it out, and the task goes on.
- **Agents propose entries in their Handoff.** The coder and the docs
  Agent may end their `<handoff>` block, and QA its `<qa-report>`, with up
  to three one-line entries between `<memory>` markers. They are no part of
  the Handoff or the report. Each is kept in `memory_proposals` until the
  Manager next curates, and is a `memory.proposed` event; an entry that
  held a credential is dropped, and one already waiting is not kept twice.
- **The Manager curates them into one pull request**, at the end of each
  Batch (once every issue in its Plan is closed) and as a weekly tidy-up
  (a week after the Floor's last curation, or its oldest proposal),
  checked every hour. Its Model, through the AI Gateway with its own
  Gateway Key, is given the memory as it is and the proposals (with who
  proposed each, on which issue), and answers the whole memory to keep as
  one JSON object (`memoryCurationSchema` in `@ai-office/shared`): a
  `summary` and its `entries`, at most 40 of 300 characters each,
  duplicates merged and stale entries dropped. An answer that is not one is
  sent back once. When the Manager is paused or has no Model, the Gateway
  refuses the call, or it answers twice with none, AI Office's rules
  curate: the proposals added, entries that say the same in the same words
  merged, and the newest 40 kept.
- **Plain code writes the file**, dropping any entry that holds a
  credential, and AI Office, as the GitHub App, commits it as the Owner
  with the Manager's `Agent:` trailer (ADR 0002) on the branch
  `ai-office/memory`, and opens the pull request "Curate the repository's
  memory", listing what was added, what was removed and the proposals it
  took. While that pull request is open, the next curation builds on its
  branch and updates it, with a comment, rather than opening another;
  once it is merged or closed, the next starts from the default branch.
  A curation that changes nothing opens nothing. The Manager never merges:
  the Owner does.
- **Only that way.** An Agent's own pull request that writes the memory
  is never merged automatically: the Merge Policy sends it to the Owner,
  on any Floor (see [the issue pipeline](issue-pipeline.md#the-merge-policy);
  pen-test finding P1-3).
- **Kept and told.** Each curation is a row in `memory_curations` (a
  Batch's once), marking the proposals it took; a `memory.curated` event
  in the Activity Feed (under **Memory**, with the proposals); and an info
  Notice, "Memory PR #12 opened on web-shop: 2 entries added, 1 removed",
  linking the pull request.

## Office-wide and Role memory

Beside the repository's memory, AI Office keeps two more memories of its
own, in Postgres (PRD FR-54, FR-55; `@ai-office/orchestrator`'s
`createSharedMemory` and `createRoleMemoryReview`):

- **Office-wide memory** is the Owner's: what every Agent on every Floor
  should know, such as coding standards, preferred libraries and review
  rules. General Settings' **Office-wide memory** card edits it, as Markdown of up
  to 12,000 characters (`office_memory`).
- **Role memory** is what Agents of one Role on one Floor have learned,
  one line per entry, at most 40 a Role (`role_memory`). The Floor
  admin's **Role memory** card lists each Role's entries.

**Where Agents find them.** At the start of each task, the coder, QA and
docs Agents' sandboxes get the office-wide memory as `OFFICE.md` and
the entries the Owner accepted for their Role as `ROLE.md`. Both are written read-only
beside the clone (never in it, so they cannot be committed), bind-mounted
**read-only** at `/home/agent/.ai-office/memory/` for every agent tool,
and deleted with the clone. The prompt says where they are, as
background rather than rules. Each reviewer's prompt quotes the office-wide
memory and the reviewers' Role memory between `<office-memory>` and
`<role-memory>` markers they cannot close. Without either, prompts and
sandboxes are as they were.

**How Role memory grows.**

- The coder and the docs Agent may end their `<handoff>` block, and QA its
  `<qa-report>`, with up to three one-line lessons for their Role between
  `<role-memory>` markers, beside any `<memory>` block for the
  repository. They are no part of the Handoff or the report. Each waits
  as a proposal (a `memory.role_proposed` event); one that the Role's
  memory says or has waiting already is not kept twice.
- **The Manager recommends or rejects** every hour. Its Model, through
  the AI Gateway with its own Gateway Key, is given each Role's memory and
  its proposals (with who proposed each, on which issue), and answers one
  JSON object (`roleMemoryDecisionsSchema` in `@ai-office/shared`):
  `accept` or `reject` for every proposal, each with a reason. An answer
  that is not one is sent back once. Plain code rejects a proposal its
  Role's memory already says, without asking. A proposal the Manager
  rejects is turned down. One it accepts is only **recommended**: it
  waits for the Owner, with the Manager's reason, and reaches no Agent.
- **Only the Owner accepts**
  ([ADR 0005](../architectural-decision-record/0005-only-the-owner-accepts-role-memory.md)).
  The Manager's Model reads the very proposal it decides on, and a
  proposal is text an Agent wrote after reading an issue, so one hostile
  issue could otherwise steer every later Agent of the Role. In the Floor
  admin, at any time, the Owner can **Accept** or **Reject** a proposal
  or a recommended entry, and **Remove** an accepted one. When the
  Manager is paused, has no Model or cannot be asked, or answers twice
  with no valid decisions, the proposals simply wait for the Owner. A
  full Role memory takes no more until an entry is removed.
- Every recommendation, decision and removal is a `memory.role_changed`
  event, saying who decided (the Manager or the Owner) and why.

**Never a credential (FR-56).** A credential check refuses anything that
looks like a secret: whatever the central redactor would change (the
credential shapes it knows, and the Owner's own secrets, such as AI
Account credentials and Gateway Keys), a redaction already made, and
Slack, Stripe, npm and assigned-token shapes (`looksLikeSecret` in
`@ai-office/shared`). An office-wide memory with such a line is not
saved: `422 memory_holds_secret` names each line (`Line 4 looks like a
credential: take the secret out.`), never what it holds. A proposed entry
that looks like one is refused, and only counted in its event. An accepted
entry that comes to look like one is left out of what Agents are given.

**Every change is an event**, in the Activity Feed under **Memory**:
`memory.office_changed` (lines added and removed, and the length; never
the text), `memory.role_proposed` and `memory.role_changed`.

**API.** `GET /api/memory/office` answers `{"content","updatedAt"}`;
`PUT /api/memory/office` takes `{"content"}`. `GET
/api/floors/:floorId/role-memory` answers `{"entries"}`, those proposed,
recommended and accepted; `POST /api/floors/:floorId/role-memory/:entryId/accept`
and `…/reject` (with an optional `{"reason"}`) decide as the Owner, and
`DELETE /api/floors/:floorId/role-memory/:entryId` removes an accepted
entry. Deciding on an entry the Owner decided already is `409
role_memory_decided`, removing an entry
that is not accepted `409 role_memory_not_accepted`, and accepting into a
full Role memory `409 role_memory_full`.

### The bookshelf: a Floor's memory

Each Floor's **bookshelf** in the 3D Office (PRD FR-58, §6.10;
`/?floor=<floor>&inspect=bookshelf:<floor>`) opens a panel with the three
memories that Floor's Agents read (`Bookshelf` in
`apps/web/src/bookshelf.tsx`), each with a link to where it is edited.
Memory is untrusted text, so it is shown as written, never rendered.

- **The repository's memory**: `.agents/MEMORY.md` on the Floor's default
  branch, read through the GitHub App and redacted as Agents read it (the
  first 12,000 characters, saying so when there are more), then the
  entries Agents proposed that wait for the Manager's next curation (who
  proposed each, on which issue). **Edit the repository's memory on
  GitHub** opens GitHub's editor at the default branch (or a new file
  there when there is none), in a new tab: like the Manager's curation,
  the change reaches the default branch through a pull request where it
  is protected. **The Manager's memory pull request #N** links its latest
  curation's. Without the GitHub App, or when GitHub refuses, the panel
  says why and offers no GitHub link.
- **Role memory**: each Role's accepted entries, and how many proposals
  wait for the Manager or the Owner (those the Manager recommended among
  them). **Edit the Role memory** opens the
  Floor Settings' **Role memory** card (`/floor-settings/<floor>#role-memory`),
  where proposals are accepted or rejected and entries removed.
- **Office-wide memory**: as the Owner wrote it. **Edit the office-wide
  memory** opens General Settings' **Office-wide memory** card
  (`/general-settings#office-wide-memory`).

Links into AI Office open without a reload, and the card they name is
brought into view once it is shown, and kept there while the cards above
it load, until the Owner scrolls (`useAnchor` in `apps/web/src/anchor.ts`). The panel changes live, on the
`memory.*` events (the repository's and Role memory's for its own Floor
only).

**API.** `GET /api/floors/:floorId/repository-memory` answers
`{"repository","branch","content","truncated","readError","proposals","pullRequest"}`
(`repositoryMemorySchema` in `@ai-office/shared`; `content` null when
there is no memory, `readError` saying why it was not read), from
`createRepositoryMemoryShelf` in `@ai-office/orchestrator`. It only
reads: the repository's memory changes through pull requests.
