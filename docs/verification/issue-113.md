# Issue #113: Configuration export and import — verification

Configuration export and import was built on `wip/issues-112-113` before
`main` gained PR #165 (AI Settings page, Claude usage windows,
prompt-cache TTL and storage clean-up), then merged onto this branch
(`a9d9f7a`). Checks were run in the Sandcastle sandbox (Node 26.10.0,
pnpm 12.10.0, no Docker) at `865484d`, the last code commit.

The blockers are built on this branch: #50, Token accounting and Token
Caps ([`issue-50.md`](issue-50.md)), whose office and issue caps are
exported; and #61, the Floor admin's settings and team
([`issue-61.md`](issue-61.md)), whose Floor settings, Merge Policy and
Agents are. Retention (#112) is exported too.

## What was built

- **The format** (`configurationSchema` in `@ai-office/shared`): a JSON
  document marked `"format": "ai-office.configuration"`, `"version": 1`,
  holding the office's settings (Git identity, intake, sandboxes, body
  storage, load balancing, retries, usage throttling, the prompt-cache
  TTL, Token Caps, retention), each AI Provider's default Model, the Owner's Model prices,
  the office-wide memory, the Skill library with every file, and every
  Floor (archived ones too) with its repository, settings and Merge
  Policy, Agents, issues' Token Caps, Skill settings per Role and each
  Role's accepted memory. Every part reuses the schema the admin's own
  routes check it with, and the whole is strict: an unknown field (such
  as a `credential`) is refused. A Floor has exactly one Manager, its
  Agents' names are its own and its required reviewers are its reviewers;
  no Floor, repository, Agent or Skill is named twice.
- **No credential** by construction: AI Accounts, Gateway Keys, the
  password, TOTP, sessions and anything sealed with `ENCRYPTION_KEY` have
  no place in the format; and the export passes the central redactor
  (which knows the Owner's own secrets), so a key pasted into an Agent's
  instructions leaves as `[REDACTED]`.
- **The service** (`createConfiguration` in `@ai-office/orchestrator`):
  `export()`; `preview(configuration)`, listing each thing it would add or
  change (with the fields) and each problem; and `import(configuration)`,
  which applies exactly those steps or, with any problem, throws
  `ConfigurationError` having changed nothing. It adds and changes but
  never removes; matches by Floor id and repository, Agent id and Skill
  name; and publishes the events the admin's own changes do
  (`config.changed`, `floor.created`, `agent.created` — so each imported
  Agent gets its own Gateway Key —, `floor.archived`, `skill.added`,
  `memory.office_changed`, `memory.role_changed`), then `config.changed`
  `configuration.imported`. One import runs at a time.
- **Routes** (`apps/server/src/configuration/routes.ts`): `GET
  /api/configuration/export` (a download,
  `ai-office-configuration-<date>.json`, `no-store`); `POST
  /api/configuration/import/preview`; `POST /api/configuration/import`
  (`409 configuration_conflicts` with the problems). A file that is not an
  export of this version is `400`. All need a signed-in session.
- **Admin's Configuration card** (`apps/web/src/configuration-card.tsx`),
  in Admin after Storage (main moved the AI cards to AI Settings; export
  and import are office administration, FR-65):
  **Export configuration** downloads the file; choosing a file to import
  checks it in the browser, previews it area by area (what is added or
  changed, which fields, and notes such as Skills waiting for review) or
  lists what stops it, and **Import these changes** applies it.

### After the merge

- **Main's office settings are covered.** The only configuration main
  added is the AI Gateway's prompt-cache TTL (`gateway_prompt_cache_ttl`,
  set in Admin's **Prompt cache TTL** card). The export holds it as
  `office.promptCache`, a preview lists a change to it
  (`office`, `promptCache`, `["ttl"]`), and an import sets it through the
  same `setPromptCacheSettings` the admin uses, so the change is a
  `config.changed` event. Main's other changes (AI Settings page, usage
  windows, Storage) add no configuration: AI Accounts stay out as
  credentials, and Storage holds no setting.
- **The card text** now says the AI Gateway's settings in AI Settings are
  in the file as well as Admin's.
- **Docs** moved from the README to
  [`docs/guide/running.md`](../guide/running.md#configuration-export-and-import).
- **A flaky test fixed.** The round trip's set-up renamed web-shop's
  coder "Ada" and added a coder "Linus", both names a new Floor's random
  team may already have; the store then answered `name_taken`, which the
  set-up ignored, and about one run in three a Floor was an Agent short.
  It now uses names outside `agentNames` and checks each answer. The
  assertions are unchanged.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 at `865484d`, with all workers (output below).
- [x] **Round-trip test: export then import into an empty database
      reproduces the configuration; no credential appears in the export.**
  - `packages/orchestrator/src/configuration/configuration.test.ts`
    configures an Office in every area (now including a prompt-cache TTL
    of `1h`), exports it, reads it back as JSON, previews it into an
    empty Office, imports it and exports again: equal to the original
    but for imported Skills waiting for review (FR-76), and equal exactly
    once they are reviewed. Importing again previews no change. It checks
    the export holds the TTL and the retention periods, and that
    importing a changed TTL is previewed and applied. The same cases
    import into an empty Postgres 18 database on the host.
  - "No credential is ever in an export": an AI Account's key pasted into
    an Agent's instructions leaves redacted, and no field could hold one.
  - `apps/server/src/configuration/routes.test.ts` does it through the
    API with credentials in use (an AI Account's key, an Owner tool's
    Gateway Key, each Agent's Gateway Key) and the TTL set to `5m`: none
    of the credentials, the password or anything sealed (`aio1:`) is in
    the download; it holds the TTL and retention; imported into an empty
    Office it exports equal, and each imported Agent has a new Gateway
    Key of its own.

### Not verifiable in this sandbox

- **The Postgres 18 runs** (Testcontainers needs Docker), skipped here
  with the reason: the five orchestrator cases importing into an empty
  Postgres database and the three route cases with the importing Office
  in Postgres, the "empty database" half of the round trip as the issue
  words it. Here the same cases pass with an empty Office in memory,
  through the same store interfaces.
- **The Admin page in a browser** (`pnpm e2e`): the card's place after
  Storage, a real download and file picker, and
  `e2e/tests/accessibility.spec.ts`.
- **A real move between two installations** (two databases, real AI
  Accounts and the GitHub App).

## Notes

- **Imported Skills wait for review** (FR-76), so "reproduces the
  configuration" holds once the Owner has reviewed them, which the round
  trip does.
- **What is not configuration**, and so not exported: AI Accounts
  (credentials; "credential migration" is out of scope), Gateway Keys,
  the password and TOTP, sessions, and what AI Office records (requests,
  events, Notices, Batches, chats). Floor Templates and the Role library
  (FR-101) are not built on this branch yet; they belong in this format
  when they are.
- The format stays version 1: no export has left this branch, so adding
  `promptCache` needs no older version to read.
- No disagreement with the PRD or an ADR was found.

## Output of the checks

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  247 passed (247)
      Tests  2837 passed | 394 skipped (3231)
   Start at  08:46:01
   Duration  43.98s (tests 41%, import 35%, environment 12%, transform 9%, setup 2%)
test exit=0

$ for i in $(seq 1 15); do pnpm exec vitest run packages/orchestrator/src/configuration; done   # after the flake fix
     15       Tests  5 passed | 5 skipped (10)

$ pnpm exec vitest run --reporter=verbose <the configuration tests>
 ✓ |@ai-office/shared| src/configuration.test.ts > a configuration export > is read back as written
 ✓ |@ai-office/shared| src/configuration.test.ts > a configuration export > is an AI Office export of this version
 ✓ |@ai-office/shared| src/configuration.test.ts > a configuration export > holds nothing it does not know, such as a credential
 ✓ |@ai-office/shared| src/configuration.test.ts > a configuration export > gives each Floor one Manager, Agents of their own names and reviewers it has
 ✓ |@ai-office/shared| src/configuration.test.ts > a configuration export > names each Floor, repository, Agent and Skill once
 ✓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, in memory > an export imported into an empty Office reproduces its configuration
 ✓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, in memory > no credential is ever in an export
 ✓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, in memory > adds and changes what is here, never removing what the document lacks
 ✓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, in memory > refuses an import with problems whole, saying what they are
 ✓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, in memory > tells the rest of AI Office of each Floor and Agent it adds
 ↓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, into Postgres 18 > an export imported into an empty Office reproduces its configuration [skipped: no Docker]
 ↓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, into Postgres 18 > no credential is ever in an export [skipped: no Docker]
 ↓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, into Postgres 18 > adds and changes what is here, never removing what the document lacks [skipped: no Docker]
 ↓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, into Postgres 18 > refuses an import with problems whole, saying what they are [skipped: no Docker]
 ↓ |@ai-office/orchestrator| src/configuration/configuration.test.ts > configuration export and import, into Postgres 18 > tells the rest of AI Office of each Floor and Agent it adds [skipped: no Docker]
 ✓ |@ai-office/web| src/configuration-card.test.tsx > configuration in Admin > downloads the export
 ✓ |@ai-office/server| src/configuration/routes.test.ts > configuration export and import, in memory > exports without a credential, and imports the export into an empty Office
 ✓ |@ai-office/server| src/configuration/routes.test.ts > configuration export and import, in memory > refuses an import with problems, and a file that is not an export
 ✓ |@ai-office/server| src/configuration/routes.test.ts > configuration export and import, in memory > needs a signed-in session
 ↓ |@ai-office/server| src/configuration/routes.test.ts > configuration export and import, into Postgres 18 > exports without a credential, and imports the export into an empty Office [skipped: no Docker]
 ↓ |@ai-office/server| src/configuration/routes.test.ts > configuration export and import, into Postgres 18 > refuses an import with problems, and a file that is not an export [skipped: no Docker]
 ↓ |@ai-office/server| src/configuration/routes.test.ts > configuration export and import, into Postgres 18 > needs a signed-in session [skipped: no Docker]
 ✓ |@ai-office/web| src/configuration-card.test.tsx > configuration in Admin > previews an import, then applies it
 ✓ |@ai-office/web| src/configuration-card.test.tsx > configuration in Admin > shows what stops an import, and does not offer it
 ✓ |@ai-office/web| src/configuration-card.test.tsx > configuration in Admin > says when a file is not an export, without sending it
 Test Files  4 passed (4)
      Tests  17 passed | 8 skipped (25)
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

- **Retention's fourth period** (`connectionDeliveriesDays`, #112's
  follow-up) is in the export with the others, through the same
  `retentionSettingsSchema`. The round-trip tests set and compare it.
- **Not yet in the format:** the Communications Agent's settings and the
  Connections from the merged branch (#125 to #130). Connections cannot be
  imported without their write-only credentials, so exporting them needs
  a decision beyond this merge (see [`issue-125.md`](issue-125.md)).

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

The configuration tests:

```text
 Test Files  4 passed (4)
      Tests  17 passed | 8 skipped (25)
```

## After merging `feat/issues-110-130-b` into the integration branch

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) at `97de0fe`, after merging `feat/issues-110-130-b` into the
integration branch (`d5ae18f`) and its follow-ups: `1b5254a`
(configuration export and import carry Fresh Start thresholds) and
`97de0fe` (a Kickoff acknowledgement is no working context).

- **Migrations.** The integration branch keeps `0044_retention` to
  `0047_connection_delivery_retention`. The merged branch's
  `0044_context_usage_and_fresh_starts`, `0045_manager_chat_skills`,
  `0046_grilling_sessions` and `0047_manager_chat_compaction` are replaced
  by one regenerated `0048_context_usage_skills_and_grilling`.
  `drizzle-kit generate` finds nothing more to generate. It has not been
  applied to a real Postgres here (no Docker).

- **Merged from `feat/issues-110-130-b`:** each Floor's and each Agent's
  Fresh Start threshold (#121) is in the export: the Floor's through
  `floorSettingsSchema` with its other settings, an Agent's as
  `freshStartThreshold` (null for its Floor's). The preview lists a
  change to either and an import sets it; the round trip sets both away
  from their defaults (`1b5254a`). Grilling Sessions (#94) are records,
  not configuration, and stay out of it.

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
 Test Files  279 passed (279)
      Tests  3179 passed | 448 skipped (3627)
test exit=0

$ pnpm --filter @ai-office/db db:generate
No schema changes, nothing to migrate 😴
generate exit=0
```

The 448 skipped tests need what the sandbox lacks: Postgres 18 and
Mailpit through Testcontainers (Docker), Docker, hadolint or Caddy for
the deployment, or the real GitHub App. They run on the host and in CI.

The configuration tests:

```text
 Test Files  4 passed (4)
      Tests  17 passed | 8 skipped (25)
```
