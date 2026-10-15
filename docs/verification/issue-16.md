# Issue #16: SSE event stream with resume, and a web client hook — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit
of the issue (`869a7ab`), after `pnpm install --frozen-lockfile`.

## What was built

- **`GET /api/events/stream`** (`apps/server/src/events/stream.ts`):
  - It is an `owner` route, so it needs a session; the route-access test
    covers it like every other route. Without a session it answers `401`.
  - **Filters:** `floorId`, `agentId`, `issue` and `type` (a
    comma-separated list of event types). Unknown fields, unknown types or
    a malformed `Last-Event-ID` get `400 invalid_request`.
  - **Messages:** each is `id: <event id>` and `data:
    {"id","occurredAt","event"}`. The stream opens with `retry: 2000`. The
    headers are `text/event-stream`, `no-cache, no-store, no-transform`
    and `X-Accel-Buffering: no`.
  - **Resume:** with `Last-Event-ID` (or `?lastEventId=`, since a browser's
    EventSource cannot send the header on its first connection), the
    stream first subscribes to the bus and holds what is published. Then
    it replays the stored events after that id from the log (#15), 500 at
    a time. Then it sends what it held, skipping ids already sent, and
    goes live. Nothing published during the catch-up is lost or repeated.
  - **Heartbeat:** a `: heartbeat` comment every 15 s. Each beat re-checks
    the session, so "sign out everywhere" (or expiry) ends open streams.
  - **Shutdown:** open streams are ended on `preClose`, so they do not hold
    up shutdown.
- **The server** builds the event bus on the `events` table, with a
  redactor holding its secret values; subscriber errors are logged.
  `buildApp` takes it as `events` (an in-memory log when absent, for
  tests) and `heartbeatMs`.
- **Shared** (`@ai-office/events/stream`, Zod only): the stream's path,
  query schema, `Last-Event-ID` schema, wire schema
  (`streamedEventSchema`) and `eventStreamUrl(filter, lastEventId)`.
- **`useEventStream(filter, { maxEvents, onEvent })`**
  (`apps/web/src/event-stream.ts`):
  - It opens an EventSource for the filter. A filter equal in value keeps
    the same stream; a different one replaces it.
  - **Merging:** each event goes into the TanStack Query cache under
    `eventsQueryKey(filter)`, once and in id order, keeping the newest 200
    by default. Malformed messages are ignored. `onEvent(event,
    queryClient)` lets callers update other caches.
  - **Reconnecting:** while the browser can reconnect by itself (with
    `Last-Event-ID`), the hook lets it, and reports `reconnecting`. When
    the browser gives up (a 401, say), the hook invalidates the session
    query, so the app goes to the login page if the session ended. It
    then reconnects after 1, 2, 4… s (up to 30 s), resuming after the
    last cached event.
  - It returns `{ events, status }` and closes the stream on unmount.
- **Dockerfile:** copies `packages/events/src`, which the server now uses.
  The deployment test caught this.
- **README:** "The live event stream".

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone (output below). `pnpm build` passes too.
- [x] **Integration test: disconnect, publish two events, reconnect with
      `Last-Event-ID`, receive both in order.**
      - `apps/server/src/events/stream.test.ts > resumes from Last-Event-ID:
        disconnect, publish two, reconnect, receive both in order` runs the
        app on a real port and reads the stream with `fetch`. It receives
        event 1, aborts, publishes 2 and 3, reconnects with `Last-Event-ID:
        1`, and gets 2 then 3, then live event 4 with no repeats.
      - The same flow through the Postgres `events` table (`… against
        Postgres 18 > resumes from Last-Event-ID out of the events table`)
        is skipped here without Docker. It was run against an embedded
        Postgres 18.3 (below).
      - It was also run against the real server (below).
      - **Negative check:** with the replay disabled, this test and two
        others fail (output below). It was restored afterwards.
- [x] **Unauthenticated stream requests get 401.** `answers 401 without a
      session` checks no cookie (inject) and a stale cookie (a real HTTP
      request): `401`, with a JSON body, not a stream. `route-access.test.ts
      > that requires a session answers 401 without one` covers it too, as
      does curl against the real server (below).
- [x] **Filters, heartbeat, and the hook that reconnects and merges into
      TanStack Query caches** (from "What to build"):
      - `stream.test.ts`: `filters by Floor, Agent, issue and type`,
        `refuses a malformed filter or Last-Event-ID`, `sends a heartbeat`,
        `ends when the session ends`, `loses nothing published while it
        catches up, and repeats nothing`, `does not hold up the server's
        shutdown`.
      - `apps/web/src/event-stream.test.tsx`: 7 tests with a fake
        EventSource, covering the cache merge, ordering and deduplication,
        the cap, the browser's own reconnects, the hook's reconnects with
        backoff and `lastEventId`, `onEvent`, and closing.

### Not verifiable in this sandbox

- **The Testcontainers test as written** (`stream.test.ts > … against
  Postgres 18`), because there is no Docker. It ran against an embedded
  Postgres 18.3, by the method of #12, #14 and #15. Nothing from that is
  committed.
- **A real browser's EventSource.** The hook was tested in jsdom with a
  fake EventSource. Real reconnect timing, `Last-Event-ID` on automatic
  reconnects, and the Vite dev proxy passing SSE through need a browser,
  on the host. No page uses the hook yet (#27, #29).
- **Behind Caddy** (the EC2 set-up): streaming through the reverse proxy
  without buffering. `X-Accel-Buffering: no` is set and Caddy flushes
  `text/event-stream` immediately, but only the host can show it.

### Notes

- **No publishers yet** (as noted for #15). The real-server run below
  stored events from a separate script, so the server's stream served
  them from the `events` table, which is exactly the resume path. Live
  delivery within one process is covered by the tests.
- **No events without `Last-Event-ID`.** A stream opened with neither the
  header nor `lastEventId` starts live, with no backlog. Pages that need
  history (#29) will read it through a REST endpoint or pass
  `lastEventId=0`.

## Output

### Fresh clone (`/tmp/clone16`)

```text
869a7ab feat(web): useEventStream hook
$ pnpm install --frozen-lockfile
Done in 252ms using pnpm v12.10.0
$ pnpm lint
lint exit=0
All matched files use Prettier code style!
$ pnpm typecheck
typecheck exit=0
apps/web typecheck: Done
apps/server typecheck: Done
$ pnpm test
test exit=0
 Test Files  37 passed (37)
      Tests  445 passed | 25 skipped (470)
$ pnpm build
build exit=0
✓ built in 544ms
```

The 25 skipped tests:
- 23 Postgres integration tests (5 `db`, 4 `events`, 2 `gateway`,
  12 `server`), skipped without Docker;
- `docker compose config validates the file`, skipped without Compose;
- the opt-in compose end-to-end test.

```text
 ✓ |@ai-office/events| src/stream.test.ts > eventStreamUrl > is the bare path without a filter
 ✓ |@ai-office/events| src/stream.test.ts > eventStreamUrl > carries the filter and where to resume, and parses back to them
 ✓ |@ai-office/events| src/stream.test.ts > the stream's query > refuses unknown types and fields
 ✓ |@ai-office/events| src/stream.test.ts > the stream's query > takes a Last-Event-ID of digits only
 ✓ |@ai-office/web| src/event-stream.test.tsx > useEventStream > opens the stream for its filter, and merges events into the query cache
 ✓ |@ai-office/web| src/event-stream.test.tsx > useEventStream > keeps each event once, in id order, and ignores malformed ones
 ✓ |@ai-office/web| src/event-stream.test.tsx > useEventStream > keeps only the newest events
 ✓ |@ai-office/web| src/event-stream.test.tsx > useEventStream > lets the browser reconnect by itself while it can
 ✓ |@ai-office/web| src/event-stream.test.tsx > useEventStream > reconnects itself when the browser gives up, resuming after the last event
 ✓ |@ai-office/web| src/event-stream.test.tsx > useEventStream > hands each new event to onEvent, to merge into other caches
 ✓ |@ai-office/web| src/event-stream.test.tsx > useEventStream > closes the stream when unmounted, or when the filter changes
 ✓ |@ai-office/server| src/auth/route-access.test.ts > every route > requires a session or is an explicit exemption
 ✓ |@ai-office/server| src/auth/route-access.test.ts > every route > that requires a session answers 401 without one
 ✓ |@ai-office/server| src/auth/route-access.test.ts > the route-registration check > fails for a new route that declares no access
 ✓ |@ai-office/server| src/auth/route-access.test.ts > the route-registration check > fails for a new exemption that is not listed
 ✓ |@ai-office/server| src/auth/route-access.test.ts > the route-registration check > passes a new route that requires a session
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > answers 401 without a session
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > streams events published after connecting, as server-sent events
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > resumes from Last-Event-ID: disconnect, publish two, reconnect, receive both in order
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > resumes from the lastEventId query parameter too
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > loses nothing published while it catches up, and repeats nothing
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > filters by Floor, Agent, issue and type
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > refuses a malformed filter or Last-Event-ID
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > sends a heartbeat
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > ends when the session ends
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > does not hold up the server's shutdown
 ↓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream against Postgres 18 > resumes from Last-Event-ID out of the events table [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
      Tests  26 passed | 1 skipped (27)
```

### Negative check

```text
$ # stream.ts: the Last-Event-ID replay never runs
 FAIL  |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > resumes from Last-Event-ID: disconnect, publish two, reconnect, receive both in order
 FAIL  |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > resumes from the lastEventId query parameter too
 FAIL  |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > loses nothing published while it catches up, and repeats nothing
      Tests  3 failed | 7 passed (10)
```

### Postgres 18.3 (embedded binary, sandbox)

```text
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > answers 401 without a session
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > streams events published after connecting, as server-sent events
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > resumes from Last-Event-ID: disconnect, publish two, reconnect, receive both in order
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > resumes from the lastEventId query parameter too
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > loses nothing published while it catches up, and repeats nothing
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > filters by Floor, Agent, issue and type
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > refuses a malformed filter or Last-Event-ID
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > sends a heartbeat
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > ends when the session ends
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream > does not hold up the server's shutdown
 ✓ |@ai-office/server| src/events/stream.test.ts > GET /api/events/stream against Postgres 18 > resumes from Last-Event-ID out of the events table
      Tests  11 passed (11)
```

### The real server against Postgres 18.3

`pnpm db:migrate`, then `node apps/server/src/main.ts`. A separate script
stored four events in `events` through a bus of its own: three
`agent.status_changed` for Agent `ada`, then a `sign_in.failed` whose user
agent held an Anthropic-shaped key. Then curl:

```text
--- without a session:
{"error":"unauthorized","message":"Sign in at /login."} 401
--- Last-Event-ID: 1, filtered to Agent ada (3 s):
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-store, no-transform
connection: keep-alive
x-accel-buffering: no
Transfer-Encoding: chunked

retry: 2000

id: 2
data: {"id":2,"occurredAt":"2026-10-08T23:31:41.886Z","event":{"type":"agent.status_changed","version":1,"floorId":"web-shop","agentId":"ada","status":"working","issue":2}}

id: 3
data: {"id":3,"occurredAt":"2026-10-08T23:31:41.890Z","event":{"type":"agent.status_changed","version":1,"floorId":"web-shop","agentId":"ada","status":"working","issue":3}}

--- lastEventId=0, only sign_in.failed (3 s):
retry: 2000

id: 4
data: {"id":4,"occurredAt":"2026-10-08T23:31:41.893Z","event":{"type":"sign_in.failed","version":1,"ip":"203.0.113.7","userAgent":"token [REDACTED]"}}

--- bad Last-Event-ID:
{"error":"invalid_request","problems":["Last-Event-ID must be an event id."]} 400
```

With a stream open, `SIGTERM` to the server:

```text
{"level":30,"time":1791502318690,"pid":13438,"signal":"SIGTERM","msg":"Shutting down."}
{"level":30,"time":1791502318691,"pid":13438,"reqId":"req-7","res":{"statusCode":200},"responseTime":1007.26,"msg":"request completed"}
```

The open stream ended 1 ms after the signal, and the process exited.
