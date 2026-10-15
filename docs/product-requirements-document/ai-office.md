# AI Office — Product Requirements Document

| | |
|---|---|
| **Product** | AI Office |
| **Repository** | `adrianeyre/temp3` (to become [`adrianeyre/ai-office`](https://github.com/adrianeyre/ai-office) on completion) |
| **Status** | Draft |
| **Visibility** | Private during development; public on completion |
| **Date** | 2026-10-08 |
| **Glossary** | [`GLOSSARY.md`](../../GLOSSARY.md) |
| **Decisions** | [`docs/architectural-decision-record/`](../architectural-decision-record/) |

## 1. Summary

AI Office is a self-hosted web application in which AI **Agents** work GitHub issues on the **Owner's** private repositories, shown as a 3D office. Each repository is a **Floor**. Each Floor has a **Manager** and a team of Agents in **Roles**, set up by a **Floor Template** such as Development (coder, reviewer, QA) or Online store (merchandiser, copywriter, brand reviewer), each using an **AI Provider** and **Model** the Owner chooses. Agents work in Sandcastle sandboxes, and AI reviewers review the resulting pull requests in a capped **Review Loop**. Each Floor's **Merge Policy** then either merges automatically or hands the pull request to the Owner through the **Notice Board**.

Every model call passes through the built-in **AI Gateway**. It load-balances across the Owner's **AI Accounts** (Claude, ChatGPT, Grok, Gemini and more) and enforces **Token Caps** per office, Floor, Agent and issue. Clicking any monitor, whiteboard, notice board or bookshelf shows exactly what is happening. Admin pages configure everything, including the full AI Gateway configuration and its dashboards. The whole application sits behind the Owner's sign-in: any of the Owner's passwords, or an API key with UI access.

## 2. Problem

Coding agents can do real work on well-scoped issues, but running several of them at once is opaque and hard to steer:
- It's hard to see who is doing what, where work is stuck, or what it is costing.
- A single AI Account hits rate limits quickly, and mixing AI Providers (one codes, another reviews) means juggling credentials and tools.
- Review loops between AIs can run forever.
- Nothing tells the Owner, in one place, what needs their attention.

AI Office makes the whole system visible, bounded and controllable, and makes it fun to watch.

## 3. Goals

1. Agents work labelled GitHub issues end to end: plan, code, review, QA, docs, pull request, and merge or hand-off to the Owner.
2. Full visibility. Every Agent's live activity, every issue and pull request and who is working it, and every model call and its token use can be found in at most two clicks.
3. Hard limits. Token Caps and Round Caps are enforced, and an Agent can never loop or spend without bound.
4. One pool of AI Accounts serves every Agent through the AI Gateway, with the complete load-balancing feature set specified in §6.8.
5. Mixed AI Providers per Floor, e.g. Claude coding and ChatGPT and Grok reviewing.
6. A 3D office of a quality that would be at home in a premium indie management game: fun, but professional enough to leave on a second monitor all day.
7. It runs on the Owner's machine or a single EC2 instance with one `docker compose up`.

## 4. Non-goals

- **More than one user.** There is one Owner, to whom every Owner password and API key belongs however many there are, and no user accounts or roles.
- **Cross-repository issues.** An issue belongs to one Floor; related work in another repository is a separate issue linked by reference.
- **Signed commits** (see [ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md)).
- **The 3D office on phones.** Phones get a 2D view (§7).
- **Acting on Notices from outside AI Office.** Connections are outbound only (§6.17). A Slack message or an email links back to AI Office; nothing can be approved, merged or resumed from it.
- **Agents touching repositories that are not Floors.**
- **Agents operating live business systems.** An Online store Floor works on its store's repository (theme, product data, copy), not in the store's admin, ad platforms or customer email.
- **Acting on issues from anyone but the Owner.** Issue text is untrusted input. An issue by another author is never picked up unless the Owner applies the `ai-office` label personally.
- **A public or multi-tenant hosted service.**

## 5. Users and key scenarios

**Primary user:** the Owner, a developer with private GitHub repositories and subscriptions or API keys for several AI Providers, running AI Office locally or on EC2.

1. **Hand over a Batch.** On the `web-shop` Floor the Owner tells the Manager "complete issues 1 to 5":
   1. The Manager drafts a Plan, and the Agents walk to the meeting room for the Kickoff.
   2. The Owner opens the whiteboard, moves issue 4 after issue 2 and approves the Plan.
   3. The Agents fan out to their desks.
2. **Watch work happen.** The Owner clicks the coder's monitor and sees its live terminal, the diffs and the model calls with their token use. They click the Agent's name in a Notice and the camera flies to its desk.
3. **Cross-AI review.** Claude's pull request is reviewed by a ChatGPT reviewer and a Grok reviewer:
   1. Round 1 has two blocking comments; Claude fixes them.
   2. Round 2 is approved and CI is green.
   3. The Floor's Merge Policy is "send to me", so a Notice "PR #14 awaiting your approval" appears with links to the pull request and the issue.
4. **Runaway prevented.** QA keeps failing on a flaky test. After the third round the pull request is labelled `needs-human`, and a Notice explains why with links to each round.
5. **Cap reached.** An Agent reaches 80% of its daily Token Cap and a Notice warns the Owner. At 100% the AI Gateway refuses its next call and the Agent pauses. The Owner raises the cap from the Notice and the Agent resumes.
6. **Rate limit avoided.** One Claude subscription hits its five-hour limit. The AI Gateway moves new sessions to the second AI Account and moves back when the first resets.
7. **Customise the team.** In Floor Settings the Owner adds a second coder:
   1. They name it, pick Gemini and override the Model.
   2. They open the Avatar Editor, randomise, then change the hair and outfit colour.
8. **Grill a new feature into issues.** The Owner opens the Manager chat and runs `/grilling`:
   1. The Manager asks rounds of numbered questions, each with a recommended answer, and looks up facts in the code itself.
   2. The Owner answers some individually and replies "recommended to all" for the rest.
   3. The Manager opens a pull request with the PRD, ADRs and glossary updates.
   4. After the Owner approves the draft list, the Manager files the GitHub issues, labelled `ai-office` and linked by "Blocked by".
9. **Use the Gateway directly.** The Owner creates a Gateway Key for their own local Claude Code and Codex. That usage appears in the analytics as Owner tools.
10. **Hear about it away from the desk.** The Owner has added a Slack Connection, an ntfy Connection and a Google Sheets Connection:
    1. While they are out, the Batch from scenario 1 finishes. The Communications Agent posts "Batch finished: 5 of 5 issues merged" to Slack with links, and appends a row per issue to the work-log sheet.
    2. Later a pull request awaits approval. Their phone gets a push with a link to the Notice.
    3. The Owner opens the link, signs in and approves it in AI Office.
11. **Open an online store Floor.** The Owner adds a Floor for their `shop-theme` repository and picks the Online store Floor Template:
    1. The Floor starts with a Manager, a merchandiser, a copywriter, a storefront developer, a brand reviewer and a store QA Agent, with the template's check commands and a stockroom look.
    2. They file "add the autumn range". The Manager's Plan gives it to the merchandiser and then the copywriter, on one branch.
    3. The brand reviewer approves, store QA checks links, prices and images, and the pull request awaits the Owner's approval.

## 6. Functional requirements

### 6.1 Access and security

- **FR-1:** On first start, a setup screen asks the Owner to set the first Owner password. There is no default password. Signed in, the Owner can add further Owner passwords, one for each person who shares the Owner's access, each unlike every other, and remove any but the first. Every Owner password is stored as an Argon2id hash.
- **FR-2:** Every page, API route and live stream requires a signed-in session, except the login page, the setup screen (until a password exists), a health endpoint and GitHub's webhook deliveries (signed with the webhook secret instead). A session begins with any of the Owner's passwords (then a TOTP code, when FR-3's second factor is on), or with an API key that has UI access: one the Owner made for their own tools in API Key Management (FR-46) and gave UI access, which asks for no second factor. Sessions expire after 7 days, or after 24 hours unused. A "sign out everywhere" action exists.
- **FR-3:** An optional TOTP second factor can be enabled, with recovery codes. It applies to every Owner password; signing in with an API key does not ask for it (FR-2). Its use is recommended, and suggested in the UI, when the site is reached over anything other than `localhost`.
- **FR-4:** Login attempts are rate-limited per client, and repeated failures are recorded in the Activity Feed.
- **FR-5:** Credentials (AI Account tokens, the GitHub App private key, Gateway Keys) are never shown in full after creation, never written to logs, prompts, commits, Notices or the Activity Feed, and are encrypted at rest with the encryption key from the environment.

### 6.2 Floors and repositories

- **FR-6:** The Owner installs the AI Office GitHub App on chosen repositories. Adding a Floor means picking one of those repositories and a Floor Template (§6.18). Each Floor is exactly one repository, and each repository is at most one Floor.
- **FR-7:** Each Floor's settings are: name (what the Office shows for the Floor everywhere; it starts as the repository's name, the Owner may rename it, 1 to 60 characters and unique among the Floors in use whatever its case, and the Floor's id and addresses keep the repository's name), default branch, setup and test commands, Merge Policy, Round Cap, Token Cap overrides, concurrency limit, required reviewer Agents, plan approval (on or off), "Most Agents" (FR-10) and "Manager spins off work from chat" (FR-24).
- **FR-8:** Issue intake:
  - Only open issues labelled `ai-office`, or named by the Owner to the Manager, are picked up.
  - By default AI Office checks every 60 seconds. GitHub webhooks are an option when the instance is reachable.
  - Issues from authors other than the Owner are ignored unless the Owner applied the label themselves.
- **FR-9:** Floors can be archived, which stops all work and hides the Floor without deleting its history.

### 6.3 Agents and Roles

- **FR-10:** A new Floor starts with the team from its Floor Template (§6.18). Development, the default, is a Manager, a coder, a reviewer and a QA Agent. The Owner can add or remove Agents of any Role in the office Role library (FR-98). A Floor may have several Agents with the same Role, which work in parallel. A Floor has exactly one Manager. The Office also has exactly one Communications Agent (§6.17), which belongs to no Floor.
  - **Team size:** Floor Settings shows a count for each Role. Its defaults come from the Floor Template. The Manager is fixed at 1.
  - **Most Agents:** a Floor setting caps how many Agents it has besides its Manager, the Owner's and Contractors alike: any whole number from 1, or no limit. The default is 8. It replaces the earlier limit of 10 Agents per Role: a Role's team size may go as high as the Floor's limit allows.
  - **Raising it:** adds Agents copied from that Role's first Agent's config: AI Provider, Model, effort, extra instructions and Token Cap overrides. Each new Agent gets its own name, a distinct random Avatar and its own Gateway Key, and can then be edited on its own.
  - **Lowering it:** removes idle Agents first. An Agent in the middle of a task finishes it and is then removed. Work is never cut off.
  - **Parallel work:** the Manager balances issues across Agents of the same Role (FR-23). Sandbox Agents still run within the office and Floor concurrency limits (FR-22), and Floor Settings warns when a Floor has more sandbox Agents than its limits let run at once.
  - **Contractors:** the Manager adds a Contractor to a Batch from its chat (FR-24, [ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md)) when the Batch needs a Role no Agent on the Floor fills, or when its ready work in a Role outnumbers the free Agents in it.
    - **Limits:** never beyond the Floor's "Most Agents", and never more work Agents than the sandbox limits (FR-22) let run at once. When a limit holds a Contractor back, the Manager says so in its chat, with a link to where the limit is raised.
    - **Role:** a library Role where one fits, such as a second coder; otherwise a one-off Role the Manager writes for the task, always in the work Stage. A one-off Role is in no Role library and goes when its Contractor leaves. Review, QA and docs stay with the Floor's own Agents.
    - **Name and Model:** named after its Role ("Migration writer", then "Migration writer 2"), with a distinct random Avatar and its own desk. It starts on its Role's suggested AI Provider and Model, or the office default, like any new Agent, and never with Token Caps of its own.
    - **Research:** for an investigation that changes nothing, a research Contractor reads a read-only clone in a sandbox, files nothing and reports its findings to the Manager.
    - **Leaving:** a Contractor leaves once no running Batch needs it and it is idle, after the Wrap-up. The Owner can keep one with "Keep on the team" on its card: it becomes an ordinary Agent that never leaves on its own, and its one-off Role joins the library.
- **FR-11:** Each Agent's config is:
  - name;
  - Avatar;
  - Role;
  - AI Provider;
  - Model (defaults to the AI Provider's default);
  - effort or reasoning level where the AI Provider supports it;
  - Token Cap overrides;
  - an extra instructions field;
  - enabled or paused.
- **FR-12:** Floor Settings dashboard lists the Floor's Agents with their status, current issue, today's and this month's tokens against their caps, and an edit action for every field in FR-11.
- **FR-13 (Avatar Editor):**
  - **Opening it:** from Floor Settings or by clicking an Agent in the office.
  - **Preview:** a live, rotatable 3D preview.
  - **What you can edit:** presentation (male, female or androgynous), body shape, face, hairstyle and hair colour, skin tone, facial hair, glasses and accessories, outfit style and colours, and a desk mascot.
  - **Buttons:** randomise, reset and save.
  - **New Agents:** each one gets a random Avatar distinct from the others on its Floor.
  - **Effect on work:** none. The Avatar never reaches a model's prompt.
- **FR-14:** UI pronouns for an Agent follow its Avatar's presentation (he, she or they).

### 6.4 AI Providers and Models

- **FR-15:** The office admin lists the AI Providers. The first set is **Claude**, **ChatGPT**, **Grok** and **Gemini**, and further AI Providers can be added as the AI Gateway supports them (§6.8). Each has a default Model chosen from the Gateway's live model catalogue.
- **FR-16:** Each AI Provider runs a matching agent tool in the sandbox. All of them reach models only through the AI Gateway.

  | AI Provider | Agent tool in the sandbox |
  |---|---|
  | Claude | Claude Code |
  | ChatGPT | Codex |
  | Grok | opencode |
  | Gemini | opencode |

  Claude Code and Codex also run the Manager's chat, as a read-only session on a read-only clone of the Floor's repository (FR-24).
- **FR-17 (Decision Model):** the office admin can optionally configure Jev as the Decision Model. Managers and safety checks use it for quick judgements:
  - Is this issue clear enough to work?
  - Is this Review Loop stalled or repeating?
  - Is this tool call safe?

  It is off by default and is never selectable as an Agent's AI Provider. When it is off, those judgements use the Manager's own Model or deterministic rules.

### 6.5 Work pipeline

- **FR-18:** Issues move through labels:
  - `needs-work` → `needs-review` → `needs-qa` → `needs-docs` → `ready-to-merge`, or `needs-human`. Each label but the last two is a Stage: work, review, QA and docs ([ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)).
  - Plus `in-progress` while an Agent holds the issue.

  Labels are the source of truth and every transition is recorded in the Activity Feed.
- **FR-19:** Agents whose Role is in the work, QA or docs Stage work in Sandcastle sandboxes (Docker):
  - Each issue runs on a named branch `ai-office/<issue>-<slug>`, which AI Office pushes.
  - The sandbox gets the repository, the AI Gateway URL, its Agent's Gateway Key and a GitHub token that can read but not write.
  - Agents never push, open pull requests or merge themselves.
- **FR-20:** Agents whose Role is in the review Stage do not use a sandbox. They make model calls through the AI Gateway, given the issue, the diff and the relevant files. Each returns a structured verdict: approve or changes requested, plus comments, each tagged `blocking` or `nit`.
- **FR-21:** AI Office opens one pull request per issue, as the GitHub App, with `Closes #N`, unless the issue's Batch goes in one pull request (FR-25a). It posts progress comments on the issue in batches, to respect GitHub's limits.
- **FR-22:** An office-wide limit on running sandboxes (default 3) and an optional lower per-Floor limit. Work beyond the limit is queued. The Manager adds no more Contractors than these limits let run at once (FR-10).
- **FR-23 (Manager):** the Manager does the following.
  - **Triage:** checks clarity, asks the Owner via a Notice when an issue is unclear, and sets priority.
  - **Dispatch:** assigns issues to Agents and balances load. When a Floor has several work Roles, it picks the Role for an issue from each Role's routing description. A `role:<name>` label forces one, and when it cannot tell it asks the Owner with an action Notice.
  - **Watchdog:** spots stalls, repeated failures and loops close to their cap.
  - **Reporting:** writes Floor status summaries.
  - **Chat requests:** files issues for the Owner's own requests in its chat, and adds and lets go of Contractors for them (FR-24, FR-10).

  Timeouts, caps, label transitions and dispatch rules are plain code; a model is used only for judgement and summaries. The Manager may pause, reassign, relabel and escalate, and for its chat's requests file issues and add or release Contractors. It may never merge, change repository settings or raise any cap, and it never changes the repository itself. Every Manager decision is logged as a comment on the issue, including each issue it files.
- **FR-23a (Status update):** a Floor's stand-up, given with **Status update** (beside Meeting Room in the Office) and, by itself, the first time the Owner opens the Floor each day. While the Floor's Agents are working, it is also given every hour, saying what each Agent did in the last hour and what it is doing next; the hourly one does not count as the day's, and the Owner can turn it off for the Floor (**Hourly Status updates while Agents work**, on by default).
  - **The Office:** the whole Floor walks to the meeting room and sits, the Manager at the whiteboard; each Agent, the Manager first, gives its rundown in turn, and then everyone walks back to their desk and sits down.
  - **What each says:** what it did on the last working day (yesterday; when nothing happened then, the latest day with work in the week before, such as Friday on a Monday after a quiet weekend; with no work all week, the last weekday) and what it plans today, from its queued and running work and the Floor's Batches.
  - **Days** are the Owner's, in their profile's time zone. The day's own is given once per Floor and day, however many browsers open it.
  - It is written in plain code from AI Office's own records, costs no tokens, and is kept in the Manager chat.
- **FR-24 (Manager chat):** clicking the Manager's glass office opens a chat.
  - Commands such as "complete issues 1 to 5", "complete issues 1 to 5 in one PR" (FR-25a), "skip 4", "move 5 up", "pause" and "resume" are handled by plain code. Anything else goes to the Manager's Model.
  - The repository is implied by the Floor.
  - The chat accepts `/skill-name [arguments]` to run a Skill (§6.14), and offers autocomplete from the Floor's available Skills.
  - **The Manager as orchestrator** ([ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md)): for each plain message, the Manager's Model decides what it is, as a coding assistant spins work off to sub-agents.
    - **A question, status or discussion:** an ordinary reply.
    - **A request too unclear to act on:** one clarifying question, and nothing is filed.
    - **Research:** a research Contractor reads the repository and reports back, and the Manager uses its findings in its reply or Plan.
    - **A request to change the repository:** plan, then go. The Manager replies with its Plan (the issues it files and the Contractors it adds), then at once files one GitHub issue per piece of work, labelled `ai-office` with a comment saying it was filed for the request, and starts them as a Batch (FR-25).
  - **Reporting back:** the Manager posts short messages in its chat as a request's Batch goes on: each issue done (its pull request merged) or blocked (which also raises a Notice), each Contractor arriving or leaving, and the Wrap-up's summary.
  - **As Claude Code is** ([ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md)): the chat works as the Owner's own coding assistant does.
    - **A continuing, read-only agent session.** When the Manager's AI Provider has an agent tool that can hold a session (Claude Code for Claude, Codex for ChatGPT, FR-16), each conversation is one session of it, resumed turn to turn and surviving a restart; `/clear` and `/compact` start a new one. It runs in its sandbox image on a read-only clone of the Floor's repository at its default branch, and may only read, search and list files, read the history (`git log`, `git show`, `git diff`), and search and fetch the web. It reaches models only through the AI Gateway with the Manager's Gateway Key, so a subscription and an API key get the same tools. It changes nothing: every change still goes through an issue, an Agent or a Contractor. Other AI Providers, and an Office without sandboxes or the GitHub App, keep one call per answer, with no tools.
    - **Tool use shown.** Under each reply, the tools it used (such as "Read src/checkout/total.ts"), collapsed to "Used 3 tools".
    - **A live task list** of the work the chat's requests spun off: one task per issue filed, per Contractor added and per research run, each Queued, Running, In review, Done or Blocked, worked out in plain code from the event log. Each opens its Agent's or Contractor's live view, and an issue its page on GitHub. A finished request's tasks stay for a day.
    - **Interrupting.** Sending while the Manager is writing stops that reply, keeping what it wrote, and the new message is answered. While the Manager carries out a request (filing issues, starting a Batch, research), a new message is refused until it has.
    - **Attachments.** Images (PNG, JPEG, GIF, WebP) and text files (such as logs, Markdown, CSV, JSON, YAML), attached, pasted or dropped: at most 5 per message, images up to 5 MiB and text up to 1 MiB, each checked to be what it says. Text goes to the Model quoted as untrusted data and redacted (FR-5), its start and end kept when it is long; images go as images where the Model's call can carry them. An attachment is kept with the message that sent it and goes with it; one never sent is deleted after a day.
    - **`@` file mentions.** Typing `@` offers the repository's files that match, and a message mentioning `@path` gives the Manager that file's text at the default branch (at most 10 files, 200 KiB each).
    - **Model and effort** are chosen in the chat's header, from the AI Provider's catalogue and the efforts its agent tool takes. This is the Manager's own setting, saved at once as in the Agent editor (FR-11), and never a Token Cap change.
    - **Its usage in the header**, as Claude Code's status line shows a session: the Manager's Context Usage (FR-85), its tokens today and this month against the Token Caps in force for it (FR-32), and the 5-hour and weekly usage windows (FR-36) of the subscription that served its latest request (or of its AI Provider's subscriptions when no request names one). They stay live.
  - **The setting:** "Manager spins off work from chat" is on by default. Off, the Manager only talks and takes typed commands.
- **FR-25 (Batch, Plan, Kickoff):**
  1. A Batch command makes the Manager draft a Plan: order, dependencies, likely overlapping files, assignments, and which issues can run in parallel. An issue may be given an ordered list of work Roles, which take turns on one branch with a Handoff between them before review. A request in the Manager chat (FR-24) is a Batch too, of the issues the Manager files for it, with the Plan it settled in the chat. Its issues enter work only through their Batch.
  2. The Plan is shown on the whiteboard during the Kickoff, and each assigned Agent acknowledges it once, with "OK" or one concern. Agents do not converse freely.
  3. With plan approval on (the default), work starts only when the Owner approves the Plan on the whiteboard. The Owner can edit it there first (reorder, drop, annotate), and the Manager replans. A chat request's Batch starts at once: the request stands as the Plan's approval. Its Plan is still on the whiteboard, with its Kickoff and Wrap-up.
  4. Mid-Batch changes replan without restarting finished work. "pause", "skip" and "move" work on chat requests' Batches too. Each chat request is its own Batch, running alongside the Floor's others.
  5. Overlapping issues are run one after another, and later branches rebase on merged work.
  6. When the Batch finishes, a Wrap-up presents a results summary: pull request links, anything blocked, and tokens used.
- **FR-25a (One-pull-request Batch):** "complete issues 1 to 10 in one PR" (or "in one pull request", "as one PR", "in a single PR") hands the Manager a Batch whose issues all go in one pull request ([ADR 0010](../architectural-decision-record/0010-a-batch-may-ship-as-one-pull-request.md)).
  - Its issues are worked one at a time, in the Plan's order, on one branch, `ai-office/batch-<id>`, each building on the commits of the issue before it. An issue starts once every issue before it is `ready-to-merge`.
  - Each issue still goes through every Stage (work, review, QA, docs) with its own labels and Review Loop. Its reviewers, QA, docs Agent and designer look at its own commits: what came after where the branch stood as it started.
  - One pull request is opened as the first issue goes to review and rewritten as each issue joins it. Its body has `Closes #N` for every issue that has joined, a Summary sketching the issues and the files they change, Evidence before and after for each issue, and the Merge Danger (whether it is a one-way or two-way door, and its blast radius).
  - The Merge Policy considers it only once every issue is `ready-to-merge`, and applies to each issue what it applies to one. An issue handed to the Owner (`needs-human`) holds the whole pull request, and a Notice says so.
  - "skip" and "move" change only the issues still to start; an issue that has started stays in the pull request. The whiteboard and the Plan in the chat say the Batch goes in one pull request.
- **FR-26 (Handoff):** each Handoff carries a short structured summary (what changed, what to check, known risks), not a transcript.

### 6.6 Review Loop and Merge Policy

- **FR-27:** Each Floor names one or more required reviewer Agents, which may use different AI Providers. Each round, every required reviewer reviews the latest diff. The coder fixes `blocking` comments only. The loop ends when every required reviewer approves with no blocking comments remaining.
- **FR-28:** The Round Cap defaults to 3, set per Floor. QA has its own Round Cap, and there is also an overall cap per pull request across all stages.
  - Reaching any cap labels the pull request `needs-human` and raises an action Notice.
  - A round whose blocking comments mostly repeat the previous round's, or whose diff barely changes, escalates early.
- **FR-29:** The Merge Policy is set per Floor; the default is **send to me**. It can be overridden per issue with the labels `ai-office:auto-merge` and `ai-office:manual`.
  - **Auto-merge:** when every required reviewer approves, no blocking comments remain, CI passes and every cap was respected, the GitHub App merges and a Notice records it.
  - **Send to me:** an action Notice links to the pull request for the Owner to approve and merge.
- **FR-30:** Conflicts between Roles, such as QA rejecting what reviewers approved, escalate to the Owner rather than looping.

### 6.7 Token Caps

- **FR-31:** Token Caps count tokens (input plus output; cache reads shown separately). Estimated cost is shown alongside for information only.
- **FR-32:** Caps are set at four levels:
  - **Office:** a daily and a monthly default.
  - **Floor:** an optional override.
  - **Agent:** an optional override.
  - **Issue:** a per-issue cap.

  The most specific cap applies. Every level is shown with its current use.
- **FR-33:** At 80% of any cap, a warning Notice. At 100%:
  - The AI Gateway refuses that Agent's next call with a cap error.
  - The Agent pauses at a safe point.
  - An action Notice offers "raise cap" or "resume tomorrow".

  Owner tools (FR-46) can have caps too.

### 6.8 AI Gateway

The AI Gateway is built into AI Office ([ADR 0001](../architectural-decision-record/0001-ai-gateway-is-built-in.md)). It must provide the following.

- **FR-34 (endpoints):**
  - Anthropic Messages API compatible (`/v1/messages`).
  - OpenAI Responses (`/v1/responses`, `/v1/responses/compact`) and Chat Completions compatible.
  - Format translation in both directions, so any agent tool can reach any AI Account.
  - Streaming throughout.
- **FR-35 (AI Account types):**
  - Anthropic: subscription OAuth login, and Console API key.
  - ChatGPT / Codex: OAuth login.
  - xAI / Grok: OAuth login, and API key.
  - Gemini: via Google's OpenAI-compatible API.
  - AWS Bedrock and Google Vertex AI.
  - OpenRouter, DeepSeek, Z.ai, Minimax, Qwen, Kimi, Ollama and Ollama Cloud.
  - Any Anthropic-compatible or OpenAI-compatible endpoint.
  - Custom endpoint URLs and an optional outbound HTTP proxy.
  - Subscription OAuth AI Accounts are only used through the AI Provider's own agent tool, as that provider's terms require.
- **FR-36 (account management):**
  - Add accounts through guided OAuth flows or by entering a key.
  - Rename, set priority, pause and resume.
  - Set usage pause thresholds (five-hour and weekly).
  - Force-reset a rate-limit state.
  - Re-authenticate.
  - See token health in real time: valid, expiring or expired, with automatic refresh ahead of expiry.
- **FR-37 (load-balancing strategies):** chosen at runtime.
  - **Session:** sticky to one account for a configurable window, default 5 hours.
  - **Session-affinity.**
  - **Drain-soonest:** prefer the account whose window resets first, with a strict variant.
  - **Least-used.**
- **FR-38 (routing):**
  - **Order of checks:** forced-account routing per request, then strategy selection, then the model-capacity filter, then usage throttling.
  - **Model-capacity filter:** excludes accounts exhausted for that model family.
  - **Usage throttling:** five-hour and weekly pacing.
  - **Errors when nothing is available:** a capacity exclusion returns a 429, throttling returns a 529, and no account at all returns a 503.
- **FR-39 (resilience):**
  - Retries with exponential backoff (configurable attempts, delay and multiplier), and a circuit breaker per account.
  - Automatic fallback back to a preferred account once its limit resets.
  - Auto-refresh that starts a new usage window when a limit resets.
  - Prompt-cache keep-alive.
- **FR-40 (combos):** named, ordered fallback chains of (AI Account, Model) slots. They are assigned per model family, can be enabled or disabled individually and globally, and waterfall to the next slot on failure.
- **FR-41 (models):**
  - A live model catalogue per AI Account type, refreshed on demand and on a schedule.
  - Model mappings and aliases.
  - Per-AI-Provider default Models (FR-15).
  - Forcing a Model per account.
  - An "extra usage" toggle where the AI Provider offers it.
- **FR-42 (attribution):** every request is attributed to an Agent and Floor (via its Gateway Key) or to an Owner tool. It is also tagged with its issue and pull request when known.
- **FR-43 (analytics dashboards):**
  - Requests, tokens (input, output, cache read, cache write), estimated cost, latency and error rates over time.
  - Broken down by AI Account, AI Provider, Model, Floor, Agent, issue and Owner tool.
  - Usage history for each AI Account's limit windows, and insights such as the top consumers and accounts close to their limits.
  - Pricing comes from a maintained pricing table with dynamic pricing where a provider publishes it.
- **FR-44 (request history):**
  - A searchable, filterable list of requests with a detail view.
  - Optional request and response bodies, encrypted at rest.
  - A live request stream and a live log stream.
- **FR-45 (configuration):** everything above is configurable from the office admin at runtime, without a restart.
- **FR-46 (Gateway Keys):**
  - Each Agent gets a Gateway Key automatically.
  - The Owner can create named Gateway Keys for their own tools (local Claude Code, Codex and others).
  - Keys can be revoked, show when they were last used, and are scoped to calling models only.
- **FR-47 (health):** a health endpoint with account and database status, used by `docker compose` health checks.

### 6.9 Notice Board and Activity Feed

- **FR-48:** A Notice is either **action** or **info**, with a title, Floor, links (GitHub issue, pull request, CI run, the Agent's desk) and one-click actions where applicable (approve and merge, raise cap, resume, open Plan). It stays until the Owner dismisses it or the action is taken.
- **FR-49:** Notices are raised for:
  - **Info:** pull request opened; pull request merged (by whom: App or Owner); Batch started or finished; Agent recovered.
  - **Action:** pull request awaiting the Owner's approval; Plan awaiting approval; Round Cap reached; Token Cap warning (80%) or reached; Agent blocked or errored; unclear issue needs the Owner's input; AI Account needs re-authentication or is rate-limited with no fallback left; Review Loop conflict between Roles.
- **FR-50:** The lobby Notice Board shows every Floor's Notices. Each Floor's wall board shows that Floor's Notices, plus every issue in progress with the Agent working it, its stage and links.
- **FR-51:** Action Notices also trigger a browser notification with a sound (the Owner can turn this off). Info Notices are silent. Notices can also reach the Owner outside AI Office through Connections (§6.17).
- **FR-52:** The Activity Feed records everything: label transitions, Handoffs, Manager decisions (including issues it files for chat requests), Contractors arriving, being kept and leaving, sandbox starts and stops, commits, pull request events, model calls (summarised), caps, configuration changes and sign-ins. It can be filtered by Floor, Agent, issue and type, and each entry links to its source.

### 6.10 Memory

- **FR-53:** Repository memory lives in `.agents/MEMORY.md` in each Floor's repository. Every Agent reads it at the start of a task. It changes only through pull requests that the Manager curates, at the end of a Batch or as a periodic tidy-up: merging duplicates, removing stale entries and keeping it short.
- **FR-54:** Office-wide memory (coding standards, preferred libraries, review rules) is stored in AI Office, edited in the office admin, and mounted read-only into every sandbox.
- **FR-55:** Role memory (lessons for a Role on a Floor) is stored in AI Office, proposed by Agents and accepted by the Manager or the Owner.
- **FR-56:** Memory is treated as untrusted input, never contains credentials, and every change is visible in the Activity Feed.

### 6.11 The 3D office

- **FR-57:** The scene is built with React Three Fiber:
  - **Lobby:** holds the office-wide Notice Board and the Communications Agent's reception desk (FR-96).
  - **Floors:** one per Floor, reached by a lift or a floor picker. Each Floor is dressed in its Floor Template's theme, such as stock shelves and parcels for an Online store or server racks for Infrastructure. The theme is decoration only.
  - **Desks:** one per Agent, with its Role's dressing (a designer's dual monitors, QA's test devices, a copywriter's notebooks). An arriving Contractor steps out of the lift and walks to its new desk; a leaving one walks back to the lift, and its desk goes. With reduced motion, they appear and go without the walk.
  - **Manager's office:** a glass office.
  - **Meeting room:** with a whiteboard.
  - **Wall boards:** a Floor wall board showing health, queue lengths, rounds used and tokens against caps.
  - **Bookshelf:** for memory.
  - **Amenities:** a canteen with a coffee machine, a gym and a water cooler.
- **FR-58 (inspectable objects):** monitors, whiteboards, Notice Boards, wall boards and bookshelves are clickable. A click flies the camera in and opens an HTML panel over the scene.
  - **Monitor:** that Agent's live activity (terminal output, tool calls, diffs, model calls with tokens).
  - **Whiteboard:** the current and past Plans, editable when awaiting approval.
  - **Bookshelf:** the memory.

  Every entry links to GitHub and to other objects. All of these share one generic "inspectable" mechanism.
- **FR-59 (Handoffs):** when an issue changes stage, the Agent stands, walks a ticket labelled with the issue number to the next Agent's desk, and the receiving monitor lights up. Work never waits for an animation: the pipeline advances immediately and the animation catches up.
- **FR-60 (meetings):** Kickoff and Wrap-up are shown as Agents gathering in the meeting room while the whiteboard fills in live. During a Grilling Session the Manager sits in the meeting room (FR-83).
- **FR-61 (idle behaviours):** when an Agent has nothing to do it plays a weighted-random activity:
  - stretch after finishing;
  - fetch a coffee from the canteen;
  - work out in the gym;
  - chat at the water cooler;
  - lean back in the chair with "zzz" after a long idle period.

  Each spot has an occupancy limit. Activities are data (location, animation, duration), so a new one is one entry. A new task interrupts any activity immediately.
- **FR-62 (state is visible):**
  - A pile of tickets on a desk shows the queue length.
  - An Agent waiting on review looks different from one with nothing queued.
  - A paused or capped Agent shows a clear marker.
  - A Floor with an action Notice shows a red light at the Manager's office.
  - **Tokens above the head:** a small label floats above each Agent, beside its Context Usage bar (FR-85), showing the tokens it has used today, such as "128k today".
    - **Colour:** set against the Agent's daily Token Cap. Neutral below 80%, amber from 80%, red at 100%.
    - **Visibility:** unlike the Context Usage bar, it stays visible while the Agent is idle.
    - **Hover:** shows this month's tokens against the monthly cap.
    - **Setting:** the setting that switches off the bars also switches off the label.
- **FR-63:** Clicking an Agent shows a card (name, Role, AI Provider, Model, current issue, tokens against caps) with links to its monitor, its config and the Avatar Editor. A Contractor's card says it is one, and offers "Keep on the team". Clicking an Agent's name anywhere in the UI flies the camera to that Agent.
- **FR-64:** Optional ambient office sound and music, muted by default.

### 6.12 Administration

- **FR-65 (office admin):**
  - AI Providers and their default Models; the Decision Model.
  - Office Token Caps and office-wide memory.
  - Concurrency limit, intake polling interval and webhooks.
  - Git identity (§6.13).
  - Retention (§7).
  - Owner passwords, TOTP and sessions.
  - JSON export and import of all configuration except credentials.
  - The complete AI Gateway configuration and its dashboards (§6.8).
  - Connections and the Communications Agent (§6.17).
  - The Role library and Floor Templates (§6.18).
- **FR-66 (Floor admin):** one per Floor, with the Floor's settings (FR-7), its Agent list and editor (FR-12, FR-13), its token usage and caps, its Merge Policy and Review Loop settings, and its Batch history.
- **FR-67:** Configuration lives in Postgres and takes effect without a restart. Only start-up secrets come from the environment: the database credentials, the GitHub App ID and private key, the session secret and the encryption key.
- **Company logo:** the logo and name shown in the UI and the browser tab are set in the codebase (`apps/web/src/brand/`), not uploaded, because AI Office has no file storage.

### 6.13 Git identity

- **FR-68:** Commit author and committer are the configured Owner identity, by default GitHub user `adrianeyre` with their GitHub noreply email. This can be overridden per Floor and is injected by AI Office, never chosen by an Agent.
- **FR-69:** Every agent commit carries trailers naming the Agent, its Role and its AI Provider and Model, e.g. `Agent: Ada (coder, Claude claude-opus-5-5)`.
- **FR-70:** The GitHub App pushes, opens pull requests, posts reviews and comments, and merges ([ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md)). The setup guide tells the Owner how to protect each Floor's default branch: require CI, forbid direct pushes, and require no approval count when auto-merge is wanted.

### 6.14 Skills

- **FR-71:** A Skill is a named, reusable instruction set in the Agent Skills format: a folder with a `SKILL.md` (frontmatter with name and description, then instructions), plus optional supporting files.
- **FR-72:** Skills come from two places:
  - **The office Skill library:** stored in AI Office and managed in the office admin. Skills are added by upload, by import from a Git repository, or by writing them in an editor.
  - **Repository Skills:** found in a Floor's repository under `.agents/skills/` and `.claude/skills/`.

  A repository Skill with the same name overrides the office Skill on that Floor.
- **FR-73:** An "Available Skills" list:
  - **Where:** beside the Manager chat and in the office admin.
  - **Each entry:** name, description and source (office, repository or built in, FR-83b).
  - **Opening one:** a modal shows the rendered `SKILL.md` and lists its supporting files, each viewable in the modal.
  - **Running one:** a "run" button inserts the command into the chat.
  - **In the 3D office:** the Manager's office bookshelf opens the same list.
- **FR-74:** In the Manager chat, `/skill-name [arguments]` loads that Skill's instructions into the Manager's session for the current conversation. The Manager may also choose a Skill itself when a request matches its description, and says which Skill it used.
- **FR-75:** Skills are also mounted read-only into every sandbox, so coder, QA, docs and designer Agents can use them too. Floor Settings can turn individual Skills on or off per Role.
- **FR-76:** Skills are instructions, so they are trusted input. An imported Skill shows its full contents for the Owner to review before it is enabled, and every add, change or removal is recorded in the Activity Feed.

### 6.15 Grilling Sessions

- **FR-77:** A Grilling Session is a Manager conversation, started with the built-in `/grilling` Skill, that interviews the Owner until they share an understanding of a feature or product, then turns it into documents and issues.
- **FR-78:** The session works in rounds:
  - Each round asks every question whose prerequisites are settled, numbered, each with the Manager's recommended answer.
  - The Owner can answer each question, reply "recommended" to one, or "recommended to all".
  - Answers reshape the next round, and the session ends when no open questions remain and the Owner confirms.
  - Questions appear as cards in the chat, each with its own answer box and an "accept recommended" button.
- **FR-79:** The Manager finds facts itself rather than asking the Owner. It reads the Floor's code, docs and issues in a read-only sandbox and can delegate fact-finding to other Agents. It asks the Owner only for decisions.
- **FR-80:** While the session runs, the Manager keeps the Floor's documents current on a branch:
  - **PRD:** `docs/product-requirements-document/`.
  - **ADRs:** `docs/architectural-decision-record/`, offered only for decisions that are hard to reverse, surprising and the result of a real trade-off.
  - **Glossary:** `GLOSSARY.md`, with each term written as soon as it is settled.
  - **Process docs:** `docs/processes/`.

  When the session ends, the GitHub App opens one pull request with all of them. The whiteboard shows the live outline and the decisions settled so far.
- **FR-81:** The Manager then proposes GitHub issues:
  - **What they are:** vertical slices, each with "What to build", acceptance criteria, "Blocked by" links, and the PRD sections and ADRs it cites.
  - **Review:** shown as a draft list the Owner can edit, reorder, merge or drop.
  - **Filing:** on approval the App files them, labelled `ai-office`, ready to become a Batch.
- **FR-82:** A Grilling Session can be paused and resumed later with its full history, and every session is kept and readable from the Manager's office.
- **FR-83:** For the whole of a Grilling Session the Manager is in the meeting room, sitting at the table:
  - It walks there when the session starts and back to its office when the session ends or is paused.
  - The whiteboard behind it shows the current round's questions and the decisions settled so far.
  - The meeting-room door shows "in session".
  - Clicking the Manager, the table or the whiteboard opens the session chat.
  - Agents the Manager sends to find facts are shown leaving their desks to visit it and returning.
- **FR-83a (End session):** The Owner can end a Grilling Session at any time, running or paused, with **End session** (or "end the session"), after saying yes to what it does:
  - **What is kept:** the decisions and terms settled so far, and its documents' pull request is opened as when it ends on confirmation (FR-80); questions still open are left open, and the chat names them.
  - **The Office:** everyone walks back from the meeting room to their desk and sits down, as when a session is paused (FR-83).
- **FR-83b (Matt Pocock's skills):** AI Office builds in Skills adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT), on every Floor, each a `SKILL.md` in the Agent Skills format crediting him:
  - **Starting a Grilling Session**, as `/grilling` does, with their own instructions beside its, and the session keeping which Skill started it:
    - `/grill-with-docs <topic>`: grilling with domain modelling, settling glossary terms and ADRs as they crystallise.
    - `/wayfinder <idea>`: the destination named first, then breadth-first rounds, with "Not yet specified" and "Out of scope" in the PRD's outline; the drafted issues are the decision and build tickets.
    - `/to-spec [topic]`: the PRD written from the conversation so far, asking only about the seams to test at.
    - `/to-tickets <paths or description>`: the PRDs and ADRs it names are read from the repository into the session as untrusted data, and its rounds settle their breakdown into vertical-slice issues. It writes no documents: "confirm" ends it and has the issues drafted at once.
  - **Loading instructions**, as any `/name` does, with their supporting files: `/pr`, `/domain-modeling`, `/research`, `/prototype`, `/tdd`, `/codebase-design`, `/diagnosing-bugs` and `/code-review`. The Manager may choose these itself, and an office or repository Skill of their name takes their place.
  - **Where documents go:** every one writes PRDs to `docs/product-requirements-document/` and ADRs to `docs/architectural-decision-record/`, never Matt's defaults.
  - **Never in a sandbox:** like `/grilling`, they are the Manager's.
- **FR-83c (Meeting Room):** a Floor's **Meeting Room** button (in the Office, beside the Manager chat's) calls every Agent of the Floor to the meeting room's table and opens a panel of the Owner's daily work there, each sending what the Owner would type in the Manager chat:
  - **Write a PRD:** a Grilling Session as Matt Pocock's `grill-with-docs` (one feature) or `wayfinder` (a large effort) runs it. PRDs always go in `docs/product-requirements-document` and ADRs in `docs/architectural-decision-record`.
  - **File GitHub issues:** drafted from an ended session (FR-81), or broken out of PRDs and ADRs on the default branch with `to-tickets`.
  - **Complete issues:** a Batch of an issue range, in one pull request by default.
  - **Status update:** one now (FR-23a), and the Floor's hourly setting.
  - The Floor stays at the table until the Owner sends it back to its desks or leaves the Floor; nothing is kept, and work never waits for it.
- **FR-83d (seated on opening):** as a Floor or the lobby opens, every Avatar is already in its seat: the Agents at their desks (or at the meeting room's table, for a session already running), the receptionist at the reception desk and the visitor on the sofa. Walks are shown only for what happens once the Floor is shown, never replayed for what happened while the Owner was elsewhere.

### 6.16 Context

- **FR-84 (Context Usage):** an Agent's Context Usage is the input tokens of its latest model call divided by its Model's context window from the model catalogue. It applies to sandbox Agents, the Manager chat and Grilling Sessions. Reviewer calls are stateless and have none.
- **FR-85 (display):**
  - **Where:** the Agent card, the Agent live view and monitor (as a small gauge on the desk monitor in 3D), Floor Settings Agent list and the Floor wall board.
  - **Above the Agent's head:** in the 3D office, a percentage bar floats above each Agent with an active session.
    - It always faces the camera and is filled and coloured by Context Usage, with the percentage as text.
    - It stays readable at the default camera distance and follows the Agent while it walks.
    - It is hidden while the Agent is idle.
    - A setting can switch all bars off.
    - It briefly animates when a Fresh Start empties it.
  - **Colours:** green below 60%, amber from 60%, red from 85%.
- **FR-86 (automatic Fresh Start):** when a sandbox Agent's Context Usage crosses its threshold (default 85%, configurable per Floor and per Agent), AI Office performs a Fresh Start:
  1. The Agent writes a structured summary for itself: done, in progress, next steps, decisions, files touched.
  2. The session ends.
  3. A new session starts on the same branch with the issue and that summary.

  Each Fresh Start is an event. A cap on Fresh Starts per task (default 3) escalates with an action Notice when reached.
- **FR-87 (manual clearing):**
  - The Agent card and monitor have a "Fresh start" action that does the same immediately.
  - The Manager chat accepts `/clear`, which wipes the conversation but keeps stored decisions, Plans and Batches.
  - It also accepts `/compact`, which replaces older history with a summary.
  - The Manager chat auto-compacts at the same threshold.
- **FR-88 (Grilling Sessions):** compaction in a Grilling Session keeps settled decisions, open questions and glossary terms word for word, re-injected from stored structured data. Only the back-and-forth is summarised.
- **FR-89 (summariser):** Fresh Start and compaction summaries are written by the Agent's own Model, or by the Decision Model when it is enabled and configured for summaries (off by default).

### 6.17 Communications

- **FR-90 (Communications Agent):** the Office has exactly one Communications Agent, created at first start. It tells the Owner, outside AI Office, when work is complete and when there is a new Notice, through the Owner's Connections.
  - **Where:** at a reception desk in the lobby. It belongs to no Floor.
  - **Scope:** it has no sandbox, no repository access and no GitHub token. It reads the event bus and writes only to Connections.
  - **Model calls:** none for ordinary messages, which come from deterministic templates. It calls a model only for Digests and published Wrap-up reports, using the Decision Model when enabled or otherwise its own AI Provider and Model, through the AI Gateway and counted against the office Token Caps.
  - **Config:** name, Avatar, AI Provider and Model (for Digests and reports), enabled or paused. While it is paused nothing is sent, and deliveries queue until it resumes.
- **FR-91 (Connections):** a Connection is one outbound integration that the Owner sets up. There are two kinds:
  - **Notification channels**, which send short messages:
    - **Slack:** an incoming webhook URL, or a bot token and a channel or user.
    - **Email:** an SMTP server (host, port, TLS, username, password), a from address and one or more to addresses.
    - **Generic webhook:** a URL that receives a JSON POST, signed with an optional HMAC secret. It covers Discord, Microsoft Teams, Zapier, n8n and similar.
    - **Phone push:** ntfy (server, topic, optional token) or Pushover (application token, user key).
  - **Publishing destinations**, which keep a written record:
    - **Confluence:** site URL, account email and API token, space and parent page.
    - **Notion:** an integration token and a parent page or database.
    - **Google:** one Google sign-in (OAuth, with only the scopes the enabled services need) through an OAuth client the Owner registers in Google Cloud and enters in the admin. Each destination then names a target: a **Google Sheets** spreadsheet and tab, a **Google Docs** folder or document, a **Google Slides** folder, a **Google Drive** folder or a **Google Calendar** calendar.
- **FR-92 (what is sent):** each Connection has its own rules.
  - **Notification channels:**
    - **Triggers:** action Notices (on by default), info Notices (off by default) and work complete (on by default: a pull request merged, an issue closed by its pull request, a Batch finished).
    - **Message:** the title, the Floor, the kind and links to the Notice in AI Office and to GitHub.
    - **Digest:** optional, hourly or daily at a set time, summarising what happened since the last one.
    - **Filters:** a Floor filter and quiet hours. During quiet hours messages are held for the next Digest or the end of quiet hours, unless the Owner lets action Notices through.
  - **Publishing destinations:**
    - **Google Sheets:** a work log with one row per completed issue: date, Floor, issue, pull request, Agents, Review Loop rounds, tokens and estimated cost. Optionally also one row per Notice.
    - **Confluence, Notion and Google Docs:** a page or document per Batch with its Wrap-up report (the Plan, each issue's outcome and pull request, rounds, tokens and estimated cost). Optionally also a running changelog page with an entry per merged pull request.
    - **Google Slides:** a short deck per Batch from the same Wrap-up report.
    - **Google Drive:** each Wrap-up report saved as a Markdown and a PDF file in the folder.
    - **Google Calendar:** an event per Batch, from start to finish, with a link to its Plan.
- **FR-93 (admin):** a Connections page in the office admin.
  - **Adding:** pick a type, fill in its form, then "Send test", which sends a test message or writes a test row and shows the result.
  - **Managing:** rename, edit rules, pause, resume and delete.
  - **Credentials:** encrypted at rest. They are write-only and never shown again after saving.
  - **Status:** each Connection shows its last delivery, its status and a log of its recent deliveries.
- **FR-94 (delivery):**
  - **Queue:** deliveries come from the event bus and wait in a durable queue in Postgres, so a restart loses nothing. Each event is delivered at most once per Connection.
  - **Retries:** a failed delivery is retried with exponential backoff for up to 24 hours, and respects the service's rate limits.
  - **Failing Connections:** after 5 consecutive failures the Connection is marked failing and an action Notice is raised. That Notice is never sent to the failing Connection itself.
  - **Activity Feed:** Connection changes, failures and recoveries appear in it. Individual successful deliveries appear only in the Connection's own log.
- **FR-95 (what leaves the Office):** everything sent to a Connection is data leaving AI Office for a third party.
  - **Redaction:** every outbound message and document passes central redaction.
  - **Never sent:** credentials, code, diffs, request or response bodies, memory or issue bodies.
  - **Detail level:** each Connection has one. "Links only" sends kinds, counts and links. "Titles and summaries" (the default) also sends issue and pull request titles and Notice summaries.
  - **Model input:** Digests and reports are written from structured data (titles, outcomes, counts), not from issue text.
  - **Outbound only:** nothing that comes back from a Connection is acted on.
- **FR-96 (in 3D):** the Communications Agent sits at the lobby reception desk. When something is sent it drops an envelope into an out-tray. A failing Connection shows a red marker on its desk. As with every animation, delivery never waits for it.

### 6.18 Floor Templates and Roles

- **FR-97 (Floor Templates):** adding a Floor means picking a Floor Template. It sets up the Floor's starting team, instructions, Skills and settings. Everything it sets up stays editable afterwards, and nothing depends on it later. The Floor shows which template it started from. Floors created before Floor Templates, and Floors added without a choice, count as Development.
- **FR-98 (Role library):** Roles are data, kept in an office Role library ([ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)).
  - **A Role is:** a name, its Stage (work, review, QA or docs), a one-line routing description, instructions, its Skills, desk dressing, and a suggested AI Provider and Model. The suggestion falls back to the office default when the Owner has no AI Account for that AI Provider.
  - **The library holds:** the Roles from every built-in template, plus Roles the Owner makes or duplicates.
  - **Changing a Role:** affects every Agent with that Role. An Agent's own extra instructions still apply on top.
  - **Built-in Agents:** the Manager and the Communications Agent are not library Roles.
- **FR-99 (what a template holds):**
  - name, description and icon;
  - its Roles from the library, with a starting count for each;
  - Floor settings: setup and check commands, required reviewers, Merge Policy and Round Cap;
  - the Manager's planning guidance, including a suggested first set-up issue;
  - its labels and its 3D theme.
- **FR-100 (built-in templates):**

  | Floor Template | Starting Roles (besides the Manager) | Typical checks |
  |---|---|---|
  | **Development** (default) | coder, reviewer, QA | the repository's tests |
  | **Online store** | merchandiser, copywriter, storefront developer, brand reviewer, store QA | theme check, links, prices, images, accessibility |
  | **Website & marketing** | web developer, copywriter, SEO specialist, conversion reviewer | build, links, Lighthouse |
  | **Content & blog** | writer, editor, fact-checker, SEO specialist | Markdown lint, links, spelling |
  | **Documentation** | technical writer, docs reviewer, example checker | docs build, links, runnable examples |
  | **Design system** | designer, front-end developer, accessibility reviewer, visual QA | component tests, visual snapshots, contrast |
  | **Data & analytics** | analytics engineer, data reviewer, data-quality QA | `dbt test`, SQL lint |
  | **Infrastructure** | platform engineer, security reviewer, plan QA | `terraform plan` or equivalent dry run, policy checks |
  | **Mobile app** | mobile developer, reviewer, device-test QA | unit tests, simulator tests |
  | **Blank** | none | none |

  Built-in templates and their Roles and Skills ship as files under `templates/<name>/` in the AI Office repository, so a new one is a pull request.
- **FR-101 (the Owner's own templates):** in the office admin the Owner can:
  - duplicate and edit a template;
  - save an existing Floor's set-up as a new template;
  - export a template, with its Roles and Skills, to a file;
  - import one from a file or a Git repository.

  Role instructions reach models, so an imported template or Role shows its full contents for review before it is enabled, as with imported Skills (FR-76). Every add, change or removal is recorded in the Activity Feed. Templates and Roles are included in configuration export.

## 7. Non-functional requirements

- **Runtime:** Node 26 or later and pnpm 12 or later, required via `engines` and `devEngines`; Docker images pin Node 26.10.0 and pnpm 12.10.0. TypeScript strict, ESM.
- **Deployment:**
  - A single `docker compose` stack: the AI Office app (server, AI Gateway and web), and Postgres 18 with an `ai_office` database.
  - Sandboxes run on the host's Docker.
  - It runs on Linux, macOS or an EC2 instance.
  - On EC2, AI Office is served over TLS through a reverse proxy (Caddy), and access should be restricted by security group or Tailscale.
- **Security:**
  - Access for the Owner alone: the Owner's passwords and API keys with UI access (§6.1).
  - Credentials are encrypted at rest and redacted from every stream.
  - Sandboxes never hold AI Account credentials or a GitHub token that can write.
  - The AI Gateway is reachable only from the compose network, the sandboxes and holders of Gateway Keys.
  - Issue text and memory are treated as untrusted.
  - Connection credentials are encrypted at rest and write-only. Outbound content is redacted and limited to each Connection's detail level (FR-95).
- **Retention defaults (configurable):**
  - Request and response bodies: 7 days, encrypted; storing them can be switched off entirely.
  - Usage and request metadata: 90 days.
  - Activity Feed and Notices: 1 year.
  - Connection delivery logs: 90 days.
  - Manager chat attachments are kept with the message that sent them; one never sent is deleted after a day (not configurable, FR-24).
- **Performance:**
  - The 3D office holds 60 fps at 1080p on a 2022-era laptop with an integrated GPU at medium quality.
  - Low, medium and high quality settings.
  - The AI Gateway adds less than 10 ms median overhead per request, excluding upstream time.
  - Notices appear within 2 seconds of the event AI Office observes.
  - Notification channels send within 30 seconds of the event, outside quiet hours and when the service is reachable.
- **Visual bar:**
  - **Look:** a stylised, soft-lit look, like a premium indie management game.
  - **Spec:** one documented colour palette and lighting spec that every asset follows, with physically based materials, soft shadows and tasteful post-processing (ambient occlusion, bloom, colour grading).
  - **Motion:** eased camera moves between every view, and characters animated with a shared rig.
  - **Text:** never rendered as hard-to-read text inside the 3D scene; panels are HTML.
  - **Assets:** CC0 and purchased asset packs. Licences are tracked in `THIRD-PARTY-NOTICES.md`.
- **Responsiveness:**
  - **Desktop:** first-class.
  - **Tablets:** fully usable.
  - **Phones:** get a 2D view of the Notice Board, the Activity Feed and the admin pages instead of the 3D office.
- **Accessibility:**
  - Every action in the 3D office is also reachable from 2D panels and the keyboard.
  - A reduced-motion setting.
  - Every page, the policies' dialogs included, meets WCAG 2.2 AA.

## 8. Architecture

See [ADR 0001](../architectural-decision-record/0001-ai-gateway-is-built-in.md) and [ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md).

```text
 Browser: React + React Three Fiber (office) · Tailwind + shadcn/ui (admin)
                         │  HTTPS + WebSocket/SSE (session-authenticated)
                         ▼
 apps/server (Fastify) ── auth · admin API · live event stream · webhooks
     │
     ├── packages/orchestrator ── intake, label pipeline, Manager, Batches,
     │        │                   Review Loop, Merge Policy, caps, Notices
     │        ├── GitHub App (issues, PRs, reviews, merges)
     │        ├── packages/communications ── Connections, outbound queue,
     │        │        templates → Slack · email · webhooks · push · Confluence · Notion · Google
     │        └── Sandcastle → Docker sandboxes (Claude Code / Codex / opencode)
     │                              │ Gateway URL + per-Agent Gateway Key
     ▼                              ▼
 packages/gateway ── load balancing, routing, translation, OAuth, analytics
     │                   │
     ▼                   ▼
 Postgres 18        AI Providers (Anthropic, OpenAI, xAI, Google, …)
```

- The **orchestrator** owns all behaviour. The **server** is a thin adapter. The **web** app is a view over one event stream.
- Every Agent action emits typed events (state change, tool call, model call, Handoff, Notice) to one event bus. The Activity Feed, monitors, wall boards and animations are all projections of it.

### Repository layout

```text
apps/
  server/        Fastify: auth, API, event stream, webhooks, static web
  web/           React + Vite + React Three Fiber + Tailwind/shadcn
packages/
  orchestrator/  pipeline, Manager, Batches, Review Loop, caps, Notices
  gateway/       AI Gateway
  github/        GitHub App client
  communications/ Communications Agent, Connections, outbound queue
  db/            Drizzle schema and migrations (Postgres)
  events/        typed event schema and bus
  shared/        shared types and utilities
docker/          compose stack, sandbox images per agent tool
templates/       built-in Floor Templates, their Roles and Skills
docs/            PRD, ADRs, processes
```

### Tooling

TypeScript and React throughout.

- **Workspace:** pnpm workspace, ESM, strict TypeScript, ESLint + Prettier, Vitest, Playwright.
- **Server:**
  - Fastify, with Zod validation on every route. The schemas live in `packages/shared` and are shared with the web app.
  - Drizzle with SQL migrations.
  - Passwords hashed with `@node-rs/argon2`.
  - Server-side sessions with HttpOnly, SameSite=Strict cookies.
  - `otplib` for TOTP.
  - No third-party authentication framework.
- **Live updates:** server-sent events (SSE) push the event stream and Manager chat replies to the browser, with resume via `Last-Event-ID`. Commands go over REST. No WebSocket.
- **Web:**
  - React with Vite.
  - TanStack Router and TanStack Query.
  - Zustand for scene and UI state.
  - React Hook Form with Zod.
  - Tailwind + shadcn/ui.
- **3D:**
  - React Three Fiber, drei and `@react-three/postprocessing`.
  - `three-mesh-bvh` for picking.
  - glTF/GLB assets compressed with Draco or Meshopt.
  - Hand-placed waypoint paths rather than a pathfinding library.
- **AI Gateway pricing:** a pricing table in the repository, `packages/gateway/pricing.json`, overridable per Model in the admin. It refreshes automatically where an AI Provider publishes prices through an API.
- **CI:** GitHub Actions on Linux.
- **AI Office's own development:** Sandcastle ([`docs/processes/running-sandcastle.md`](../processes/running-sandcastle.md)).

## 9. Verification strategy

- **Unit and integration:** Vitest, with Postgres via Testcontainers in CI.
- **AI Gateway contract tests:** recorded provider responses (including streaming, errors, 429/529 and OAuth refresh) per AI Account type. CI never calls a live AI Provider.
- **Orchestrator scenarios:** fake GitHub and fake agent tools drive the scenarios in §5 end to end: Review Loop caps, Merge Policy paths, Token Cap refusal, stall escalation.
- **Connections:** a contract suite per Connection type runs against local fakes in CI (Mailpit for SMTP, and fake Slack, webhook, ntfy, Pushover, Confluence, Notion and Google APIs). Real services are verified on the host.
- **End to end:** Playwright for login and TOTP, admin pages, the Notice Board and the Plan approval flow.
- **Visual:** screenshot tests of key 3D scenes (lobby, a Floor, the meeting room, the Avatar Editor) at fixed seeds, rendered without a GPU in headless Chromium in CI.
- **CI:** Linux only. Lint, typecheck, unit and integration tests (Postgres via Testcontainers), Playwright end-to-end tests and screenshot tests. No live AI Provider or GitHub calls.
- **On the host:** the look and feel of the office and its frame-rate target, the `docker compose` stack and real Sandcastle runs. Issues list these separately as "verified on the host".

## 10. Roadmap

Each phase is useful on its own and complete when its exit criteria pass.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Foundations** | Monorepo scaffold, lint/typecheck/test, compose stack with Postgres, setup screen, login, TOTP, event bus | `docker compose up` gives a password-protected empty app; CI green |
| **1. Walking skeleton** | GitHub App, one Floor, intake, one Claude coder Agent in Sandcastle, PR opened by the App, Owner commit identity, Activity Feed and Notice Board in a plain 2D UI | A labelled issue on a test repo becomes an App-opened PR authored as the Owner, with Notices and full activity |
| **2. AI Gateway core** | Gateway endpoints and translation; Claude, ChatGPT, Grok and Gemini AI Accounts; session and least-used strategies; Gateway Keys per Agent and for Owner tools; Token Caps enforced; analytics, request history; office admin for all of it | Agents run only through the Gateway; a cap refusal pauses an Agent; two Claude accounts share load |
| **3. Review and Merge** | Reviewer Agents (structured verdicts), multiple reviewers across AI Providers, Review Loop and Round Caps, QA and docs Agents, Merge Policy, Floor admin with Agent list and editor | Scenarios 3 and 4 in §5 pass against a test repo |
| **4. The 3D office** | Lobby and Floors, desks, inspectable monitors and boards, Agent cards, Handoff walks, wall boards, Avatar Editor, quality settings, phone 2D view | Visual bar and performance targets met; every 2D feature reachable in 3D |
| **5. Managers and Batches** | Manager triage, dispatch and watchdog; Manager chat; Batches, Plans, Kickoff and Wrap-up meetings; editable whiteboard; concurrency queue; memory; Skills library, Available Skills list and `/skill` commands; Grilling Sessions producing PRD/ADR/docs pull requests and GitHub issues | Scenarios 1 and 8 in §5 pass end to end |
| **6. Full Gateway and polish** | Every remaining AI Account type and Gateway feature in §6.8 (combos, drain-soonest, throttling, capacity routing, keep-alive, auto-refresh), designer Agents, Decision Model, idle behaviours, ambient sound, retention jobs | Gateway feature list in §6.8 complete; idle behaviours never delay work |
| **7. Communications** | The Communications Agent; Connections for Slack, email, generic webhooks, ntfy and Pushover; Confluence, Notion and Google (Sheets, Docs, Slides, Drive, Calendar) publishing; Digests; Connections admin | Scenario 10 in §5 passes; a failing Connection raises a Notice and recovers |
| **8. Floor Templates** | Roles as data on four Stages, the Role library, the ten built-in Floor Templates, routing between work Roles, Owner-made, imported and exported templates, 3D themes | Scenario 11 in §5 passes; a Development Floor behaves exactly as before |
| **9. Future** | Agents operating live business systems (store admin, ads, customer email), creating repositories from a template, two-way Connections (acting on Notices from Slack or email), cross-repository Batches, multiple users, signed commits, 3D on phones | — |

## 11. Risks

| Risk | Mitigation |
|---|---|
| The AI Gateway's scope is large (§6.8) | Its own phases (2 and 6); contract tests per AI Account type; core strategies first |
| AI Providers' terms restrict subscription logins outside their own tools or in automated use | Subscription accounts used only through the provider's own agent tool; API-key accounts supported throughout; the Owner is warned in the admin when adding a subscription account |
| Review Loops never converge | Blocking vs nit; Round Caps per stage and per pull request; stall detection; escalation to the Owner |
| Prompt injection via issue text, memory, imported Skills or imported Floor Templates | Owner-only intake; memory changes reviewed; imported Skills, Roles and Floor Templates reviewed before enabling; sandboxes hold no write credentials; the Decision Model screens tool calls when enabled |
| Parallel Agents produce merge conflicts | The Plan sequences overlapping issues; one branch per issue; rebase on merged work; concurrency limit |
| The 3D scene is slow on modest hardware | Quality settings, instancing, baked lighting, a performance budget enforced in CI where possible |
| Credentials leak into logs, prompts or the UI | Central redaction on the event bus; encryption at rest; sandboxes get Gateway Keys only |
| Private repository details leak through Connections to third-party services | Outbound only; a detail level per Connection; central redaction; no code, diffs, bodies or memory ever sent (FR-95) |
| Third-party APIs change, rate-limit or revoke access | A contract suite per Connection type; a durable queue with retries; failing Connections raise a Notice |
| GitHub rate limits with many Agents | Batched comments, conditional requests, webhooks where available |

## 12. Decisions log

Settled during design review (2026-10-08):

- **Name:** "AI Office". The repository becomes `adrianeyre/ai-office` and goes public on completion. Until then it is private with no licence. The Owner picks a licence at release, and asset licences are tracked in `THIRD-PARTY-NOTICES.md`.
- **Stack details:** set during issue planning (2026-10-08). See §8 Tooling: SSE plus REST, the TanStack libraries, Zustand, React Hook Form + Zod, a hand-rolled auth layer, React Three Fiber with drei and post-processing, a pricing table in the repository, and Linux-only CI with frame rate checked on the host.
- **Access:**
  - One Owner and one password, set at first start. Further Owner passwords and API-key sign-in were added on 2026-10-10 (FR-1, FR-2): however many there are, they all belong to the one Owner.
  - Optional TOTP, rate-limited login, 7-day sessions.
- **Floors and Agents:**
  - One Floor per repository.
  - Each Floor has its own Agents, set up by its Floor Template from the office Role library. Development, the default, starts with a Manager, coder, reviewer and QA.
  - A team-size count per Role scales a Floor's team, within its "Most Agents"; Agents of the same Role work in parallel.
  - The Avatar is appearance only, edited in the Avatar Editor.
- **AI Providers:**
  - Claude, ChatGPT, Grok and Gemini first. Grok and xAI are one AI Provider.
  - The agent tools are Claude Code, Codex and opencode, all through the AI Gateway.
  - Jev is an optional Decision Model only.
- **AI Gateway:**
  - Built in, with the full load-balancing feature set ([ADR 0001](../architectural-decision-record/0001-ai-gateway-is-built-in.md)).
  - Per-Agent Gateway Keys; Owner tools can use the Gateway too.
- **Token Caps:** count tokens, at office, Floor, Agent and issue levels, daily and monthly. Warn at 80%; the Gateway refuses at 100%.
- **Floor Templates** (added 2026-10-09):
  - A Floor still works on one repository. A Floor Template is a starting set-up, not a permanent type.
  - Roles are data on four fixed Stages: work, review, QA and docs ([ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)). `needs-code` becomes `needs-work`.
  - Ten built-in templates, the Owner's own, and import and export.
  - Agents operating live business systems, and creating repositories, are future work.
- **Attention:** the Notice Board (action and info Notices) and the Activity Feed are separate. Browser notifications are for action Notices only.
- **Communications** (added 2026-10-09, replacing the earlier non-goal of email and Slack Notices):
  - One office-wide Communications Agent in the lobby.
  - Notification channels: Slack, email (SMTP), generic webhooks, and phone push through ntfy or Pushover.
  - Publishing destinations: Confluence, Notion and Google Sheets, Docs, Slides, Drive and Calendar.
  - Templated messages, with optional Digests written by a model.
  - Outbound only. Two-way Connections are future work.
- **Review and merge:**
  - Review Loop with blocking vs nit; Round Cap 3 by default; stall detection.
  - Reviewers make model calls without a sandbox. QA, coder, docs and designer Agents work in Sandcastle sandboxes on named branches that AI Office pushes.
  - Merge Policy per Floor: "send to me" by default, or auto-merge gated on reviewers, CI and caps. Overridable per issue by label.
- **GitHub:** a GitHub App acts. Commits are authored as the configurable Owner identity (default `adrianeyre`) with an `Agent:` trailer ([ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md)).
- **Intake:** only issues labelled `ai-office` or named to the Manager. Polling every 60 seconds by default, webhooks optional, Owner-authored issues only.
- **Configuration:** stored in Postgres, edited in the admin pages, exportable as JSON. Secrets come from the environment and are encrypted at rest.
- **Concurrency:** 3 sandboxes office-wide by default, with an optional per-Floor limit.
- **Manager:** a chat in the glass office; plain-code commands; plan approval on by default.
- **Contractors** (added 2026-10-11, [ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md)): a request in the Manager chat becomes a Batch the Manager files and starts at once, adding Contractors within the Floor's "Most Agents" (default 8, or no limit) and the sandbox limits. A Floor setting turns it off.
- **Skills:**
  - Agent Skills format, from an office library plus the Floor repository's own.
  - Run with `/skill-name` in the Manager chat, browsable in an Available Skills list with a modal viewer, and mounted into sandboxes.
- **Grilling Sessions:** a built-in `/grilling` Skill runs rounds of questions with recommended answers. It produces a pull request with the PRD, ADRs, glossary and docs, then files approved GitHub issues.
- **Context:**
  - Context Usage is shown per Agent, colour-coded at 60% and 85%.
  - A Fresh Start (structured self-summary, then a new session) happens automatically at 85% or on demand, capped at 3 per task.
  - The Manager chat has `/clear`, `/compact` and auto-compaction.
  - Grilling compaction keeps decisions, questions and terms word for word.
  - The Decision Model can optionally write the summaries.
- **Memory:** repository memory in `.agents/MEMORY.md` changed by PR; office-wide and Role memory stored in AI Office.
- **Stack:**
  - TypeScript pnpm monorepo: Fastify, Drizzle, Postgres 18 in Docker, React + Vite + React Three Fiber, Tailwind + shadcn/ui.
  - One `docker compose` stack. Node 26.10.0 and pnpm 12.10.0.
- **Visual bar:** a stylised premium indie look; 60 fps on an integrated GPU; quality settings; a 2D view on phones; sound muted by default.
- **Retention:** bodies 7 days, metadata 90 days, Activity Feed and Notices 1 year.
- **Out of scope for now:** multiple users, cross-repository issues, signed commits, 3D on phones, acting on Notices from outside AI Office, non-Floor repositories, issues from other authors.
