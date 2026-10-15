# GitHub, events and the Manager chat

The GitHub App client, the event bus, the Activity Feed, the Branches page, the Agent live view and the Manager chat. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## The GitHub App client

`packages/github` is how AI Office acts on GitHub, as the AI Office GitHub
App ([ADR 0002](../../docs/architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md)).
`createGitHubApp({ appId, privateKey })` signs a JWT with the App's key,
lists its installations and their repositories, and gives a client per
repository for issues, labels, comments, branches, pull requests, reviews,
merges, check runs and the checks a branch requires. Each repository gets its own installation token,
scoped to that repository alone, kept until five minutes before it expires.
Reviews are always posted as comment reviews: GitHub refuses an approval
from a pull request's author, and the App is that author.

For tests, `@ai-office/github/testing` has a fake GitHub:
`createFakeGitHub()` implements the same interface in memory, with a
scenario API (`installRepository`, `createIssue`, `setLabel`, `pushCommit`,
`finishCI`, …). `serveFakeGitHub(fake, { appId, publicKey })` serves it over
HTTP as GitHub's REST API, checking the App's JWTs and tokens, so the real
client can run against it.

The contract suite (`packages/github/src/contract.test.ts`) runs the same
tests against the fake, against the real client over the fake's HTTP, and,
when `GITHUB_CONTRACT_APP_ID` is set, against the real App. That last run
needs `GITHUB_CONTRACT_APP_PRIVATE_KEY` too, and works on
`GITHUB_CONTRACT_REPOSITORY`
(default `adrianeyre/ai-office-sandbox`). It opens and closes issues there,
and merges a pull request that adds a file under `ai-office-contract/`. The
App needs the permissions AI Office itself needs (`appPermissions`, listed
in [Setting up the GitHub App and your Floors](../../docs/processes/setting-up-a-floor.md#the-apps-permissions)),
plus **Checks: Read and write** on that repository, since the suite
reports CI itself. How to set that up and run it is in
[Run the contract suite against the real App](../../docs/processes/setting-up-a-floor.md#run-the-contract-suite-against-the-real-app).

The fake checks permissions as GitHub does: each call needs its
permission (to read it for a `GET`, to write it otherwise), a token
minted with none has the App's (`appPermissions`), and a token asking for
more than the App has is refused with a 422. So the contract suite over
HTTP fails if `appPermissions` misses anything the client calls.

```bash
GITHUB_CONTRACT_APP_ID=123456 GITHUB_CONTRACT_APP_PRIVATE_KEY="$(cat app.pem)" \
  pnpm vitest run --project @ai-office/github
```

## The event bus

`packages/events` defines every event AI Office emits (Floor, Agent, issue,
Batch, memory, sandbox, Handoff, model call, Notice, Token Cap,
configuration and sign-in events) as one Zod discriminated union on `type`, each with a `version`.
`@ai-office/events/schema` holds just the schema, for the web app.

`createEventBus` validates each published event, redacts it, appends it to
the `events` table and only then delivers it to subscribers (each with an
optional Floor, Agent, issue and type filter). Events are published one at
a time, so their ids grow in the order they were stored and delivered, and
`eventsAfter(id)` reads back everything after a given id. The table is
append-only: a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`, except
a delete of events before a cutoff, as [retention](running.md#retention)
and the [storage clean-up](running.md#storage) do.

### The live event stream

`GET /api/events/stream` sends the events to a signed-in session as
server-sent events. Each message's `id` is the event's id, and its `data`
is `{"id","occurredAt","event"}`.

- **Filters:** `floorId`, `agentId`, `issue` and `type` (comma-separated),
  for example `?floorId=web-shop&type=handoff,cap.warning`.
- **Resume:** with `Last-Event-ID` (or `?lastEventId=`), the stream first
  replays every stored event after that id, then carries on live, missing
  and repeating nothing.
- **Heartbeat:** a `: heartbeat` comment every 15 seconds, which also
  re-checks the session. Signing out everywhere ends open streams.
- Without a session it answers `401`.

In the web app, `useEventStream(filter)` (`apps/web/src/event-stream.ts`)
keeps a stream open and reconnects when it drops, resuming after the last
event it has. It merges each event into the TanStack Query cache under
`eventsQueryKey(filter)`, and `onEvent` can update other queries too.
`enabled` opens it only when ready, and `after` makes a first connection
resume after a given event id (one a page of stored events ended with).

## The Activity Feed

**Activity** in the web app is the Activity Feed (PRD FR-52): every event,
newest first.

- **Filters:** Floor, Agent, issue, type and a time range (from, to). They
  are kept in the address, such as `/activity?floorId=web-shop&type=handoff`.
- **Live:** new events stream in at the top, unless the time range has
  ended. The stream opens once the first page is read, resuming right
  after its newest event.
- **Infinite scroll:** older events load a page at a time as the end of
  the list scrolls into view (or with **Load older events**).
- **Links:** each entry links to its source: the issue on GitHub, its
  Agents, and its Notice.
- **Sign-ins:** every checked sign-in attempt, each lockout and each sign
  out is an event (`sign_in.succeeded`, `sign_in.failed`,
  `sign_in.locked_out`, `signed_out`), as well as a row in
  `sign_in_events`. The password never is.
- **Gateway Keys:** each Gateway Key not in use presented at `/v1` on the
  app's port, and each lockout that starts, is an event
  (`gateway_key.failed`, `gateway_key.locked_out`), with the client's
  address. The key never is (see
  [Gateway Keys](ai-gateway.md#gateway-keys)).

`GET /api/events` serves it: a page of stored events, newest first, with
the stream's filters (`floorId`, `agentId`, `issue`, `type`) plus `from`
and `to` (ISO 8601), `limit` (50 by default, at most 200) and `before` (an
event id). It answers `{"events":[…],"nextBefore":…}`; pass `nextBefore` as
`before` for the next page, until it is null. `eventHistoryUrl()` (in
`@ai-office/events/stream`) builds the address.

## The Branches page

**Branches** in the main menu shows which branch each Agent works on, and
how far each is ahead of and behind its Floor's default branch, as a lane
view, without a Git client. It only reads: nothing on it merges, rebases
or deletes a branch.

- **Floor:** the selector at the top picks the Floor (one repository). It
  is in the address (`/branches?floor=web-shop`), so a link opens the
  same Floor, and the last one picked is kept in this browser.
- **Lanes:** the default branch is the trunk. Each branch AI Office made,
  an issue's (`ai-office/<issue>-<slug>`, from `issueBranch()`), a
  one-pull-request Batch's (`ai-office/batch-<id>`, from `batchBranch()`;
  [ADR 0010](../architectural-decision-record/0010-a-batch-may-ship-as-one-pull-request.md))
  or a Grilling Session's documents' (`ai-office/grilling-<id>`), leaves it at
  its merge base, with its own commits as dots, newest last; a lane with
  more than a hundred shows the newest hundred after a "…". Hovering over
  or tabbing to a dot shows the commit's short sha, subject, author and
  the Agent its `Agent:` trailer names, and its time; each dot links to
  the commit. A Grilling Session's lane is dashed, and a Batch's shared
  branch is drawn heavier, as it carries several issues. Its lane names
  the Batch and the issue at work on it now (the one an Agent is running,
  else the first not yet ready to merge), then each of the Batch's issues,
  in the order the Owner named them, with where it stands: to start, its
  stage (its work in the queue, else its pipeline label), ready to merge
  or closed. Its Agent or stage is that issue's. Branches AI Office did
  not make are not shown.
- **Each lane** has its name, a `↑3 ↓12` badge (3 commits ahead, 12
  behind, as `git rev-list --left-right --count main...<branch>` counts
  them), the issue it is for, its open pull request and the CI on its
  head (none, running, passed or failed), the Agent working on it (a
  small likeness of its Avatar, its name and Role) or else the stage it
  waits in, and how long ago its last commit was.
- **Likely to conflict:** a lane more than 20 commits behind, or split
  off more than 7 days ago, is marked so, in amber with a warning sign.
- **The table** below the lanes says the same, a lane to a row, for a
  screen reader and the keyboard. The lane view scrolls sideways on a
  phone.
- **Live:** the page reads the Floor's branches again a second after a
  burst of its events: `repository.changed`, which a [webhook](issue-pipeline.md#issue-intake-and-the-pipeline)
  for a push, pull request, check run or check suite publishes; a branch
  AI Office pushed, a pull request it opened or merged; a sandbox
  starting or stopping; and an issue changing stage. It also reads them
  once a minute.
- **Errors:** a GitHub failure is shown as GitHub said it, with
  **Try again**; the selector still works.

`GET /api/floors/:floorId/branches` serves it (`floorBranchesSchema` in
`@ai-office/shared`), behind the Owner's sign-in like every Floor route:
an unknown Floor answers `404`, an archived one `409`, an unconfigured
App `503`, and a GitHub failure `502` with GitHub's message. The server
asks GitHub with the App's installation token, which never reaches the
browser: one call lists the branches (`listBranches("ai-office/")`), and
one per branch compares it with the default branch (`compareBranches`,
which gives `ahead_by`, `behind_by`, the merge base and the branch's
commits), with the open pull requests, the check runs on each head and
each issue. To spare GitHub's rate limits (`createBranches` in
`@ai-office/orchestrator`), what it said of a Floor is kept for a minute,
read again sooner only after the repository changed, and then no sooner
than five seconds after the last read, once for every page asking at the
time. A comparison is kept for as long as neither commit moves, finished
CI until a check changes, and an issue's title for five minutes.

## The Agent live view

Each Agent has a live view at `/floors/<floor>/agents/<agent>` (PRD
FR-58): what it is doing, as it does it. Its desk monitor's panel in the
Office links there, and so does the monitor on its card.

- **What it shows:** the Agent's terminal output (`sandbox.text`), the
  tools it calls (`sandbox.tool_call`), the files it changes, as diffs
  (`sandbox.diff`), and its model calls with their tokens
  (`model_call.completed`), with its sandbox starting and stopping and its
  status. It starts with the Agent's last 200 such events, then streams
  new ones, resuming right after them.
- **Scrolling:** it follows new output. Scrolling up pauses that, so the
  Owner can read back; **Jump to latest** (with how many arrived) or
  scrolling back to the bottom follows again.
- **Diffs:** the sandbox runner reads each `Edit`, `MultiEdit` and `Write`
  tool call from Claude Code's stream and publishes its diff as the Agent
  makes the change: removed lines start with `-`, added ones with `+`, and
  `@@` separates changes to the same file.
- **Reuse:** `AgentLiveView` (`apps/web/src/agent-live-view.tsx`) is the
  panel itself; a desk monitor's panel in the 3D Office shows it too.

Model calls appear once the AI Gateway publishes them as events; it
attributes each request to its Agent in `gateway_requests` already.

### Context Usage

An Agent's Context Usage (PRD FR-84, FR-85) is how full its working
context is: the input tokens of its latest model call (cached ones
included, so the whole prompt) divided by its Model's context window from
the model catalogue.

- **Sessions:** it is measured per session. A sandbox's run is one
  session: its agent tool names it in `x-ai-office-session`, and the
  Gateway records it in `gateway_requests.session`. It ends when the
  sandbox stops. The Manager chat's calls name no session, so they are one
  session for as long as it lasts.
- **What counts:** calls to the Agent's own Model. Reviewer calls are
  stateless, so reviewers have none. Only the Manager works outside a
  sandbox: another Agent's call that names no session, such as its Kickoff
  acknowledgement of a Plan, is a one-off and changes nothing. The
  Communications Agent belongs to no Floor and has none. An agent tool's side calls to another
  Model (a small model, say), failed calls, token counting and calls that
  started before the one already counted change nothing.
- **Unknown:** a Model the catalogue gives no context window shows as
  **Unknown**, never 0%.
- **Colours:** green below 60%, amber from 60%, red from 85%
  (`contextUsageBand` in `@ai-office/shared`, for every view).
- **Where:** a gauge on the Agent live view's page, a column in the
  Floor Settings' Agent list, and a bar above the Agent's head in the 3D
  Office, beside its tokens today, which empties with a short animation
  at a Fresh Start (see
  [Above the Agents' heads](web-app.md#above-the-agents-heads)).
- **API:** `GET /api/floors/:floorId/context-usage` lists each of the
  Floor's Agents with a session going (its issue, Model, input tokens,
  context window and Context Usage from 0 to 1, or null when unknown).
- **Events:** an `agent.context_usage` event is published when an Agent's
  whole percentage changes or whether it is known changes, and when its
  session ends (`active: false`). The 3D displays read the API, then
  follow these events.
- **Memory only:** it is kept in memory. A restart ends every sandbox, and
  with them their sessions.

### Fresh Starts

A Fresh Start (PRD FR-86, FR-87, FR-89) ends a sandbox Agent's session and
begins a new one on the same work, carrying only a structured summary the
Agent wrote for itself. The sandbox runner does it, so coder, QA and docs
Agents all have it.

- **Automatic:** when the session's Context Usage reaches its threshold:
  the Agent's own, else its Floor's, else 85%. Set the Floor's in its
  admin page's **Settings** (**Fresh Start threshold (%)**), and an
  Agent's in its editor (empty uses the Floor's). Both are from 10 to 100.
- **By hand:** `POST /api/floors/:floorId/agents/:agentId/fresh-start`
  does the same at once (the "Fresh start" action of the Agent card and
  monitor, wired in by the 3D Office). It answers `202` with the session
  being ended, or `409 no_session` when the Agent has no sandbox session
  going.
- **What happens:**
  1. Work the Agent had not committed is saved in a commit (`chore: save
     work in progress for a Fresh Start`), and the sandbox is stopped
     (`sandbox.stopped` with outcome `fresh_start`).
  2. The Agent's own Model, through the AI Gateway with its Gateway Key,
     writes the summary from the session as AI Office recorded it (what it
     said, the tools it called, the branch's commits and changed files):
     one JSON object with `done`, `inProgress`, `nextSteps`, `decisions`
     and `filesTouched` (`freshStartSummarySchema`). A summary that does
     not match is asked for once more; credentials are redacted from it.
     The session read the issue, the repository and tools' output, which
     anyone may have written, and the issue's title, commit subjects and
     file names are outside text too. So the summary prompt quotes each
     (`<issue-title>`, `<commits>`, `<files>`, `<transcript>`) between
     markers they cannot close, and tells the Model they are untrusted,
     not instructions (pen-test finding P1-7).
  3. A new sandbox starts in the same clone, on the same branch, with the
     issue's prompt and a **Fresh Start N of at most 3** section holding
     the summary. The summary is quoted too (`<summary>`), as notes on
     where the work stands rather than instructions, and the section goes
     before the Owner's instructions for the Agent, which still end the
     prompt. An `agent.fresh_start` event records each one, with its
     trigger (`threshold` or `manual`) and the Context Usage.
- **The cap:** a task may make 3 Fresh Starts. When a fourth is due, the
  Agent is paused instead (as if paused in its editor), an action Notice
  asks the Owner to check the issue and resume it, and the work goes back
  in the queue with its commits pushed. Resuming the Agent starts the task
  again, with a fresh count. As with any Agent paused in its editor,
  another Agent of its Role may take the work meanwhile.

## The Manager chat

Each Floor's Manager has a chat at `/floors/<floor>/manager` (PRD FR-24),
linked from Floor Settings as **Chat with the Manager**. The repository
is implied by the Floor. The conversation is kept per Floor, in
`manager_chat_messages`, and read when the chat opens.

- **Commands, in plain code.** "complete issues 1 to 5", "skip 4", "move 5
  up", "pause", "resume" and "status" are read by AI Office itself
  (`readManagerCommand` in `@ai-office/orchestrator`), and no model sees
  them. Issue lists take ranges (`1 to 5`, `1-5`, `1 through 5`) and lists
  (`1, 3 and 4`, `#1 & #3`), at most 50 issues. The answer says what was
  understood: "Understood: complete 5 issues: #1, #2, #3, #4 and #5."
  "complete issues …" then hands the Manager a [Batch](batches-and-memory.md#batches-and-plans),
  and the answer goes on with its Plan. Ending it "in one PR" (or "in one
  pull request", "as one PR", "in a single PR"), as in "complete issues 1
  to 10 in one PR", puts the Batch's issues in
  [one pull request](batches-and-memory.md#one-pull-request-for-a-batch),
  and the answer says so: "Understood: complete 10 issues: #1, … and #10,
  in one pull request." "in one PR" after any other command is refused,
  saying it goes with "complete". "status" is answered with the
  Manager's [status report](issue-pipeline.md#status-reports). "skip" and "move" change
  the open Batch holding the issue ([below](batches-and-memory.md#changing-a-batch-mid-way-skip-and-move)),
  and the answer goes on with its new version. Pausing a Floor is not
  available yet, so for that it adds that nothing changed. If carrying a
  command out fails, or it does not fit the Batch, the answer is an error
  saying why.
- **Refused with a hint.** A misspelt command ("compleet issues 1 to 5")
  is answered "Did you mean "complete issues 1 to 5"?", and one it cannot
  read (a range that runs backwards, a missing issue number) with what to
  type instead. Neither reaches a model.
- **Anything else** goes to the Manager's Model through the AI Gateway,
  with the Manager's own Gateway Key, so it is attributed to the Manager
  and its Floor and counts against its Token Caps. The prompt names the
  Manager, the Floor, its team and the commands, then the conversation so
  far (its last 50 messages). A paused Manager, or a call the Gateway
  refuses, is answered with why. Where its AI Provider allows, the
  Manager answers in a continuing, read-only agent session that can read
  the repository and the web
  ([below](#a-read-only-session-as-claude-code-is)); else in one call,
  with no tools. Sending while it writes interrupts it.
  With the Floor's "Manager spins off work from chat" on, the Model also
  decides whether the message is a request to act on
  ([below](#requests-batches-and-contractors)).
- **Skills** (PRD FR-74). `/skill-name [arguments]` runs one of the Floor's
  Skills (its [Available Skills](notices-and-skills.md#available-skills):
  the office library's enabled Skills and the repository's own). The box
  autocompletes it: while it holds only `/` and the start of a name, the
  matching Skills are listed under it; the arrow keys move through them,
  Enter or Tab (or a click) puts `/name ` in the box, and Escape closes the
  list.
  - **Running one** keeps the Owner's message with the Skill it ran
    (`skill`: its `name`, `source`, `arguments` and `chosenBy: "owner"`)
    and a redacted copy of its `SKILL.md` instructions, then the Manager's
    Model answers. A name the Floor has no Skill of is answered at once
    with a hint (the nearest name, and the Floor's Skills), and reaches no
    model.
  - **Loaded for the conversation.** Every Skill loaded by the messages the
    Model is given (its last 50) is in the Manager's prompt, under "Skills
    loaded in this conversation", as it was loaded: the latest 5, at most
    40,000 characters of each. Their supporting files cannot be read from
    the chat.
  - **Chosen by the Manager.** The prompt also lists the Floor's other
    Skills, by name and description, unless the Owner ran one. When a
    request matches one, the Manager starts its reply with the line `[use
    skill: name]`. AI Office holds the reply's start back while it could
    be that line, stops that call, loads the Skill, and asks again. The
    reply then starts "Using the Skill /name." and is kept with the Skill
    (`chosenBy: "manager"`) and its instructions, so it stays loaded too.
    A line naming a Skill the Floor does not have is left out of the reply.
  - **Shown.** A message that ran a Skill, and a reply whose Skill the
    Manager chose, are marked **Skill /name**.
  - Repository Skills are read through the GitHub App, and a Floor's
    Skills are kept for 30 seconds (`floorChatSkills`).
- **Streaming.** The reply streams into the page as the Model writes it,
  over server-sent events. On reconnection the stream resumes after the
  last message the page has, then gives the reply being written from its
  text so far.
- **Credentials.** The Owner's words are redacted before they are kept or
  sent, and never logged; so are attached text files and mentioned files
  as the Model is given them. An attachment's name and content are never
  logged, only its type and size.
- **API.** `GET /api/floors/:floorId/manager-chat` gives the Manager
  (with its Model), the latest 200 messages and any reply being written.
  `POST /api/floors/:floorId/manager-chat/messages` with
  `{"text","attachments"}` sends one (`attachments`, the ids of up to 5
  uploaded files, may be left out; a message needs text or an
  attachment), answering `201 {"message","reply"}`: `reply` is the answer
  to a command (or a hint, or the status report), and null while the
  Model's reply streams. Every message has `skill`, null unless it ran
  one, `tools`, the tools a reply's session used, and `attachments`. A
  Floor that is archived answers `409 floor_archived`; a message sent
  while the Manager carries out a request, or answers a Grilling turn or
  a compaction, `409 reply_in_progress`; and one naming an attachment
  that is not the Floor's, or was sent already, `404
  attachment_not_found`. `GET /api/floors/:floorId/manager-chat/stream` is
  the stream: `message` frames (with the message's id as the event id),
  `pending`, `delta` and `tool` frames for the reply being written, and
  `tasks` when the [task list](#the-task-list) changed, resuming after
  `Last-Event-ID` (or `?lastEventId=`). The attachments, `@` files and
  task list have endpoints of their own ([below](#a-read-only-session-as-claude-code-is)).
- **Available Skills.** Beside the chat, the Floor's
  [Available Skills](notices-and-skills.md#available-skills): opening one
  shows it, and **Run** puts `/name ` in the box. `?skill=<name>` in the
  address puts it there as the page opens.
- **Reuse:** `ManagerChatPanel` (`apps/web/src/manager-chat.tsx`) is the
  chat itself, for the glass office in the 3D office to open too.

### A read-only session, as Claude Code is

The Manager chat works as the Owner's own coding assistant does (PRD
FR-24,
[ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md)).
The Manager can look things up for itself, but still changes nothing:
every change goes through an issue, an Agent or a Contractor.

- **A session per conversation.** When the Manager's Model is one Claude
  Code or Codex calls (the Claude and ChatGPT AI Providers, FR-16), each
  plain message is a turn of one agent session for the conversation (the
  chat since its latest `/clear` or `/compact`, named as its calls name
  their session). The session's first turn is given the conversation so
  far; each later turn resumes it by the tool's own session id and is
  given only the Owner's newest turn, with the Manager's instructions
  again when they changed (a Skill loaded, research reported back). The
  ids are kept in `manager_chat_sessions` (`manager/chat-session-store.ts`),
  so a conversation goes on after a restart. `/clear` and `/compact` start
  a new session. Grilling turns, issue drafting and compaction summaries
  stay one-shot calls.
- **Read-only.** The tool runs with `docker run` in its
  [sandbox image](issue-pipeline.md#sandbox-images)
  (`manager/chat-sessions.ts`, `models/agent-tool-session.ts`), per Floor:
  - a clone of the repository at its default branch, made with a GitHub
    App read-only token of the turn's own (revoked once the clone is
    fresh, before the tool runs) and refreshed before each turn, mounted
    read-only at `/home/agent/workspace` (under
    `<SANDBOX_WORK_DIR>/manager-chat/<floor>/repo`);
  - the tool's own state mounted as its home, so its sessions survive;
  - a sandbox's allow-listed environment, with only the way to the Gateway:
    no Git identity, no GitHub token, never an AI Account's credential.
  The session has **no shell** (P2-1): a `Bash(git diff:*)` rule bounds a
  command's prefix, not what it does, and `git diff --no-index` read any
  file in the container, the Gateway Key in the process's environment
  included. It reads the history (and Codex the files too) through AI
  Office's **repository tools** (`manager/repository-tools.ts`), an MCP
  server AI Office writes to `<SANDBOX_WORK_DIR>/manager-chat/<floor>/tools`
  each turn and mounts read-only at `/home/agent/ai-office`: `read_file`,
  `list_files`, `search`, `git_log`, `git_show` and `git_diff`. Each runs
  Git without a shell on the clone's objects at the default branch, with
  a revision or a path checked before it is passed (never an option,
  never absolute, never `..`, always before or after `--`), so no path
  leaves the repository and a symlink is read as a link; Git runs with an
  environment of its own, with no credential in it.
  Claude Code is given only `Read`, `Grep`, `Glob`, `WebSearch` and
  `WebFetch`, plus the repository tools' `git_log`, `git_show` and
  `git_diff`; its file tools may read the clone and the turn's images
  only, and it refuses `Bash`, `Edit`, `Write`, `MultiEdit`,
  `NotebookEdit`, writing any path (`Edit(//**)`, P2-2) and reading
  `/proc`, `/sys` or its own home. The repository tools take no option,
  and their Git commands write nothing, not even a lock
  (`GIT_OPTIONAL_LOCKS=0`). Codex runs
  with `--sandbox read-only`, its shell turned off
  (`features.shell_tool=false`, `features.unified_exec=false`), the
  repository tools and live web search. A Manager answering in one call
  through Codex has its shell turned off too. Nothing is ever pushed.
  Each turn runs on a sandboxes' network of its own, which the sandbox
  relay joins, so its web fetches reach only the hosts
  `SANDBOX_EGRESS_HOSTS` names, and it reaches no sandbox; web search runs
  at the AI Provider, through the Gateway
  ([ADR 0008](../architectural-decision-record/0008-sandboxes-reach-only-the-gateway-and-allowed-hosts.md),
  [ADR 0006](../architectural-decision-record/0006-each-sandbox-has-a-network-of-its-own.md)).
- **Through the Gateway, for every account.** The tool reaches models only
  through the AI Gateway at `SANDBOX_GATEWAY_URL`, with the Manager's own
  Gateway Key, so a subscription and an API key get the same tools, and
  the calls are attributed and capped as the Manager's. Other AI
  Providers, and an Office without the GitHub App or
  `SANDBOX_GATEWAY_URL`, answer in one call through the Gateway, unable to
  read the repository.
- **Tool use, collapsed.** Each tool the session uses is sent as a `tool`
  frame as it is used, and kept with the reply (`tools`, at most 200): its
  name and what it was used on, such as `Read src/checkout/total.ts`. The
  page shows "Used 3 tools" under the reply ("Using …" while it is
  written), opening to the list (`chat-tool-use.tsx`).
- **Interrupting.** Sending while the Manager is writing a reply stops
  it: what it wrote so far is kept, and the new message is answered in its
  place. The button reads **Interrupt and send**. While the Manager carries
  out a request (filing issues, starting a Batch, research), or answers a
  Grilling turn or a compaction, a new message is refused with `409
  reply_in_progress` until it has; a message that already interrupted
  stops a request before it acts.
- **Attachments** (`manager/attachments.ts`, `chat-attachments.tsx`).
  Images (PNG, JPEG, GIF, WebP) and text files (plain text and logs,
  Markdown, CSV, JSON, NDJSON, XML, YAML) are attached with the clip,
  pasted or dropped on the box.
  - **Limits:** at most 5 per message; an image up to 5 MiB, a text file
    up to 1 MiB. The page checks them first, and the server checks the
    real bytes again: an image must be the image it says, text must be
    UTF-8.
  - **Uploaded at once**, unsent, with `POST
    /api/floors/:floorId/manager-chat/attachments` and
    `{"name","mediaType","content"}` (base64), answering `201` with its id;
    the message then names it. It is kept in `manager_chat_attachments`
    with the message that sent it, and goes with it. One never sent is
    deleted after a day by [retention](running.md#retention).
  - **To the Model.** A text file is quoted between markers as untrusted
    data, redacted, and cut to 60,000 characters (its start and its end,
    where a log fails, saying how much was left out). An image goes as an
    image where the Model's call can carry one; a call that carries only
    text is told it was attached but cannot be seen.
  - **Shown** on the sent message: images as thumbnails, text files as
    chips, each opening its content from `GET
    /api/floors/:floorId/manager-chat/attachments/:attachmentId` (an image
    inline, text as a download, never run as a page).
- **`@` file mentions** (`manager/repository-files.ts`,
  `file-mention-autocomplete.tsx`). Typing `@` lists the repository's
  files matching what follows, best match first (at most 20), from `GET
  /api/floors/:floorId/manager-chat/files?query=`; the arrow keys move
  through them, Enter or Tab puts `@path ` in the box, and Escape closes
  the list. The paths are read from the default branch's tree through the
  GitHub App and kept a minute per Floor. A message mentioning `@path`
  gives the Manager each file's text at the default branch (at most 10
  files, 200 KiB each, quoted and redacted as attachments are); a missing
  file is noted, never an error.
- **Model and effort** are chosen in the chat's header
  (`manager-model-picker.tsx`), from the Manager's AI Provider's catalogue
  and the efforts its agent tool takes, as the
  [Agent editor](floors-and-agents.md#the-agent-editor) offers them. Each change is saved
  at once as the Manager's own setting (`PATCH
  /api/floors/:floorId/agents/:agentId`); it is never a Token Cap change.

#### The task list

Beside the chat, a live task list shows the work the Owner's requests
spun off, as Claude Code lists its sub-agents' tasks (`manager/chat-tasks.ts`,
`chat-task-list.tsx`). It is folded under a button saying how many are
still going, and shows nothing until there are some.

- **Tasks.** For each chat request's Batch, open or finished within the
  day, one task per issue of its Plan, one per Contractor added for it,
  and one per research run, newest request first.
- **States:** Queued, Running, In review, Done or Blocked, worked out in
  plain code from the event log (the issue's latest pipeline label, its
  merge, the work queue and the Batch's Wrap-up); no model is asked. An
  issue is Running while its work runs at `needs-work`, In review at
  review, QA, docs or the merge gate, and Blocked at `needs-human`.
- **Links.** Each task opens its Agent's or Contractor's
  [live view](#the-agent-live-view), and an issue its page on GitHub. A
  Contractor that has left has no live view.
- **Live.** When any of it may have changed, the stream sends a `tasks`
  frame and the page fetches `GET
  /api/floors/:floorId/manager-chat/tasks` again.

### Requests, Batches and Contractors

The Manager is the chat's orchestrator, as a coding assistant spins work
off to sub-agents (PRD FR-24,
[ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md)).
It never changes the repository itself: work goes to the Floor's Agents,
and to Contractors it adds, through GitHub issues. The Floor setting
**Manager spins off work from chat** (on by default, in Floor Settings)
turns this on; off, the Manager only talks and takes typed commands, as
before. Commands, `/skill-name`, `/clear`, `/compact` and Grilling Sessions
are untouched, and a message that runs a Skill, or is sent while a
Grilling Session runs, is never a request.

- **What each message is.** The prompt asks the Model to decide
  (`requestsSection` in `manager/requests.ts`): a question, a status
  request or a discussion gets an ordinary reply; anything else is
  answered as one JSON object in a fenced block opened by ` ```request `,
  whose `decision` is `batch`, `clarify` or `research`
  (`chatRequestSchema` in `@ai-office/shared`). AI Office holds a reply's
  start back from the stream while it could open that block, so a
  decision is never shown as it is written. A decision that cannot be
  acted on (bad JSON, an unknown Role, an issue depending on a later one)
  is sent back once with what is wrong; after that the reply is kept
  plainly, or as an error saying why.
- **Fenced first** (P2-3, `manager/request-fence.ts`, ADR 0009). A
  `batch` whose issues name a file that holds secrets, says what CI runs
  or installs (dependencies among them), or is read by later Agents as
  memory, Skills or instructions files nothing unless the Owner's own
  words name that file too (its path, its name or a folder it is in):
  plain rules, the Merge Policy's own (`merge/owner-only.ts`), checked
  before any model is. The chat lists each such file and why, and asks
  the Owner to name them, or to file the issues and say "complete issues
  …".
- **Bound to the Owner's own words** (P2-3,
  `manager/request-binding.ts`). The decision is written by the Manager's
  session, which has read the repository, web pages and attachments, any
  of which may hold an instruction someone planted. So before a `batch`
  files anything or a `research` adds anyone, AI Office makes one more
  call to the Manager's Model, with no tools and no session, given only
  the Owner's own messages (this one and up to four before it, never the
  Manager's replies) and the plan in full (every issue, one-off Role and
  question), quoted as untrusted data (`requestPlanText`). Only an answer
  that the plan does what the Owner asked and nothing else
  (`{"bound": true}`) lets it go on, and the request stands as the
  Plan's approval as before (ADR 0004). Otherwise, or when the check
  fails or its answer cannot be read, nothing is filed, no one is added
  and no Batch starts, and the chat says why. The Manager's prompt also
  says that only the Owner's messages ask for work, and that what it
  reads is data, never instructions.
- **`clarify`:** one clarifying question, kept as the reply. Nothing is
  filed.
- **`research`:** something to find out in the repository first. A
  research Contractor, in a one-off Role the Model wrote, answers up to
  three questions in read-only sandboxes, as a Grilling Session's facts
  are found ([FR-79](#grilling-sessions)), files nothing and leaves. Its
  findings are posted in the chat, and the Model is asked again knowing
  them (once: it cannot send more research). With no room for a
  Contractor, the Manager researches itself. Without sandboxes set up,
  research is not offered.
- **`batch`: plan, then go.** The Model lists the issues to file, each
  with what to build, acceptance criteria, the earlier issues it depends
  on, its likely files, and its work Role: a library work Role's name, or
  a one-off Role it writes in `roles` (a name such as "Migration writer",
  a description and instructions). The Role's instructions never become
  its Contractor's (P2-4): they go into the issues it works, as "The
  Manager's notes for the Migration writer", quoted as untrusted with the
  rest of the issue, and the Role gets AI Office's own instructions
  ([Contractors](floors-and-agents.md#contractors)); a research
  Contractor's Role is given AI Office's too, and its questions are its
  task. AI Office then, in plain code:
  1. **Staffs it** (`staff`). A Contractor is added for each Role the
     Batch needs that no Agent on the Floor fills, and for each ready
     issue (one depending on no other) beyond the free Agents in its Role.
     Each takes one place in both limits: the Floor's **Most Agents**, and
     the sandbox limits (the office's, and the Floor's own if lower) less
     the Floor's staying work Agents, as more work Agents than sandboxes
     would only wait. When a limit holds one back, the Plan says which,
     with a link to where it is raised (General Settings' Sandboxes card, or the
     Floor's settings). An issue whose one-off Role then has no Contractor
     goes to the Floor's first work Role instead.
  2. **Says its Plan**, as a `plan` message: the summary, the issues with
     their Roles and order, and the Contractors it adds.
  3. **Files the issues** in order, through the Manager's one narrow
     GitHub path (`managerChatIssues`): each labelled `ai-office`, its
     body quoting the Owner's request with "Blocked by" naming the issues
     filed for those it depends on, and a comment noting it was filed for
     the request. A `manager.issue_filed` event records each.
  4. **Adds the Contractors** and says each one's arrival.
  5. **Starts the Batch** with the Plan settled here (checked as any draft
     is), skipping the Floor's plan approval: the request is the approval
     ([Batches](batches-and-memory.md#batches-from-the-manager-chat)).
  If filing stops part-way, the chat says which issues were filed, and
  `complete issues …` starts them. The chat is held while this runs.
- **Reporting back.** As the Batch goes on, the Manager posts `progress`
  messages in answer to the request (`createChatReports`): each issue done
  (its pull request merged) or blocked (handed to the Owner, which raises
  its Notice as ever), each Contractor leaving, and the Wrap-up's summary
  with a link to the whiteboard. The chat marks them **Plan** and
  **Progress**.
- **Contractors** are described with
  [a Floor's team](floors-and-agents.md#contractors).

### Clearing and compacting

The Manager chat's conversation can be cleared or compacted (PRD FR-87,
FR-88, FR-89). Nothing stored apart from it is touched: the Manager's
decisions, Batches and their Plans, Skills loaded in a compacted
conversation, and a Grilling Session's data. The page keeps every message.

- **`/clear`** is answered at once in plain code. The answer is a `clear`
  message, shown as a divider: "Cleared the conversation: Mira starts
  afresh from here. Decisions, Plans and Batches are kept." The Manager's
  Model is given nothing from before it, and Skills loaded before it are
  unloaded. A running Grilling Session goes on, and the answer says so.
- **`/compact [what to keep]`** has the Manager's own Model summarise the
  conversation for itself (`manager/compaction.ts`).
  - It is given a transcript of the conversation since it was last cleared
    or compacted, starting from the summary before it if there is one.
    Earlier `/clear` and `/compact` messages, and their answers, are left
    out. What to keep, if given, is passed on.
  - The summary is kept as a `summary` message, answering the `/compact`.
    Its `compaction` records the trigger (`owner`), the Manager's Context
    Usage at the time, the last message it replaced (`upTo`), and how many
    it replaced.
  - From then on, the Model is given that summary under "Earlier in this
    conversation", then only the messages after it.
  - With nothing to summarise, a hint says so.
  - The page shows a summary as a **Compacted** card, the summary folded
    inside.
- **Auto-compaction.** Before the Manager's Model answers a message, the
  chat checks the Manager's Context Usage in the conversation (from
  `ContextUsage`, the Gateway's measure of its latest call). If it reached
  the Manager's Fresh Start threshold (else its Floor's: 85% by default),
  the conversation up to that message is compacted first.
  - The summary has trigger `auto` and answers nothing (`replyTo` null).
    The Model then answers the message from the summary.
  - If compacting fails, the Model answers from the conversation as it is,
    and the failure is logged.
- **Sessions.** Each conversation's model calls name their own session,
  `manager-chat:<floor>:<id>`, where the id is that of its latest `clear`
  or `summary` (0 before the first). Clearing or compacting ends the old
  session, so the Manager's Context Usage empties and starts again with
  the next call. The summary's own call names the session it replaces.
  Only the chat's own calls count towards auto-compaction: a triage or a
  Plan by the same Manager does not.
- **In a Grilling Session** (FR-88), the summariser is told the session's
  decisions, open questions and glossary terms are kept apart and given
  back word for word, so it summarises only the back-and-forth. Every
  prompt in the session carries them from `grilling_sessions`, so a
  compacted session still lists every settled decision word for word.
- **The summariser** is the Manager's own Model, through the AI Gateway with
  its Gateway Key (FR-89). The Decision Model option for summaries arrives
  with the Decision Model (#109).
- **The status line in the header.** Beside the Model and effort, the
  chat page's header shows what Claude Code's status line shows a
  session, for the Manager (`manager-status-line.tsx`, the Manager's
  `ChatStatusLine` from `chat-status-line.tsx`), as labelled meters that
  wrap onto more rows on a narrow screen. In the 3D Office's panel, a
  Grilling Session's included, it shows compact over the chat:
  - its **Context Usage** gauge (FR-85), from
    `GET /api/floors/:floorId/context-usage`, kept live by
    `agent.context_usage` events;
  - **Today** and **This month**: its tokens against the Token Caps in
    force for it (FR-32), as a percentage and a bar, from
    `GET /api/floors/:floorId/token-usage`, read again on each of the
    Floor's wall-board events and each minute, as the wall board reads
    them;
  - **5-hour** and **Weekly**: the usage windows (FR-36) of the
    subscription that served the Manager's latest request, as the AI
    Gateway's request history names it
    (`GET /api/gateway/requests?agentId=…&limit=1`), with its pace line
    and pause threshold as the AI Accounts card draws them. Without such
    a request, the windows of the Manager's AI Provider's accounts that
    report them are shown instead, each named. An account that reports
    no windows, such as an API key, shows none. The account is found
    again after each of the Manager's requests on the AI Gateway's live
    request stream (`GET /api/gateway/requests/stream?floorId=…&agentId=…`),
    which reads its tokens again too, and
    the accounts are read each minute, as the AI Accounts card reads
    them, since AI Providers report the windows only to the server's own
    polling.
- **The Floor's name** heads the page and the line under the title
  ("The Manager of Storefront"), as the Owner chose it (FR-7); the page's
  address keeps the Floor's id (`/floors/web-shop/manager`). A rename
  shows at once, on the Floor's `config.changed` event.
- `/clear` and `/compact` are read before Skills, so a Skill named `clear`
  or `compact` cannot be run from the chat.

### Grilling Sessions

A Grilling Session (PRD FR-77, FR-78, FR-79, FR-80, FR-81, FR-82) is a Manager
conversation that interviews the Owner in rounds of questions until the two
share an understanding of a feature or product. It is started in the Manager chat
with the built-in Skill: `/grilling <what to grill>`.

- **The built-in Skill.** `/grilling` is AI Office's own Skill
  (`packages/orchestrator/src/grilling/skill.ts`), on every Floor. The
  Available Skills list shows it as **Built in**. No office or repository
  Skill of its name overrides it, it is never mounted into a sandbox, and
  Floor Settings' per-Role switches leave it out. The Manager is not
  offered it to choose for itself: starting a session is the Owner's
  call.
- **The other Skills that start one** (FR-83b). Four built-in Skills
  adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills)
  (MIT) start a Grilling Session too, and run it exactly as `/grilling`
  does, with their own instructions loaded beside `/grilling`'s
  (`packages/orchestrator/src/skills/built-in/<name>/SKILL.md`). Like
  `/grilling`, no other Skill of their name overrides them, and the
  Manager is not offered them to choose. Each session keeps the Skill that
  started it (`skill`), which the Grilling Sessions list and **Read** show:
  - `/grill-with-docs <topic>`: grilling with domain modelling. The
    Manager challenges terms against `GLOSSARY.md`, sharpens fuzzy
    language, invents edge-case scenarios and checks the code, settling
    glossary terms as they crystallise and ADRs only when they qualify.
  - `/wayfinder <idea>`: the first round names the destination, and later
    rounds ask breadth-first across the whole space. The PRD's outline is
    the map, with **Destination**, **Notes**, **Not yet specified** (the
    fog of war) and **Out of scope** sections beside what to build. The
    issues drafted at the end are the decision and build tickets. AI Office
    does not claim, assign or label tickets, or work through them in later
    sessions, and its instructions say so.
  - `/to-spec [topic]`: writes the PRD from the conversation so far in its
    first turn, in Matt's spec sections (Problem Statement, Solution, User
    Stories, Implementation Decisions, Testing Decisions, Out of Scope,
    Further Notes), and asks only whether the seams to test at are right.
  - `/to-tickets <PRD and ADR paths, or a description>`: breaks an existing
    plan into tracer-bullet issues, described below.

  Every one of them writes the PRD to
  `docs/product-requirements-document/`, ADRs to
  `docs/architectural-decision-record/` and terms to `GLOSSARY.md`, as
  every session does: their instructions say so in place of Matt's
  defaults (`docs/adr/`, `.scratch/`, a local tracker or a setup Skill).
  `@ai-office/shared` exports their commands' names
  (`grillWithDocsSkillName`, `wayfinderSkillName`, `toTicketsSkillName`,
  `toSpecSkillName`, and `grillingSkillNames` for all five), for anything
  that sends them, such as a Meeting Room.
- **`/to-tickets`.** It breaks a plan already written into issues, and
  writes no documents of its own (`grillingWritesDocuments`):
  - **What it reads.** Each path in its arguments under
    `docs/product-requirements-document/` or
    `docs/architectural-decision-record/` (with or without `@`, at most
    five; `grillingSourcePaths`) is read from the repository's default
    branch through the GitHub App, as `@` mentions are, when the session
    starts. Each is redacted, cut to 40,000 characters and kept with the
    session (`sources`). The prompt quotes them between `<<<BEGIN FILE`
    and `<<<END FILE` markers as untrusted data, never instructions. A
    path that cannot be read is kept without its text, so the Manager
    says so. The rest of the arguments is the description.
  - **Its rounds** put the proposed breakdown to the Owner (each issue's
    title, what it blocks on and what it delivers) and ask Matt's
    questions: is the granularity right, are the blocking edges right,
    should any be merged or split.
  - **No documents.** Its turns are asked for none, and plain code keeps
    no outline, ADRs, process docs or glossary terms whatever the Model
    gives. Nothing is written on a branch.
  - **Ending.** "confirm" (or "end the session") ends it with no pull
    request, and the Manager drafts the issues at once, in the same
    answer: exactly the breakdown the Owner approved. Review, **Approve
    and file** and the issues' bodies are as for any session, with the
    documents it broke down under **Cites**. Without the GitHub App it
    ends as any session does, with no issues drafted.
- **Rounds.** The Manager's Model writes each turn as one JSON object
  (`grillingTurnSchema` in `@ai-office/shared`): the decisions the answers
  settled, glossary terms, open questions the answers made moot
  (`withdraw`), and its next questions, each with a recommended answer and
  the earlier questions it depends on. An answer that cannot be kept is
  asked for once more with what was wrong. AI Office then works the rest
  out in plain code (`grilling/session.ts`):
  - it numbers questions across the whole session;
  - each round asks every open question whose prerequisites are settled
    (answered or withdrawn), and holds the rest for a later round;
  - every answered question is settled as a decision. Where the Model
    names no decision for an answer, the question and its answer become
    one.

  The round's message is kept with `grilling: {sessionId, round}`, and
  shows the questions as cards. The Model's JSON is never streamed to the
  page: "Mira is answering…" shows until the round is kept.
- **Finding facts.** The Manager finds facts itself rather than asking
  the Owner (FR-79), and asks the Owner only for decisions. While it may,
  a turn can name, instead of questions, up to five `facts` to find in the
  Floor's code, docs and issues. Each fact can name one of the Floor's
  Agents to send (an enabled sandbox Agent: a coder, QA, docs or designer
  Agent, not a reviewer). A fact naming no such Agent is the Manager's own
  to find. AI Office then:
  1. says in the chat what is being found and by whom ("Before round 2,
     finding 2 facts in the repository rather than asking you: …");
  2. finds every fact at once, each in its own read-only sandbox
     (`grilling/fact-finding.ts`);
  3. keeps the answers with the session, says them in the chat ("Found in
     the repository: …"), and asks the Model for its turn again. The facts
     are then in the session section of its prompt.

  Nothing else in a turn that names facts is kept. A turn may have facts
  found twice; the third time it is not offered, and any facts it names
  are left out.

  Each fact-finding sandbox:
  - clones the Floor's default branch with a GitHub App **read-only**
    token of its own, which is also the sandbox's `GH_TOKEN`, so the agent
    tool can read issues and pull requests with `gh` but change nothing
    on GitHub. It is revoked as the sandbox stops;
  - runs the sent Agent's agent tool (Claude Code, Codex or opencode),
    through the AI Gateway with that Agent's own Gateway Key. Its calls name
    the sandbox as their session and no issue;
  - is given no Git identity, and nothing in it is ever pushed;
  - has its answer read from between `<fact>` and `</fact>`. If the
    repository in the sandbox changed (a commit, or a file left changed),
    the answer is not kept;
  - has its clone deleted when it stops, whatever happened.

  A fact that cannot be found (the sandbox failed, timed out after 10
  minutes, or gave no answer) is kept as not found, with why. The Model
  may then ask the Owner for it if it matters.
  `grilling.fact_finding_started` and `grilling.fact_finding_stopped`
  record each sandbox in the Activity Feed. Fact-finding needs the GitHub App and `SANDBOX_GATEWAY_URL`.
  Without them the Manager is not offered it.
- **The documents.** As decisions settle, the Manager keeps the Floor's
  documents current on the session's own branch, `ai-office/grilling-<id>`
  (FR-80). A turn may also write `outline` (sections of the PRD, each in
  full; one given again replaces the section of its heading), `adrs` and
  `processes` (each replacing the one of its title). After every turn is
  kept, AI Office writes the files from the stored session, in plain code
  (`grilling/documents.ts`):
  - **The PRD:** `docs/product-requirements-document/<topic>.md`, with the
    outline, then every settled decision word for word. If the Floor
    already has a PRD of that name, the session writes
    `<topic>-grilling-<id>.md` beside it rather than replace it.
  - **ADRs:** `docs/architectural-decision-record/NNNN-<title>.md`,
    numbered on from the Floor's own (never rewriting one of them, even of
    the same title), written as the Floor's ADRs are
    (the decision, **Considered Options**, **Consequences**). An ADR is
    kept only when the Model says why it is hard to reverse
    (`hardToReverse`), surprising (`surprising`) and the result of a real
    trade-off (`tradeOff`). One without all three is left out, and the
    round's message says so. The reasons go in the pull request's body.
  - **The glossary:** `GLOSSARY.md`. Each term settled is written as soon
    as the turn that settled it is kept: in place of the entry of its
    name (its `**Term**:` line to the next blank line), or added under a
    heading named for the session. Without a glossary, a new one.
  - **Process docs:** `docs/processes/<title>.md`, the whole text. One of
    the name of an existing process doc replaces it, for the Owner to
    review in the pull request.

  AI Office, as the GitHub App, commits what changed (nothing, when
  nothing did) as the Owner with the Manager's `Agent:` trailer (ADR
  0002), on the session's branch, and pushes it. The first commit is
  made on the default branch, and later ones on the branch itself. The
  round's message says what was updated ("Updated on
  ai-office/grilling-3: GLOSSARY.md and …"). A write that fails (GitHub
  unavailable, say) never holds the session up. The round is asked, its
  message says why the documents could not be written, and the next turn
  writes them again. `grilling.documents_written` records each commit in
  the Activity Feed (**Pull requests**), without any document text.
- **The whiteboard.** While a session runs, the Floor's whiteboard (its
  page and the meeting room's in 3D) shows it above the Plans: the
  current round's questions with their status, its live outline, the
  decisions settled so far, and the branch its documents are kept on. It
  changes as the session and its documents' events arrive.
- **In the Office** (FR-83), the Manager sits at the meeting room's table
  for the whole session, the door shows "In session", and clicking the
  Manager, the table or the whiteboard opens the session chat. See
  [A Grilling Session in the meeting room](web-app.md#a-grilling-session-in-the-meeting-room).
  Each change to a session publishes `grilling.session_changed` (started,
  paused, resumed, a round asked, answers or decisions settled, ended),
  with its round and counts and never a question or answer.
- **Answering.** Each card has its own answer box and an **Accept
  recommended** button. **Send answers** sends what was written or
  accepted as one message, and **Recommended to all** accepts the rest of
  the round too. Typed messages work the same way, read in plain code
  (`readGrillingAnswers`): `3: CSV` (or `3.`, `Q3)`, `#3 -`), `3:
  recommended`, `recommended to all`, and a bare `recommended` when only
  one question is open. Lines after an answer continue it.
  - **Part of a round answered:** "Noted your answers to 1 and 3. Still
    open in round 2: 2 and 4." No model is called.
  - **Every question answered:** the Model writes the next round.
  - **A number not in the round, or "recommended" with several open:**
    a hint says what to send instead.
  - **Anything else** goes to the Manager's Model, with the session in its
    prompt, while the round is open (a question about a question, say).
    Once every question asked is answered, it asks for the next round.
    Commands such as "status" still work in a session.
- **Ending.** When a turn leaves no open questions, the chat says how many
  decisions are settled and asks the Owner to reply "confirm". "confirm"
  (or **Confirm and end** above the chat) ends the session. Anything else
  asks the Model for more questions. With the GitHub App, ending opens the
  one pull request with all of the session's documents first:
  - the documents are written a last time;
  - the App opens the pull request from the session's branch into the
    default branch, titled `docs: Grilling Session 3 on <topic>`. Its
    body lists the files, the decisions, the glossary terms and why each
    ADR is one;
  - `grilling.pull_request_opened` and an info Notice record it;
  - the session ends, and the chat links the pull request.

  If the pull request cannot be opened, the session does not end. It
  stays open, awaiting confirmation, and the chat says why: "confirm"
  tries again. A pull request already open from the branch is used, never
  a second one. The Manager never merges: merging is the Owner's.
- **The issues** (FR-81). Once the pull request is open and the session
  has ended, the Manager's Model drafts the GitHub issues that build what
  it settled, in the same answer to "confirm" (`grilling/issues.ts`):
  - **The draft.** One JSON object (`grillingIssuesTurnSchema`): vertical
    slices in build order, each with a title, "What to build",
    acceptance criteria, `blockedBy` (positions of earlier issues in the
    list) and the PRD sections and ADRs it cites. Plain code keeps them
    with the session as drafts, numbered 1 on (`draftIssues`): only
    earlier issues count as blockers, and only the session's own outline
    headings and ADR titles as citations, spelled as the session has
    them. An answer that is not a draft is sent back once; then the chat
    says why, and "draft the issues of session 3" asks again.
  - **Review.** **Read** shows them under **Issues**, each editable: its
    title, what to build, acceptance criteria (one per line) and the
    drafts it is blocked by. **Move up**/**Move down** reorder them,
    **Merge it into** merges one into another (in the other's place: its
    title, both texts, every criterion and citation once, everything
    either was blocked by, and drafts blocked by the merged one blocked by
    the other instead) and **Drop** drops one (drafts blocked by it then
    wait on what it waited on). These rules are `@ai-office/shared`'s
    `mergeIssueDrafts`, `dropIssueDraft` and `moveIssueDraft`. Drafts
    blocked by each other in a cycle, or by a draft not in the list,
    cannot be saved or approved. **Draft again** asks the Model for new
    drafts, in place of these, until one is filed.
  - **Filing.** **Approve and file** saves the edits, then sends "file the
    issues of session 3" (or "approve the issues", for the latest ended
    session). AI Office, as the GitHub App, files them in dependency
    order: each after the drafts it is blocked by, otherwise in the
    Owner's order (`issueFilingOrder`), labelled `ai-office`. Each body
    has **Context** (the session and its pull request), **What to
    build**, **Acceptance criteria** as a checklist, **Blocked by** with
    the issue numbers filed for the drafts it waits on, and **Cites** with
    the PRD's path and sections and each ADR's path. Each issue is kept
    with its draft as soon as it is filed, and `grilling.issue_filed`
    records it (in the Activity Feed under **Issues**).
  - **When GitHub fails** partway, filing stops, the chat says which were
    filed and why the rest were not, and "file the issues of session 3"
    (**File the rest**) files only the rest. Once one is filed, the drafts
    can no longer be edited or drafted again.
  - **Ready to become a Batch.** The chat ends with the command to hand
    them over, such as "complete issues 12 to 15". Nothing starts on its
    own: intake leaves issues the App opened alone, as they are not the
    Owner's (PRD §4). A Batch takes the issues the App filed on the
    Owner's approval as the Owner's (`approvedIssues`, the Batches'
    `approved` option), and its Plan orders them, the issue bodies'
    "Blocked by" before it.
- **Pausing and resuming.** "pause the session" (or **Pause session**)
  pauses the running one. Until it is resumed, the chat is the Manager's
  own again. "resume the session" resumes the latest paused one, "resume
  session 3" that one (or **Resume** in the list). Resuming shows the
  open round's cards again. A Floor runs one session at a time:
  `/grilling`, or any other Skill that starts one, while one runs is
  refused with where it stands.
- **Ending early (FR-83a).** "end the session" (or **End session**, which
  asks first) ends the running one now, or the latest paused one when
  none runs, whatever is still open: "confirm" waits for no open
  questions, this does not. What has settled is kept and its documents'
  pull request opened, as on "confirm", and the chat names the questions
  left open. If the pull request cannot be opened, the session stays as it
  was, and "end the session" tries again. The Floor walks back to its
  desks, as on a pause.
- **The prompt.** While a session runs, the Manager's prompt holds the
  grilling Skill's instructions, those of the Skill that started it when
  that was not `/grilling`, and a "The Grilling Session" section
  written from the stored session: its topic, every settled decision word
  for word, its glossary terms, and its open questions with their
  recommended answers. It also holds the facts found in the repository,
  each with its answer word for word, and the documents: the branch, the
  PRD's outline word for word, and the ADRs and process docs by title. A
  `/to-tickets` session's section quotes the documents it read instead.
- **Kept.** Sessions are kept in `grilling_sessions`, one row each, with
  their questions, decisions, terms, facts, outline, ADRs and process docs
  as structured data, and `documents`: where they stand on GitHub (the
  branch, the files and commit last written, the pull request and why the
  last write failed, if it did). Migrations:
  `0048_context_usage_skills_and_grilling`, `0061_grilling_facts`,
  `0062_grilling_documents` and `0063_grilling_issues`, which adds
  `issues`: the drafts in the Owner's order, each with the issue filed for
  it, when they were drafted and approved, and why filing last stopped,
  if it did. `skill` is the built-in Skill that started it, and `sources`
  the documents a `/to-tickets` session read. Every chat message of a
  session names it (`manager_chat_messages.grilling_session_id`, and
  `grilling_round` for a round's message). Ended sessions are kept too.
  **Grilling Sessions**, beside the chat, lists them newest first with
  their status, rounds, decisions and open questions. **Read** opens one in
  full: its decisions, glossary terms, the facts found in the repository,
  its documents (the branch, the pull request, the outline, ADRs and
  process docs), its issues, each round's questions and answers, the
  questions not yet asked, and the conversation.
- **API.** `GET /api/floors/:floorId/grilling-sessions` lists a Floor's
  sessions. `GET /api/floors/:floorId/grilling-sessions/:sessionId` gives
  one in full (`questions`, `decisions`, `terms`, `facts`, `outline`,
  `adrs`, `processes`, `documents`, `issues`, `sources`) with its
  `messages`, or `404 grilling_session_not_found`. Both give each
  session's `skill`.
  `PUT /api/floors/:floorId/grilling-sessions/:sessionId/issues` keeps the
  Owner's edited drafts (`{drafts}`, in their order) and answers the
  session: `400 grilling_issues_invalid` for drafts that cannot be filed,
  `409 grilling_issues_not_editable` before they are drafted or once one
  is filed, and `409 reply_in_progress` while the Manager answers.
  Sessions are started, answered, paused, resumed and their issues
  drafted and filed through the chat's own messages, so there is no
  route for those. Every chat message has `grilling`: null outside a
  session.
- **Credentials.** The topic, the Model's questions, answers, decisions,
  terms, facts to find, documents and draft issues, the facts found, and
  the Owner's answers and edited drafts are redacted before they are
  kept, sent, committed or filed.

## Direct chats and the Terminal

Besides the Manager chat, the Owner can talk one to one with any of a
Floor's Agents, and with the AI itself in the **Terminal**
(`apps/web/src/direct-chat.tsx`, `@ai-office/orchestrator`'s
`createDirectChats`). There are no commands, Skills or Grilling Sessions:
every message goes to a Model through the AI Gateway, and its reply
streams in as the Manager's does.

- **An Agent's chat** opens from its card in the Office (**Chat with Bo**)
  or at `/floors/<floor>/agents/<agent>/chat`. It asks the Agent's own
  Model with the Agent's own Gateway Key, so it is attributed to the Agent
  and its Floor and counts against its Token Caps. Its prompt says who the
  Agent is, its Role's description and instructions, and the Owner's extra
  instructions for it, and that it cannot run tools or change the
  repository from the chat. A paused Agent, or one with no Model, is
  answered with why. The Manager's own card opens the Manager chat.
- **The Terminal** is in the navigation (`/terminal`): the Owner asks any
  AI Provider's default Model (Claude's to start with), chosen beside the
  box. Its calls present the Terminal's own Gateway Key, made the first
  time it is used and kept sealed like the Communications Agent's (kind
  `terminal`); the request history shows them as the Owner tool
  "Terminal". A Model the Terminal does not offer is refused.
- **A status line** heads each, as the Manager chat's does (the same
  `ChatStatusLine`; compact in the 3D Office's panel): the Model, the
  chat's **Context Usage**, the tokens, and the 5-hour and weekly windows
  of the subscription that served its latest request. A direct chat is a
  conversation of its own, apart from the Agent's sandbox session, so its
  model calls name the session `direct-chat`, which the Agent's own
  Context Usage leaves out; the chat's is its latest answered call's whole
  prompt against its Model's context window, from the AI Gateway's request
  history (`usage` in the chat's `GET`; none before the first reply or
  since a `/clear`). An Agent's tokens are against its Token Caps; the
  Terminal's key has none, so it shows its tokens today and this month
  (the Owner tool "Terminal" in `GET /api/office/token-caps`). Each request
  of the caller's on the AI Gateway's live request stream (by Agent, or
  `?ownerTool=Terminal`) reads them all again.
- **`/clear`** starts the conversation the Model is given afresh, shown as
  a divider; the page keeps every message. The Model is given the latest
  50 messages since the latest clear.
- **Kept** in `direct_chat_messages`, by chat (`agent:<id>` or
  `terminal`); an Agent's chat goes with its Floor. The Owner's words are
  redacted before they are kept or sent, and never logged. One message is
  answered at a time.
- **API.** `GET /api/floors/:floorId/agents/:agentId/chat` and `GET
  /api/terminal` give who answers (`name`, `aiProvider`, `model`), the
  latest 200 messages, any reply being written, its `usage` (the latest
  answered call's `model`, `inputTokens`, `contextWindow`, `contextUsage`
  and `aiAccountId`, or null) and, for the Terminal, its `models`. `POST …/messages` with `{"text"}` (and, for the Terminal, an
  optional `"model"`) answers `201 {"message","reply"}`: `reply` is null
  while the Model's streams. `GET …/stream` is the stream, with the Manager
  chat's `message`, `pending` and `delta` frames. An unknown Agent answers
  `404 agent_not_found`, a message while one is answered `409
  reply_in_progress`, and a Model the Terminal does not offer `400
  model_not_offered`.
