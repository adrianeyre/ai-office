# Issue #15: `packages/events`: typed event schema and bus — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit
of the issue (`442b362`), after `pnpm install --frozen-lockfile`.

## What was built

- **The schema** (`packages/events/src/schema.ts`): `officeEventSchema`,
  one Zod discriminated union on `type`, of 23 event types. Every type has
  `version: 1` and is a strict object, so an unknown field is refused:

  | Family | Types |
  | --- | --- |
  | Floor | `floor.created`, `floor.archived` |
  | Agent | `agent.created`, `agent.removed`, `agent.status_changed`, `agent.fresh_start` |
  | Issue | `issue.picked_up`, `issue.assigned`, `issue.label_changed` |
  | Sandbox | `sandbox.started`, `sandbox.stopped` |
  | Handoff | `handoff` (with the FR-26 summary: changed, check, risks) |
  | Model call | `model_call.completed` (summarised: account, provider, Model, status, latency, tokens) |
  | Notice | `notice.raised`, `notice.dismissed`, `notice.acted_on` |
  | Cap | `cap.warning`, `cap.reached` |
  | Config | `config.changed` (which keys changed, never their values) |
  | Sign-in | `sign_in.succeeded`, `sign_in.failed`, `sign_in.locked_out`, `signed_out` |

  - **Versioning.** A type changes incompatibly by gaining a v2 beside v1,
    as a nested `z.discriminatedUnion("version", …)`, so stored v1 rows
    still parse. Zod 4 nests these; this was checked before relying on
    it.
  - `subjectOf` finds the Floor, every Agent (a Handoff has two) and the
    issue an event concerns. `matchesFilter` applies a
    `{ floorId, agentId, issue, types }` filter.
  - `@ai-office/events/schema` exports only this module (Zod alone), so the
    web app can use it for #16 without pulling in the database.
- **The table** (`events`, migrations `0006_events` and
  `0007_events_append_only`):
  - Columns: `id` (identity), `occurred_at`, `type`, `version`,
    `floor_id`, `agent_ids text[]`, `issue`, and `payload jsonb`.
  - Indexes for the filters #16 needs: type, Floor, Floor and issue, and a
    GIN index on the Agents.
  - A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`.
- **The bus** (`createEventBus`):
  - `publish` validates the event (a malformed one is refused, and
    nothing is stored), redacts it with the central redactor (#13), and
    appends it to the store. Only then does it deliver it to subscribers.
  - Publishes run one at a time, so ids are committed and delivered in
    the same increasing order even when many are published at once. A
    reader resuming after an id cannot miss one that commits late.
  - `subscribe(listener, filter)` returns an unsubscribe function. A
    subscriber that throws (or rejects) is reported to `onListenerError`,
    and the others still receive the event.
  - `eventsAfter(id, filter, limit)` reads the log back, oldest first (for
    #16's `Last-Event-ID`).
- **Stores:** `databaseEventStore(db)` and `memoryEventStore()` (for
  tests).

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone (output below).
- [x] **Integration test: published events are stored in order and
      delivered to subscribers.**
      - `store.test.ts > stores published events in order and delivers them
        to subscribers` publishes one event of every type, all at once,
        through the bus with the Postgres store. It checks that the rows'
        ids, payloads, types and versions are in publishing order, that the
        filter columns are right, and that subscribers received the same
        events with the same ids in the same order.
      - It uses Testcontainers, so it is skipped here. It was run against
        an embedded Postgres 18.3 (below).
      - The same behaviour is covered in memory by `bus.test.ts > stores
        published events in order, then delivers them to subscribers`,
        which also checks each event was stored before it was delivered,
        and by `keeps the order of events published at once`.
- [x] **A secret placed in a payload is redacted in the stored row.**
      - `store.test.ts > redacts a secret placed in a payload in the stored
        row` publishes an event carrying a GitHub token and a registered
        secret value. It reads `payload::text` straight from the table:
        neither appears, and both are `[REDACTED]`. It ran against Postgres
        18.3, as above.
      - In memory, `bus.test.ts > removes a secret placed in a payload
        before it is stored or delivered` checks the stored and the
        delivered event, for an Anthropic key and a `password=` value.
      - **Negative check:** with the bus's `redactor.redact` call removed,
        that test fails (output below). It was restored afterwards.
- [x] **The table is append-only** (from "What to build"): `store.test.ts
      > is append-only` checks that `UPDATE`, `DELETE` and `TRUNCATE` are
      refused (Postgres 18.3, below).

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written** (4 in
  `packages/events/src/store.test.ts`), because there is no Docker. They
  were run against an embedded Postgres 18.3, by the method of #12 and #14,
  with scratch copies that replace only the container fixture. Nothing from
  this is committed.

### Notes

- **No publishers yet.** Nothing in AI Office publishes events at this
  point. Sign-ins, for example, are still recorded only in
  `sign_in_events` (#12, #14). Delivering events to the browser is #16,
  and the Activity Feed (#29) will be built on them. The issue asks only
  for the schema and the bus.
- **Retention vs append-only.** PRD §7 keeps the Activity Feed for one
  year. The trigger forbids every `DELETE`, so the retention job will need
  a deliberate migration that allows deleting rows past their retention
  period. This is noted in the migration.
- **One process.** The bus orders publishes within one process, as AI
  Office runs (the same assumption as the sign-in rate limit). Several
  processes writing to `events` would need a database-level lock to keep
  ids committing in order.

## Output

### Fresh clone (`/tmp/clone15`)

```text
442b362 feat(events): typed, versioned event schema and the event bus
$ pnpm install --frozen-lockfile
Done in 415ms using pnpm v12.10.0
$ pnpm lint
lint exit=0
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit=0
apps/web typecheck: Done
apps/server typecheck: Done
$ pnpm test
test exit=0
 Test Files  34 passed (34)
      Tests  424 passed | 24 skipped (448)
```

The 24 skipped tests:
- 22 Postgres integration tests (5 `db`, 4 `events`, 2 `gateway`,
  11 `server`), skipped without Docker;
- `docker compose config validates the file`, skipped without Compose;
- the opt-in compose end-to-end test.

```text
$ pnpm exec vitest run --project @ai-office/events --reporter=verbose
 ✓ src/schema.test.ts > officeEventSchema > covers Floor, Agent, issue, sandbox, Handoff, model call, Notice, cap, config and sign-in events
 ✓ src/schema.test.ts > officeEventSchema > parses a <type> event        (23 tests, one per type)
 ✓ src/schema.test.ts > officeEventSchema > refuses an unknown type, another version, or an unknown field
 ✓ src/schema.test.ts > officeEventSchema > refuses a malformed field
 ✓ src/schema.test.ts > subjectOf > finds the Floor, every Agent and the issue
 ✓ src/schema.test.ts > matchesFilter > matches everything without a filter
 ✓ src/schema.test.ts > matchesFilter > narrows by Floor, Agent, issue and type together
 ✓ src/bus.test.ts > the event bus > stores published events in order, then delivers them to subscribers
 ✓ src/bus.test.ts > the event bus > keeps the order of events published at once
 ✓ src/bus.test.ts > the event bus > delivers to each subscriber only what matches its filter
 ✓ src/bus.test.ts > the event bus > stops delivering once unsubscribed
 ✓ src/bus.test.ts > the event bus > refuses a malformed event, storing and delivering nothing
 ✓ src/bus.test.ts > the event bus > delivers to every subscriber even when one throws
 ✓ src/bus.test.ts > the event bus > reads back the events after an id, filtered
 ✓ src/bus.test.ts > redaction on the bus > removes a secret placed in a payload before it is stored or delivered
 ↓ src/store.test.ts > the event bus against Postgres 18 > stores published events in order and delivers them to subscribers [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ↓ src/store.test.ts > the event bus against Postgres 18 > redacts a secret placed in a payload in the stored row [same]
 ↓ src/store.test.ts > the event bus against Postgres 18 > reads back the events after an id, by Floor, Agent, issue and type [same]
 ↓ src/store.test.ts > the event bus against Postgres 18 > is append-only [same]
      Tests  37 passed | 4 skipped (41)
```

### Negative check

```text
$ # bus.ts: `redactor.redact(officeEventSchema.parse(event))` → `officeEventSchema.parse(event)`
 FAIL  |@ai-office/events| src/bus.test.ts > redaction on the bus > removes a secret placed in a payload before it is stored or delivered
      Tests  1 failed | 7 passed (8)
```

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > stores published events in order and delivers them to subscribers
 ✓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > redacts a secret placed in a payload in the stored row
 ✓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > reads back the events after an id, by Floor, Agent, issue and type
 ✓ |@ai-office/events| src/store.test.ts > the event bus against Postgres 18 > is append-only
      Tests  4 passed (4)
$ (packages/db) scratch copy of src/migrate.test.ts, all 8 migrations
      Tests  6 passed (6)
```
