# Issue #21: Agents and Roles: a default team per Floor — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the issue's last code
commit (`91551d0`), after `pnpm install --frozen-lockfile`.

## What was built

- **`agents` table** (migration `0009_agents`). Each row holds an Agent's
  config from PRD FR-11:
  - name, Role, AI Provider, Model override (null uses the AI Provider's
    default), effort (null for the default), extra instructions (empty),
    enabled (true);
  - the Avatar as JSON, and daily and monthly Token Cap overrides (empty);
  - its Floor (a foreign key) and when it was created.

  It also enforces:
  - names unique on a Floor;
  - a check on the Role;
  - **`agents_one_manager_per_floor`**, a partial unique index on
    `floor_id` where the Role is `manager`.
- **Shared** (`packages/shared/src/agents.ts`, `avatar.ts`):
  - the Roles (the event schema now uses this one list) and how they are
    written (`QA`);
  - the default team's Roles, and the first AI Providers (Claude, ChatGPT,
    Grok, Gemini) with Claude's default Model, `claude-opus-5-5`;
  - the Agent API schema;
  - the **Avatar** of FR-13 (presentation, body shape, face, hairstyle and
    colour, skin tone, facial hair, glasses, accessories, outfit style and
    colours, desk mascot). `randomAvatar` picks one that looks unlike the
    others on the Floor (presentation, hair, skin and outfit), and gives
    up after 1000 tries rather than loop.
- **The orchestrator** (`packages/orchestrator/src/agents/`):
  - **The default team.** Adding a Floor now stores it with a Manager, a
    coder, a reviewer and a QA Agent, all or nothing (one transaction in
    Postgres). They have distinct random names (from a list of computing
    pioneers' first names) and distinct random Avatars. They use Claude
    with its default Model, are enabled, and override nothing. The reviewer
    becomes the Floor's required reviewer (FR-27). Each is announced with
    `agent.created`, after `floor.created`.
  - **`createAgents`** lists a Floor's Agents, oldest first (archived
    Floors' too), and adds more. It refuses:
    - a second Manager (`manager_exists`);
    - a name already on the Floor (`agent_name_taken`);
    - an AI Provider with no default Model unless a Model is given
      (`model_required`);
    - an archived Floor, or one that does not exist.

    The store checks again, so a race cannot slip a second Manager in. In
    Postgres the index refuses it whatever the code does. Adding Agents
    has no API yet: that is #47.
  - **Stores:** `databaseStores(db)` and `memoryStores()` give the Floor
    and Agent stores as a pair.
- **The API:** `GET /api/floors/:floorId/agents` (signed-in session) lists
  a Floor's Agents, each with the Model it uses and whether that is an
  override. It answers 404 `floor_not_found` for an unknown Floor.
- **The web app:** the Floor admin page has a read-only **Agents** table:
  name, Role, AI Provider, Model (marked "(default)" when it is the AI
  Provider's), and Enabled or Paused. The required reviewer is marked.
- **README:** an "Agents" section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone (output below).
- [x] **Integration tests: new Floor gets the default team; a second
      Manager is refused.** `packages/orchestrator/src/agents/agents.test.ts`
      runs 7 cases with the Floors and Agents in memory and again in
      Postgres 18:
      - **The default team:** a new Floor's Agents are a Manager, a coder,
        a reviewer and a QA Agent, in that order. Each is checked field by
        field: Claude, no Model override, no effort, no extra instructions,
        enabled, no Token Cap overrides, a valid Avatar. Their names and
        Avatar looks are distinct. The reviewer is the Floor's required
        reviewer. Four `agent.created` events follow `floor.created`, each
        with Model `claude-opus-5-5`.
      - **A second Manager is refused:** `manager_exists`, with "web-shop
        already has its Manager: a Floor has exactly one." The team is
        unchanged and no event is published.
      - **Each Floor has its own Manager:** a second Floor gets one too.
      - **The rest:** more Agents of other Roles can be added (two coders
        on one Floor), each with a distinct name and Avatar. Refused: a
        name already on the Floor; Grok with no Model; an archived Floor;
        an unknown Floor.
      - **The store's own check (memory)**, and in Postgres **the table's**:
        an `INSERT` of a second Manager row, past all the code, is refused
        by `agents_one_manager_per_floor`. A Manager on another Floor is
        fine.

      The server's `apps/server/src/agents/routes.test.ts` checks the API
      lists the team (and 404s), in memory and in Postgres.

      Without Docker the Postgres runs are skipped with the reason. They
      were run against an embedded Postgres 18.3 with the scratch fixture
      of #20 (nothing from it is committed). All 76 Postgres tests passed:
      the Agent, Floor and migration suites (output below).
- [x] **Playwright: the Floor admin lists the four Agents.**
      `e2e/tests/agents.spec.ts`:
      1. The Owner adds `adrianeyre/web-shop` from Admin and opens its
         Floor admin.
      2. The Agents table has four rows: Manager, Coder, Reviewer (marked
         "required reviewer") and QA.
      3. Each row reads "Claude claude-opus-5-5 (default) Enabled", and
         the four names are distinct.
      4. After a reload the same four names are listed.

      It passed with the other 7 (8 of 8) in real Chromium against the real
      server and the embedded Postgres 18.3 (output below).

### Also checked here

- **Unit tests:**
  - `packages/shared/src/avatar.test.ts`: 200 random Avatars are valid;
    the same random numbers give the same Avatar; 31 on one Floor all look
    different; it gives up after 1000 tries instead of looping.
  - `packages/orchestrator/src/agents/names.test.ts`: every name is used
    once before any repeats, then numbered (`Ada 3`).
- **Web unit test** (`apps/web/src/floors.test.tsx > lists the Floor's
  Agents, read-only`): the table's rows and cells exactly, including an
  overridden Model and a paused Agent, with nothing to edit.
- **Negative checks**, each restored afterwards:
  - With the Manager checks removed from the service and the memory store,
    both in-memory "refuses a second Manager" tests failed. The Postgres
    runs still passed: the table's index refused the second Manager on its
    own, and the store reported it.
  - With QA left out of the default team, the Playwright test failed
    (`Expected: 5, Received: 4` rows).
- **#20's tests**, updated to the team. A new Floor's
  `requiredReviewerAgentIds` is now its reviewer, and `floor.created` is
  followed by four `agent.created` events. While doing this, an unhandled
  rejection showed up against Postgres in tests that built several
  refused promises before awaiting them; they now make each in turn.

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written**, because there is no
  Docker. They ran against an embedded Postgres 18.3 instead (above).
- **`pnpm e2e` with Testcontainers**, for the same reason. It ran with
  `E2E_POSTGRES_URL` instead.

### Notes

- **Default Models.** FR-15 has the Owner choose each AI Provider's default
  Model from the AI Gateway's live catalogue in the office admin, which
  does not exist yet. Until it does, only Claude's default is known
  (`claude-opus-5-5`, the PRD's own example). An Agent of another AI
  Provider needs its own Model; that only matters once Agents can be added
  (#47).
- **Gateway Keys.** ADR 0001 says each Agent gets its own Gateway Key,
  "created with the Agent". Gateway Keys do not exist yet (PRD phase 2,
  FR-46), and this issue's "What to build" does not ask for them. When
  they come, they must be created for existing Agents as well as new ones.
- **Removing Agents** (FR-10) and editing them (FR-12) are #47. Nothing
  can remove the Manager yet; "exactly one" holds because a Floor is
  created with one and a second is refused.

## Output

### Fresh clone (`/tmp/clone21`, at `91551d0`)

```text
$ pnpm install --frozen-lockfile --offline
Done in 369ms using pnpm v12.10.0
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0
$ pnpm typecheck
typecheck exit=0
$ pnpm test
 Test Files  47 passed (47)
      Tests  537 passed | 64 skipped (601)
test exit=0
```

The 64 skipped tests are the 54 of #20 and the 10 new Postgres runs (8
Agent cases and 2 API cases).

### The Agent tests, verbose

```text
 ✓ src/agents/names.test.ts > a new Agent's name > is one no other Agent on the Floor has
 ✓ src/agents/names.test.ts > a new Agent's name > is numbered once every name is used
 ✓ src/avatar.test.ts > a random Avatar > is a valid Avatar
 ✓ src/avatar.test.ts > a random Avatar > is the same for the same random numbers
 ✓ src/avatar.test.ts > a random Avatar > looks different from the others on its Floor
 ✓ src/avatar.test.ts > a random Avatar > gives up rather than loop when it can only repeat itself
 ✓ src/agents/agents.test.ts > Agents, kept in memory > gives a new Floor a Manager, a coder, a reviewer and a QA Agent
 ✓ src/agents/agents.test.ts > Agents, kept in memory > refuses a second Manager
 ✓ src/agents/agents.test.ts > Agents, kept in memory > lets each Floor have its own Manager
 ✓ src/agents/agents.test.ts > Agents, kept in memory > adds more Agents of any other Role, each unlike the others
 ✓ src/agents/agents.test.ts > Agents, kept in memory > refuses a name another Agent on the Floor has
 ✓ src/agents/agents.test.ts > Agents, kept in memory > refuses an AI Provider with no default Model unless given a Model
 ✓ src/agents/agents.test.ts > Agents, kept in memory > adds no Agents to an archived Floor, nor to one that does not exist
 ✓ src/agents/agents.test.ts > Agents, kept in memory > refuses a second Manager in the store too
 ↓ src/agents/agents.test.ts > Agents, kept in Postgres 18 > … (8 tests) [skipped: no Docker]
 ✓ src/agents/routes.test.ts > the Agent API, in memory > lists a new Floor's Manager, coder, reviewer and QA Agent
 ✓ src/agents/routes.test.ts > the Agent API, in memory > answers 404 for a Floor that does not exist
 ↓ src/agents/routes.test.ts > the Agent API, in Postgres 18 > … (2 tests) [skipped: no Docker]
```

### Postgres 18.3 (embedded binary, sandbox)

The Agent and Agent API runs; the same run passed the Floor and migration
suites too (76 in all).

```text
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > gives a new Floor a Manager, a coder, a reviewer and a QA Agent
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > refuses a second Manager
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > lets each Floor have its own Manager
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > adds more Agents of any other Role, each unlike the others
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > refuses a name another Agent on the Floor has
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > refuses an AI Provider with no default Model unless given a Model
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > adds no Agents to an archived Floor, nor to one that does not exist
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > has the table refuse a second Manager on a Floor
 ✓ apps/server/src/agents/routes.test.ts > the Agent API, in Postgres 18 > lists a new Floor's Manager, coder, reviewer and QA Agent
 ✓ apps/server/src/agents/routes.test.ts > the Agent API, in Postgres 18 > answers 404 for a Floor that does not exist
      Tests  76 passed (76)
```

### Playwright (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium)

```text
Running 8 tests using 8 workers

  ✓  5 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (1.7s)
  ✓  6 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (2.0s)
  ✓  3 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (2.1s)
  ✓  8 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.0s)
  ✓  1 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (2.3s)
  ✓  4 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (2.3s)
  ✓  2 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (2.5s)
  ✓  7 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (2.4s)

  8 passed (3.8s)
```

### Negative checks

```text
$ # Manager checks removed from the service and the memory store
 × packages/orchestrator/src/agents/agents.test.ts > Agents, kept in memory > refuses a second Manager
 × packages/orchestrator/src/agents/agents.test.ts > Agents, kept in memory > refuses a second Manager in the store too
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > refuses a second Manager
 ✓ packages/orchestrator/src/agents/agents.test.ts > Agents, kept in Postgres 18 > has the table refuse a second Manager on a Floor

$ # default team without QA
  ✘  4 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (7.1s)
    Error: expect(locator).toHaveCount(expected) failed
    Expected: 5
    Received: 4
  1 failed
  7 passed (8.4s)
```
