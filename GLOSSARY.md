# AI Office

A 3D office in which AI agents work GitHub issues on private repositories, supervised by a single owner, with the owner's AI accounts pooled behind a load balancer.

## People and places

**Owner**:
The single person who uses AI Office and is the human of last resort for every decision. The Owner signs in with any of the Owner's passwords or with an API key that has UI access; however many there are, they all belong to the one Owner.
_Avoid_: User, admin, operator

**Office**:
The whole AI Office installation: every Floor, plus the shared lobby with the office-wide Notice Board.
_Avoid_: Building, workspace

**Floor**:
The part of the Office dedicated to exactly one GitHub repository, with its own Agents, settings and wall board.
_Avoid_: Level, room, project

**Floor Template**:
The starting set-up chosen when a Floor is created, such as Development or Online store: its Roles and how many Agents of each, their instructions, its Skills and its settings. Everything it sets up stays editable afterwards, and nothing depends on it later.
_Avoid_: Floor type, department, preset, category

## Workers

**Agent**:
A named, configured worker on one Floor that fills one Role using one AI Model. The Communications Agent is the one exception: it belongs to no Floor.
_Avoid_: Worker, bot, employee

**Role**:
The job an Agent does, such as coder, copywriter or merchandiser: a name, instructions and Skills, belonging to one Stage. Floor Templates bring their own Roles; the manager and communications Roles are built in; a Contractor's Role is a one-off, written by the Manager for one task. A Floor may have several Agents with the same Role.
_Avoid_: Type, job, position

**Stage**:
One of the four steps every issue passes through on a Floor, each with its own label: work (change the repository in a sandbox), review (give a verdict), QA (check the result) and docs (document it). Every Role except manager and communications belongs to exactly one Stage.
_Avoid_: Step, phase, status

**Manager**:
The Agent on each Floor that triages, plans and dispatches work, turns the Owner's chat requests into Batches worked by Agents and Contractors, and escalates to the Owner. It never does the work itself, never merges, and is never the Owner.
_Avoid_: Supervisor, lead, director

**Contractor**:
An Agent a Manager adds to its Floor, at its own desk, for one Batch: in a one-off Role the Manager writes for its task and named after it, it either changes the repository in the work Stage or researches without changing anything. It leaves once no running Batch needs it, unless the Owner keeps it on the team.
_Avoid_: Temp, freelancer, helper, sub-agent

**Avatar**:
How an Agent looks in the Office (presentation, hair, skin tone, outfit), changed in the Avatar Editor. It never affects how the Agent works.
_Avoid_: Sex, character, skin

**Seasonal event**:
A few weeks a year (Christmas, Halloween, Easter, New Year) when the Office dresses up: decorations in the lobby and on every Floor, extras such as Christmas trees, lights and tinsel, Halloween's decorations and pumpkins, Easter eggs, costumes, party hats, nibbles and party food, and its Actors. Each is on or off, with its dates and its Actors' lines, in General Settings.
_Avoid_: Holiday mode, theme (a Floor's theme is something else)

**Actor**:
A Seasonal event's visitor (Santa, the Elf and the Grinch, Halloween's frights, the Easter Bunny, New Year's drunks) who now and then, or when the Owner calls one, steps out of the lift, goes round the Office a different way each time, saying one of its lines at each stop and having a go at what there is to play, and leaves. Only one is out at a time. It is not an Agent and does no work.
_Avoid_: NPC, mascot, guest

**Avatar Editor**:
The panel where the Owner changes one Agent's Avatar with a live 3D preview.
_Avoid_: Character creator, customiser

## AI

**AI Provider**:
A family of AI models an Agent can use, such as Claude, ChatGPT, Grok or Gemini, each with an Owner-chosen default Model.
_Avoid_: AI, LLM, vendor, xAI (as a separate entry from Grok)

**Model**:
A specific model from an AI Provider. An Agent uses its AI Provider's default Model unless it overrides it.
_Avoid_: Engine, version

**AI Account**:
One of the Owner's credentials with an AI Provider (a subscription login or an API key), pooled and load-balanced across every Agent.
_Avoid_: Key, login, seat

**AI Gateway**:
The part of AI Office through which every Agent's model call passes, choosing which AI Account serves it and enforcing Token Caps.
_Avoid_: Proxy, load balancer, router

**Gateway Key**:
A credential issued by the AI Gateway to one Agent (or to one of the Owner's own tools) to identify the caller. It is never an AI Account credential.
_Avoid_: API key, token

**Decision Model**:
An optional fast model (Jev) used only by Managers and safety checks for quick judgements. It is never an Agent's AI Provider.
_Avoid_: Classifier, judge

## Work

**Batch**:
The set of issues a Manager works as one: those the Owner hands it in one command, such as "complete issues 1 to 5", or those it files from one request the Owner makes in its chat.
_Avoid_: Sprint, job, run, task list

**One-pull-request Batch**:
A Batch the Owner hands over "in one PR": its issues are worked one at a time, in the Plan's order, on one shared branch, and merge together in one pull request that closes them all.
_Avoid_: Combined PR, mega-PR, stacked PRs

**Plan**:
The Manager's proposal for a Batch (order, dependencies, assignments), shown on the Floor's whiteboard.
_Avoid_: Roadmap, schedule

**Kickoff**:
The meeting-room step where the Manager presents a Plan and each assigned Agent acknowledges it once.
_Avoid_: Meeting, standup, briefing

**Wrap-up**:
The closing meeting-room step that presents a Batch's results.
_Avoid_: Retro, meeting, debrief

**Status update**:
A Floor's daily stand-up in the meeting room, where each Agent says what it did on the last working day and plans today; while its Agents work, one is also given each hour, saying what each did in the last hour.
_Avoid_: Standup, daily, check-in

**Handoff**:
The passing of an issue or pull request from one Agent to the next, shown as the Agent walking a ticket to the next desk.
_Avoid_: Transfer, delegation

**Skill**:
A named, reusable set of instructions an Agent can follow, run by the Owner with `/skill-name` or chosen by the Manager.
_Avoid_: Command, macro, plugin, prompt

**Built-in Skill**:
A Skill AI Office brings to every Floor, such as `/grilling` or `/pr`: some start a Grilling Session, the rest load their instructions into the Manager chat. Most are adapted from Matt Pocock's skills.
_Avoid_: System skill, default skill

**Grilling Session**:
A Manager conversation, started with `/grilling` or another Built-in Skill that starts one, that interviews the Owner in rounds of questions with recommended answers until they share an understanding, then produces documents, GitHub issues or both.
_Avoid_: Interview, Q&A, discovery session

**Direct chat**:
The Owner's one-to-one conversation with one of a Floor's Agents, opened from its card, with no commands or Skills; the Manager's is the Manager chat.
_Avoid_: DM, agent chat window

**Terminal**:
The page where the Owner chats with the AI itself, outside any Floor, asking an AI Provider's default Model.
_Avoid_: AI console, playground

**Context Usage**:
How full an Agent's working context is: the share of its Model's context window its latest model call used.
_Avoid_: Context percent, memory usage, token usage

**Fresh Start**:
Ending an Agent's session and beginning a new one on the same work, carrying only a structured summary the Agent wrote for itself.
_Avoid_: Reset, clear, restart

## Attention

**Notice**:
An item on a Notice Board that the Owner should see or act on, such as a PR opened, a PR awaiting approval, a blocked Agent or a reached Token Cap. It stays until dismissed or acted on.
_Avoid_: Alert, notification, message

**Notice Board**:
Where Notices are shown: the lobby board shows every Floor's Notices; each Floor's wall board shows its own.
_Avoid_: Inbox, alerts panel

**Communications Agent**:
The one office-wide Agent, at the lobby reception desk, that tells the Owner outside AI Office when work is complete or a Notice arrives, through Connections. It has no sandbox and no repository access.
_Avoid_: Notifier, messenger, bot

**Connection**:
An outbound integration the Owner sets up for the Communications Agent. It is either a notification channel (Slack, email, webhook, phone push) or a publishing destination (Confluence, Notion, Google Sheets, Docs, Slides, Drive or Calendar). Connections never act on anything sent back.
_Avoid_: Integration, channel, plugin

**Digest**:
A periodic summary that a Connection sends of what happened since the last one, instead of or as well as individual messages.
_Avoid_: Report, newsletter, roundup

**Activity Feed**:
The complete, read-only record of everything that happens in the Office, filterable by Floor, Agent and issue.
_Avoid_: Log, history, timeline

## Limits and review

**Token Cap**:
A limit on tokens an Agent may use in a period, set office-wide by default and overridable per Floor, per Agent and per issue.
_Avoid_: Budget, quota, spend limit

**Review Loop**:
The repeated cycle of reviewer Agents reviewing a pull request and the coder Agent fixing blocking comments, until all reviewers approve or the Round Cap is reached.
_Avoid_: Review cycle, ping-pong

**Round Cap**:
The maximum number of rounds a Review Loop may run before the pull request is handed to the Owner.
_Avoid_: Iteration limit, max retries

**Merge Policy**:
A Floor's rule for what happens when a pull request passes its Review Loop: merge automatically, or send it to the Owner via a Notice. Overridable per issue.
_Avoid_: Auto-merge setting, approval mode
