# Issue #52: Analytics dashboards and insights — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

### The API (`apps/server/src/analytics/routes.ts`)

Four routes. Each needs a signed-in session and declares its access, so
the route-access test covers it. Each takes `from` and `to` (ISO 8601, at
most 366 days apart; at most 31 by the hour). A range that ends before it
starts, is too long, or is badly formed is `400`.

| Route | What it answers |
| --- | --- |
| `GET /api/analytics/series?bucket=hour\|day` | The totals for the range, and per bucket: every bucket, empty ones too. |
| `GET /api/analytics/breakdown?by=…` | The totals per AI Account, AI Provider, Model, Floor, Agent, issue or Owner tool, most tokens first. |
| `GET /api/analytics/insights` | The top consumers (Agents and Owner tools by tokens, with their share), and the AI Accounts close to their limits (a usage window at 80% or more that has not reset, or held back now). |
| `GET /api/analytics/usage-windows` | Each AI Account's usage-window readings in the range, oldest first. |

"Totals" means:

- requests;
- errors (status ≥ 400) and the error rate;
- input, output, cache-read and cache-write tokens;
- tokens (input plus output, as Token Caps count them);
- estimated cost;
- mean latency.

How the totals are computed:

- **One grain.** `RequestHistoryStore.analyticsRows(from, to, bucket)`
  adds up `gateway_requests` per bucket (`date_trunc` in UTC), AI Account
  name, Model, Floor, Agent, issue and Owner tool, with one `GROUP BY` in
  Postgres or a loop in memory.
- **Rolled up.** Pure functions in `packages/gateway/src/analytics/`
  (`seriesOf`, `breakdownOf`, `topConsumersOf`, `accountsNearLimits`) roll
  that grain up. The routes add Floors' and Agents' names; a removed one
  keeps its id.
- **AI Provider** comes from the Model (`aiProviderOfModel`), so requests
  served by a since-deleted account still count. A request refused before
  any account served it (such as at a Token Cap) shows as "No AI Account".
- Shared Zod schemas are in `packages/shared/src/analytics.ts`.

### The dashboards (`apps/web/src/analytics-page.tsx`, `analytics-charts.tsx`)

**Analytics** in the navigation (`/analytics`, with `range` and `by` in
the address):

- **Filter row.** One row above everything: Last 24 hours (by the hour),
  Last 7, 30 or 90 days (by the day). Each range is whole UTC buckets,
  ending with the current one.
- **Stat tiles.** Requests; tokens (with cache read and write); estimated
  cost; mean latency; error rate (with "4 of 40 requests").
- **Over time**, one chart each and one axis each:
  - requests (columns);
  - tokens by type (stacked columns: input, output, cache read, cache
    write);
  - estimated cost (line);
  - mean latency (line);
  - error rate (line).
- **Insights.** The top consumers, each with a share meter and a link to
  an Agent's live view. The AI Accounts near their limits, each with a
  status icon, a label and a meter.
- **Breakdown** by any dimension: horizontal bars of tokens (the top ten,
  the rest folded into "Other"), and a table of every item with its
  requests, tokens, cache, cost, latency and error rate.
- **Usage-window history.** A small chart per AI Account of its five-hour
  and weekly windows, using the highest reading in each bucket.

**Charts follow the app's design system.** I followed the data-viz method
I was given:

- **Tokens.** Chart tokens are CSS custom properties on `.viz` in
  `apps/web/src/styles.css`, with `.dark` values for the app's own dark
  variant.
- **Palette validated.** Categorical slots come in a fixed order, never
  cycled. I ran the palette validator against the app's card surfaces:

  ```text
  Palette (light, surface #ffffff, categorical): 4 slots
    [PASS] Lightness band         all 4 inside L 0.43–0.77
    [PASS] Chroma floor           all 4 >= 0.1
    [PASS] CVD separation         worst adjacent #eda100↔#1baf7a ΔE 9.1 (protan) · tritan 27.0
    [PASS] Normal-vision floor    worst adjacent #eda100↔#1baf7a ΔE 22.9 (normal)
    [WARN] Contrast vs surface    below 3:1 — relief required (visible labels or table view): [["#1baf7a",2.82],["#eda100",2.17]]
  Palette (dark, surface #171717, categorical): 4 slots
    [PASS] … all five checks
  ```

  The light-mode contrast warning is met by a visible legend on every
  multi-series chart and a table view on every chart.
- **Marks.** Columns ≤ 24 px with a 4 px rounded end and a 2 px surface
  gap between stacked segments. Lines are 2 px. Dots are 8 px with a 2 px
  surface ring. Grids are solid hairlines.
- **Text.** Labels and values use text colours, never series colours.
  Status colours appear only with an icon and a label.
- **Reading values.** A tooltip shows every series for a bucket on hover
  and on keyboard focus (arrow keys move along the buckets). Every value
  is also in the table view.
- **Refetching.** On a refetch the previous render stays, at reduced
  opacity.

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. Output below.
- [x] API tests for each aggregation: `apps/server/src/analytics/routes.test.ts`
      seeds request records and AI Accounts, then checks each answer
      against them. Six cases, run in memory here; the same six run in
      Postgres 18 in CI and on the host:
  - **Series by the day:** totals, each day's requests, tokens by type,
    cost, mean latency and error rate; records outside the range are left
    out.
  - **Series by the hour:** every hour, empty ones with a null latency.
  - **Breakdowns:** every dimension (AI Account including "No AI
    Account", AI Provider, Model, Floor including "Owner tools", Agent by
    name, issue, Owner tool), in order, with every total.
  - **Insights:** top consumers with shares; accounts near limits (a
    window at 92%, an account rate-limited now; not one whose 95% window
    has reset).
  - **Usage windows:** each account's readings in the range, oldest
    first.
  - **Refusals:** bad ranges, an unknown dimension, a missing range, and
    no session.

  `packages/gateway/src/history/history.test.ts` checks the store's
  `analyticsRows` grain (by the hour and day, errors, latency, an account
  of null) in memory, and in Postgres 18 on the host.
- [ ] Playwright: dashboard renders with seeded data. **Written, not run
      here**. `e2e/tests/analytics.spec.ts` seeds three Gateway requests
      through the end-to-end server's new `recordGatewayRequests` control
      command, signs in, opens **Analytics** and checks:
  - the stat tiles;
  - the five charts and their marks;
  - the breakdown by Model, then by Owner tool (in the address);
  - the top consumers;
  - the last 24 hours.

  Like every end-to-end test it needs Docker for Postgres. Here it is
  skipped with its reason (output below); CI and the host run it. As
  the closest check possible here, `apps/web/src/analytics-page.test.tsx`
  renders the whole app at `/analytics` in jsdom against a stubbed API
  with seeded data, and checks:
  - the stat tiles' text;
  - each chart's legend, tooltip (on hover and from the keyboard) and
    table rows;
  - the insights;
  - the breakdown and changing it;
  - the usage-window chart;
  - re-reading by the hour for the last 24 hours.

## Not verifiable in this sandbox

- **Postgres** (Docker): the `analyticsRows` `GROUP BY` (`date_trunc(…,
  'UTC')`, `count(*) FILTER (…)`) and every API case in Postgres. They
  are written as cases run against both stores, skipped here with the
  reason.
- **The Playwright test** (above): needs Docker.
- **The look in a browser.** Chromium could be downloaded but not
  started: the sandbox lacks its system libraries (`libnspr4.so`,
  `libnss3.so` and others), and no package source is available to
  install them. Instead I rendered the three kinds of chart (stacked
  columns, a gapped line, the usage windows' sparse lines) to static
  SVG, rasterised them with resvg in a scratch directory outside the
  repository, and inspected the images:
  - ticks are clean;
  - nothing collides;
  - the 2 px gaps and the rounded ends render;
  - the dots carry their ring.

  That inspection found one defect, now fixed and tested: a lone value
  between gaps drew no mark at all. Whole-page layout, the dark mode and
  the hover layer in a real browser are left to the host.

## Notes

- **Where it lives.** The issue calls these "Admin dashboards". They have
  their own page and navigation link, `/analytics`, rather than more
  cards on the long Admin page. A page under `/admin/…` would also have
  marked Admin's navigation link as current.
- **Retention.** Retention (#112) is out of scope; the API reads whatever
  `gateway_requests` holds.
- **The errors count** is every answer with a status of 400 or more. That
  includes the Gateway's own refusals (a cap, no account) and callers
  that went away (499).

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck` (tail):

```text
e2e typecheck: Done
exit 0
```

`pnpm test`:

```text
 Test Files  123 passed (123)
      Tests  1254 passed | 239 skipped (1493)
exit 0
```

The skipped tests need Docker (Postgres through Testcontainers, the
compose stack, hadolint's image, the image builds) and say so.

The tests for this issue (verbose, trimmed):

```text
✓ src/analytics/routes.test.ts > the analytics API, in memory > answers the totals, and each day's, over the range: requests, tokens by type, cost, latency and errors
✓ src/analytics/routes.test.ts > the analytics API, in memory > answers every hour of a range by the hour, empty ones too
✓ src/analytics/routes.test.ts > the analytics API, in memory > breaks the requests down by each dimension, most tokens first
✓ src/analytics/routes.test.ts > the analytics API, in memory > names the top consumers and the AI Accounts close to their limits
✓ src/analytics/routes.test.ts > the analytics API, in memory > answers each AI Account's usage-window readings in the range, oldest first
✓ src/analytics/routes.test.ts > the analytics API, in memory > refuses a range that ends before it starts, is too long, or is cut too finely
↓ src/analytics/routes.test.ts > the analytics API, in Postgres 18 > (each of the six cases) [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
✓ src/history/history.test.ts > request history, kept in memory > adds up requests per hour or day, AI Account, Model and caller for analytics, with their errors and latency
↓ src/history/history.test.ts > request history, kept in Postgres 18 > adds up requests per hour or day, … [Docker is not available …]
✓ src/analytics-page.test.tsx > the analytics dashboards > shows the headline totals for the last 7 days, by the day
✓ src/analytics-page.test.tsx > the analytics dashboards > charts each total over time, with a legend, a tooltip on hover and keys, and a table
✓ src/analytics-page.test.tsx > the analytics dashboards > names the top consumers and the AI Accounts close to their limits
✓ src/analytics-page.test.tsx > the analytics dashboards > breaks down by Model, then by another dimension, keeping it in the address
✓ src/analytics-page.test.tsx > the analytics dashboards > charts each AI Account's usage windows over the range
✓ src/analytics-page.test.tsx > the analytics dashboards > reads everything again, by the hour, for the last 24 hours
✓ src/analytics-page.test.tsx > the dashboards' arithmetic > (3 tests)
✓ src/analytics-charts.test.tsx > a chart over time > gives a lone value between gaps a dot, as well as the line's end
✓ src/analytics-charts.test.tsx > a chart over time > draws columns no wider than 24 px, each from the baseline
✓ src/app.test.tsx > the app layout > links to every page from the navigation
✓ src/app.test.tsx > the app layout > renders the Analytics page at /analytics
```

`pnpm --filter @ai-office/e2e exec playwright test tests/analytics.spec.ts`:

```text
Docker is not available (Could not find a working container runtime strategy), so the end-to-end tests are skipped. They run in CI and on the host, or set E2E_POSTGRES_URL.

Running 1 test using 1 worker

  -  1 [chromium] › tests/analytics.spec.ts:51:1 › the dashboards render the seeded requests

  1 skipped
```
