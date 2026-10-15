# Issue #126: Slack Connection — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commit (`c4da068`).

## What was built

- **The Slack type** (`connectionTypes` gains `slack`; migration
  `0046_communications` widens the `connections_type` check). Its
  credentials (`slackCredentialsSchema`) are either:
  - `{ mode: "webhook", webhookUrl }`: an incoming webhook, whose address
    is the credential; the Connection shows only its host; or
  - `{ mode: "bot", botToken, channel }`: a bot token (`xoxb-`, or `xoxp-`)
    and a channel (`#ops` or its id) or a user's id; the Connection shows
    "Posts to #ops as a bot" and never the token.
- **The transport** (`packages/communications/src/transports/slack.ts`):
  an incoming webhook is POSTed to directly; a bot posts with
  `chat.postMessage` (bearer token, link unfurling off). Each message is
  in Slack's block format (`slackBlocks`): a mrkdwn section with the title
  (escaped, within Slack's 3000 characters), a context line with the Floor
  and the kind, and an actions block with **Open in AI Office** and
  **Open on GitHub** link buttons (the second only when there is a GitHub
  link). Plain `text` carries the Floor and title for notifications.
- **Rate limits:** a 429 throws a `DeliveryError` with the `Retry-After`,
  and the queue tries again only after it (never sooner than a second).
- **Refusals:** Slack's error code is shown, never anything else of its
  answer: `invalid_auth`, `not_authed`, `token_revoked` and
  `account_inactive` read "Slack refused the bot token (…)"; others, such
  as `channel_not_found` or an incoming webhook's `no_service`, "Slack
  refused the message (…)". Each counts as a failed delivery, so 5 in a
  row make the Connection failing with its action Notice (#125).
- **Redaction:** the central redactor knows Slack tokens (`xox?-…`) and
  incoming webhook addresses (`https://hooks.slack.com/services/…`), as
  well as each Connection's credentials registered when they are opened.
- **A fake Slack** (`serveFakeSlack` in `@ai-office/communications/testing`):
  `chat.postMessage` checking the bearer token (`invalid_auth`) and the
  channel (`channel_not_found`), an incoming webhook (`ok`, or 404
  `no_service` for an unknown one), Slack's `invalid_blocks` checks for
  block types, text and button limits and button URLs, and 429 with
  `Retry-After` on request.
- **Web:** the Connections page's add form has a type choice; Slack asks
  for an incoming webhook address, or a bot token and a channel or user.
  The secret fields are password fields, cleared once sent.
- README: the Slack Connection under "Communications and Connections".

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (output below).
- [x] Contract tests against a fake Slack API for both modes
      (`packages/communications/src/transports/slack.test.ts`, 13 tests,
      through the Communications Agent's real queue with the fake Slack on
      a local port):
  - both modes deliver a pull request merged as Slack blocks, checked
    whole: title, Floor, kind and the two link buttons with their
    addresses; and a test message;
  - both modes, a 429 with `Retry-After: 7`: the delivery stays pending
    with its next try at +7 s, is not tried at +6 s, and is delivered once
    at +7 s;
  - an invalid bot token: five tries, each "Slack refused the bot token
    (invalid_auth).", then the Connection is failing (5 in a row) with one
    "Connection failing" Notice and a `connection.failing` event; the token
    is in none of its deliveries;
  - also: `channel_not_found`, an incoming webhook Slack no longer knows
    (404 `no_service`), the credentials never given back (list,
    deliveries, events), what is shown of each mode, mrkdwn escaping and
    Slack's length limits, and the credentials' validation.
- The web form for a Slack bot is covered by
  `apps/web/src/connections-page.test.tsx` ("adds a Slack Connection with
  a bot token and a channel").

### Verified on the host

- [ ] A test message and an action Notice arrive in a real Slack
      workspace — **not verifiable here** (no real Slack workspace, app or
      token in this sandbox).

### Not verifiable in this sandbox

- The real Slack Web API and a real incoming webhook (above).
- `0046_communications` applied to Postgres 18 (needs Docker; the
  Postgres cases of #125's tests cover the `connections` table).

## Output

`pnpm lint`:

```text
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`:

```text
 Test Files  234 passed (234)
      Tests  2752 passed | 382 skipped (3134)
   Duration  43.23s
```

The Slack contract tests:

```text
 ✓ Slack through an incoming webhook > sends a message in Slack's block format: title, Floor, kind and link buttons
 ✓ Slack through an incoming webhook > waits for a 429's Retry-After before trying again
 ✓ Slack through an incoming webhook > sends a test message, and never gives its credentials back
 ✓ Slack through a bot token and a channel > sends a message in Slack's block format: title, Floor, kind and link buttons
 ✓ Slack through a bot token and a channel > waits for a 429's Retry-After before trying again
 ✓ Slack through a bot token and a channel > sends a test message, and never gives its credentials back
 ✓ a Slack bot > with an invalid token makes the Connection failing after 5 tries, with a Notice
 ✓ a Slack bot > says when its channel is not found
 ✓ a Slack bot > shows where it posts, and not its token
 ✓ an incoming webhook > that Slack no longer knows is refused with its reason
 ✓ an incoming webhook > shows only its host
 ✓ slackBlocks > escapes Slack's markup and keeps within its limits, without a GitHub button when there is no link
 ✓ Slack's credentials > take a bot token and a channel or user, or an incoming webhook
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

- Nothing about the Slack Connection changed in the merge but its
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
