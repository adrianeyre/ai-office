# Issue #131: Google sign-in and the Google Sheets work log — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in the working tree of this branch, clean at
`684e788` (the code is in `8c72926` and `002cbbd`, the guide in
`684e788`): `pnpm lint`, `pnpm typecheck`, `pnpm test` and `drizzle-kit
generate`.

The blocker is built on this branch: #125, the Communications Agent, its
Connections and the durable queue ([`issue-125.md`](issue-125.md)). The
Google Sheets Connection is a publishing destination as #130 made them
for Confluence and Notion ([`issue-130.md`](issue-130.md)), and follows
#129's detail levels ([`issue-129.md`](issue-129.md)).

## What was built

### Google sign-in (`packages/shared` `google.ts`; `packages/communications` `google.ts`)

- **The OAuth client.** The Owner registers an OAuth client (Web
  application) in Google Cloud and enters its ID and secret
  (`PUT /api/google/client`). The secret is sealed with `ENCRYPTION_KEY`
  (context `google.client_secret`) and never sent back; the ID is shown.
  A new client ID signs the account out, since a refresh token belongs to
  its client. Entering it is `config.changed` with the new scope `google`.
- **Minimal scopes.** Signing in asks only for the scopes of the services
  the Google Connections use (`googleServiceScopes`, `googleScopesFor`):
  for Google Sheets, `https://www.googleapis.com/auth/spreadsheets`, and
  nothing else (no `openid`/`email`, no Drive, and no
  `include_granted_scopes`, so nothing granted before is added). With no
  Google Connection there is nothing to ask for, and sign-in is refused
  (`google_no_services`).
- **The flow** (`createGoogleAuth`): the authorization code flow with PKCE
  (S256), `access_type=offline` and `prompt=consent` for a refresh token,
  and a random `state` used once within 10 minutes. The redirect URI is
  `/admin/connections/google` on `PUBLIC_URL`. That web page is served
  without a session (`auth/access.ts`): Google's cross-site redirect
  carries no SameSite=Strict cookie, and the page holds nothing; it hands
  the code and state to `POST /api/google/sign-in/complete`, which needs
  the session. The scopes Google granted (the Owner can untick one) are
  kept; a service not granted is shown as missing, and its deliveries
  fail saying so.
- **Tokens.** The refresh and access tokens are sealed in the new
  `google_sign_in` table (one row, migration `0073_google_sign_in`). The
  access token is refreshed a minute before it expires, and once more
  when the Sheets API refuses it early (401); concurrent refreshes share
  one request. A rotated refresh token replaces the old one.
- **A revoked grant.** Google refusing the refresh token with
  `invalid_grant` marks the sign-in `revoked` and calls the
  Communications Agent, which marks **every** Google Connection failing
  at once (not after 5 failures), each with an action Notice linking to
  it, then publishes `google.grant_revoked` (with how many). Deliveries
  keep their usual retries; after the Owner signs in again
  (`google.signed_in`), the Agent lets everything pending for Google
  Connections go at once (`retryPending`), and each recovers with its
  next delivery (`connection.recovered`). Sign out revokes the grant at
  Google as well as it can (`google.signed_out`).
- **Never a secret.** No answer, event or log line holds the client
  secret, a token or the code: every one is registered with the redactor
  when sealed or opened, and the central redactor gains the shape of a
  Google OAuth client secret (`GOCSPX-…`; Google's access and refresh
  tokens were already among its shapes).

### The Google Sheets work log (`transports/google-sheets.ts`, `publications.ts`, `communications.ts`)

- `connectionTypes` gains **`google_sheets`**, a publishing destination
  and a **work log** (`workLogTypes`, `isWorkLog`) and a **Google
  Connection** (`googleConnectionTypes`, `googleServiceOf`). Its
  "credentials" are its target only, the spreadsheet (its address or its
  id) and the tab; neither is secret, and the tokens stay with the
  sign-in.
- **Rules**: a work log keeps only its Floors and the new
  `rules.notices` ("A row for each Notice too"); `rulesFor` and the new
  `defaultRulesFor` keep everything else off.
- **One row per completed issue.** `pull_request.merged` (which closes
  the issue, by the App or the Owner) makes a `work_log` message with a
  `workLog` entry: the issue and its title, the pull request, the Agents
  that worked it, its Review Loop rounds, its tokens and estimated cost.
  The server's `completedIssueOf` (`apps/server/src/connections/publishing.ts`)
  reads them from AI Office's own records, never GitHub: the title from
  intake's `issue.picked_up`; the Agents from `issue.assigned`,
  `sandbox.started`, `review.posted` and `qa.reported`, in the order they
  began; the rounds with the Wrap-up's `issueRecord`; and the tokens and
  cost from the AI Gateway's usage for that Floor and issue.
- **Optionally one row per Notice**, within its Floors, except a Notice
  about that Connection (FR-94).
- **The row**: `Date, Kind, Floor, Issue, Title, Pull request, Agents,
  Review Loop rounds, Tokens, Estimated cost (USD), AI Office, AI Office
  ID`. At "links only" it has no Floor name, title or Agents. Rows are
  redacted before they are queued, and written with
  `valueInputOption=RAW`, so a title such as `=IMPORTXML(…)` is text,
  never a formula.
- **No duplicates.** Each row ends with its delivery's id, the same on
  every attempt; the tab's id column is read before a row is appended, so
  a retry after a lost answer appends nothing. The tab is made (with a
  header row) when the spreadsheet has none by that name. Send test
  writes a test row (FR-93). Errors say what is wrong without a token:
  "The Google account signed in cannot edit the spreadsheet: share it with
  that account (403).", "Google Sheets has no spreadsheet with that id
  (404).", a 429 retried after its `Retry-After`.
- **The fake** (`serveFakeGoogle` in `@ai-office/communications/testing`):
  a consent screen that checks the client, the redirect URI, PKCE and the
  state, and grants what was asked for (or less, or declines); a token
  endpoint that exchanges a code once (checking the PKCE verifier and the
  client's secret), refreshes, revokes, and answers `invalid_grant` for a
  revoked grant; and a Sheets API that takes only valid, unexpired tokens
  with the spreadsheets scope, adds tabs, reads a column, appends rows,
  and can lose an append's answer or answer 429.

### Events, the server and the web app

- **Events**: `google.signed_in` (the scopes granted), `google.signed_out`
  and `google.grant_revoked` (how many Google Connections), in the
  Activity Feed's Connections group; `config.changed` gains the scope
  `google`. `connection.failing` gains an optional `reason`
  (`google_sign_in_revoked`), and its `failures` may now be 0, as a
  Connection marked failing by a revoked grant may not have failed yet;
  both widen the schema, so every stored event still parses.
- **Server**: `GET /api/google`, `PUT /api/google/client`,
  `POST /api/google/sign-in`, `POST /api/google/sign-in/complete`,
  `DELETE /api/google/sign-in` (`connections/google-routes.ts`), all
  needing the session. The server makes the Google sign-in beside the
  Connections (in their Postgres store), gives it to the transports, and
  gives the Communications Agent `completedIssue`.
- **Web**: a **Google sign-in** card on the Connections page (status, the
  redirect URI to register, the scopes it asks for, the OAuth client with
  its secret typed once and cleared, sign in and sign out), Google Sheets
  in the add form (spreadsheet address or id, tab, "A row for each Notice
  too"), and the `/admin/connections/google` page that finishes the
  sign-in once and says how it went.
- **Docs**: [`notices-and-skills.md`](../guide/notices-and-skills.md)
  ("Google sign-in", "Google Sheets", the API's shapes); the README's and
  the guide index's line for it.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below): 302 test files, 3393 tests passed, 494
      skipped. `drizzle-kit generate` finds nothing more to generate.
- [x] **Contract tests against a fake Google OAuth and Sheets API**
      (`packages/communications/src/transports/google-sheets.test.ts`, 9
      tests, with the real Communications Agent, Google sign-in, memory
      queue and event bus against `serveFakeGoogle`):
  - **Consent with minimal scopes.** Before an OAuth client, sign-in is
    refused; before a Google Connection, too (`google_no_services`). With
    a Google Sheets Connection the one consent screen asks for exactly
    `["https://www.googleapis.com/auth/spreadsheets"]`, with the client's
    ID, the redirect URI, `response_type=code`, `access_type=offline`,
    `prompt=consent` and S256 PKCE, and no `include_granted_scopes`. The
    kept record's refresh token is sealed (`aio1:`), and neither it, the
    access token nor the client's secret is in what is kept or in any
    event. A declined consent, a forged state and a state used twice are
    refused; a consent that unticks Sheets leaves Sheets "missing", and
    Send test says "The Google sign-in does not allow Google Sheets: sign
    in to Google again to allow it."
  - **Token refresh.** The token from signing in serves the first row; 59
    minutes on, it is refreshed before the second (`refresh_token` sent
    once); when Google ends the access token early, the Sheets 401
    refreshes it once and the row is written on the same attempt.
  - **A revoked grant marks the Connections failing.** The Owner revokes
    access; an hour on, the refresh is refused (`invalid_grant`): the
    delivery fails with "Google refused AI Office's sign-in: the grant
    was revoked or has expired. Sign in to Google again on the Connections
    page.", the sign-in is `revoked`, **both** Google Connections are
    failing (the one with nothing to send too) and the webhook is not,
    with one action Notice each linking to its Connection, two
    `connection.failing` events (`reason: google_sign_in_revoked`) and
    `google.grant_revoked` with `connections: 2`. A retry while revoked
    asks Google nothing and raises no other Notice. Signing in again sends
    the waiting row at once, and the Connection recovers
    (`connection.recovered`).
  - **One row per completed issue, no duplicates on retry.** The tab is
    made; the first append's answer is lost (the row is written, the
    delivery fails "Google Sheets answered 502: Bad gateway."); the retry
    finds its row by its id and appends nothing, and taking the event in
    again queues nothing: the tab is the header and one row, compared
    cell by cell (date, "Issue completed", Floor, issue link, title,
    pull request link, "Ada, Alan, Grace", 2 rounds, 152,340 tokens,
    $1.23, the AI Office link, the delivery's id). There was exactly one
    append, `RAW`. A second completed issue is a second row; one on a
    Floor outside its Floors, none.
  - Also: Notices make rows only with the Notices rule (action and info,
    with their links), and Send test writes a test row; at "links only"
    a row has links and numbers but no Floor, title or Agents, and a key
    planted in an issue's title is `[REDACTED]` while the `=IMPORTXML(…)`
    title stays text; a 429 is retried after its `Retry-After`, and an
    unknown spreadsheet says so; the spreadsheet is taken by address or
    id.

  **Sabotage**, each restored after: without the id look-up before
  appending, the "never two" test fails; asking for `openid email` as
  well, the minimal-scopes test fails; with a revoked grant marking no
  Connection failing, the revoked-grant test fails; refreshing only once
  the token has expired (not a minute before), the refresh test fails.
  Restored: 9 passed.

**Beyond the criteria:**

- `apps/server` `connections/google-routes.test.ts`: the whole flow
  through the API against the fake Google: a malformed client refused, the
  client entered, sign-in refused until a Google Sheets Connection is
  added (its details "Spreadsheet …" and `Tab "Work log"`), the consent
  screen's one scope, a forged state refused (404), the sign-in finished,
  Send test writing a row through it, and sign out revoking the grant at
  Google; the client secret, the code and every token Google issued are
  in no answer, event, log line or kept record.
- `apps/server` `auth/sessions.test.ts`: `/admin/connections/google` is
  served without a session; `/admin/connections` still redirects to
  `/login`, and finishing a sign-in without a session is 401.
- `apps/server` `connections/publishing.test.ts`: a completed issue's
  Agents in the order they began (coder, reviewer, QA; another issue's
  and an unknown Agent left out), its Review Loop rounds (2), and its
  tokens and cost from its own usage rows only, over all time.
- `apps/web` `connections-page.test.tsx` (5 new tests): adding a Google
  Sheets work log by the spreadsheet's address with a row per Notice;
  entering the OAuth client (a malformed ID refused, the secret sent once,
  with the CSRF token, and cleared), the sign-in button disabled until a
  Google Connection exists, then going to the consent screen; the
  redirect page handing the code and state to the API once; and saying
  why a sign-in could not finish.
- `packages/shared` `redact.test.ts`: a Google OAuth client secret is
  redacted.

### Verified on the host

- [ ] **Rows appear in a real spreadsheet (after #135).** Needs a real
      Google Cloud OAuth client, a Google account and the network; the
      fake stands in here.

## Not verifiable in this sandbox

- **Real Google**: its consent screen and granular consent, its token
  endpoint's real answers (and refresh-token expiry for a client in
  "Testing" publishing status, after 7 days), Sheets' real rate limits,
  and how a row looks in a real spreadsheet.
- **A real browser's cookies on Google's redirect**: that the
  SameSite=Strict cookie is withheld on the redirect but sent with the
  page's own `fetch` is what browsers do; here it is covered only by the
  server serving the page without a session and the API needing one.
- **Postgres 18** (no Docker): the Postgres variant of the Google sign-in
  API test (skipped with the reason), migration `0073_google_sign_in`
  itself (the `google_sign_in` table and its checks, and the widened
  `connections_type` check), and the Postgres `retryPending`.
- **Playwright** (`pnpm e2e`, needs Docker and Chromium): the Connections
  page with the Google sign-in card in a browser, including the
  accessibility spec's axe check of `/admin/connections`. No end-to-end
  test was added for the redirect page.

## Notes

- **"The Google services enabled"** is read as the services the Google
  Connections use: adding a Google Sheets Connection is what enables
  Sheets, and signing in then asks for its scope. There is no separate
  switch per service; when Docs, Slides, Drive or Calendar Connections
  arrive, their scopes join `googleServiceScopes` and signing in again
  asks for them.
- **Which account is signed in** is not shown: knowing it would need an
  identity scope (`openid email`), which no service needs. The card shows
  when it was signed in, and what was granted.
- **A completed issue** is one whose pull request was merged
  (`pull_request.merged`, by the App or the Owner), which closes it
  (`Closes #N`, FR-21). An issue closed without a merged pull request
  has no row.
- **Agents** are named as the Floor has them now: an Agent since removed
  is left out of a row (`AgentStore.list` omits removed Agents).
- A revoked grant raises one Notice per Google Connection, as FR-94
  makes failing per Connection. With two Google Connections, the Notice
  about one is queued for the other if its Notices rule is on, and waits
  (failing, retried) until the Owner signs in again.
- A begun sign-in's state is kept in the server's memory: a restart
  between "Sign in to Google" and Google's redirect means signing in
  again.

## Noticed, out of scope

- As #125's note says, the configuration export (#113) carries neither
  the Connections nor, now, the Google OAuth client's ID.
- The end-to-end suite has no test of the Google sign-in card or the
  redirect page (needs Docker here, and a fake Google served to the
  server process).

## Output

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm --filter @ai-office/db exec drizzle-kit generate
No schema changes, nothing to migrate 😴

$ cat /proc/loadavg
29.19 42.72 36.43 21/28318 21726
$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  302 passed (302)
      Tests  3393 passed | 494 skipped (3887)
   Duration  69.68s
test exit=0
```

An earlier full run, at load average 56 to 75 from sibling runs, had one
time-out in a test this issue does not touch, never an assertion:

```text
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 12 Agents' Floor clear of furniture and walls
Error: Test timed out in 5000ms.
 Test Files  1 failed | 301 passed (302)
      Tests  1 failed | 3392 passed | 494 skipped (3887)
```

The same file alone then passed (78 of 78), and so did the full run above.
No test was skipped, weakened or given a longer time-out.

This issue's tests (verbose):

```text
✓ google-sheets.test.ts > Google sign-in > asks for the Google Connections' scopes and no more, with PKCE and for a refresh token, and keeps the tokens sealed
✓ google-sheets.test.ts > Google sign-in > finishes each sign-in once; a declined consent, or one granting less, says so
✓ google-sheets.test.ts > Google sign-in > refreshes the access token a minute before it expires, and when Google refuses it early
✓ google-sheets.test.ts > a revoked grant > marks every Google Connection failing at once, with a Notice each; a new sign-in recovers them
✓ google-sheets.test.ts > the work log > one row per completed issue, never two: a lost answer is tried again without a second row
✓ google-sheets.test.ts > the work log > a row per Notice only with its Notices rule, and never about itself; Send test writes a test row
✓ google-sheets.test.ts > the work log > "links only": links and numbers, no Floor name, title or Agent; a credential in a title is redacted
✓ google-sheets.test.ts > the work log > a 429 is retried after its Retry-After; an unknown spreadsheet says so
✓ google-sheets.test.ts > a Google Sheets Connection's spreadsheet and tab > takes the spreadsheet's address or its id, and a tab's name
 Test Files  1 passed (1)
      Tests  9 passed (9)

✓ (server) publishing.test.ts > a completed issue, for its work log row > names the Agents that worked it in the order they began, with its Review Loop rounds and its model calls' tokens and cost
✓ (server) google-routes.test.ts > the Google sign-in API, kept in memory > signs in through the API with the Google Connections' scopes, and never answers, logs or publishes a secret, token or code
↓ (server) google-routes.test.ts > the Google sign-in API, kept in Postgres 18 > … [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
✓ (server) sessions.test.ts > pages > serve Google's redirect back without a session: its cross-site redirect carries no cookie, and the API it calls needs one
 Test Files  3 passed (3)
      Tests  24 passed | 1 skipped (25)

✓ (web) connections-page.test.tsx > adds a Google Sheets work log by the spreadsheet's address, with a row per Notice: Floors and Notices its only rules
✓ (web) connections-page.test.tsx > enters Google sign-in's OAuth client, its secret sent once and cleared, then goes to Google's consent screen
✓ (web) connections-page.test.tsx > hands Google's redirect back to the API once, and says the account is signed in
✓ (web) connections-page.test.tsx > says why Google's redirect could not finish the sign-in
✓ (web) connections-page.test.tsx > a delivery's outcome > names a work log's rows
 Test Files  1 passed (1)
      Tests  23 passed (23)

$ vitest run --project @ai-office/communications
 Test Files  8 passed (8)
      Tests  91 passed | 18 skipped (109)
```
