# Issue #129: Connection detail levels, quiet hours and Digests — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commit (`696c8fa`).

## What was built

- **Detail level** (FR-95), per Connection (`detailLevel`, already a
  column, now set on `POST /api/connections` and changed with `PATCH`):
  - **Titles and summaries** (the default) sends each message whole.
  - **Links only** (`atDetailLevel` in `messages.ts`) sends the kind and
    the links, with "New action Notice", "New info Notice" or "Work
    complete" in place of the title, and no Floor name. A links-only
    Digest is counts and a link, from a template, with no Model call.
  - Everything queued, Digests included, still passes the central
    redactor; what the Digest's Model reads is redacted too. Messages
    only ever come from the templates (Notice titles, pull request
    numbers, links), so code, diffs, bodies, memory and issue text are
    never sent.
- **Quiet hours** (FR-92), a Connection rule (`rules.quietHours`: `start`,
  `end`, an IANA `timeZone`, `actionNotices`), computed with `Intl` so
  summer time is followed (`schedule.ts`). A delivery that falls due in
  them is held (its `nextAttemptAt` moved on, without counting as an
  attempt): until they end, or on a Connection with a Digest until the
  next Digest, which marks it `summarised` instead of sending it. Action
  Notices go at once when the Owner lets them through. Changing quiet
  hours or the Digest lets go at once whatever they no longer hold.
- **Digests** (FR-90, FR-92), a Connection rule (`rules.digest`: hourly,
  on the hour, or daily at a time in a time zone). A Digest falls due
  after the last one (or after the Digest was turned on), waits out quiet
  hours, and is not sent when nothing happened. It reads the events since
  its own cursor (`connections.digest_cursor`, `last_digest_at`) through
  the same templates and Floor filter, and is written from structured data
  only (`DigestData`: `since`, `until`, counts by kind, and each item's
  kind, Floor, title and outcome). At titles and summaries the
  Communications Agent's Model writes it (`gatewayDigestWriter`), through
  the AI Gateway's Messages endpoint with the Communications Agent's own
  Gateway Key; when there is no Model, or the call fails (a Token Cap,
  the Gateway down), it comes from a template. It is queued as a delivery
  of kind `digest` with a `summary`, which every transport renders (a
  webhook's `summary` field, a Slack section, an email paragraph, the
  text of an ntfy or Pushover push).
- **The Communications Agent's Gateway Key**: a new key kind,
  `communications`, made when the server first starts the Communications
  Agent and kept sealed (`ensureCommunicationsKey`, `communicationsKey`).
  The Gateway attributes its requests to the Agent id `communications`
  with no Floor (shown as "Communications Agent" in the analytics), and
  refuses them with a cap error (`communicationsCapCheck`) once its own
  tokens reach the office's daily or monthly Token Cap
  (`communicationsCapUse`, `communicationsCapRefusal`). It cannot be
  revoked on its own.
- **Migration `0046_communications`**: the Digest's
  progress on `connections`; the `summarised` delivery status; the check
  that a test has no event relaxed so a Digest (no event, not a test) is
  allowed; the `communications` key kind, sealed, one in use.
- **Web:** the Connections page's add and edit forms take the detail
  level, quiet hours (from, until, time zone, let action Notices through)
  and a Digest (never, hourly, daily at a time in a time zone); each
  Connection shows them in a line; its log says "held for quiet hours
  until …" and "held for quiet hours, then summarised in a Digest".
- **Guide:** detail levels, quiet hours and Digests in
  `docs/guide/notices-and-skills.md`; the Communications Agent's Gateway
  Key in `docs/guide/ai-gateway.md`.

### Choices where the PRD leaves room

- "Held for the next Digest or the end of quiet hours": read as *for the
  next Digest* on a Connection that has one, and *until the end of quiet
  hours* on one that does not, so a daily-Digest Connection is quiet all
  night and its morning Digest covers the night.
- A Digest covers every message kind within the Floor filter, whatever
  the Connection's triggers, so turning the triggers off gives "Digests
  instead of individual messages" (the Glossary's "instead of or as well
  as").
- "Links only" also leaves out the Floor's name, reading "kinds, counts
  and links" strictly.
- The Decision Model writing Digests is out of scope (#109): the
  Communications Agent's own AI Provider and Model write them.

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (output below).
- [x] Tests (`packages/communications/src/digests.test.ts`, through the
      Communications Agent's real queue and the webhook transport to a
      fake receiver):
  - **"links only" output contains no titles:** an action Notice, an info
    Notice and a merged pull request arrive as "New action Notice", "New
    info Notice" and "Work complete" with their links, no Floor, and none
    of the titles or the Floor's name anywhere in what was sent; the
    links-only Digest likewise.
  - **a planted secret in a title is redacted:** a Notice titled with an
    Anthropic key arrives as "AI Account rejected key [REDACTED]", and the
    key is nowhere in the raw body; in a Digest it is redacted before the
    Model reads it and in what is sent.
  - **quiet hours hold and then release:** a merged pull request at 23:30
    London time, in quiet hours from 22:00 to 07:00, is held (pending,
    no attempt, due at 07:00 BST = 06:00Z), not sent at 06:59, and sent
    at 07:00; changing the quiet hours lets it go at once; with a Digest
    it is held for the 08:00 Digest and marked `summarised`.
  - **an action Notice passes through when allowed:** held with "let
    action Notices through" off; sent at once with it on, while a merged
    pull request at the same moment is still held.
- [x] Test with a fake Gateway: a daily Digest is produced from structured
      data and its request is attributed to the Communications Agent —
      "Digests are written from structured data by the Communications
      Agent's Model, through the Gateway with its own key": nothing at
      07:59 London time; at 08:00 one Messages request to a fake Gateway
      that knows whose each Gateway Key is, presenting the Communications
      Agent's key (the fake attributes it to the Communications Agent),
      with the Agent's Model, the Digest system prompt and, as its only
      message, exactly the structured data (`since`, `until`, counts and
      each item's kind, Floor, title and outcome); the Digest is sent with
      the Model's text as its `summary`, and the next one counts only what
      happened since. The real Gateway's attribution is covered too:
      `packages/gateway/src/keys/keys.test.ts` sends a request with the
      Communications Agent's key through the Gateway and the request
      record has `agentId: "communications"`, no Floor, no Owner tool;
      `packages/gateway/src/caps.test.ts` refuses its call at the office's
      cap; `packages/orchestrator/src/caps/token-caps.test.ts` counts its
      own tokens against the office's caps.

### Not verifiable in this sandbox

- The Postgres runs of the new store paths (`recordDigest`,
  `releaseHeld`, the digest columns) and of the Communications Agent's
  key (`gateway_keys` constraints, the one-in-use index): the cases are
  written to run against Postgres 18 too ("quiet hours and Digests, kept
  in Postgres 18", and the Postgres runs in `keys.test.ts` and
  `token-caps.test.ts`) and are skipped here with the reason, as is
  migration `0046` itself. They run in CI and on the host.
- A Digest written by a real Model through a real AI Account (needs real
  AI accounts), and a Digest reaching a real Slack, mailbox or phone.
- The Playwright end-to-end suites (need Docker and a browser); the
  Connections page's new fields are covered by its component tests.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck: Done
```

`pnpm test`:

```text
 Test Files  241 passed (241)
      Tests  2830 passed | 397 skipped (3227)
   Duration  75.56s (tests 42%, import 35%, transform 11%, environment 10%, setup 1%)
```

The issue's tests:

```text
 ✓ detail levels > "links only" sends kinds and links, never a title or a Floor's name
 ✓ detail levels > "titles and summaries", the default, sends the title and the Floor
 ✓ detail levels > is changed with the Connection's other settings, and told to the Activity Feed
 ✓ redaction > removes a secret planted in a title from what is sent
 ✓ quiet hours > hold action Notices too, unless the Owner lets them through
 ✓ Digests > are hourly on the hour, and not sent when nothing happened
 ✓ Digests > wait out quiet hours when they fall due in them
 ✓ Digests > at "links only" are counts and a link from a template, with no Model call
 ✓ Digests > redact a planted secret before the Model reads it, and in what is sent
 ✓ Digests > come from a template when the Gateway refuses the Model call, as at a Token Cap
 ✓ quiet hours and Digests, kept in memory > quiet hours hold a message until they end, then send it
 ✓ quiet hours and Digests, kept in memory > quiet hours let go at once what they no longer hold when they change
 ✓ quiet hours and Digests, kept in memory > Digests are written from structured data by the Communications Agent's Model, through the Gateway with its own key
 ✓ quiet hours and Digests, kept in memory > Digests summarise what quiet hours held, instead of sending it after them
 ↓ quiet hours and Digests, kept in Postgres 18 > … (4, skipped: Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.)
 ✓ the clock of a time zone > tells overnight quiet hours, in summer time and out of it
 ✓ the clock of a time zone > finds the next time of day across the clocks going back
 ✓ the clock of a time zone > puts each Digest after the last, and holds only in quiet hours
      Tests  17 passed | 4 skipped (21)

 ✓ src/keys/keys.test.ts > Gateway Keys, kept in memory > gives the Communications Agent one key of its own, and attributes its requests to it, with no Floor
 ✓ src/caps.test.ts > Token Caps at the Gateway > asks for the Communications Agent's calls against the office's caps, refusing it at one
 ✓ src/caps/token-caps.test.ts > Token Caps, kept in memory > counts the Communications Agent's own tokens against the office's caps, refusing it at one

 ✓ src/connections-page.test.tsx > the Connections page > adds a Connection at links only, with quiet hours and a daily Digest
 ✓ src/connections-page.test.tsx > the Connections page > refuses a time zone it does not know
 ✓ src/connections-page.test.tsx > the Connections page > changes a Connection's detail level and turns its Digest off
 ✓ src/connections-page.test.tsx > a delivery's outcome > says when quiet hours hold it, and when a Digest summarised it
 ✓ src/connections-page.test.tsx > a delivery's outcome > names a Connection's quiet hours when action Notices are let through
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

- **Digests and retention.** A delivery a Digest summarised (`summarised`)
  is finished, so retention's Connection deliveries rule deletes it after
  90 days by default. A delivery held for quiet hours is pending, so it
  stays until it is sent or summarised, however old (`945c595`).
- The Communications Agent's Gateway Key (`gateway_keys_one_communications`
  and the widened `gateway_keys` checks) is in `0046_communications`.

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
