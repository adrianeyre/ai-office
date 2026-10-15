# The issue pipeline

From issue to merged pull request: intake, triage, routing between work Roles, sandboxes, reviews, QA, the designer, docs, the Merge Policy and the Manager's watchdog. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## Issue intake and the pipeline

With the GitHub App configured, the server checks every Floor in use for
open issues labelled `ai-office`, every 60 seconds (PRD FR-8). Each one
not yet in the pipeline is triaged by the Floor's Manager
([below](#triage)). Once it is clear enough to work, it is labelled
`needs-work`, recorded as `issue.picked_up`, and queued for an Agent.

- **Only the Owner's issues.** Issue text is untrusted. An issue opened
  by anyone else is ignored unless the Owner applied the `ai-office`
  label personally: the latest `labeled` event for it must be the
  Owner's. The Owner is GitHub user `adrianeyre` by default. Issues the
  GitHub App filed from a Grilling Session are ignored here too: they
  wait for the Owner to hand them to the Manager as a Batch. So are the
  issues the Manager files for a request in its chat: they enter work
  only through that request's
  [Batch](batches-and-memory.md#batches-from-the-manager-chat).
- **Only the text the Owner approved.** Anyone who can edit an issue can
  change it after the Owner labelled it. So every Agent, and the
  Manager's triage and Plans, work the version of its title and body the
  Owner approved, never whatever it says now (pen-test finding P1-5).
  That is the latest version the Owner wrote, or the GitHub App (an issue
  AI Office filed), or anyone wrote before the Owner's latest `ai-office`
  label. GitHub keeps each version of an issue (its edit history, read
  through its GraphQL API, and its renamed events). An edit by anyone
  else after the label is not worked until the Owner removes the
  `ai-office` label and adds it again. An issue whose approved version
  cannot be told (edited in the same second as the label, or deleted from
  its history) is not worked either: intake ignores it, a Batch leaves it
  out, and a Stage that meets one fails with that reason.
- **Settings.** General Settings' **Intake** card sets the Owner's GitHub login
  and the interval, from 10 seconds to an hour (`GET` and `PUT
  /api/office/intake`). Changes apply from the next check, without a
  restart.
- **Labels.** Intake creates the pipeline's labels on each Floor's
  repository if they are missing: `ai-office`, the stages,
  `in-progress`, and the [Merge Policy](#the-merge-policy)'s overrides,
  `ai-office:auto-merge` and `ai-office:manual`.
- **Batches.** An issue an open [Batch](batches-and-memory.md#batches-and-plans) holds, waiting
  for its Plan's approval or for the issues it depends on, is left for
  the Batch to start, labelled `ai-office` or not.
- **Webhooks (optional).** When GitHub can reach AI Office, the GitHub
  App's webhooks make it act at once rather than at the next check;
  the checks carry on regardless, in case a delivery is lost. General Settings'
  **GitHub webhooks** card turns them on with the App's webhook secret
  (`GET` and `PUT /api/office/webhooks`), which is kept sealed with
  `ENCRYPTION_KEY` and never sent back. GitHub delivers to `POST
  /api/github/webhooks`, which needs no session: a delivery is believed
  only when its `X-Hub-Signature-256` matches the secret, checked over
  the raw body, and is refused with `401` otherwise (a `404` while
  webhooks are off). A sender whose deliveries fail that check 20 times
  in ten minutes is refused with `429`, unverified and unlogged, until
  ten minutes after its first; a delivery that verifies, or saving the
  card, forgets its failures. A signed delivery about a Floor in use
  starts:
  - **intake**, for an issue opened, reopened, labelled, edited or
    transferred, and for a pipeline label deleted or renamed (which
    intake then creates again);
  - **the Batches' check** for issues whose dependencies are done, for
    an issue or pull request closed;
  - **the [Merge Policy](#the-merge-policy)'s look at CI**, for any
    other pull request change, a check run or a check suite, if it is
    waiting for CI on that Floor;
  - **a `repository.changed` event**, for a push, a pull request change,
    a check run or a check suite, on which the
    [Branches page](events-and-chat.md#the-branches-page) reads the
    Floor's branches again.

  A webhook only says when to look: intake and the pipeline still read
  the issue and its labels from GitHub, so a delivery's payload is
  trusted no further than its signature. A delivery is acted on once:
  GitHub signs the body but not `X-GitHub-Delivery`, so AI Office
  remembers the SHA-256 of each body it took (the last 10,000, in
  memory), and the same body again is answered `202` and starts nothing,
  whatever delivery id it carries. Setting the App up for them is
  in [setting up the GitHub App and your Floors](../processes/setting-up-a-floor.md#webhooks-optional).

The labels on GitHub are the source of truth for where an issue is
(FR-18). `createPipeline` (in `@ai-office/orchestrator`) reads them
before every move, applies the move on GitHub, and records it as
`issue.label_changed`:

```text
needs-work → needs-review → needs-qa → needs-docs → ready-to-merge
     ↑______________|____________|                         |
                    ↑______________________________________|
any stage but needs-human → needs-human
```

- The first four labels are the four Stages' (work, review, QA and docs;
  [ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)).
  An Agent works issues at its Role's Stage, whatever the Role is called.
- A Floor without an Agent in the QA or docs Stage skips it. A reviewer,
  QA or a designer sends an issue back to `needs-work`. The
  [Merge Policy](#the-merge-policy) sends one back to `needs-review` when
  commits were pushed after its reviewers approved it, and their approval
  then brings it straight back to `ready-to-merge`.
- A stage may be worked by more than one Role in turn, on its one label
  (ADR 0003; `stageRoles`): at `needs-qa`, the QA Stage's Agents, then a
  [designer](#the-designer) on a Floor with one. The designer is the
  built-in work-Stage Role; this design review at `needs-qa` is the one
  piece of work the pipeline gives a Role by name.
- `needs-work` was `needs-code` before Roles were data. AI Office renames
  the old label on each Floor's repository as it starts (see
  [Labels AI Office creates](../processes/setting-up-a-floor.md#labels-ai-office-creates)).
- Review cannot be skipped. Only the Owner moves an issue out of
  `needs-human`, on GitHub. Any other move is refused with
  `illegal_transition`.
- An Agent holds an issue with `in-progress` while it works it, and
  moving on releases it. An issue with two stage labels is refused
  rather than guessed at.

### Triage

Before work starts on one of the Owner's issues, the Floor's Manager
checks it is clear enough to work, and sets its priority (PRD FR-23;
`createTriage` in `@ai-office/orchestrator`):

- **Clear enough to work** means acceptance criteria are present (as a
  list, or unmistakably in the text) and the scope is bounded: one change
  one Agent can finish in one pull request.
- **Its priority** is `high`, `normal` or `low`. The work queue starts
  higher-priority issues first within a Floor's priority ([below](#the-work-queue)).
- **The Decision Model judges first, while it is on** and the Manager is
  not paused (FR-17; see
  [The Decision Model](ai-gateway.md#the-decision-model)): Jev is asked,
  with the Manager's own Gateway Key, whether the issue is clear (yes when
  it is at least 50% likely to be), how soon to work it, and what it most
  lacks, which becomes the Owner's question (its acceptance criteria, what
  to build, or where the work stops). The comment says the Manager triaged
  it with the Decision Model, and how likely Jev found it clear. When Jev
  cannot be asked, the Manager's Model judges, as below.
- **The Manager's Model judges** otherwise, through the AI Gateway with the
  Manager's own Gateway Key, so the call is attributed to the Manager and
  the issue and counts against the Manager's Token Caps. Its prompt quotes
  the issue as untrusted text, redacted first (a credential pasted into
  an issue never reaches a model), and its answer must be one JSON object
  (`triageVerdictSchema` in `@ai-office/shared`): `clear`, `priority`, a
  `reason`, and the `questions` an unclear issue asks (1 to 5). An answer
  that is not one is sent back once.
- **Plain code decides what it can.** An issue with no description is
  unclear, and no model is asked. When the Manager's Model cannot be asked
  (the Manager is paused or has no Model, or the Gateway refuses the
  call, say at a Token Cap or with no AI Account), or it answers twice
  with no valid triage, AI Office's own rules judge: clear, at `normal`
  priority, only when the issue lists acceptance criteria (a line naming
  them, or a task list).
- **A clear issue** goes into the pipeline at `needs-work`.
- **An unclear issue waits**, out of the pipeline and with nothing
  queued. The Owner gets an action Notice, "Unclear issue needs your
  input: #N …", linking the issue and the Manager, and the issue gets a
  comment with the Manager's reason and questions. Later checks leave it
  alone, asking no model, while its title and body are unchanged.
- **Once the Owner edits it** (its title or body), the next check triages
  it again, and the earlier Notice is taken off the board.
- **Work it as it is**, the Notice's action, has the issue picked up as
  it is at the next check, at the priority the Manager set.

Every decision is a comment on the issue (starting `<!-- ai-office:triage
-->`) and an `issue.triaged` event in the Activity Feed, naming who
judged: the Manager's Model, the Decision Model, AI Office's rules or the
Owner. Comments are
redacted, and a comment GitHub refuses never stops triage. Each issue's
latest triage is kept in `issue_triage`, so a waiting issue keeps waiting
across a restart.

### Routing between work Roles

When a Floor's team has more than one work-Stage Role, such as a
merchandiser and a copywriter, a clear issue also needs the Role that
works it (PRD FR-23,
[ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)).
Its work then goes only to Agents in that Role
([dispatch](#the-work-queue)).

- **A `role:<name>` label forces it.** Intake puts a `role:<name>` label
  (such as `role:copywriter`) on each Floor's repository for every work
  Role on its team, and makes one for a work Role added later. An issue
  with one of them goes to that Role, and the Manager's Model is not
  asked to choose. A label names a Role by its name or id, in any case.
- **Otherwise the Manager chooses, in the same triage.** Its prompt lists
  the Floor's work Roles with their one-line routing descriptions, and
  its answer adds `roles` (the ids of the Roles that could work the
  issue, best first) and a `roleReason`. One Role is its choice.
- **When it cannot tell** (it names several Roles, or none), the issue
  waits, out of the pipeline, and the Owner gets one action Notice,
  "Choose the Role to work #N …", with a button for each candidate Role
  (**Give it to the copywriter**; at most four, the Roles it named or
  else every work Role). When no model judged (AI Office's rules
  triaged it), the Owner is asked too. Choosing one sends the issue on:
  the server wakes intake, which picks it up at once for that Role.
  Adding a `role:<name>` label does the same at the next check, and takes
  the Notice off the board. Later checks ask nothing more while it waits.
- **A Floor with one work Role never asks.** Its issues go to that Role
  with no routing in the prompt, no comment about it and no event, as
  before.
- **A Batch's Plan may give the issue its Roles**, several in turn on
  one branch ([several work Roles on one issue](batches-and-memory.md#several-work-roles-on-one-issue)).
  They settle its Role ahead of any label, and the Model is not asked to
  choose; the work goes to the Role whose turn it is.
- **A Contractor's one-off Role** ([Contractors](floors-and-agents.md#contractors))
  is given work only by its Batch's Plan: it gets no `role:` label, the
  Manager's Model never chooses it, and its Contractor takes no other
  work, even for an issue no Role was chosen for.

Each choice and its reason is in the triage's comment on the issue
(`### Role: copywriter`, or `### Role: waiting for the Owner` with the
candidates and how to choose), or a comment of its own when the Owner
chooses or labels a waiting issue; and an `issue.routed` event in the
Activity Feed: "Ada gave #4 to the copywriter Role", with "(by its role
label)", "(the Owner's choice)" or "(by its Batch's Plan)". The chosen Role is kept with the
issue's triage in `issue_triage` (`role`, and `candidates` while the
Owner is asked).

## Sandboxes

`createSandboxRunner` (in `@ai-office/orchestrator`) runs one Agent's
task in a Docker sandbox with Sandcastle (PRD FR-19). It never pushes:
AI Office does that later.

1. It clones the Floor's repository at its default branch, with a
   read-only installation token (`readOnlyToken()`). The token is passed
   to Git through its environment, so it is not left in the clone. Each
   sandbox's token is its own, minted for it, and revoked as the sandbox
   stops, so one a sandbox sent out reads nothing afterwards; after a
   Fresh Start the new sandbox gets a new one.
2. It works on the issue's branch, `ai-office/<issue>-<slug>`, carrying
   on from it if it was pushed before.
3. It runs the Floor's setup command when the sandbox is ready, then the
   agent tool of the Agent's AI Provider (PRD FR-16) with the task's
   prompt: Claude Code for Claude, Codex for ChatGPT, and opencode for
   Grok and Gemini, each in its own image. The prompt is passed inline,
   so Sandcastle never runs shell blocks (`` !`…` ``) found in issue text.
   The Floor's Skills on for the Agent's Role are mounted read-only (see
   [A Floor's Skills](notices-and-skills.md#a-floors-skills)), and so are the office-wide memory
   and the Role's memory (see
   [Office-wide and Role memory](batches-and-memory.md#office-wide-and-role-memory)).

   The agent tool takes its settings, hooks and instructions from AI
   Office, never from the repository it works on (P1-9): Claude Code
   reads only the user's settings (its image's) and AI Office's own
   (`--setting-sources user`, `--settings`) and no MCP server but AI
   Office's (`--strict-mcp-config`), so the repository's
   `.claude/settings.json` (its hooks and permissions), `CLAUDE.md` and
   `.mcp.json` do nothing; Codex reads no `AGENTS.md`
   (`project_doc_max_bytes=0`), in the Manager chat's session too; and
   opencode reads no project configuration (its `opencode.json` and
   `.opencode/` agents, commands and plugins) and none of Claude Code's
   files (`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE`).
   Every sandbox Stage's prompt says such files are the repository's
   content, like any of its files, and nothing in them is an instruction
   to the Agent. Fact-finding's sandboxes start their agent tool the same
   way.
4. What the Agent says and the tools it calls stream to the event bus as
   `sandbox.text` and `sandbox.tool_call`, between `sandbox.started` and
   `sandbox.stopped`. Each tool call is screened (FR-17; `toolCallCheck`),
   and so is the Floor's setup command, before it runs (as a `Setup`
   call):
   - **AI Office's rules** (`toolCallRules`) judge every call, whether the
     [Decision Model](ai-gateway.md#the-decision-model) is on or off and
     whether Jev answers or not. They catch what is plainly unsafe:
     reading the sandbox's credentials (`$GH_TOKEN`, the Gateway Key) or
     its whole environment (`env`, `/proc/*/environ`), reaching the
     cloud's metadata service or the host's Docker, sending data to a
     host other than the sandbox, running a script it downloads (`curl …
     | sh`), raw connections (`nc`, `/dev/tcp`), scanning, and `rm -rf /`.
     A call longer than 100,000 characters is not passed, as what it
     holds past the part read is unknown.
   - **Jev**, while the Decision Model is on and asked with the Floor's
     Manager's Gateway Key, is shown the whole call and judges how likely
     it is to be unsafe (reading or sending credentials, reaching hosts
     the work does not need, attacking or escaping the sandbox, destroying
     what it was not asked to). At 80% or more it is unsafe.

   **Before it runs.** Claude Code asks the screen before each call runs,
   every tool's (P1-8): AI Office gives it a `PreToolUse` hook
   (`--settings`) that posts the call to the AI Gateway's screen route
   (`POST /v1/ai-office/tool-calls`) with the Agent's Gateway Key and its
   session. A call judged unsafe never runs, and so does one the screen
   cannot be asked about (the route cannot be reached, the call is from
   no running session of that Agent, or it is not judged within 90
   seconds). Codex and opencode give AI Office no such hook: their calls
   are screened as they stream, so such a call has already run when it is
   judged. Each call is judged once, though it is asked about and seen in
   the stream.

   A call judged unsafe stops the run and it fails, "The sandbox for issue
   #N was stopped: the Decision Model judged a Bash call unsafe (97%
   likely)" or "… AI Office's rules judged a Bash call unsafe: it reads
   the sandbox's credentials", even if the Agent had finished; nothing it
   did is pushed, and the Agent is blocked with an action Notice. A
   Grilling Session's fact-finding and a research Contractor's sandbox are
   screened by AI Office's rules the same way, before each call runs where
   Claude Code asks, and keep no answer from a sandbox one stopped.
5. It returns the commits and the tokens used. On cancellation (an
   `AbortSignal`) or after an hour, the sandbox is killed and the clone
   deleted.

**The sandbox's environment holds only:**

- the Git identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`);
- `GH_TOKEN`, which can read the repository but not write, and is the
  sandbox's own, revoked as it stops;
- the way to models, through the AI Gateway only (ADR 0001, PRD FR-16),
  as the agent tool reads it. Each tool sends `x-ai-office-issue:
  <issue>` (and `x-ai-office-pull-request: <PR>` once the issue has an
  open pull request) and `x-ai-office-session: <sandbox id>` on every
  model call, so the Gateway keeps the run on one AI Account (FR-37).
  What each call counts against (FR-42) is not its headers' word: the
  runner holds the issue and its pull request for the Agent at the
  Gateway while the sandbox runs, so every call its key makes counts
  against them, whatever it names (pen-testing G1-1; see
  [Gateway Keys](ai-gateway.md#gateway-keys)):
  - **Claude Code:** `ANTHROPIC_BASE_URL` (the Gateway's URL,
    `SANDBOX_GATEWAY_URL`), `ANTHROPIC_AUTH_TOKEN` (the Agent's own
    Gateway Key) and `ANTHROPIC_CUSTOM_HEADERS` (the headers).
  - **Codex:** `OPENAI_BASE_URL` (the Gateway's OpenAI API, `…/v1`),
    `AI_OFFICE_GATEWAY_KEY` (the Agent's Gateway Key) and
    `AI_OFFICE_ISSUE`, `AI_OFFICE_PULL_REQUEST` and `AI_OFFICE_SESSION`.
    `codex exec` is given a model provider of AI Office's own
    (`-c model_provider="ai_office"` and its settings): the Responses API
    at `OPENAI_BASE_URL`, with the key from `AI_OFFICE_GATEWAY_KEY` and
    each header from its variable. The Agent's effort (`minimal` to
    `high`) is `model_reasoning_effort`.
  - **opencode:** `OPENCODE_CONFIG_CONTENT`, a configuration whose only
    model provider is `ai-office`: the Gateway's OpenAI API through
    `@ai-sdk/openai-compatible` (Chat Completions, which Grok and Gemini
    accounts serve), with the Gateway Key and the headers. The Agent's
    Model is run as `ai-office/<model>`.

Every sandbox provider is wrapped to drop anything else, and a
repository's own `.sandcastle/.env` is deleted from the clone, so it
cannot pull the server's secrets in. **No AI Account credential ever
reaches a sandbox, under any name:** there is no key for one
(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`,
`CODEX_API_KEY`, `XAI_API_KEY` and `GEMINI_API_KEY` are dropped), the
key each tool is given must be a Gateway Key, and a sandbox whose environment holds any
value shaped like an AI Provider's credential (Anthropic, OpenAI, xAI,
Google, AWS keys and OAuth tokens), or holding one of the Owner's AI
Account credentials whatever its shape, is never started.

**What a sandbox reaches**
([ADR 0008](../architectural-decision-record/0008-sandboxes-reach-only-the-gateway-and-allowed-hosts.md),
[ADR 0006](../architectural-decision-record/0006-each-sandbox-has-a-network-of-its-own.md)).
Each sandbox is started on a Docker network of its own,
`ai-office-sandbox-<uuid>`, never Docker's default bridge, made just
before it and removed just after. That network is `internal`: it has no
route out of the host, to the internet, the local network or the
instance metadata service. The one other thing on it is the **sandbox
relay** (`docker/sandbox-relay/relay.ts`), a small Node script run from
the Node image, read-only and with no capabilities, which AI Office joins
to it under the name `sandbox-relay`. So a sandbox never reaches another
sandbox, of its own Floor or another's (pen-testing S2-5). The relay
itself is on `SANDBOX_NETWORK`, by default `ai-office-sandboxes`, also
internal, where AI Office finds it by its compose service; no sandbox is
on that network, and inter-container traffic is off on it.
`docker-compose.yml` starts the relay and creates that network, and
outside compose `docker-compose.dev.yml` does (`pnpm db:up`). A sandbox
is not started while the relay is not running. A crashed AI Office's
sandbox networks (labelled `ai-office.sandbox-network`) are removed the
next time it starts a sandbox. The relay:

- **Port 3047** is forwarded, byte for byte, to the AI Gateway: `app:3047`
  under compose, the Gateway on the host (`host.docker.internal`, with
  `GATEWAY_HOST` letting it in) outside it. So `SANDBOX_GATEWAY_URL` is
  `http://sandbox-relay:3047` either way.
- **Port 3128** is an HTTPS proxy, which the sandbox images name as
  `HTTPS_PROXY` (with `NO_PROXY=sandbox-relay`), so `npm`, `pnpm`,
  `pip`, `git` and `gh` use it. It relays `CONNECT` to port 443 of a
  host `SANDBOX_EGRESS_HOSTS` names (a name, or `*.domain` for every name
  under it), and answers anything else 403: another host, another port,
  an IP address, plain HTTP. Each connection, relayed or refused, is a
  JSON line in the relay's log (`docker compose logs sandbox-relay`).
  `.env.example` lists `registry.npmjs.org` and `api.github.com`; empty
  means none, and then a sandbox reaches the Gateway alone.

Every host on the list is one an injected Agent could send what it read
to, if it has an account there, so list only what Floors need. The
Manager's chat sessions, fact-finding and subscription model calls are
each started the same way, on a network of their own, so their web
fetches reach only those hosts too (their web search runs at the AI
Provider, through the Gateway).

**How a sandbox is started** (pen-testing S2-4). Every container AI
Office starts for an Agent takes the same flags, `sandboxHardening` in
`packages/orchestrator/src/sandbox/docker.ts`. That covers a task's
sandbox, a Grilling Session's fact-finding, a Manager chat session and a
subscription's model call:

- `--cap-drop ALL`: it holds no Linux capability, not even through a
  binary with file capabilities such as `ping` (`NET_RAW`);
- `--security-opt no-new-privileges`: a setuid binary in the image
  cannot raise its privileges;
- `--memory 4g` and `--pids-limit 4096`: one sandbox cannot take the
  host's memory or process table from the app, Postgres and the other
  sandboxes. The EC2 sizes in
  [Deploying to EC2](../processes/deploying-to-ec2.md#1-choose-an-instance)
  leave room for the default sandbox limit at 4 GB each;
- `--read-only`: the image's files cannot be changed. It writes only
  where it works: the mounted worktree (or, for a Manager chat, the tool's
  state), and its home (`/home/agent`) and `/tmp`. Each of those two is
  an anonymous volume of its own, which Docker fills from the image (so
  the agent tool and the Skills' folder are there) and removes with the
  container.

It still runs as AI Office's own user, never root, with Docker's default
seccomp and AppArmor profiles. Sandcastle's own Docker provider cannot
pass these flags, so AI Office starts the container itself
(`dockerProvider`) and Sandcastle runs its commands in it with
`docker exec`, as before.

Sandboxes use the Gateway's own port, `GATEWAY_PORT` (3047), through the
relay, never the app's address that the Owner's tools use. Compose sets
`SANDBOX_NETWORK` and `SANDBOX_GATEWAY_URL` (`http://sandbox-relay:3047`)
itself, whatever `.env` says; `.env.example` sets the same for
`pnpm dev`.

### Sandbox images

Each agent tool has a sandbox image (PRD FR-16):

| Agent tool | Dockerfile | Tag | Pinned version |
| --- | --- | --- | --- |
| Claude Code | `docker/sandbox-claude/Dockerfile` | `ai-office/sandbox-claude:6` | `@anthropic-ai/claude-code` 2.1.287 |
| Codex | `docker/sandbox-codex/Dockerfile` | `ai-office/sandbox-codex:6` | `@openai/codex` 0.162.1 |
| opencode | `docker/sandbox-opencode/Dockerfile` | `ai-office/sandbox-opencode:6` | `opencode-ai` 1.19.0 |

Each has:

- Node 26.10.0 and pnpm 12.10.0, `git`, `gh` and its agent tool, each
  from a pinned, checked artifact and never at a moving version: the
  Node image by digest; `gh` as one release checked against its SHA-256;
  pnpm and the agent tool with `npm ci` from the `package.json` and
  `package-lock.json` beside the Dockerfile, which pin each package's
  version and SHA-512 and name the only install scripts that may run.
  Claude Code and opencode are told never to update themselves;
- a non-root `agent` user, with the UID and GID of the user that runs AI
  Office, so files an Agent writes in the bind-mounted worktree belong
  to that user (Sandcastle refuses to start an image built for another
  UID). Under compose that is the app's `node` user, UID and GID 1000;
- no credential: the sandbox runner configures the tool from the
  sandbox's environment (above);
- the folder where the Floor's Skills are mounted read-only, made as
  `agent` (see [A Floor's Skills](notices-and-skills.md#a-floors-skills)).

```bash
pnpm sandbox:build                        # all three, as the user that runs AI Office
pnpm sandbox:build codex opencode         # only those named
AGENT_UID=1000 AGENT_GID=1000 pnpm sandbox:build   # for compose's `node` user, before `docker compose up`
```

Each build is tagged as `sandboxImages` (in `@ai-office/orchestrator`)
names it, the tag `dockerSandbox()` runs for that agent tool. A tool's
version is never picked at build time: to move it, change its
`package.json`, run `npm install --package-lock-only --ignore-scripts`
beside it (and allow the new version's install script in `allowScripts`
where it has one), and give the image a new tag version.

The Claude Code and Codex images also run the Manager chat's read-only
session, on a read-only clone of the Floor's repository (see
[the Manager chat](events-and-chat.md#a-read-only-session-as-claude-code-is)).

`pnpm test` checks each Dockerfile and lints it with hadolint (installed,
or else its image on Docker). It also fails when a Dockerfile changes
without a new tag version. With `AI_OFFICE_SANDBOX_IMAGE_E2E=1` it
builds each image and runs its tool's `--version` as `agent`.

### The work queue

Picked-up work waits in the `work_queue` table, so it survives a
restart (PRD FR-22).

- **The limits.** No more sandboxes run at once than the office-wide
  limit: 3 by default, set in General Settings' **Sandboxes** card (`GET` and
  `PUT /api/office/sandboxes`). A Floor may also have a lower limit of its
  own, its **Concurrency limit** setting (`concurrencyLimit` in `PATCH
  /api/floors/:floorId`, empty for none): no more of its sandboxes run at
  once, whatever room the office has. A Floor limit above the office's
  changes nothing. A new limit applies at once.
- **Order.** Waiting work starts as sandboxes free up, by its Floor's
  **priority** (0 to 10, higher first, in each Floor's settings), then
  its issue's priority from [triage](#triage) (`high`, `normal`, `low`),
  then oldest first.
- **Dispatch.** The Floor's Manager gives each piece of work to an Agent
  whose Role is in the label's Stage (work, QA or docs), or in the Role
  the work names (a designer's review, at `needs-qa`; its `role` column),
  by rules in plain code (`chooseAgent` and `rebalance` in
  `@ai-office/orchestrator`; PRD FR-23), so the Agents of a Stage share
  the work. It goes by the Role's Stage, never its name ([ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)):
  a Role the library adds in the work Stage is given work as a coder is.
  An issue's work-Stage work goes only to Agents in the work Role
  [routing](#routing-between-work-roles) chose for it, while the Floor
  has any in that Role (when it has none any more, any work-Stage Agent
  may take it); with no Role chosen, a Floor's work-Stage Agents share
  its work as one team. A designer's review goes only to designers, never
  to the QA Stage's Agents:
  - new work goes to the enabled Agent with the least work (queued or
    running), one not paused at a Token Cap if there is one, the oldest
    among equals;
  - work waiting for an Agent that cannot start it (busy with other work,
    paused in the Agent editor or at a Token Cap, leaving its Floor, or
    removed) moves to an Agent of its Stage, and its issue's work Role,
    that is free: enabled, not paused or leaving, with nothing queued or
    running. Each free Agent takes one, in the order work starts. Work
    waiting for an Agent that has been removed never starts for it.

  Each assignment is an `issue.assigned` event in the Activity Feed. An
  Agent works one task at a time, no work starts for a paused Agent, and
  `agent.queue_changed` records how many wait for each.
- **Restarts and archiving.** Work left running by a server that
  stopped is queued again when it starts. Work on archived Floors does
  not start.
- **Review rounds.** Work at `needs-review` is queued too, but uses no
  sandbox, so it starts whatever the limit. It is the Floor's required
  reviewers' work, for no one Agent, and waits while any of them is
  paused at a Token Cap.
- **The Merge Policy.** Work at `ready-to-merge` is queued the same way,
  for no Agent and with no sandbox (see [The Merge Policy](#the-merge-policy)).

The server starts work only once Agents can do it: with the GitHub App
configured and `SANDBOX_GATEWAY_URL` set. Until then it queues work
without starting it.

### From issue to pull request

Work at `needs-work` is done by the coder flow (`createCoderFlow` in
`@ai-office/orchestrator`; PRD FR-19, FR-21, §5 scenario 2):

1. The Floor's coder Agent holds the issue (`in-progress`) and works it
   in a sandbox. Its prompt (`coderPrompt`) has the issue, quoted as
   untrusted text it cannot break out of, the Floor's branch, setup and
   test commands, and the commit rules: Conventional Commits, `Refs #N`
   and the Agent's `Agent:` trailer. It holds no credential.
2. AI Office pushes the branch as the GitHub App (`publishBranch`). The
   branch is first fetched into a fresh repository of AI Office's own,
   so nothing the Agent left in its clone's Git config or hooks runs
   with the token that can write. There each new commit is made again,
   authored and committed as the Floor's Git identity, with the
   `Agent:` trailer, whatever the Agent set. Its content and author
   date are kept, and commits already on GitHub are left alone. Its
   message is kept too, but for any line naming who made the commit:
   an `Agent:` line, or a person's such as `Co-authored-by:` or
   `Signed-off-by:`, which the Agent may write but only AI Office may
   say in a commit authored as the Owner. Those are dropped, so the
   `Agent:` trailer AI Office adds is the only one.
   - **Rebased onto merged work first** (PRD FR-25.5). Before review the
     branch is rebased onto the default branch as GitHub has it, if that
     has moved on since the work began (an earlier issue of its Batch it
     overlaps was merged, say). Its commits are replayed there, committed
     as the Floor's Git identity, in a checkout of AI Office's own with
     hooks off, and the branch is pushed over what GitHub had, with a
     lease on it. A branch on GitHub holding commits the Agent never saw
     is not replaced: the push is refused, as before.
   - **A conflicting rebase** is given up: the branch is pushed as the
     Agent left it, and the coder's Handoff tells the reviewers which
     files conflict and that it needs the default branch merged in before
     it can merge.
3. It opens one pull request for the issue, as the App, with
   `Closes #N` and a link to the Agent's live view. Later work on the
   issue updates that pull request.
4. It moves the issue to `needs-review`, which lets it go, queues its
   review round, and raises an info Notice, "PR #N opened", linking the
   issue, the pull request and the Agent.

When the issue's Plan gives it [several work Roles](batches-and-memory.md#several-work-roles-on-one-issue),
each but the last stops after step 2: the branch is pushed as it is (not
rebased), the Agent's Handoff is kept for the next Role, and the issue is
let go at `needs-work`, its work queued again for the next Role's Agent,
which works on the same branch. Only the last opens the pull request.

`branch.pushed` and `pull_request.opened` record steps 2 and 3 in the
Activity Feed; `branch.pushed` says whether the branch was already on the
default branch, was rebased onto it (and at which commit), or conflicted
(in which files). If anything fails (the sandbox, a run with no commits, a
refused push), the issue is let go at `needs-work`, the Agent's status
becomes `blocked`, and an action Notice, "Agent blocked", says why.

### Reviews

Work at `needs-review` is a review round by every one of the Floor's
required reviewer Agents (`createReviewFlow`; PRD FR-20, FR-27). It
holds the issue while they review, all at once:

1. **No sandbox.** Each reviewer makes model calls through the AI
   Gateway (a Messages request, which the Gateway serves from an AI
   Account of the reviewer's AI Provider), with its own Gateway Key, so
   the calls are attributed to it, the issue and the pull request, and
   count against its Token Caps.
2. **Its prompt** (`reviewerPrompt`) has the issue, the pull request's
   diff and the files it changes as its branch leaves them (with line
   numbers), each quoted as untrusted text. The list of the files it
   changes heads the diff's quote: a path is the work Agent's to choose,
   and Git takes any byte but NUL in one, so a path could otherwise read
   as the prompt's own words (pen-test finding P1-6). Nothing from the
   pull request, a path included, can close the diff's quote or a file's.
   A long file is cut, saying so: the diff holds every change. It also
   quotes the repository's memory, the office-wide memory and the
   reviewers' Role memory.
   **Only a pull request shown in full is reviewed** (pen-test finding
   P1-11). Before any reviewer is asked, `notShownInFull` checks that the
   prompt can carry the whole diff: every file's diff, as GitHub gives
   it, and no more than 100,000 characters of it. A pull request whose
   diff is longer, or with a file GitHub shows no diff of (binary, or too
   large), goes to the Owner: it is labelled `needs-human`, and an action
   Notice says why ("Too large to review: PR #N (#I) cannot be shown to a
   reviewer in full (…), so it is yours to review."). No reviewer is
   asked and no approval is recorded, so the Merge Policy never merges it
   on an approval of part of it.
3. **A verdict, checked.** The answer must be one JSON object that
   `reviewVerdictSchema` (`@ai-office/shared`) accepts: `approve` or
   `changes_requested`, a summary, and comments, each `blocking` or
   `nit`, on a file and a line. An approval has no blocking comments;
   changes requested has at least one. An answer that is not a verdict
   is sent back once, saying what is wrong. If the second is not one
   either, an action Notice ("Agent blocked: … gave no valid verdict")
   links the issue and pull request, and the issue is let go at
   `needs-review`.
4. **Posted as the App.** Each verdict is a review on the pull request
   by the GitHub App (a comment review: the App cannot approve its own
   pull request; ADR 0002). Comments go inline on lines the diff shows,
   and in the review's body otherwise. `review.posted` records each one,
   with its counts and a link, in the Activity Feed.

A reviewer refused at its Token Cap puts the round back in the queue
until it resumes. With no required reviewer to review, or no open pull
request, an action Notice says so.

### The Review Loop

Each verdict is kept with its round, in `review_verdicts` (PRD FR-27,
FR-28; §5 scenarios 3 and 4). When every required reviewer has given its
verdict for the round:

- **All approve, no blocking comments** (nits alone approve): the issue
  moves on to `needs-qa`, and QA's work is queued (below). A Floor without
  a QA Agent goes on to `needs-docs`, or `ready-to-merge`.
- **Blocking comments, below the Floor's Round Cap** (3 by default): the
  issue goes back to `needs-work` and the coder's fix is queued. The coder
  works on the same branch and pull request, from a prompt with the
  blocking comments only, quoted, and the reviewers' Handoff. When a Plan
  gave the issue several work Roles, the fix goes to the one whose
  changes the blocking comments concern, or else to the last
  ([`fixRole`](batches-and-memory.md#several-work-roles-on-one-issue)). Its delivery
  queues the next round, in which every required reviewer reviews the new
  head commit.
- **Blocking comments at the Round Cap:** the issue and its pull request
  are labelled `needs-human`, and an action Notice, "Round Cap reached",
  links each round (a review from it, preferring one that asked for
  changes).
- **A stalled loop escalates early** (FR-28): from round 2, a round with
  blocking comments goes to the Owner as at the Round Cap, with a "Review
  Loop stalled" Notice saying why, when
  - its blocking comments mostly repeat the previous round's: more than
    half of them are on a file a blocking comment of the previous round
    was on, sharing at least 60% of its words; or
  - the fix since the previous round barely changed the diff: fewer than 3
    lines added and deleted between the two rounds' head commits (a
    one-line edit counts 2), as GitHub compares them
    (`RepositoryClient.compareCommits`).

  These are plain rules (`stallOf`, in `@ai-office/orchestrator`). While
  the [Decision Model](ai-gateway.md#the-decision-model) is on, Jev judges
  in their place (FR-17), with the Manager's Gateway Key: given both
  rounds' blocking comments and the lines the fix changed, it judges the
  round converging (back to the coder), repeating or stalled (to the
  Owner, the Notice saying the Decision Model judged it so). When Jev
  cannot be asked, the rules judge.
- **A conflict between Roles escalates** (FR-30; [below](#conflicts-between-roles)):
  below the Round Cap, a round whose blocking comments reject the coder's
  fix for a QA failure goes to the Owner, before the stall rules are
  checked.

**Handoffs** (FR-26) carry a short structured summary, never a transcript:
what changed, what to check, and known risks. They are kept in `handoffs`,
and each is a `handoff` event when its receiving Agents take it. An Agent
may also propose entries for the [repository's memory](batches-and-memory.md#repository-memory)
and for its [Role's memory](batches-and-memory.md#office-wide-and-role-memory) in its Handoff,
which are kept apart from it:

- **Work Role to work Role**, when a Plan gives an issue several in
  turn: emitted as the next Role's Agent starts, and quoted in its
  prompt.
- **Coder to reviewers**, emitted to each reviewer as a round starts, and
  given to them in their prompts. The coder writes it at the end of its
  run, in a `<handoff>` block its prompt asks for; what it leaves out is
  filled in from its commits and the issue (or the comments it fixed).
- **Reviewers to coder**, emitted as the coder starts its fix: who asked
  for changes, the blocking comments, the nits left aside, and how many
  rounds are left.
- **Reviewers to QA**, on approval, with the nits left aside: emitted as
  QA starts, and given to it in its prompt.
- **QA to coder**, when its checks fail: what failed, how to reproduce it,
  and how many rounds of QA are left; **QA to the designer** (on a Floor
  with one) or **to docs**, when they pass, emitted as that Agent starts.
- **Designer to coder**, when the UI needs changes it did not make itself:
  what it found, the changes to make, and how many rounds of design review
  are left; **designer to docs**, when the UI passes.
- **Docs on**, to `ready-to-merge`: what it documented.

A round interrupted by a restart, or by a reviewer that failed, carries on
at the same head commit: only the reviewers without a verdict there review
again. A round can send an issue back before its coder's own work has
ended; the work queue adds the fix once that work ends.

### QA

Work at `needs-qa` is done by the Floor's QA Agent (`createQaFlow`; PRD
FR-19, FR-28, §5 scenario 4), once every required reviewer approved. A
Floor without a QA Agent skips the stage: approval moves the issue on to
`needs-docs`, or `ready-to-merge` without a docs Agent.

1. **In a sandbox, on the pull request's branch.** The QA Agent holds the
   issue, takes the reviewers' Handoff, and works from a prompt
   (`qaPrompt`) that asks it to run the Floor's test command, add tests
   where the change has none (committing them, never changing the code
   under test), and exercise a web UI with Playwright when the repository
   has one. The issue and the Handoff are quoted, as for the coder.
2. **Its report.** It ends with a `<qa-report>` block: `Result: pass` or
   `fail`, a summary, and for a failure the steps that reproduce it
   (`parseQaReport`). A run without one blocks the Agent ("Agent blocked:
   … gave no QA result"), and the issue stays at `needs-qa`.
3. **Tests it added are pushed** as the coder's commits are (as the Owner,
   with its `Agent:` trailer), and the App comments the result on the
   pull request ("**QA passed**" or "**QA failed**", with the steps). Each
   round is kept in `qa_reports`, and is a `qa.reported` event in the
   Activity Feed.
4. **A pass** moves the issue on (`needs-docs` and its docs Agent, below,
   or `ready-to-merge`), with QA's Handoff; on a Floor with a designer, it
   stays at `needs-qa`, let go, and the [designer](#the-designer)'s work is
   queued. **A failure** goes back to `needs-work` with a Handoff:
   the coder's next prompt has a "QA feedback to fix" section with what QA
   found and the steps, quoted. Its fix goes through review again, then QA.

QA has its own **Round Cap of 3**, and an **overall cap per pull request**
counts its rounds of review and QA together: one fewer than the two caps
together (the Round Cap plus 2, so 5 by default). A QA failure at either
labels the issue and pull request `needs-human` with an action Notice,
"QA Round Cap reached" or "Overall cap reached", linking each round of
review and QA in order. (A review can never reach the overall cap first:
it sends work back only below its Round Cap, when QA has failed at most
twice.)

A QA Agent paused at a Token Cap stops at its run's end, keeps the tests it
committed, and its work waits, as the coder's does.

### Conflicts between Roles

When QA and the reviewers hold opposite positions on a pull request,
sending it round again only bounces the coder between them, so AI Office
stops the loop and hands it to the Owner (PRD FR-30): the issue and its
pull request are labelled `needs-human`, and an action Notice, "Review Loop
conflict between Roles: …", links each round of review and QA and shows
both positions side by side, each in its own words with a link to where it
was said. Two shapes count, by plain rules (`qaConflictOf` and
`reviewConflictOf`, in `@ai-office/orchestrator`; the Decision Model is not
asked):

- **QA against the reviewers.** QA fails a pull request that every reviewer
  approved in both of the last two review rounds, and its failure repeats
  the one before (its summary and steps sharing at least 60% of their
  words, as the stall rule compares comments). The Notice shows the
  reviewers' approval, then QA's failure with its steps. A failure that is
  new each round is not a conflict: it goes back to the coder, up to QA's
  Round Cap.
- **The reviewers against QA.** QA failed a round the reviewers approved,
  the coder fixed it, and the next review round has blocking comments,
  more than half of them on files the fix changed (as GitHub compares the
  head QA checked with the new one). The Notice shows QA's failure, then the
  reviewers' blocking comments. Blocking comments on something else are
  the Review Loop's own, and the coder fixes them as usual.

The caps come first: a round that also reaches the Round Cap, QA's Round
Cap or the overall cap is reported as that cap.

### The designer

On a Floor with a designer Agent (the Role library's built-in `designer`
Role, in the work Stage: added in Floor Settings, or in a starting team
such as Design system's), the designer reviews a pull request's UI once QA
has passed it (`createDesignFlow`; PRD FR-10, FR-18), besides taking its
share of the work as a work Role. It works on the QA Stage's label,
`needs-qa`, after the QA Stage's Agents (ADR 0003: the four Stages stay
fixed), so its work is queued with the Role `designer` (`designerRole`)
and goes only to designers. On a Floor with a
designer but no QA Agent, it takes the reviewers' approval instead. A Floor
without a designer skips it.

1. **In a sandbox, on the pull request's branch.** The designer holds the
   issue, takes QA's Handoff (or the reviewers'), and works from a prompt
   (`designPrompt`) that asks it to find the repository's style guide (a
   style guide or design document, design tokens, a theme or Tailwind
   configuration, the components the UI already uses; without one, the
   UI's existing look), read the branch's diff, start the UI as the
   repository does, and **take screenshots with Playwright** of each screen
   the change touches, at 1280 px and 390 px and in each state it adds.
   Screenshots stay in `/tmp/design-review/` in the sandbox and are never
   committed. It reviews them against the guide: colours, typography,
   spacing and alignment, components, states, phones and accessibility.
   A repository without a UI, or a change that touches none, passes.
2. **Its own fixes.** Small, contained styling fixes (CSS, a component's
   classes or props, design tokens) it commits itself, as `style` or `fix`
   commits; they are pushed as the Owner's commits with its `Agent:`
   trailer. Anything larger, or anything that changes what the UI does, it
   reports as changes for the coder.
3. **Its report.** It ends with a `<design-review>` block: `Result: pass`
   or `changes`, a summary, and for changes the numbered findings (screen,
   what is wrong, what the guide says, the component or CSS change)
   (`parseDesignReport`). A run without one blocks the Agent ("Agent
   blocked: … gave no design review"), and the issue stays at `needs-qa`.
4. **The App comments the result** on the pull request ("**Design
   approved**" or "**Design changes requested**", with any fixes it made
   and the changes for the coder). Each round is kept in `design_reviews`
   and is a `design.reported` event in the Activity Feed, linking the
   comment.
5. **A pass** moves the issue on (`needs-docs`, or `ready-to-merge`) with
   its Handoff. **Changes** go back to `needs-work` with a Handoff to the
   coder: its next prompt has a "Design feedback to fix" section with what
   the designer found and the changes to make, quoted. The fix goes
   through review and QA again, then the designer.

The designer has its own **Round Cap of 3** (`designRoundCap`): changes
still asked for in round 3 label the issue and pull request `needs-human`
with an action Notice, "Design Round Cap reached", linking each round of
review, QA and design in order. A designer paused at a Token Cap keeps the
fixes it committed, and its work waits.

### Docs

Work at `needs-docs` is done by the Floor's docs Agent (`createDocsFlow`;
PRD FR-18, FR-19), once a pull request has passed review and QA (and the
designer, on a Floor with one). A Floor
starts without one, and a Floor without a docs Agent skips the stage: QA's
pass (or the reviewers' approval, without QA) moves the issue straight to
`ready-to-merge`.

- **A small Model by default.** A docs Agent added without a Model of its
  own uses its AI Provider's small Model (`claude-haiku-5-5` for Claude;
  `smallModels` in `@ai-office/shared`), or the AI Provider's default
  where none is known. The Agent editor changes it like any other.
- **In a sandbox, on the pull request's branch.** It holds the issue, takes
  QA's Handoff (or the reviewers'), and works from a prompt (`docsPrompt`)
  that asks it to read the branch's diff from the default branch, update
  the README where the change affects it, add a changelog entry if the
  repository keeps one, and add or update the docstrings of the code the
  change adds or changes, changing documentation only.
- **Pushed, then `ready-to-merge`.** What it commits is pushed as the
  Owner's commits with its `Agent:` trailer, as the coder's are, and the
  issue moves to `ready-to-merge` with its Handoff (its `<handoff>` block,
  filled in from its commits and the Handoff it took), where the Floor's
  [Merge Policy](#the-merge-policy) takes it. A run that changes
  nothing still moves on: nothing needed documenting.
- A run that fails blocks the Agent with an action Notice, leaving the
  issue at `needs-docs`; a docs Agent paused at a Token Cap keeps what it
  committed, and its work waits.

### The Merge Policy

Work at `ready-to-merge`, queued by whichever stage passed the pull request
last (review, QA or docs), decides what becomes of it (PRD FR-29, FR-49;
§5 scenario 3; `createMergeFlow` in `@ai-office/orchestrator`). No Agent
does it and it uses no sandbox: it only asks GitHub, as the App. Each
Floor's **Merge Policy** is in its settings (`mergePolicy` in `PATCH
/api/floors/:floorId`):

- **Send to me** (the default): an action Notice, "PR #N awaiting your
  approval", links the pull request, the issue, its CI run and each round
  of review and QA, and offers **Approve and merge**
  (`approve_and_merge`). It is raised once, however often the work runs.
- **Merge automatically** (`auto_merge`): the GitHub App merges the pull
  request only when its gate lets it (ADR 0002; plain rules, `heldBack`
  and `ciOf`):
  - every required reviewer approved it in the latest round of its Review
    Loop (one made a required reviewer since has not), and approved the
    head commit it merges, not an earlier one;
  - no blocking comments remain from that round;
  - its CI passed: on its head commit, every check run passed (`success`,
    `neutral` or `skipped`, a check run again by its latest run), and
    every check the base branch requires ran (its branch protection's
    required status checks and its rulesets', `requiredChecks`);
  - no cap was exceeded: its review rounds are within the Floor's Round
    Cap, its rounds of QA within QA's, both together within the overall
    cap, and no Token Cap was reached on its work (a `cap.reached` event
    naming the issue).

  It waits for CI to finish, looking every 30 seconds for up to half an
  hour, and for up to five minutes for a first check to start when the
  branch requires none. A check that fails is final at once, and a
  condition other than CI that fails does not wait for CI. Then the App
  merges the head CI passed on (a newer head is refused, and checked
  first, the gate included), with a merge commit, so each of the Agents' commits stays the
  Owner's with its `Agent:` trailer; an info Notice, "PR #N merged
  automatically: …", records it. Otherwise the pull request goes to the
  Owner as with "send to me", the Notice saying why: "PR #2 awaiting your
  approval: not merged automatically, as CI check "test" failed.", linking
  the failed run.
- **Commits after the approval.** QA's tests, the designer's fixes and
  the docs Agent's changes are pushed after the reviewers approved, and
  an approval counts only for the head it was given for. So when all that
  stands in the way of an automatic merge is commits pushed since the
  reviewers approved, the issue goes back to `needs-review` with the
  Handoff that brought it to `ready-to-merge`, and every required
  reviewer reviews the head in a new round of the Review Loop. Their
  approval brings it straight back to `ready-to-merge`, past QA and docs,
  which have passed already; blocking comments send it to the coder, and
  the fix goes through QA and docs again. Such a round is never counted
  as stalled, since it follows an approval rather than a fix. When the
  Review Loop has no round left (the Round Cap, or the overall cap of
  review and QA together), the pull request goes to the Owner instead:
  "… not merged automatically, as commits were pushed after Grace
  approved it." Nothing is merged by policy that its reviewers were not
  shown (pen-test finding P1-1).
- **What CI runs is the Owner's to merge.** A pull request that changes
  what the repository's CI runs is never merged automatically, on any
  Floor and whatever its label: it goes to the Owner, "… not merged
  automatically, as it changes what CI runs." CI runs what the pull
  request itself says, so neither CI passing nor the reviewers are a
  check on it (pen-test finding P1-2). These are plain rules on the paths
  it changes (`runByCi` in `owner-only.ts`), a renamed file's old path
  too, at any depth and in any case:
  - CI definitions and Git hooks: `.github/`, `.gitlab-ci.yml`,
    `.circleci/`, `.buildkite/`, `Jenkinsfile`, `.husky/`,
    `.pre-commit-config.yaml` and the like;
  - scripts: anything under `scripts/`, `script/`, `ci/` or `bin/`, and
    any shell, PowerShell or batch script;
  - dependencies and the toolchain: `package.json`, every lock file,
    `pnpm-workspace.yaml`, `.npmrc` and every other `.…rc` file,
    `.nvmrc`, `.yarn/`, and their counterparts for Python, Ruby, Rust,
    Go, the JVM, PHP and dbt (`pyproject.toml`, `conftest.py`,
    `Gemfile`, `Cargo.toml`, `go.mod`, `build.gradle`, `pom.xml`,
    `dbt_project.yml`…), `Makefile`, `Dockerfile` and compose files;
  - tools' settings: every `*.config.*` and `*.workspace.*` file
    (`vitest.config.ts`, `eslint.config.js`, `playwright.config.ts`…) and
    `tsconfig*.json`.

  The code under test, the tests and the documentation are not among
  them: those are what the reviewers review. A pull request that changes
  more files than GitHub lists (3,000) goes to the Owner too, since what
  it leaves out could be anything.
- **What no reviewer could be shown is the Owner's to merge.** A pull
  request whose whole diff a reviewer's prompt cannot carry (longer than
  100,000 characters, or with a file GitHub shows no diff of) goes to the
  Owner, "… not merged automatically, as no reviewer can be shown it in
  full (…)", whatever approvals it has (pen-test finding P1-11;
  `notShownInFull`). The review round sends it to the Owner before any
  reviewer is asked, so this catches an approval recorded otherwise, such
  as before the check existed.
- **What later Agents read is the Owner's to merge.** In the same way, a
  pull request that changes what later Agents read as memory, Skills or
  their agent tool's instructions and settings goes to the Owner, "… not
  merged automatically, as it changes what later Agents read as memory,
  Skills or instructions." (pen-test finding P1-3; `readByAgents` in
  `owner-only.ts`). The repository's memory changes only through the
  Manager's curation and the Owner's merge (FR-53), and a Skill reaches
  Agents only once the Owner has reviewed it (FR-76): an Agent's own pull
  request changes neither by policy. These are anything under `.agents/`
  (the memory, `.agents/MEMORY.md`, and the repository's Skills),
  `.claude/`, `.codex/` or `.opencode/`, and every `CLAUDE.md`,
  `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `.mcp.json` and
  `opencode.json`, at any depth and in any case.
- **What a chat request built is the Owner's to merge.** An issue a chat
  request's Batch holds goes to the Owner whatever the Floor's policy,
  "… not merged automatically, as it was filed for a chat request." on an
  auto-merge Floor (pen-test finding P2-3, ADR 0009): its Plan was written
  by the Manager's session after reading content anyone may have planted.
  Only the Owner's own `ai-office:auto-merge` on the issue waives it. A
  Batch handed over by "complete issues" keeps the Floor's policy.
- **Per issue**, a label overrides the Floor's policy:
  `ai-office:manual` sends the pull request to the Owner, and
  `ai-office:auto-merge` merges it automatically (still through the gate).
  `ai-office:auto-merge` counts only when the Owner added it (the
  Owner's GitHub login, from General Settings' **Intake** card): anyone may ask for
  the Owner's approval, but only the Owner may waive it. With both labels,
  the Owner decides.
- **Approve and merge** has the App merge the pull request with a merge
  commit, as the Owner approved it: the gate is not asked again, though
  GitHub's branch protection still is. It merges only the head the
  Notice was raised for, which the Notice names, and tells GitHub so. If
  the branch has moved on since (anything pushed after the Owner was
  asked, an Agent's later work included), nothing is merged: the Notice
  is closed and a new one asks about the new head, "PR #N awaiting your
  approval: its branch moved on to abc1234 since you were last asked". If
  the issue has left `ready-to-merge` (it went round the Review Loop
  again, say), nothing is merged and the Notice is closed. When the pull
  request is sent to the Owner again for another head, the Notice for the
  old one is closed. If GitHub refuses (say the branch needs an approval
  count), or the pull request was closed, the Notice stays with the
  reason; one the Owner already merged on GitHub just closes.

Each merge is a `pull_request.merged` event (`by`: `app`, or `owner` for
Approve and merge) and an info Notice saying who merged it. GitHub closes
the issue through the pull request's `Closes #N`. For an automatic merge,
protect each Floor's default branch to require CI, but not an approval
count (ADR 0002): the App cannot approve its own pull request. [Setting up
a Floor](../../docs/processes/setting-up-a-floor.md#6-protect-the-default-branch)
has the protection for each Merge Policy, setting by setting.

### The Manager's watchdog

Each Floor's Manager watches its work, every minute, by rules in plain
code (PRD FR-23; `createWatchdog` in `@ai-office/orchestrator`):

- **Stalled work.** Work running with no sign of progress for 20
  minutes (the Merge Policy's work, which waits on CI and bounds its own
  wait, aside) (since it started, or since the last output, tool call, model
  call, review or push on its issue) is stopped and given to a free Agent
  of its Role (enabled, not paused, with nothing queued or running), or
  queued again for the same Agent when none is free. The third stall of
  an issue's work at a stage hands it to the Owner instead: the work is
  stopped, the issue labelled `needs-human`, and an action Notice says
  why.
- **Repeated failures.** An issue whose work failed (an "Agent blocked"
  Notice, say) and is still open at that stage is queued again, for
  another free Agent of its Role if there is one. After three failures in
  a row it is handed to the Owner the same way. An Agent whose last three
  tasks failed, on more than one issue, is paused (as in the Agent
  editor), with an action Notice; resume it in the Agent editor.
- **Loops near their cap.** When a Review Loop sends an issue back to
  its coder with one round left before the Round Cap, an action Notice
  tells the Owner, who can step in before it ends at `needs-human`.

**Its authority.** The Manager may retry, reassign, relabel, pause and
escalate with a Notice; for the Owner's requests in its chat, it may also
file issues and add and let go of Contractors
([ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md);
`assertManagerMayForChat`). It may never merge, change repository settings
or raise any cap, and it never changes the repository itself. Every action passes one permission check
(`assertManagerMay`), which refuses anything else with a
`ManagerAuthorityError` and a `manager.action_refused` event. Beneath it,
the Manager's GitHub client (`managerGitHub`) reads, labels issues and
comments, and refuses merges, write tokens and changes to the
repository's labels, branches and pull requests; it moves an issue only
back to `needs-work` or out to `needs-human`, never forward past review;
and it holds no Token Cap service. Its GitHub client still refuses to
create an issue: a chat request's issues are filed through a narrow path
of their own (`managerChatIssues`), which only files an issue labelled
`ai-office` and comments why, as a Grilling Session's are filed.

**Its decision log.** Each decision is a comment on the issue (starting
`<!-- ai-office:manager -->`, redacted) and a `manager.decision` event in
the Activity Feed, naming the action, what led to it, the stage and the
Agents involved. Decisions are kept in `manager_decisions`, each keyed by
the condition it answered (one stalled run, one failure, one round), so
none is taken twice, across restarts too. A comment GitHub refuses never
undoes a decision.

### Status reports

Each Floor's Manager writes a short status report (PRD FR-23;
`createStatusReports` in `@ai-office/orchestrator`), on request and once a
day:

- **In flight:** each issue at a stage, with the Agent working it (and for
  how long), or the Agent its queued work waits for.
- **Blocked:** an issue whose latest work at its stage failed, with nothing
  queued again, and work waiting for an Agent paused in the Agent editor or
  at a Token Cap (a review round, for a paused required reviewer).
- **Needing you:** the Floor's open action Notices, and issues at
  `needs-human`, or at `ready-to-merge` when the Floor's Merge Policy is
  "send to me".
- **Tokens used:** the Floor's tokens today and this month (UTC), as Token
  Caps count them.

It is written in plain code from the work queue, the Notices and the
issues' labels on GitHub (read with the Manager's GitHub client), so it
uses no tokens and no model sees issue text to write it. Without the
GitHub App, or when GitHub cannot be read, it comes from the work queue and
the Notices alone, and says so. Issue titles are redacted before they are
shortened.

- **On request:** type `status` (or `report`, `status report`) in the
  Manager chat. The report is the Manager's answer in the chat.
- **Daily:** at 09:00 UTC, each Floor's report is posted in its Manager
  chat, answering no message. It is written once a day, across restarts (the
  latest one is read from `manager_chat_messages`), and not at all for a
  Floor with nothing in flight, blocked or needing you and no tokens used
  today.
- **On the Notice Board:** each report is also an info Notice, "Status
  report on web-shop: 3 in flight, 2 blocked, 3 needing you, 1,500 tokens
  today", from the Manager, linking the chat and up to nine of its issues
  (those needing you first).

A status report is not the Floor's
[Status update](web-app.md#the-status-update) (PRD FR-23a), its stand-up
in the meeting room, which is also given every hour while the Floor's
Agents are working (work running on the queue, not at `ready-to-merge`),
saying what each did in the last hour.

### Progress comments

While an Agent works an issue, AI Office keeps the issue told with one
comment, edited in place (`createProgressComments`; PRD FR-21). It
shows the stage, the Agent with a link to its live view, how many steps
it has taken and the last five (its commands, file changes and output,
from the event bus). To respect GitHub's limits it is edited at most
once a minute, however many steps there are. When the work ends, the
last edit is a summary: the pull request, why the Agent is blocked, or
that AI Office stopped (then pending edits are written at once). The
comment starts with `<!-- ai-office:progress -->`, so later work on
the issue edits the same comment. Everything written is redacted, and a
write GitHub refuses never stops the work.
`RepositoryClient.updateComment(id, body)` does the editing.

On the host, `SANDBOX_WORK_DIR` is where clones are made (by default in
the system's temporary directory), and the Manager chat's per-Floor tool
homes and clones too. AI Office takes it only as its own user's
directory: a symbolic link there, or a directory another user made (the
system's temporary directory is anyone's to write in), is refused, and
the server does not start (pen-testing I2-4). It, and each directory AI
Office makes for its runs, is private to that user (`0700`, made so
whatever the umask, and made so again if it was not), so no other local
user reads a clone beneath it (pen-testing I2-5). Docker bind-mounts them into the sandboxes by the
path AI Office gives it, so it must be the same path for AI Office and
the Docker host. Agents work both in `pnpm dev` and under compose: there
the app image has `git` and the `docker` CLI, starts sandboxes on the
host's Docker through its socket, and mounts `AI_OFFICE_SANDBOX_DIR`
(`~/.ai-office/sandboxes` by default) at the same path inside the app,
made for its `node` user. On Docker Desktop (Windows, macOS) the path must
be one Docker Desktop resolves the same way for both mounts; see
[Agents' sandboxes under compose](running.md#running-ai-office-with-docker-compose).
