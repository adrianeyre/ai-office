# Issue #127: Email (SMTP) Connection — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commit (`4e09c40`).

## What was built

- **The email type** (`connectionTypes` gains `email`; migration
  `0046_communications` widens the `connections_type` check). Its
  credentials (`emailCredentialsSchema`): an SMTP `host` and `port`, a TLS
  mode (`starttls`, `tls` or `none`), an optional `username` and
  `password` (both or neither), a `from` address and one to twenty `to`
  addresses. All of it is sealed with `ENCRYPTION_KEY`; the Connection
  shows its `host:port`, its TLS mode, who it signs in as and its
  addresses, never the password.
- **The transport** (`packages/communications/src/transports/email.ts`),
  on [nodemailer](https://nodemailer.com/) (a new dependency of
  `@ai-office/communications`, with no install scripts; the lockfile is
  committed): one SMTP connection per delivery, with time-outs and no
  logging. `starttls` requires STARTTLS, `tls` is TLS from the start, and
  `none` ignores TLS (for a server on the same machine or network). Each
  message goes to every address at once, with:
  - the subject `[AI Office] <Floor>: <title>` (kept to one line);
  - a plain-text part and an HTML part, each with the title, the Floor,
    the kind, and **Open in AI Office** and **Open on GitHub** links
    (escaped in the HTML);
  - an `X-AI-Office-Delivery` header with the delivery's id.

  Failures say what happened without anything the server echoed: a
  refused sign-in is "The SMTP server refused the username or password
  (535)."; also a refused sender or recipient, TLS that could not be set
  up, and a server that could not be reached. Each counts as a failed
  delivery, so 5 in a row make the Connection failing (#125).
- **Mailpit in the test harness**
  (`@ai-office/communications/testing/mailpit`): `mailpitTest`, a Vitest
  fixture that starts `axllent/mailpit:v1.27` with Testcontainers once per
  test file, with SMTP sign-in required for one account
  (`MP_SMTP_AUTH`, allowed without TLS), and reads what it received from
  its HTTP API. Without Docker its tests are skipped with the reason; with
  `CI` set they fail instead, as the Postgres harness does.
- **A fake SMTP server** (`serveFakeSmtp` in
  `@ai-office/communications/testing`): EHLO, AUTH PLAIN and LOGIN (535
  for any other account), MAIL, RCPT and DATA, so the same contract also
  runs where there is no Docker.
- **Web:** the Connections page's add form takes an email Connection:
  SMTP server, port (587 by default), TLS (STARTTLS by default), username
  and password, from, and to (comma-separated). The password field is
  cleared once sent.
- README: the email Connection under "Communications and Connections".

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (output below).
- [ ] Contract tests against Mailpit (skipped with a reason when Docker is
      unavailable): message content, multiple recipients, authentication
      failure marks the Connection failing — **written and skipped here
      with the reason**, as the criterion allows
      (`packages/communications/src/transports/email.test.ts`, "email,
      against Mailpit", 3 tests):

      ```text
      ↓ email, against Mailpit > sends each message as plain text and HTML, with links back to AI Office and GitHub [Docker is not available (Could not find a working container runtime strategy), so the email contract tests against Mailpit are skipped. They run in CI and on the host.]
      ↓ email, against Mailpit > sends one message to several addresses [Docker is not available (…)]
      ↓ email, against Mailpit > a refused sign-in fails each delivery, and 5 in a row make the Connection failing [Docker is not available (…)]
      ```

      They have not run against a real Mailpit here, so this box stays
      unticked until they run on the host or in CI. **The same three
      cases ran and passed** against the in-process fake SMTP server
      ("email, against a fake SMTP server in this process"), through the
      Communications Agent's real queue and nodemailer:
  - message content: from, to, the subject, the delivery header, and the
    plain text and HTML (decoded from the MIME parts), each with the
    title, Floor, kind and both links;
  - multiple recipients: one message to three addresses;
  - authentication failure: "Send test" reports the refused sign-in, then
    five failed deliveries make the Connection failing with one
    "Connection failing" Notice and a `connection.failing` event, and
    neither password appears in what the API or the events give back.
- Also passing here: an unreachable server ("The SMTP server could not be
  reached (ESOCKET)."), what an email Connection shows, the credentials'
  validation, and the HTML escaping and one-line subject; and, in
  `apps/web/src/connections-page.test.tsx`, adding an email Connection and
  refusing a username without a password.

### Verified on the host

- [ ] A test message and an action Notice arrive in a real mailbox — **not
      verifiable here** (no SMTP account or mailbox in this sandbox).

### Not verifiable in this sandbox

- The Mailpit contract tests (above): they need Docker. Mailpit's header
  names and API answers are as its documentation describes; the test reads
  header names without regard to case.
- STARTTLS and TLS against a real SMTP server (the fake and Mailpit both
  run without TLS).
- `0046_communications` applied to Postgres 18 (needs Docker).

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
 Test Files  235 passed (235)
      Tests  2761 passed | 385 skipped (3146)
   Duration  51.72s
```

A run a few minutes earlier, with the host at load average 82 from
sibling runs, had 8 tests time out at Vitest's 5-second default (every
failure `Error: Test timed out in 5000ms.`), one of them this issue's own
web test, which typed many characters. That test, and the page's others,
now paste into fields rather than typing each key: the same steps and
assertions, about twice as fast.

`pnpm install --frozen-lockfile`:

```text
Lockfile is up to date, resolution step is skipped
Done in 52ms using pnpm v12.10.0
```

The email tests:

```text
 ↓ email, against Mailpit > … (3, skipped: no Docker)
 ✓ email, against a fake SMTP server in this process > sends each message as plain text and HTML, with links back to AI Office and GitHub
 ✓ email, against a fake SMTP server in this process > sends one message to several addresses
 ✓ email, against a fake SMTP server in this process > a refused sign-in fails each delivery, and 5 in a row make the Connection failing
 ✓ email, against a fake SMTP server in this process > says when the SMTP server cannot be reached
 ✓ an email Connection > shows its server, TLS, sign-in and addresses, never its password
 ✓ an email Connection > takes a username and a password together, and at least one address
 ✓ an email Connection > escapes what it puts in its HTML, and keeps its subject to one line
      Tests  7 passed | 3 skipped (10)
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

- Nothing about the email Connection changed in the merge but its
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
