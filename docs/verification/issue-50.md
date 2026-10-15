# Issue #50: Token accounting and Token Caps — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`567f5db`).

## What was built

### Accounting (FR-31)

- **What counts.** A request's tokens are its input plus output, as Token
  Caps count them (and as least-used load balancing already did). Cache
  reads and cache writes are added up apart, with the estimated cost for
  information only.
- **Where from.** The AI Gateway's request records (`gateway_requests`).
  `RequestHistoryStore.tokenUsage(from, to)` adds up the requests started
  in [`from`, `to`) per Floor, Agent, issue and Owner tool (the finest
  grain), in memory or with one `GROUP BY` in Postgres. The orchestrator
  rolls those rows up per Agent, Floor, issue and Owner tool.
- **Periods.** The day and the month, in UTC (`periodBounds`).

### Token Caps (FR-32)

- **Levels.** The office's daily and monthly defaults (new columns in
  `office_settings`; 5,000,000 a day and 100,000,000 a month until the
  Owner sets them). The Floor's (its existing settings). The Agent's (its
  existing columns, now editable). The issue's (new table
  `issue_token_caps`, migration `0024_token_caps`).
- **The most specific applies** (`resolveTokenCap` in
  `packages/shared/src/token-caps.ts`). For an Agent's work it takes the
  issue's cap, else the Agent's, else its Floor's, else the office's.
  The day and the month are each resolved on their own.
- **What a cap counts.** An issue's cap counts every Agent's tokens on
  that issue. An Agent's, a Floor's or the office's cap counts the Agent's
  own tokens (see Notes).
- **`createTokenCaps`** (`packages/orchestrator/src/caps/token-caps.ts`):
  - the office's caps, and setting them;
  - setting or removing an issue's caps, on a Floor in use;
  - `capUse({ floorId, agentId, issue })`: the cap in force for each
    period, its level and its use (what #51 will enforce);
  - `officeUsage()`: the Office's totals, per Floor and per Owner tool,
    and the Agent nearest its cap;
  - `floorUsage(floorId)`: the Floor's caps and totals, its Agents'
    default caps and each Agent's use against its cap, and its issues'
    caps and use (issues with caps, or used this month).

  Each change is a `config.changed` event naming the caps, never their
  values:
  - `tokenCaps.daily` (office);
  - `issues.12.tokenCaps.daily` (floor);
  - `tokenCaps.monthly` (agent).

### API

All need a signed-in session; the route-access test checks them.

- `GET /api/office/token-caps` answers the office's caps and the Office's
  use. `PUT` with `{"daily","monthly"}` sets them: whole numbers above 0,
  nothing else.
- `GET /api/floors/:floorId/token-usage` answers the Floor's caps and use.
- `PUT /api/floors/:floorId/issues/:issue/token-caps` with
  `{"daily","monthly"}` sets an issue's caps (null for none).
- `PATCH /api/floors/:floorId/agents/:agentId` now also takes
  `tokenCaps`.

### Web: editing caps, each with its use

- **Office admin.** A new **Token Caps** card:
  - the daily and monthly caps, each with the Agent nearest it ("Nearest
    its cap today: Ada, 1,490 of 2,000 (the Agent's own)");
  - the Office's use today and this month (tokens, cache reads, estimated
    cost);
  - tables by Floor and by Owner tool.
- **Floor admin.**
  - The Floor's own caps stay in its settings.
  - The Agents table gains **Tokens today** and **Tokens this month**:
    each Agent's use against the cap in force, and where that cap is set
    (FR-12).
  - A new **Token usage** card shows the Floor's use and its Agents'
    default caps, and lists issues against their caps. It also sets and
    removes an issue's caps.
- **Agent editor.** Daily and Monthly Token Cap fields, each with "Used
  today: 1,234 of 800,000, the Floor's cap. Empty uses the Floor's or the
  office's."

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). Without Docker: 1147 passed, 221 skipped (the
      Postgres tests, with the reason). Against an embedded Postgres 18:
      1353 passed, 15 skipped.
- [x] **Unit tests: cap resolution precedence.**

  `packages/shared/src/token-caps.test.ts`:
  - the office's default applies when nothing more specific is set,
    including levels set to null;
  - every combination of levels: the issue beats the Agent, the Agent its
    Floor, and the Floor the office;
  - the most specific cap applies whether it is higher or lower;
  - each period resolves on its own;
  - UTC day and month bounds, including a year's end and 29 February.

  `packages/orchestrator/src/caps/token-caps.test.ts`, in memory and in
  Postgres 18. The same Agent's caps move office → Floor → Agent → issue
  as each is set. An issue's cap counts another Agent's tokens on the
  issue, and other issues do not get it. An Agent without its own cap
  falls back to the Floor, then the office, period by period.

  **Negative check:** with the order made Agent before issue, 2 tests
  fail (reverted afterwards).
- [x] **Unit tests: aggregates match request records.**

  `packages/gateway/src/history/history.test.ts`, in memory and in
  Postgres 18:
  - 60 requests from a fixed pseudo-random sequence are recorded: two
    Agents on one Floor, one on another, and an Owner tool; issues none,
    #4 or #7; tokens sometimes missing (null); costs.
  - Their times include the moment before the day, its first and last
    moments, and the next day's first.
  - `tokenUsage` for the day must equal sums computed straight from the
    records, row by row: requests, input, output, cache reads, cache
    writes, tokens and cost.
  - The next day is empty.

  **Negative check:** with the end of the period counted in, this test
  fails (reverted afterwards).

  `apps/server/src/token-caps/routes.test.ts`, in memory and in
  Postgres 18:
  - Six records are written into the request history, one of them last
    month.
  - The API's totals must equal what those records add up to: the
    Office's day (every count, cache reads, cost) and month, per Floor
    and per Owner tool.
  - Its caps must hold: the coder's use against the office's cap, then
    the Floor's daily cap, the Agent's monthly cap and an issue's daily
    cap, each where it applies.
  - It refuses bad caps, bad issue numbers and unknown Floors.

### Other tests added

- `packages/orchestrator/src/agents/agents.test.ts`: an Agent's own caps
  set and cleared, with their `config.changed` keys (memory and
  Postgres 18).
- `apps/web/src/token-caps.test.tsx`: the office card's caps, the Agent
  nearest its cap, the Office's use, the Floor and Owner tool tables;
  saving; a 0 cap refused before sending.
- `apps/web/src/floors.test.tsx`:
  - the Agents table's token columns;
  - the Agent editor's cap fields, with their use;
  - an issue's caps set and removed in the Token usage card.

The Playwright suite (19 tests) passes against the embedded Postgres 18 in
Chromium, twice in a row (output below).

**A test fix along the way.** `gateway-requests.spec.ts` failed once in a
full parallel run, and passed five runs in a row alone. The body-storage
checkbox changes at once, before its `PUT` is answered, so under load the
test could send its next request while bodies were still kept. The test
now waits for that `PUT`'s answer (`test(e2e): wait for body storage to be
saved…`). It asserts exactly what it did before.

### How Postgres and Chromium were run here

As for #47: `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp/pgpkg`
(port 54329); a scratch patch, applied only for the run and reverted,
pointed `postgresTest` at it; `E2E_POSTGRES_URL` for `pnpm e2e`. Chromium
from `playwright install chromium`, with Debian bookworm's libraries in
`/tmp/chromelibs`. None of this is in the repository.

## Not verifiable in this sandbox

- **Docker:** the Testcontainers Postgres, the compose stack, and
  migration `0024_token_caps` on the compose database. The migration was
  applied to the embedded Postgres 18 by every Postgres test.
- **Real traffic:** no real AI Account's requests were counted. The
  records were written by the tests.
- **Volume:** usage is read from `gateway_requests` with one grouped query
  per period, on each read of a usage page. How fast that is over months
  of real records was not measured. The `started_at` index serves its
  range.

## Notes, and readings of the canon

- **What each level's cap counts.** The glossary defines a Token Cap as "a
  limit on tokens an Agent may use in a period, set office-wide by default
  and overridable per Floor, per Agent and per issue". So the office's
  and a Floor's caps are defaults for each of their Agents, not limits on
  their totals. The most specific one set applies (FR-32).
  - An **issue's** cap is read as a limit on the issue: every Agent's
    tokens on it count. While an Agent works the issue, it applies in
    place of the Agent's own.
  - FR-32's "every level is shown with its current use" is met by showing
    each level's totals (Office, Floor, issue, Owner tool), and each
    Agent's use against the cap in force for it.

  If the Owner meant Floor and office caps as totals, `capUseOf` is the
  one place to change.
- **Owner tools' caps.** FR-33 says Owner tools "can have caps too". This
  issue's levels are office, Floor, Agent and issue, so Owner tools are
  added up and shown (per day and month) but have no cap yet. Their caps
  belong with enforcement (#51) or a later issue.
- **The office's default values** (5,000,000 a day, 100,000,000 a month
  per Agent) are not in the PRD. They were chosen so that no Agent can
  spend without bound from the start (Goal 3). The Owner changes them in
  Admin.
- **UTC.** Days and months are UTC; the PRD names no time zone.
- **Enforcement** (warnings at 80%, refusals at 100%, pausing) is #51,
  out of scope here.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  115 passed (115)
      Tests  1147 passed | 221 skipped (1368)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  115 passed (115)
      Tests  1353 passed | 15 skipped (1368)
   Duration  59.40s (tests 83%, import 11%, transform 3%, environment 2%)
```

The issue's own tests, verbose, against Postgres 18 (excerpt):

```text
 ✓ |@ai-office/shared| src/token-caps.test.ts > resolveTokenCap > uses the office's default when nothing more specific is set
 ✓ |@ai-office/shared| src/token-caps.test.ts > resolveTokenCap > lets the issue beat the Agent, the Agent its Floor, and the Floor the office
 ✓ |@ai-office/shared| src/token-caps.test.ts > resolveTokenCap > applies the most specific cap whether it is higher or lower
 ✓ |@ai-office/shared| src/token-caps.test.ts > resolveTokenCap > resolves each period on its own
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in memory > adds up the tokens of the requests in a period per Floor, Agent, issue and Owner tool, as their records say
 ✓ |@ai-office/gateway| src/history/history.test.ts > request history, kept in Postgres 18 > adds up the tokens of the requests in a period per Floor, Agent, issue and Owner tool, as their records say
 ✓ |@ai-office/orchestrator| src/caps/token-caps.test.ts > Token Caps, kept in Postgres 18 > applies the most specific cap set, counting the issue's tokens for an issue's cap and the Agent's for the others
 ✓ |@ai-office/server| src/token-caps/routes.test.ts > the Token Caps API, in Postgres 18 > answers the office's caps and the Office's use, as the request records add up
 ✓ |@ai-office/server| src/token-caps/routes.test.ts > the Token Caps API, in Postgres 18 > answers a Floor's Agents and issues against their caps, as set at each level
      Tests  42 passed (42)
```

`pnpm e2e` (tail, second run):

```text
  19 passed (14.3s)
```
