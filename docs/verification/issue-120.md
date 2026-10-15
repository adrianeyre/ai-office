# Issue #120: Context Usage tracking and display — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

The blockers are built on this branch:

- #35, Gateway Keys ([`issue-35.md`](issue-35.md)): each request in
  `gateway_requests` names its Agent and Floor, which Context Usage is
  counted against.
- #46, the model catalogue ([`issue-46.md`](issue-46.md)): each Model's
  context window, when its AI Provider's models list gives one.

## What was built

- **The measure** (`packages/shared/src/context-usage.ts`, PRD FR-84,
  FR-85):
  - `contextUsageOf(inputTokens, contextWindow)`: from 0 to 1, or null
    when the window is unknown (never 0). A call larger than the window
    counts as full.
  - `contextUsageBand(usage)`: `green` below 0.6, `amber` from 0.6, `red`
    from 0.85, `unknown` for null. `contextUsageBandTokens` maps them to the
    palette (`state-ok`, `state-warning`, `state-critical`,
    `state-neutral`), for the 2D views and the 3D displays alike.
  - `contextUsageText`: whole percent, rounded down (so 84.9% stays amber,
    and its text says 84%), or `Unknown`.
- **The session** (`packages/gateway`, migration
  `0048_context_usage_skills_and_grilling`): the Gateway already routed
  by the `x-ai-office-session` header, which every sandbox's agent tool sends
  with its run's id. It now records it in `gateway_requests.session`.
- **The tracker** (`createContextUsage`,
  `packages/orchestrator/src/context/usage.ts`):
  - Every request the Gateway records is told to it
    (`observeModelCalls`, from the request history's subscription). Its
    input tokens are the whole prompt: fresh, cache-read and cache-written,
    as the Gateway normalises every AI Provider's usage. They are kept
    against the calling Agent's current session and divided by its Model's
    context window from the catalogue (`contextWindowOf`, reading the
    catalogue at most once a minute).
  - **Excluded:** reviewer calls (stateless), calls to another Model than
    the Agent's (an agent tool's small-model side calls would otherwise
    drop the gauge), failed calls, `count_tokens` and Codex's
    `responses/compact`, calls without usage, calls that started before
    the one already counted, and calls from a session that has ended.
  - **Sessions:** a request naming a new session starts a new one. A
    stopped sandbox ends its own session (`followSandboxSessions`, from
    `sandbox.stopped`), and a removed Agent is forgotten. The Manager
    chat's calls name no session, so they are one session for as long as
    it lasts (FR-84 includes the Manager chat).
  - **The event:** `agent.context_usage` (new in `@ai-office/events`),
    published when the Agent's whole percentage changes, or whether it is
    known changes. It is also published when its session ends, with
    `active: false`. Listeners in the process (`subscribe`) hear of every
    call, for #121's threshold.
- **The API:** `GET /api/floors/:floorId/context-usage` lists each of the
  Floor's Agents with a session going: its issue, Model, input tokens,
  context window, Context Usage (0 to 1, or null) and when it changed. It
  answers 404 for a Floor that does not exist, and needs a session like
  every route.
- **The 2D views** (`apps/web/src/context-usage.tsx`):
  `ContextUsageGauge` is a small meter filled and coloured by band, with
  the percentage as text. It shows `Unknown` without a context window, and
  a dash without a session. `useContextUsage(floorId)` reads the API, then
  applies the Floor's `agent.context_usage` events, reading it again
  whenever the stream reconnects. The gauge is shown:
  - on the Agent live view's page, under the Agent's name (not for
    reviewers);
  - in a new **Context Usage** column of the Floor admin's Agent list.
- The Activity Feed names the new event ("Context Usage") in its Agents
  group, and the README has a Context Usage section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Their output
  is below. Postgres cases (366 across the suite) skip without Docker, as
  they did before this issue.
- [x] **Unit tests: usage computed from recorded requests.**
  - `packages/orchestrator/src/context/usage.test.ts` feeds recorded calls
    to the tracker and checks the usage, the events and the API body.
  - `apps/server/src/context-usage/routes.test.ts` records requests into
    the request history of a real app and reads
    `GET /api/floors/web-shop/context-usage`: 172,000 tokens of a
    200,000-token window is `0.86`, and the reviewer's call is not listed.
  - `packages/gateway/src/balancing/routing.test.ts` checks that requests
    through the Gateway record the session they named (none for an Owner
    tool).
- [x] **Unit tests: colour bands at 59/60/84/85%.**
  - `packages/shared/src/context-usage.test.ts` checks 0.59 green, 0.6
    amber, 0.84 amber and 0.85 red, and the same edges from whole token
    counts of a 200,000-token window (119,999 green, 120,000 amber,
    169,999 amber, 170,000 red).
  - `apps/web/src/context-usage.test.tsx` checks that the gauge renders
    59%, 60%, 84% and 85% in green, amber, amber and red.
- [x] **Missing context windows show as unknown, not 0%.**
  - `contextUsageOf` gives null without a window.
  - The tracker's event and the API carry `contextUsage: null` (tracker
    test and server test, each with a Model the catalogue lists without a
    window).
  - The gauge shows `Unknown`, with no meter and no `0%` (web test).

### Verified on the host

- [ ] **A real coder run shows Context Usage rising in the live view.**
  This needs Docker, Claude Code, a real AI Account and #18's GitHub App
  and sandbox repository. In the sandbox, the live view test streams
  `agent.context_usage` events into the real page: 62% amber, then 86%
  red, then the session ends.

## Not verifiable in this sandbox

- **A real agent tool sending `x-ai-office-session`.** Claude Code
  (`ANTHROPIC_CUSTOM_HEADERS`), Codex (`env_http_headers`) and opencode
  were already configured to send it
  (`packages/orchestrator/src/sandbox/agent-tools.ts` and
  `environment.ts`). Only the Gateway's recording of it is tested here,
  with a stand-in client.
- **Real AI Providers' models lists giving context windows.** ChatGPT's
  Codex backend gives `context_window`. Whether Anthropic's, xAI's and
  Google's do depends on the live endpoints, and recorded fixtures wait
  for #45. A Model without one shows Unknown, by design.
- **Postgres:** the `gateway_requests.session` column round-trip (migration
  0042) runs in the Postgres cases of the request history tests, which
  skip without Docker.
- **A browser:** the gauge's look (colours, width) was checked through the
  DOM only. No Playwright run, as Playwright needs Docker for Postgres.

## Notes

- **Out of scope here, as the issue says:** the desk monitor gauge (#68),
  the wall board (#69), the Agent card (#72) and the bar above each
  Agent's head. They read `GET /api/floors/:floorId/context-usage` and
  follow `agent.context_usage`, with `contextUsageBand` and
  `contextUsageBandTokens` for the colours. The verification notes of
  #68, #69 and #72 were waiting for this API.
- **Events per whole percent.** "Emit a Context Usage event on change" is
  read as a change in the whole percentage shown (or its being known).
  Every model call changes the exact token count, and an event for each
  would add one Activity Feed row per call. Listeners in the process hear
  of every call.
- **Side calls.** PRD FR-84 says "its latest model call". Only calls to the
  Agent's own Model count. Claude Code makes small-model calls of a few
  hundred tokens beside the main conversation, and counting those would
  make the gauge jump to near 0% and back.
- **`model_call.completed` is still not published** (noted in #32, #68 and
  #69). Context Usage does not depend on it: it is fed from the request
  history directly.
- **Memory only.** Context Usage is kept in the server's memory. A restart
  stops every sandbox, and with them their sessions. The Manager chat's
  usage comes back with its next call.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  234 passed (234)
      Tests  2739 passed | 366 skipped (3105)
   Duration  87.15s (tests 40%, import 39%, transform 14%, environment 6%, setup 1%)
```

The issue's own tests (`vitest run --reporter=verbose` on its four new
test files):

```text
 ✓ |@ai-office/shared| src/context-usage.test.ts > contextUsageBand > is green below 60%, amber from 60% and red from 85% 3ms
 ✓ |@ai-office/shared| src/context-usage.test.ts > contextUsageBand > puts the bands' edges where whole tokens land on them 1ms
 ✓ |@ai-office/shared| src/context-usage.test.ts > contextUsageBand > is unknown, not green, when the usage is not known 0ms
 ✓ |@ai-office/shared| src/context-usage.test.ts > contextUsageOf > divides the input tokens by the context window 0ms
 ✓ |@ai-office/shared| src/context-usage.test.ts > contextUsageOf > is null, not 0, without a context window 0ms
 ✓ |@ai-office/shared| src/context-usage.test.ts > contextUsageOf > counts a call larger than the catalogue's window as full 0ms
 ✓ |@ai-office/shared| src/context-usage.test.ts > contextUsageText > writes whole percentages, rounded down, or Unknown 1ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > ContextUsageGauge > shows 0.59 as 59% in green 231ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > ContextUsageGauge > shows 0.6 as 60% in amber 19ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > ContextUsageGauge > shows 0.84 as 84% in amber 21ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > ContextUsageGauge > shows 0.85 as 85% in red 14ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > ContextUsageGauge > shows a missing context window as unknown, not 0% 7ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > ContextUsageGauge > shows a dash without a session going 2ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > withContextUsageEvent > adds or replaces the Agent's Context Usage 2ms
 ✓ |@ai-office/web| src/context-usage.test.tsx > withContextUsageEvent > removes the Agent once its session has ended 0ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > callInputTokens > is the whole prompt: fresh, cache-read and cache-written tokens 4ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > callInputTokens > is unknown when the call reported no usage 0ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > computes Context Usage from recorded requests: the latest call's input tokens over the Model's context window 57ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > emits an event only when the whole percentage changes 5ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > shows a Model with no context window in the catalogue as unknown, not 0% 2ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > leaves reviewer calls out: they are stateless 1ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > counts the Manager chat's calls, which name no session 1ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > ignores side calls to another Model, failed calls, token counting and calls without usage 1ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > ignores a call that started before the one already counted 2ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > starts again with each session, and ends with it 2ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > does not end the current session for another that ended 2ms
 ✓ |@ai-office/orchestrator| src/context/usage.test.ts > createContextUsage > follows sandboxes: a stopped sandbox ends its session, a removed Agent is forgotten 5ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > GET /api/floors/:floorId/context-usage > lists each Agent with a session going and its Context Usage, from the requests the Gateway recorded 183ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > GET /api/floors/:floorId/context-usage > shows a Model with no context window in the catalogue as unknown, not 0% 92ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > GET /api/floors/:floorId/context-usage > answers 404 for a Floor that does not exist, and 401 signed out 55ms
 ✓ |@ai-office/server| src/context-usage/routes.test.ts > contextWindowOf > reads a Model's context window from its AI Provider's catalogue, at most once a minute 1ms
 Test Files  4 passed (4)
      Tests  31 passed (31)
```

And the changed tests elsewhere:

```text
 ✓ |@ai-office/gateway| src/balancing/routing.test.ts > routing headers through the Gateway > keeps each Agent session on one account, and spreads sessions across the best priority 44ms
 ✓ |@ai-office/web| src/agent-live-view.test.tsx > the Agent live view > shows the Agent's Context Usage, colour-coded and kept live by its events 186ms
 ✓ |@ai-office/web| src/floors.test.tsx > the Floor admin page > lists the Floor's Agents, with their Gateway Keys 227ms
```

A baseline run before this issue's changes had two timeouts in
`apps/web/src/scene/floor-layout.test.ts` ("keep every path of 9/10
Agents' Floor clear of furniture and walls", 5 s limit, under the full
parallel run). That file was not changed here, and it passed in the
full run above.

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

- **The Kickoff's acknowledgements** (#85, merged in from the other side)
  are asked of each assigned Agent through the AI Gateway as that Agent,
  naming no session. They were counted as the Agent's working context, so
  a coder had a Context Usage between the Kickoff and its sandbox's first
  call that no sandbox would ever end. Now only the Manager's calls count
  without a session; another Agent's is a one-off, as stateless as a
  review (`97de0fe`, with a test). The Communications Agent's Digests and
  reports belong to no Floor and were already left out; a test says so.

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

The Context Usage tests:

```text
 Test Files  4 passed (4)
      Tests  36 passed (36)
```
