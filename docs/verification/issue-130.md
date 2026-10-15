# Issue #130: Wrap-up reports to Confluence and Notion — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`d46f9fd`,
the guide; the code is in `08c3a4c` and `416b1ff`).

The blockers are built on this branch: #125, the Communications Agent,
its Connections and the durable queue ([`issue-125.md`](issue-125.md));
#129, detail levels, quiet hours and Digests ([`issue-129.md`](issue-129.md)),
whose detail levels the reports follow and whose Model-written Digests the
reports' summaries are written like; and #85, the Wrap-up
([`issue-85.md`](issue-85.md)), whose `batch.finished` event and kept
results the reports are made from.

## What was built

### Publishing destinations (`packages/shared` `connections.ts`; `packages/db`)

- `connectionTypes` gains **`confluence`** and **`notion`**, the
  **publishing destinations** (`publishingTypes`,
  `isPublishingDestination`); the other types are notification channels.
- **Confluence** credentials: the site's address (http or https), an
  Atlassian account's email and API token (the secret), a space's key and
  the parent page's id. **Notion** credentials: an integration token
  (`ntn_` or `secret_`, the secret), and a parent page or database with its
  32-hex id (hyphens and case normalised away).
- **Rules**: `connectionRulesSchema` gains an optional `changelog`. A
  publishing destination's rules are its Floors and its changelog only
  (`rulesFor`, `defaultPublishingRules`): triggers, quiet hours and
  Digests are kept off, when it is added and when it is edited.
- **Messages**: `messageKinds` gains `report` and `changelog`, and
  `outboundMessageSchema` an optional `document` (the report's Markdown,
  at most 100,000 characters).
- **Migration `0046_communications`** widens the `connections`
  type check.

### The report (`packages/communications` `report.ts`, `markdown.ts`, `publications.ts`)

- **Its data** (`BatchReport`) is the finished Batch's Wrap-up joined with
  the Plan it finished on and its coders' names (the server's
  `batchReportOf`, from AI Office's own records: the Communications Agent
  has no repository access).
- **The Markdown** (`reportMarkdown`): the title ("AI Office: Batch 3
  Wrap-up (Web shop)"), when it finished and on which version of the
  Plan, its counts, tokens and estimated cost; a Summary; the Plan's
  order with each issue's link, title, coder and dependencies, and the
  parallel groups; a Results table (issue, outcome, pull request, Review
  Loop and QA rounds, tokens, estimated cost, and a Total row); what was
  left out and why; and a link to the Wrap-up on the whiteboard.
- **Written by the Communications Agent** (FR-90): the Summary is written
  by its Model through the AI Gateway with its own Gateway Key
  (`gatewayReportWriter`, sharing `gatewayText` with the Digests' writer),
  from structured data only (`reportData`: the Floor, counts, and each
  issue's title, outcome, rounds, tokens and cost, never an issue's text,
  FR-95), its titles marked as data. Without a Model, when the call fails,
  and at "links only", it comes from a template.
- **Detail level** (FR-95): at "links only" a report has kinds, counts and
  links: its title has no Floor name, and it names no issue title, Agent
  or reason; no Model is asked. A changelog entry is "Pull request merged"
  and its link.
- **Redaction**: the report's data and its summary are redacted **before**
  the Markdown is written (escaping would otherwise split a credential, as
  `sk\-ant\-…`, so the redactor no longer matched it, and the destination
  would unescape it), and the message again after.
- **Only ever text**: anything quoted (titles, reasons, the summary) is
  escaped (`escapeMarkdown`); the Markdown subset reader (`parseMarkdown`)
  takes only http and https links. `confluenceStorage` and `notionBlocks`
  write it as Confluence's storage format (every text and address
  escaped) and as Notion's blocks (rich text at most 2000 characters an
  item).
- **What is sent** (`publicationFor`, and `publicationsTo` in
  `communications.ts`): `batch.finished` sends each publishing destination
  whose Floors it passes the report, made once per detail level; with
  `changelog` on, `pull_request.merged` sends a changelog entry ("Pull
  request #15 merged, closing issue #5: Pay at checkout", the title from
  the event log's `issue.picked_up`, `issueTitleOf`). Notices and every
  other event send them nothing. Each goes through the same durable queue,
  at most once per Connection per event, with the same retries, failing
  and recovery.

### The transports (`transports/confluence.ts`, `transports/notion.ts`)

- **Confluence** (REST API v2, Basic authentication): a report is a child
  page of the parent page in the space (the space's id read from its
  key); the changelog is one "AI Office changelog" page under the same
  parent, made with its first entry, each entry a line appended as the
  page's next version (read again once on a 409).
- **Notion** (API `2022-06-28`, bearer token): a report is a page under
  the parent page, or in the database (its title property read from the
  database), its blocks 100 to a request; the changelog is one page
  there, each entry a bulleted item appended to it.
- **Exactly once**: a report's page is looked for by its title before it
  is made (Confluence's titles are unique in a space, and a duplicate's
  400 is taken as the page being there; a Notion page's children are
  listed, following `has_more`; a database is queried by its title
  property), and an entry by its pull request's link before it is
  appended. So a retry after a lost answer makes neither twice.
- **Send test** only reads (the space and the parent page; the Notion
  parent), writing nothing.
- Errors say what is wrong without the credential: "Confluence refused the
  email and API token (401).", "Notion cannot reach the parent page: share
  it with the integration (404).", a 429 retried after its `Retry-After`.
- **Fakes** (`serveFakeConfluence`, `serveFakeNotion` in
  `@ai-office/communications/testing`): in-memory services that check
  authentication, the Notion version header, page and block shapes and
  limits, unique titles in a space, page versions, pagination of
  children, and can answer 429s or carry out a write but lose its answer.

### The server and the web app

- The server gives the Communications Agent `batchReport`, `issueTitle`
  and the report writer (`connections/publishing.ts`, `server.ts`).
- The Connections page adds **Confluence** and **Notion** with their
  fields; their rules are "A running changelog: an entry for each merged
  pull request" and Floors (no triggers, quiet hours or Digest), reset
  when the kind of Connection changes; the list says "Wrap-up reports ·
  Running changelog"; Send test says it only read the parent.

### Docs

[`notices-and-skills.md`](../guide/notices-and-skills.md): "Publishing
destinations" (Confluence, Notion, exactly once, the report, detail level
and redaction, the fakes) and the API's shapes.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). Without Docker the Postgres tests skip with
      the reason (2901 passed, 403 skipped).
- [x] **Contract tests against fake Confluence and Notion APIs: a finished
      Batch creates exactly one page with the report.**
      `packages/communications/src/transports/publishing.test.ts`, with
      the real Communications Agent, memory queue and event bus:
  - Confluence: `batch.finished` with the first write's answer lost: the
    page is made but the delivery fails ("Confluence answered 502.") and
    is retried; the retry finds the page by its title and makes no other:
    exactly one child page of the parent, in the space, and the only write
    is one `POST /pages`. Its storage body is checked: the heading and
    counts line, the Summary (the Model's), the Plan in order with coders
    and dependencies, every Results row (outcome, pull request link,
    rounds, tokens, cost) and the Total, what was left out, and the link
    to the whiteboard.
  - Notion: the same under a parent page (children listed two at a time,
    so the look-up follows `has_more`): exactly one page, its blocks
    starting heading, paragraph, heading, paragraph, and its table's rows
    compared cell by cell, the pull request a link. In a database: one
    page, found by the database's title property.
- [x] **The changelog is appended once per merge.** Confluence: three
      merges on web-shop (and one on another Floor, outside its Floors):
      one "AI Office changelog" page under the parent, each pull request's
      link exactly once, in order, the third's answer lost and retried
      without a second entry (version 4: made, then three entries). With
      the changelog off, merges publish nothing. Notion, in a database:
      three entries, each link once, the third's answer lost.
- [x] **The detail level and redaction apply.** "Titles and summaries":
      both destinations name the Floor and the Agents; a planted Anthropic
      key in an issue title and in the Model's summary is `[REDACTED]`
      and no `sk-ant-` reaches either; the title's `**now**
      [click](https://evil.example) |` is text: no link to it, no extra
      table cell; the Model was asked once for both, with exactly the
      structured data (compared in full, the title redacted). "Links
      only": no Floor name, issue title, Agent, reason or summary text in
      either destination's report or the changelog; the table rows are
      links and numbers; the summary is the template's; the changelog
      entry is "Pull request merged" with its link; no Model call.

      **Sabotage:** with the report not redacted before its Markdown is
      written, the redaction test fails (the escaped key passes the
      redactor and is unescaped by the destination); with Notion's
      look-up before making a page removed, both Notion "exactly one
      page" tests fail. Both restored; 10 passed.

**Beyond the criteria:**

- Send test only reads (Confluence: `GET /spaces` and `GET /pages/<parent>`
  only; Notion: GETs only) and writes nothing; a wrong API token says
  "Confluence refused the email and API token (401)." and is never in a
  Connection's answer; an unshared Notion parent says so. A 429's
  `Retry-After` sets the next attempt. Notices never reach a publishing
  destination, and its notification rules are kept off when added and
  edited.
- `markdown.test.ts` (7 tests): the subset read; escaped text stays text
  (no link, bold, cell, list or heading); only http(s) links; Confluence
  storage escaping; Notion blocks and rich text split at 2000 characters.
- `apps/server` `connections/publishing.test.ts`: the report data joins
  the Wrap-up with the Plan it finished on (version 2's dependencies and
  parallel groups) and the coders' names, none for a Batch not finished
  or another Floor's; an issue's title is intake's latest on that Floor.
  `connections/routes.test.ts`: Confluence and Notion added through the
  API, their rules normalised, their tokens in no answer, event or log.
- `apps/web` `connections-page.test.tsx`: adding a Confluence Connection
  with a changelog (no triggers or quiet hours offered; the token cleared
  after), adding a Notion database Connection after refusing a malformed
  token, and how a publishing destination's rules read.

### Verified on the host

- [ ] **A real Batch's report appears in a real Confluence space and
      Notion workspace.** Needs real Atlassian and Notion accounts and the
      network; the fakes stand in here.

## Not verifiable in this sandbox

- **Real Confluence and Notion** (above): their real answers, rate limits
  and rendering of the storage format and blocks.
- **Postgres 18** (no Docker): the Postgres runs of `communications.test.ts`,
  `routes.test.ts` and the rest, and migration `0048` itself.
- **Playwright** (`pnpm e2e`, needs Docker and Chromium): the Connections
  page in a browser, including its axe check with the new fields.
- **The real AI Gateway** writing a report's summary (a fake writer stands
  in; the Gateway call is the Digests' own, `gatewayText`, whose tests
  pass).

## Notes

- FR-90 says the Communications Agent uses the Decision Model when it is
  enabled, otherwise its own AI Provider and Model. As for #129's Digests,
  the summary uses its own Model: the Decision Model is not built on this
  branch.
- A Notion report of more than 100 blocks is made in more than one
  request; if a later one's answer were lost, the retry would find the
  page and stop, so its end could be missing. A report reaches 100 blocks
  only with dozens of issues and left-out issues (a Batch has at most 50
  issues and the table is one block); every real report so far is far
  under it.
- Google destinations are out of scope (their own issues).

## Output

```text
$ pnpm lint   (tail)
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ cat /proc/loadavg
29.98 36.19 35.96 10/29267 52346
$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  247 passed (247)
      Tests  2901 passed | 403 skipped (3304)
exit=0
```

The contract tests and the Markdown (verbose):

```text
✓ src/markdown.test.ts > the report's Markdown > reads headings, paragraphs, lists and tables, with bold and links
✓ src/markdown.test.ts > the report's Markdown > escaped text is only text: no link, no bold, no cell, no list, no heading
✓ src/markdown.test.ts > the report's Markdown > a link to anything but http or https is text
✓ src/markdown.test.ts > the report's Markdown > a line starting with a pipe but no table is a paragraph
✓ src/markdown.test.ts > for Confluence > is the storage format, with every text and address escaped
✓ src/markdown.test.ts > for Notion > is blocks: headings, paragraphs, list items and a table with a header row
✓ src/markdown.test.ts > for Notion > splits text into items of at most 2000 characters
✓ src/transports/publishing.test.ts > Confluence > a finished Batch creates exactly one child page with its Wrap-up report, even when the answer is lost and it is sent again
✓ src/transports/publishing.test.ts > Confluence > the changelog: one page, made with the first entry, and each merged pull request appended once, a lost answer included
✓ src/transports/publishing.test.ts > Confluence > without a changelog, merges publish nothing; Notices are never a publishing destination's
✓ src/transports/publishing.test.ts > Confluence > Send test only reads the space and the parent page; refused credentials say so, without the token
✓ src/transports/publishing.test.ts > Confluence > a 429 is retried after its Retry-After
✓ src/transports/publishing.test.ts > Notion > a finished Batch creates exactly one page under the parent page, with its report as blocks, even when the answer is lost
✓ src/transports/publishing.test.ts > Notion > in a database: one page found by its title property; and the changelog appended once per merge
✓ src/transports/publishing.test.ts > Notion > Send test only reads the parent; a parent not shared with the integration says so
✓ src/transports/publishing.test.ts > detail levels and redaction in a report > "titles and summaries": titles, the Floor and Agents named, every credential redacted, and what a title or the summary says only ever text
✓ src/transports/publishing.test.ts > detail levels and redaction in a report > "links only": kinds, counts and links; no Floor name, issue title, Agent or reason, and no Model call
 Test Files  2 passed (2)
      Tests  17 passed (17)

$ vitest run (server) src/connections
 Test Files  2 passed (2)
      Tests  9 passed | 7 skipped (16)
$ vitest run (web) src/connections-page.test.tsx
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

## After merging into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `e713845`, after the merge (`9629801`) and its follow-ups:
`0ae986e` (two stray `.orig` files removed), `945c595` (retention deletes
Connections' delivery logs) and `e713845` (a test of the Batches' prompt
check).

- **Migrations.** This branch keeps `0044_retention` and
  `0045_github_webhooks`. The merged branch's `0044_communications`,
  `0045_push_connections`, `0046_connection_detail_quiet_hours_digests`,
  `0047_batch_kickoff_wrap_up` and `0048_publishing_destinations` are
  replaced by one regenerated `0046_communications`, with their header
  comments, and `0047_connection_delivery_retention` follows it.
  `drizzle-kit generate` finds nothing more to generate. Neither migration
  has been applied to a real Postgres here (no Docker).

- Nothing about the Confluence and Notion Connection changed in the merge but its
  migration's number (above). Its contract tests pass against their fakes
  as before.
- Its delivery log is now kept 90 days by retention (see
  [`issue-125.md`](issue-125.md) and [`issue-112.md`](issue-112.md)).

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
 Test Files  266 passed (266)
      Tests  3067 passed | 435 skipped (3502)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 435 skipped tests need what the sandbox lacks: 409 Postgres 18 and
3 Mailpit through Testcontainers (Docker), 10 Docker, hadolint or Caddy
for the deployment, and 13 the real GitHub App. They run on the host and
in CI.

The Communications package's tests:

```text
 Test Files  7 passed (7)
      Tests  82 passed | 18 skipped (100)
```
