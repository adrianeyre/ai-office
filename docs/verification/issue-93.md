# Issue #93: Run Skills from the Manager chat — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) in the working tree of this branch, after `pnpm install
--frozen-lockfile`.

## What was built

### Reading `/skill-name [arguments]` (`packages/shared`, `manager-chat.ts`)

- `readSkillCommand(text)`: `/name` or `/name arguments`, the name a
  valid Skill name (lowercase letters, digits and single hyphens, at most
  64), the arguments trimmed (null when there are none). Anything else is
  not a Skill command and is read as before.
- `managerChatSkillSchema`: the Skill a message ran: `name`, `source`
  (`office` or `repository`), `arguments`, and `chosenBy` (`owner`, who
  typed `/name`, or `manager`, who chose it).
- Every chat message gains `skill` (null unless it ran one).
- `skillAnnouncement(name)`: "Using the Skill /name."

### Kept (`packages/db`, migration `0048_context_usage_skills_and_grilling`)

`manager_chat_messages` gains `skill` (JSON) and `skill_instructions`
(text: the Skill's instructions as they were loaded, redacted). Checks: a
Skill is only on the Owner's message or a reply, and a row has
instructions exactly when it has a Skill. The store
(`orchestrator/src/manager/store.ts`) keeps both, and
`loadedSkills(floorId, sinceId)` answers the Skills loaded from a message
on, with their instructions. The instructions are never in the API's
messages.

### The chat (`packages/orchestrator`, `manager/chat.ts`, `prompt.ts`, `chat-skills.ts`)

- **`skills` option**: the Floor's Skills (`ChatSkills`: each Skill's name,
  description, source and `SKILL.md` instructions, and why the
  repository's could not be read). `floorChatSkills(floorSkills)` makes it
  from `FloorSkills.available` (#92): every Skill on the Floor, the
  repository's read through the GitHub App, kept 30 seconds per Floor (a
  failure is not kept). The server passes it to the chat (`server.ts`,
  `app.ts`), with the Floor Skills now made with the GitHub App and shared
  with the sandbox runner.
- **`/name [arguments]`**, read before the plain-code commands:
  - a Skill the Floor has: the Owner's message is kept with `skill`
    (`chosenBy: "owner"`, the arguments redacted) and its instructions,
    redacted; then the Manager's Model answers, as for any message;
  - a name the Floor has no Skill of: a `hint` at once, "There is no Skill
    /x on this Floor.", with the nearest name ("Did you mean "/y"?", by
    the commands' edit distance), the Floor's Skills (or how to add one),
    and why the repository's could not be read, if they could not. No
    model is called, and the Floor's next message is answered.
- **Loaded for the conversation**: each reply's prompt has a "Skills
  loaded in this conversation" section with every Skill loaded by the
  messages the Model is given (the last 50), each as it was last loaded:
  the latest 5, each cut at 40,000 characters with a note. They are
  trusted input (FR-76), and come after the commands and before the
  repository's memory and the Owner's instructions for the Manager.
- **The Manager's own choice**: unless the Owner ran a Skill, the prompt
  also has "Skills you can choose": the Floor's other Skills, by name and
  (redacted) description, and how to choose one: a first line `[use
  skill: name]` and nothing else.
  - While the reply's start could still be that line (`readSkillChoice`),
    it is held back from listeners; once it cannot, it is told.
  - When it chooses a Skill the Floor has, that call is stopped (its
    `AbortController`), the Skill is loaded, and the Model is asked again
    with it in the prompt and "You chose the Skill /name for the Owner's
    last message: follow it now."; no Skill is offered then. Listeners are
    told "Using the Skill /name." first, then the new answer.
  - The reply is kept as "Using the Skill /name.\n\n…", with `skill`
    (`chosenBy: "manager"`) and the instructions, so the Skill stays
    loaded for the conversation.
  - A choice of a Skill the Floor does not have is left out of the reply,
    which is otherwise the Model's own; so is a reply that only looks
    like one ("[usually] …"). A reply that comes whole (not a piece at a
    time) is read the same way.
- **Credentials**: the instructions, arguments and descriptions pass the
  chat's redactor before they are kept or reach a model.

### The web app (`apps/web`)

- **Autocomplete** (`skill-autocomplete.tsx`): while the box holds only
  `/` and the start of a name, the Floor's Skills that start with it, then
  those that hold it (at most 8), are listed under the box, each with its
  description. The arrow keys move through them, Enter or Tab (or a click,
  which keeps focus in the box) puts `/name ` in the box without sending,
  and Escape closes the list until the text changes. The box keeps its
  textbox role, with `aria-autocomplete="list"`, `aria-controls` and
  `aria-activedescendant` while the list is open; a polite live region
  says how many match.
- **Marks**: a message that ran a Skill, and a reply whose Skill the
  Manager chose, show **Skill /name**.
- The box's hint says `/skill-name` runs a Skill and `/` lists them.

The guide documents it under
[The Manager chat](../guide/events-and-chat.md#the-manager-chat).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (2813 passed, 379 skipped). Against an embedded Postgres 18.4
      (below), the whole suite: 3171 passed, 21 skipped, the new migration
      applied with the rest.
- [x] **Scenario tests: explicit command loads the Skill; automatic choice
      is announced.** `packages/orchestrator/src/manager/skills-scenario.test.ts`
      drives the Manager chat end to end: a Floor added from the fake
      GitHub, whose repository holds a `pdf` Skill (overriding the office
      library's `pdf`), an office `release-notes` Skill in the library,
      the real `FloorSkills` and `floorChatSkills`, and a scripted Model.
      Each case runs in memory and in Postgres 18 (10 tests, all passing):
  - **explicit command loads the Skill**: `/release-notes for version
    1.2` is kept with its Skill (`office`, arguments `for version 1.2`,
    `chosenBy: "owner"`); the Model's prompt has the Skill's instructions
    under "Skills loaded in this conversation", without its frontmatter
    and with a credential in it redacted, and offers no Skill; the next
    message's prompt still has it loaded, and offers only the others;
    `loadedSkills` names the message that loaded it;
  - **a repository Skill overrides the office's**: `/pdf` loads the
    repository's instructions, not the office's;
  - **an unknown name**: `/release-note for 1.2` is answered at once with
    `There is no Skill /release-note on this Floor. Did you mean
    "/release-notes"? Its Skills are /pdf and /release-notes.`, and no
    model is called;
  - **automatic choice is announced**: asked "Can you get the text out of
    invoice.pdf?", the Model first writes `[use skill: pdf]`; the first
    prompt offered `pdf` and `release-notes` with their descriptions; the
    second has `pdf`'s instructions and "You chose the Skill /pdf…"; the
    kept reply is "Using the Skill /pdf.\n\nPage 1: Invoice 42." with its
    Skill (`repository`, `chosenBy: "manager"`); listeners were told
    exactly that, never the choosing line; the next message still has
    `pdf` loaded;
  - **no choice**: a reply that starts "[usually]" is the Model's own,
    and a choice of a Skill the Floor does not have is left out; one call
    each.

Besides:

- `manager/prompt.test.ts` (6 new): the Skills sections, their order, the
  chosen Skill, the cut at 40,000 characters, none without Skills;
  `readSkillChoice` reading a choice, waiting on a start that could be
  one, and refusing others.
- `manager/chat-skills.test.ts` (2): instructions below the frontmatter,
  the repository's error, the 30-second cache, a failure not kept.
- `apps/server/src/manager-chat/routes.test.ts` (1 new): `/release-notes
  for 1.2` through the API, with an office Skill added through
  `POST /api/skills`: the message's `skill`, the Model's prompt, the
  history, and the hint for an unknown name.
- `apps/web/src/manager-chat.test.tsx` (2 new): the autocomplete (listed
  with descriptions, the arrow keys and `aria-selected` /
  `aria-activedescendant`, Enter and Tab putting `/name ` in the box
  without sending, a click, Escape then Enter sending as written); the
  **Skill /name** marks.
- `e2e/tests/available-skills.spec.ts` (1 new): the autocomplete in
  Chromium against the built app: `/` lists both Skills, ArrowDown and
  Enter put `/release-notes ` in the box.

**Negative checks** (each reverted afterwards from a copy, then the tests
were green again), across `skills-scenario.test.ts` and `prompt.test.ts`:

| Sabotage | Failed |
| --- | --- |
| Loaded Skills never reach the prompt | 5 tests |
| The choosing line is told to listeners as it arrives | 2 tests |
| No "Using the Skill /name." announcement | 1 test |
| `/name` is not read (it goes to the plain-code commands and the Model) | 3 tests |

### How Postgres and Chromium were run here

As for #92: `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
18.4) in `/tmp/pg18`, outside the repository, with a scratch edit to
`packages/db/src/testing/postgres.ts` (`SCRATCH_PG_URL`, database names
unique per worker) reverted with `git checkout` and never committed; and
Playwright's Chromium with Debian bookworm's shared libraries in
`/tmp/chromelibs`, through `LD_LIBRARY_PATH`, and `E2E_POSTGRES_URL`.

### Not verifiable in this sandbox

- **Testcontainers**: the Testcontainers path of the Postgres tests needs
  Docker; they ran against the embedded Postgres 18.4 instead, and run in
  CI.
- **A real Model choosing a Skill.** The scripted Model writes the
  `[use skill: name]` line itself; whether a real Manager's Model chooses
  well from the descriptions, and keeps to the line's form, is for the
  host with a real AI Account (PRD §9: CI never calls a live AI Provider).
  The prompt says exactly what to write, and anything else is answered as
  the Model's own.
- **The real GitHub App** (Owner action #18): repository Skills were read
  from the fake GitHub through the real App client.

## Output

### `pnpm lint`

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0
```

### `pnpm typecheck`

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test` (no Docker: the Postgres tests skip)

```text
 Test Files  243 passed (243)
      Tests  2813 passed | 379 skipped (3192)
exit=0
```

### `pnpm test` against the embedded Postgres 18.4

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  243 passed (243)
      Tests  3171 passed | 21 skipped (3192)
exit=0
```

### The scenario tests (verbose, against the embedded Postgres 18.4)

```text
 ✓ … Skills in the Manager chat, in memory > an explicit /name loads the Skill into the Manager's session for the rest of the conversation 124ms
 ✓ … Skills in the Manager chat, in memory > a repository Skill overrides the office's of its name 53ms
 ✓ … Skills in the Manager chat, in memory > a /name the Floor has no Skill of is answered with a hint, and reaches no model 52ms
 ✓ … Skills in the Manager chat, in memory > the Manager chooses a Skill whose description matches, and the reply says which it used 103ms
 ✓ … Skills in the Manager chat, in memory > a reply that chooses no Skill, or one the Floor does not have, is the Model's own 103ms
 ✓ … Skills in the Manager chat, in Postgres > an explicit /name loads the Skill into the Manager's session for the rest of the conversation 1732ms
 ✓ … Skills in the Manager chat, in Postgres > a repository Skill overrides the office's of its name 148ms
 ✓ … Skills in the Manager chat, in Postgres > a /name the Floor has no Skill of is answered with a hint, and reaches no model 147ms
 ✓ … Skills in the Manager chat, in Postgres > the Manager chooses a Skill whose description matches, and the reply says which it used 203ms
 ✓ … Skills in the Manager chat, in Postgres > a reply that chooses no Skill, or one the Floor does not have, is the Model's own 204ms
      Tests  10 passed (10)
```

### Playwright (`E2E_POSTGRES_URL`, embedded Postgres 18.4, Chromium, 2 workers)

```text
$ pnpm exec playwright test --workers=2 tests/available-skills.spec.ts tests/skills.spec.ts tests/accessibility.spec.ts tests/batch.spec.ts tests/status-report.spec.ts tests/whiteboard.spec.ts
  17 passed (3.0m)

$ pnpm exec playwright test --workers=2 tests/available-skills.spec.ts   (with the autocomplete test)
  3 passed (7.4s)
```

`manager-chat.spec.ts`, `agent-editor.spec.ts` and
`gateway-requests.spec.ts` still fail as they did before this batch:
they open Admin for cards the merged AI Settings page (#165) moved there.
See [issue-92.md](issue-92.md#the-whole-playwright-suite).

## Notes

- **"For the conversation".** There is no `/clear` on this branch yet
  (FR-87), so a conversation is what the Model is given: the Floor's last
  50 messages. A Skill stays loaded while the message that loaded it is
  among them. When `/clear` and `/compact` arrive, `loadedSkills`'s
  `sinceId` is where a cleared conversation starts.
- **How the Manager chooses.** The model calls here carry text only (no
  tools), so the choice is a first line the Manager writes. AI Office, not
  the Model, writes "Using the Skill /name.", so the reply always says
  which Skill it used (FR-74), and the Skill's instructions are only in
  the prompt once chosen, as the Agent Skills format's progressive
  disclosure has it: descriptions first, instructions on use.
- **Two calls for a choice.** Choosing costs the start of one call (it is
  stopped as soon as the line is read) and one more call, both through
  the AI Gateway with the Manager's Gateway Key, so both count against its
  Token Caps.
- **Which Skills.** All of the Floor's Skills are the Manager's: the Floor
  admin's per-Role switches are for sandbox Roles (FR-75).
- **A snapshot.** A loaded Skill is kept as it was loaded, so editing the
  Skill in the library does not change a conversation already using it;
  running it again loads the new version.
- **PRD and ADRs.** No disagreement found. The Skill's instructions reach
  only the Manager's own model calls through the AI Gateway (ADR 0001).

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `97de0fe`, after merging `feat/issues-110-130-b` into the
integration branch (`d5ae18f`) and its follow-ups: `1b5254a`
(configuration export and import carry Fresh Start thresholds) and
`97de0fe` (a Kickoff acknowledgement is no working context).

- **Migrations.** The integration branch keeps `0044_retention` to
  `0047_connection_delivery_retention`. This branch's
  `0044_context_usage_and_fresh_starts`, `0045_manager_chat_skills`,
  `0046_grilling_sessions` and `0047_manager_chat_compaction` are replaced
  by one regenerated `0048_context_usage_skills_and_grilling`, which this
  file now names. `drizzle-kit generate` finds nothing more to generate.
  It has not been applied to a real Postgres here (no Docker).

- **The server** builds the Manager chat with its Skills beside the other
  side's Communications Agent, webhooks and retention; nothing in the
  other side writes to the Manager chat.

### Output of the checks

```text
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  279 passed (279)
      Tests  3179 passed | 448 skipped (3627)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 448 skipped tests need what the sandbox lacks: Postgres 18 and
Mailpit through Testcontainers (Docker), Docker, hadolint or Caddy for
the deployment, or the real GitHub App. They run on the host and in CI.

The Skills-in-chat tests:

```text
 Test Files  3 passed (3)
      Tests  17 passed | 6 skipped (23)
```
