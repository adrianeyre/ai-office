# Issue #128: Phone push Connections, ntfy and Pushover — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commit (`831bfd8`).

## What was built

- **Two Connection types** (`connectionTypes` gains `ntfy` and `pushover`,
  named "Phone push: ntfy" and "Phone push: Pushover"; migration
  `0046_communications` widens the `connections_type` check).
  - **ntfy** (`ntfyCredentialsSchema`): a server (`http`/`https`; the web
    form starts at `https://ntfy.sh`), a topic (1 to 64 letters, digits,
    `-` and `_`, as ntfy allows) and an optional access token (`tk_` and
    29 letters and digits). The Connection shows the server's host and
    "Publishes with (or without) an access token". The topic is treated as
    a credential (on a public server it is what keeps the notifications
    private) and never shown.
  - **Pushover** (`pushoverCredentialsSchema`): an application token and a
    user (or group) key, each 30 letters and digits. The Connection shows
    `user key uQiR…` only.
- **The transports** (`packages/communications/src/transports/ntfy.ts`,
  `pushover.ts`):
  - **Priority:** an action Notice is sent at high priority, ntfy `4`
    and Pushover `1`; anything else at the default, ntfy `3` and Pushover
    `0` (`ntfyPriority`, `pushoverPriority`). Pushover's emergency
    priority (2) is never used.
  - **Click link:** ntfy's `click` and Pushover's `url` (titled "Open in
    AI Office") are the message's AI Office link (the Notice, or the
    issue's activity for work complete). The GitHub link is an ntfy
    `view` action ("Open on GitHub") or a line of Pushover's text.
  - ntfy is sent as JSON to the server's root (so titles need no header
    encoding), with `Authorization: Bearer <token>` when there is one.
    Pushover is form-encoded to `/1/messages.json`, with the event's time
    as `timestamp`, and keeps to its 250/1024/512-character limits.
  - **Failures** say what happened without echoing the service: "ntfy
    refused the access token (401).", "ntfy needs an access token to
    publish to this topic (403).", "Pushover refused the application token
    (400).", "Pushover refused the user key (400).", unreachable, other
    statuses. Each counts as a failed delivery, so 5 in a row mark the
    Connection failing with its action Notice (#125). A 429 waits for its
    `Retry-After`.
- **Redaction:** a transport can now say which of its credentials are
  secret (`ConnectionTransport.secrets`); ntfy registers its topic and
  token with the central redactor, not its server address (every string
  was registered before, which would have redacted `https://ntfy.sh`
  wherever it appeared). ntfy access tokens (`tk_…`) join the redactor's
  credential shapes.
- **Fakes** (`@ai-office/communications/testing`): `serveFakeNtfy`
  (JSON publishing at `/`; protected topics answer 403 without a token,
  any wrong token 401; bad topic, priority or click URL 400; 429 with
  `Retry-After` on request) and `serveFakePushover` (`/1/messages.json`;
  `"token": "invalid"` / `"user": "invalid"` with 400, Pushover's length
  and priority checks).
- **Web:** the Connections page's add form takes an ntfy Connection
  (server, topic, access token) or a Pushover Connection (application
  token, user key); the secret fields are password fields, cleared once
  sent.
- **Guide:** "Phone push" under Communications and Connections in
  `docs/guide/notices-and-skills.md`, and the API bodies.

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (output below).
- [x] Contract tests against fake ntfy and Pushover APIs: priority, click
      link, and an invalid token marking the Connection failing —
      `packages/communications/src/transports/push.test.ts`, through the
      Communications Agent's real queue and the real transports:
  - priority: an action Notice arrives at ntfy priority 4 and Pushover
    priority 1; work complete at ntfy 3 and Pushover 0;
  - click link: ntfy's `click` and Pushover's `url` are
    `https://office.example.com/notices?notice=notice-awaiting` (and the
    activity link for work complete), with the GitHub link as an ntfy
    button and a line of Pushover's text;
  - invalid token: a revoked ntfy access token (401) and a wrong Pushover
    application token (400) each fail 5 deliveries in a row, the
    Connection becomes `failing` with one "Connection failing" Notice and
    a `connection.failing` event, and neither the token nor the topic or
    user key appears in what the API or the events give back.
  - also: a protected topic with its token, a topic that needs a token
    (403), a 429's `Retry-After`, a refused Pushover user key, what each
    Connection shows, Pushover's limits and both credential schemas; and,
    in `apps/web/src/connections-page.test.tsx`, adding each type from
    the page and refusing a Pushover key of the wrong shape.

### Verified on the host

- [ ] A push reaches a real phone through each service — **not verifiable
      here** (no ntfy or Pushover account, and no phone, in this sandbox).

### Not verifiable in this sandbox

- Real ntfy and Pushover: the fakes answer as their API documentation
  describes (ntfy's JSON publishing, its `40101`/`40301` errors;
  Pushover's `status`, `token`/`user` `"invalid"` answers). Recorded
  responses from the real services are not available here.
- `0046_communications` applied to Postgres 18 (needs Docker); the
  Postgres tests that would run it are skipped with the reason.

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
 Test Files  240 passed (240)
      Tests  2805 passed | 391 skipped (3196)
   Duration  80.67s (tests 42%, import 35%, transform 11%, environment 10%, setup 1%)
```

An earlier full run, with the host at load average 65 from sibling runs,
had two of `apps/web/src/scene/floor-layout.test.ts`'s path checks (8 and
10 Agents, untouched by this issue) time out at Vitest's 5-second default;
that file then passed alone (77 tests) and the whole suite passed in the
run above.

The issue's tests:

```text
 ✓ ntfy > sends an action Notice at high priority, opening the Notice in AI Office when tapped
 ✓ ntfy > sends work complete at the default priority
 ✓ ntfy > publishes to a topic that needs it with the access token
 ✓ ntfy > with an invalid token makes the Connection failing after 5 tries, with a Notice
 ✓ ntfy > says when a topic needs an access token
 ✓ ntfy > waits for a 429's Retry-After before trying again
 ✓ ntfy > shows its server and whether it signs in, never its topic or token
 ✓ ntfy > checks its server, topic and token
 ✓ Pushover > sends an action Notice at high priority, its link opening the Notice in AI Office
 ✓ Pushover > sends work complete at normal priority
 ✓ Pushover > with an invalid application token makes the Connection failing after 5 tries, with a Notice
 ✓ Pushover > says when the user key is refused
 ✓ Pushover > shows the start of its user key only
 ✓ Pushover > keeps within Pushover's limits
 ✓ Pushover > checks its application token and user key
      Tests  15 passed (15)
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

- Nothing about the phone push (ntfy and Pushover) Connection changed in the merge but its
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
