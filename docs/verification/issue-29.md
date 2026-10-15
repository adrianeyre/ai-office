# Issue #29: Activity Feed page — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **Reading the log back** (`@ai-office/events`): `EventBus.history()`
  reads stored events newest first, with the live stream's filters
  (Floor, Agent, issue, type), a time range (`from` inclusive, `to`
  exclusive), a page size and `beforeId` for the next page. Both stores
  (memory and the `events` table) implement it; one scenario
  (`checkHistory`) checks both.
- **API:** `GET /api/events` with `floorId`, `agentId`, `issue`, `type`
  (comma-separated), `from`, `to` (ISO 8601), `limit` (50 by default, 1
  to 200) and `before`. It answers `{ events, nextBefore }`; `nextBefore`
  is null on the last page. A signed-in session is needed; a malformed
  query is a 400. The query and response schemas and `eventHistoryUrl()`
  are in `@ai-office/events/stream`, shared with the web app.
- **Sign-in events (#12):** every checked sign-in attempt is now also
  published, as `sign_in.succeeded` or `sign_in.failed` (with the second
  factor when one was checked), as is each lockout it starts
  (`sign_in.locked_out`) and signing out here or everywhere
  (`signed_out`). They keep the client's address and user agent, as
  `sign_in_events` does, and never the password.
- **Web:** the **Activity** page is the Activity Feed:
  - every event, newest first, each with its time, type, Floor, a
    sentence saying what happened (`event-text.ts`, with Agents' names),
    and links to its source: the issue on GitHub, its Agents and its
    Notice;
  - filters for Floor, Agent (that Floor's, or every Floor's), issue,
    type (grouped) and from/to, kept in the address
    (`/activity?floorId=web-shop&type=handoff`);
  - infinite scroll: the next page loads when the end of the list is on
    screen, and again after a page while it still is; **Load older
    events** does the same by keyboard or click. The end of the list is
    not a scroll anchor, so loaded pages push it down;
  - live updates: new events matching the filters stream in at the top,
    unless the range has ended. The stream opens once the first page is
    read, resuming right after its newest event, so nothing published in
    between is missed. `useEventStream` gained `enabled` and `after` for
    this.
- **End-to-end harness:** a test's server is started again on fresh ports
  when another process took one between choosing and binding it
  (`EADDRINUSE`), which happened once with 13 parallel tests.
- **README:** "The Activity Feed", and the hook's new options.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 at the issue's last commit (output below).
- [x] **Playwright: filtering by Floor and by type narrows the list; new
      events stream in.** `e2e/tests/activity.spec.ts`, in real Chromium
      against the real server and the embedded Postgres 18.3:
      - **"filters by Floor and type, and new events stream in":** with
        two Floors added, the feed lists 11 entries (the sign-in, then
        each Floor and its four Agents). Choosing `web-shop` leaves its 5
        and nothing of `blog`'s, and puts `floorId=web-shop` in the
        address. Adding the type "Floor added" leaves 1; all Floors of
        that type, 2. With `blog` chosen, its Round Cap changed in
        another tab streams in at the top ("Floor settings changed:
        roundCap.") without a reload (a marker on `window` survives), and
        a change to `web-shop`'s does not.
      - **"loads older events as it scrolls":** 120 events plus the
        sign-in show 50, then at least 100 after scrolling to the bottom,
        then all 121, ending with the sign-in and "That is everything."

      Both passed 10 times each with 10 workers, and the whole suite (13
      tests) passed twice in a row (output below).

      **Negative check:** with the feed's stream disabled, the first test
      failed (`Expected: 6, Received: 5`); restored afterwards.

### Also checked here

- **Integration (memory and Postgres 18):** `checkHistory` (paging,
  each filter, the time range) in `packages/events`;
  `apps/server/src/events/history.test.ts` (paging and filters through
  the API in both, plus access, malformed queries, and the sign-in
  events: two failures, the lockout, a sign out, and signing out
  everywhere, with no password in them).
- **Web component tests** (`apps/web/src/activity-feed.test.tsx`, 8):
  the entries and their sources; each filter and the address; the time
  range; loading older pages; no stream once the range has ended; a
  streamed event arriving at the top, with the stream resuming after the
  newest event read; every event type in exactly one type group; and
  sentences for a Handoff, a lockout and a Token Cap warning.
- `useEventStream`'s new options (`apps/web/src/event-stream.test.tsx`):
  opening only when enabled, starting after the event given, and
  preferring its own cached events.
- The Postgres runs were against an embedded Postgres 18.3 (the method of
  #12 to #28). The whole suite that way: 743 passed, 15 skipped (the
  migration tests that start their own container, and the real-App
  GitHub contract, which needs #18).

### Not verifiable in this sandbox

- **The Testcontainers path** of the Postgres tests and of `pnpm e2e`:
  there is no Docker. Both ran against the embedded Postgres 18.3.

## Notes

- **The stream tests and sign-ins.** The SSE tests sign in, which is now
  an event, so they take event ids from what they publish instead of
  counting from 1.
- **GitHub links** are built as `https://github.com/<owner>/<repo>/issues/<n>`
  from the Floor's repository (GitHub sends a pull request's number there
  on to the pull request), except `issue.picked_up`, which carries the
  issue's own URL. On GitHub Enterprise Server (`GITHUB_API_URL`) these
  links would point at github.com; Floors do not yet keep their
  repository's web address.
- **Agent links** go to the Agent's Floor admin page until the Agent live
  view exists (#32).
- **Infinite scroll under load** sometimes loads one page more than the
  screen needs, so the scroll test checks for "at least 100" after the
  first scroll rather than exactly 100.
- **Retention** (one year, PRD §7) is #112.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  68 passed (68)
      Tests  680 passed | 103 skipped (783)
   Start at  01:53:43
   Duration  7.30s (import 46%, tests 33%, environment 11%, transform 10%)
```

The whole suite against the embedded Postgres 18.3 (all but the
Docker-only `deployment` project):

```text
 Test Files  66 passed (66)
      Tests  743 passed | 15 skipped (758)
```

The new tests (verbose, embedded Postgres 18.3):

```text
✓ src/bus.test.ts > the event bus > reads the log back newest first, a page at a time (the Activity Feed) 2ms
✓ src/event-stream.test.tsx > useEventStream > opens only when enabled, starting after the event it is given 4ms
✓ src/event-stream.test.tsx > useEventStream > resumes after its cached events rather than the event it is given 3ms
✓ src/store.test.ts > the event bus against Postgres 18 > reads the log back newest first, a page at a time (the Activity Feed) 151ms
✓ src/store.test.ts > the event bus against Postgres 18 > stores published events in order and delivers them to subscribers 60ms
✓ src/store.test.ts > the event bus against Postgres 18 > redacts a secret placed in a payload in the stored row 30ms
✓ src/store.test.ts > the event bus against Postgres 18 > reads back the events after an id, by Floor, Agent, issue and type 36ms
✓ src/store.test.ts > the event bus against Postgres 18 > is append-only 41ms
✓ src/events/history.test.ts > GET /api/events, in memory > pages through the events newest first 79ms
✓ src/events/history.test.ts > GET /api/events, in memory > filters by Floor, Agent, issue, type and time 16ms
✓ src/activity-feed.test.tsx > the Activity Feed > lists every event newest first, each linked to its source 253ms
✓ src/events/history.test.ts > GET /api/events, in Postgres 18 > pages through the events newest first 152ms
✓ src/events/history.test.ts > GET /api/events, in Postgres 18 > filters by Floor, Agent, issue, type and time 54ms
✓ src/events/history.test.ts > GET /api/events > needs a session, and refuses a malformed query 16ms
✓ src/events/history.test.ts > sign-ins in the Activity Feed > records each sign-in attempt, the lockout, and signing out 36ms
✓ src/events/history.test.ts > sign-ins in the Activity Feed > records signing out everywhere 19ms
✓ src/activity-feed.test.tsx > the Activity Feed > narrows the list by Floor, Agent, issue and type, in the address 266ms
✓ src/activity-feed.test.tsx > the Activity Feed > narrows the list by time 47ms
✓ src/events/stream.test.ts > GET /api/events/stream against Postgres 18 > resumes from Last-Event-ID out of the events table 133ms
✓ src/activity-feed.test.tsx > the Activity Feed > loads older events a page at a time 109ms
✓ src/activity-feed.test.tsx > the Activity Feed > streams nothing in when the time range has ended 41ms
✓ src/activity-feed.test.tsx > the Activity Feed > shows new events at the top as they stream in 64ms
✓ src/activity-feed.test.tsx > event text > lists every event type in exactly one group 0ms
✓ src/activity-feed.test.tsx > event text > names Agents, and never needs more than the event 3ms
```

`pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium), the
second of two runs in a row:

```text
  ✓   8 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.3s)
  ✓   3 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (2.4s)
  ✓   1 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (2.4s)
  ✓   2 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (2.4s)
  ✓   6 [chromium] › tests/activity.spec.ts:81:1 › the Activity Feed loads older events as it scrolls (2.5s)
  ✓   4 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (2.6s)
  ✓   7 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (2.7s)
  ✓   5 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (3.5s)
  ✓   9 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (1.4s)
  ✓  11 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (1.5s)
  ✓  10 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (1.6s)
  ✓  12 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (1.9s)
  ✓  13 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (2.2s)
  13 passed (6.5s)
```

The Activity Feed suite, 10 times each on 10 workers:

```text
  20 passed (9.9s)
```

The negative check (the feed's stream disabled):

```text
  ✘  1 [chromium] › tests/activity.spec.ts:7:1 › the Activity Feed filters by Floor and type, and new events stream in (7.1s)
    Error: expect(locator).toHaveCount(expected) failed
    Expected: 6
    Received: 5
```
