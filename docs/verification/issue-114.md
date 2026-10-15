# Issue #114: Optional GitHub webhooks for intake — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **Signatures** (`packages/github/src/webhooks.ts`).
  `verifyWebhookSignature(secret, body, signature)` checks GitHub's
  `X-Hub-Signature-256` (`sha256=` and the hex HMAC-SHA256 of the raw
  body) in constant time. A missing, malformed or SHA-1 signature, or an
  empty secret, is refused. `parseWebhookPayload` reads only the action,
  the repository's `full_name` and the label's name.
- **Settings** (migration `0045_github_webhooks`). `office_settings`
  gains two columns:
  - `github_webhooks_enabled`: null means off.
  - `github_webhook_secret`: the secret, sealed with `ENCRYPTION_KEY`.

  Check constraints keep the secret sealed (`aio1:`) and require one
  whenever webhooks are on. `GET` and `PUT /api/office/webhooks` read and
  set `{ enabled, secretSet }`. The secret is write-only: it is never
  sent back, and leaving it out keeps the stored one. Turning webhooks on
  with no secret is refused with `webhook_secret_required`. A change
  records `config.changed` with the keys `webhooks.enabled` and
  `webhooks.secret`, never the value. The secret is registered with the
  redactor whenever the process holds it in clear.
- **Deliveries** (`POST /api/github/webhooks`,
  `apps/server/src/webhooks/routes.ts`). The route is `public`, since
  GitHub has no session, and is listed in the route-access test's
  exemptions. It runs in its own Fastify scope, which keeps bodies as
  raw bytes (at most 5 MiB), so the signature is checked over exactly
  what GitHub signed. It answers:
  - `404` while webhooks are off;
  - `401` when the signature does not match, logging the event and
    delivery id but never the signature;
  - `400` for a signed body that is not a JSON object;
  - `202 { started }` once taken.
- **What a delivery starts** (`packages/orchestrator/src/webhooks/`).
  Only deliveries about a Floor in use count. Others, and deliveries for
  repositories that are not Floors, are accepted and ignored.
  - An `issues` delivery (opened, reopened, labeled, edited or
    transferred) runs intake now.
  - A `label` delivery that deletes or renames a pipeline label has
    intake check that Floor's labels again, then run.
  - A closed issue or pull request runs the Batches' check for issues
    whose dependencies are done.
  - Any other `pull_request` delivery, a `check_run` or a `check_suite`
    wakes the Merge Policy's wait for CI on that Floor.

  Nothing is awaited: GitHub expects its answer within seconds.
- **Polling stays the fallback**
  (`packages/orchestrator/src/rounds.ts`). Intake and the Batches' check
  now run on `createRounds`, which keeps the interval as before. Its
  `trigger()` runs a round at once, or straight after the round that is
  running, and the interval restarts from it. Triggers that arrive during
  one round are run together as one round. The merge gate's
  `ciChanged(floorId)` ends its current wait between polls early.
- **Admin.** The **GitHub webhooks** card, below **Intake**:
  - an on/off checkbox and a password field for the secret;
  - the webhook URL (the page's origin plus `/api/github/webhooks`), and
    the events to subscribe to.
- **Docs.**
  - [The issue pipeline](../guide/issue-pipeline.md#issue-intake-and-the-pipeline)
    covers what webhooks do.
  - [Setting up a Floor](../processes/setting-up-a-floor.md#webhooks-optional)
    covers setting them up on the App, plus troubleshooting for `401`
    and `404`.
  - [Running AI Office](../guide/running.md#signing-in) names the route
    as one that needs no session.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below).
- [x] **Tests: invalid signatures refused.**
  - `packages/github/src/webhooks.test.ts`: a missing, empty, truncated,
    over-long, wrong-secret or SHA-1 signature is refused, as are a body
    changed after signing and an empty secret.
  - `packages/orchestrator/src/webhooks/webhooks.test.ts` ("refuse a
    delivery whose signature is missing, wrong or for another body"):
    deliveries signed with the old secret are refused after it changes.
    "Is refused, and picks nothing up, when its signature is wrong" shows
    a forged delivery starts nothing.
  - `apps/server/src/webhooks/routes.test.ts` ("refuse a delivery with no
    signature, or a wrong one, starting nothing"): through HTTP, an
    unsigned, a forged and a tampered delivery each get `401`, and
    intake runs no round.
- [x] **Tests: a labelled-issue webhook triggers intake.** Each test uses
      a real intake with an hour between polls, on the fake GitHub:
  - `webhooks.test.ts` ("picks the issue up at once, without waiting
    for the next poll"): the Owner labels an issue `ai-office`, and a
    signed `issues`/`labeled` delivery has it labelled `needs-code` and
    queued.
  - `routes.test.ts` ("take a labelled issue in at once, without waiting
    for the next poll"): the same through `POST /api/github/webhooks`,
    answered `202 {"started":["intake"]}`.

### Also covered

- Settings:
  - off by default;
  - the secret is sealed and never read back;
  - turning webhooks on needs a secret;
  - `config.changed` holds keys, not values (orchestrator and route
    tests).
- `404` while off; the Owner's settings routes need a session.
- What each event and action starts (`webhookActions`, table test).
- `createRounds`:
  - the interval, as before;
  - a trigger runs at once and restarts the interval;
  - triggers during a round run as one;
  - nothing runs while stopped;
  - a failing round does not stop the rounds.
- The merge gate looks at CI again when its Floor's CI changes, and not
  for another Floor (`merge.test.ts`).
- Admin's card (`apps/web/src/webhooks-card.test.tsx`):
  - it shows the URL and the events;
  - it saves `{ enabled, secret }` with the CSRF token;
  - the secret field is a password field, cleared after saving;
  - it explains the refusal without a secret, and refuses a short
    secret before sending it.
- The existing intake, Batches and merge tests pass unchanged on the new
  rounds.

### Not verifiable in this sandbox

- **The Postgres 18 variants.**
  - `webhooks.test.ts`'s "settings kept in Postgres 18" cases, which
    also apply migration `0045` and its check constraints, need Docker.
    They are skipped here with the reason and run in CI and on the host.
  - The same applies to the rest of the suite's Postgres tests (the
    400 skipped).
- **Real GitHub deliveries.** The GitHub App and `ai-office-sandbox`
  (#18) do not exist yet, and the sandbox is not reachable from GitHub.
  Signatures are checked against GitHub's documented scheme, computed
  with Node's HMAC.
- **The webhook card in a browser.** It was checked with Testing
  Library in jsdom, not in a browser.

## Notes and decisions

- **Where the secret lives.** FR-65 puts "webhooks" in the office admin,
  and FR-67 keeps the environment for start-up secrets only. So the
  secret is configuration in Postgres, sealed like the TOTP secret, and
  not an environment variable.
- **Configuration export (FR-65).** The export leaves the webhook
  settings out. The secret is a credential, and an import that turned
  webhooks on without one would break the constraint that one exists
  whenever they are on.
- **No commit statuses.** The App is not given **Commit statuses**
  (the setup guide's "not asked for"), and the merge gate reads check
  runs, so `status` deliveries start nothing and the guide does not ask
  for them.
- **A delivery is a hint, not data.** Intake and the pipeline still read
  issues and labels from GitHub. The Owner check (PRD §4) is unchanged.
- **Public exposure** (TLS, firewalling) is #115.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  252 passed (252)
      Tests  2885 passed | 400 skipped (3285)
   Start at  09:12:43
   Duration  66.34s (tests 42%, import 32%, environment 12%, transform 11%, setup 2%)
```

The new tests, verbose (`apps/server`):

```text
 ✓ src/webhooks/routes.test.ts > GitHub webhook settings > are off until the Owner turns them on with a secret, which is never sent back
 ✓ src/webhooks/routes.test.ts > GitHub webhook settings > need a session
 ✓ src/webhooks/routes.test.ts > GitHub webhook deliveries > are a 404 while webhooks are off
 ✓ src/webhooks/routes.test.ts > GitHub webhook deliveries > refuse a delivery with no signature, or a wrong one, starting nothing
 ✓ src/webhooks/routes.test.ts > GitHub webhook deliveries > take a labelled issue in at once, without waiting for the next poll
 ✓ src/webhooks/routes.test.ts > GitHub webhook deliveries > take GitHub's ping, and ignore deliveries about other repositories
      Tests  6 passed (6)
```

`packages/orchestrator` (the webhooks and rounds files):

```text
 ✓ src/webhooks/webhooks.test.ts > a labelled-issue webhook, with intake running > picks the issue up at once, without waiting for the next poll
 ✓ src/webhooks/webhooks.test.ts > a labelled-issue webhook, with intake running > is refused, and picks nothing up, when its signature is wrong
 ↓ src/webhooks/webhooks.test.ts > GitHub webhooks, settings kept in Postgres 18 > … [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
      Tests  30 passed | 6 skipped (36)
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

- **The Batches' webhook trigger and the merged branch's prompt check
  share one set of rounds.** #85 added a check of the Batches on each
  merge or `needs-human` label, which ran `check()` alongside the
  minute loop. After the merge it asks `createRounds` for a round
  (`rounds.trigger()`), as a GitHub webhook does. A merge and a webhook's
  trigger at the same moment run one round, or one straight after the
  running one. The new test (`e713845`) shows the merge-driven check, and
  that a merge with a trigger starts the next issue once.

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

The webhook, rounds and Batches tests:

```text
 ✓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in memory > once started, a merge checks the Batches at once, and a webhook's trigger at the same moment starts nothing twice
 ↓ |@ai-office/orchestrator| src/batches/batches.test.ts > Batches and their Plans, in Postgres 18 > once started, a merge checks the Batches at once, and a webhook's trigger at the same moment starts nothing twice [skipped: no Docker]
 Test Files  6 passed (6)
      Tests  32 passed | 51 skipped (83)
```
