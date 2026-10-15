# Issue #133: Google Calendar Batch events — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in the working tree of this branch, clean at
`688debb` (the code is in `91cc7b3`, `c64f92e`, `fd79ad9` and `35f5f25`,
the guide in `688debb`): `pnpm lint`, `pnpm typecheck`, `pnpm test` and
`drizzle-kit generate`. After them only this note changed.

The blockers are built on this branch: #131, Google sign-in
([`issue-131.md`](issue-131.md)), whose OAuth client, minimal scopes,
token refresh and revoked-grant handling the Calendar Connection
publishes through; and #83, Batches and their Plans
([`issue-83.md`](issue-83.md)), whose `batch.started` event and the
Plan on the whiteboard the event is made from and links to. Its finish
comes from #85's `batch.finished` and the Wrap-up AI Office keeps
([`issue-85.md`](issue-85.md)), which #130 already reads for reports
([`issue-130.md`](issue-130.md)).

## What was built

### The Connection (`packages/shared` `connections.ts`, `google.ts`; `packages/db`)

- `connectionTypes` gains **`google_calendar`**: a publishing destination
  and a Google Connection. It names a **calendar**
  (`googleCalendarCredentialsSchema`) by its id
  (`…@group.calendar.google.com`, or any calendar's email-like id), by
  its embed address (`…/calendar/embed?src=<id>`) or its iCal address
  (`…/calendar/ical/<id>/…`), or as `primary`. The calendar is not
  secret; the tokens stay with the sign-in.
- **A calendar** (`calendarTypes`, `isCalendar`) publishes no Wrap-up
  report and keeps no changelog. `rulesFor` keeps its Floors only.
- **Messages** gain the kinds `batch_started` and `batch_finished`
  ("Batch started", "Batch finished" in a Connection's log). They also
  gain a `calendar` entry (`calendarEntrySchema`): the Batch's Floor and
  id, and when it started and finished.
- **Scope**: `googleServices` gains `calendar`, which needs only
  `https://www.googleapis.com/auth/calendar.events` (see Notes).
- **Migration `0076_google_calendar`** widens the `connections_type`
  check.

### The event (`packages/communications` `calendar.ts`, `transports/google-calendar.ts`)

- **What is sent** (`calendar.ts`). `batch.started` and `batch.finished`
  are now taken in as well as the notification triggers. Each calendar
  within the Batch's Floors is sent a message at its detail level,
  redacted:
  - **Started**: "AI Office: Batch 3 (Web shop), in progress". The
    description says which issues' work started ("Batch 3 on Web shop is
    in progress: work started on #1.") and has "Open the Plan in AI
    Office", the Floor's whiteboard for that Batch.
  - **Finished**: "AI Office: Batch 3 (Web shop): 1 of 3 issues merged, 1
    blocked, 1 not started". The description has the counts, tokens and
    estimated cost, then one line per issue with its outcome and pull
    request (the issue and pull request linked), then the Plan link. All
    of this comes from the Wrap-up as AI Office keeps it. Without one,
    the counts and tokens come from the event, and the start is left as
    it was. Past 6,000 characters the issue list ends "…and N more issues:
    see the Plan".
  - **Links only**: "AI Office: Batch 3, in progress", with no Floor name
    and no issue title, keeping the counts and the links.
  - The publication is redacted before its Markdown is written, as a
    report is (#130), so escaping cannot split a credential past the
    redactor.
- **The transport** (`google-calendar.ts`):
  - **The event's id** is AI Office's own: SHA-256 of the Connection's
    id, the Floor and the Batch, in hex (within Calendar's base32hex).
    It is the same on every attempt of both deliveries, and different
    for every Connection: Connection ids are random.
  - **A start** looks the event up (`GET …/events/<id>`). If there is
    none it makes it (`POST …/events` with that id), lasting an hour
    from the Batch's start. An event already there stands as it is.
  - **A finish** changes the event (`PATCH`) to run from the Batch's
    start to its finish, with the new title and description. If there is
    none (404) it makes the event whole. If making finds the id taken
    (409), it changes the event after all. If the id is taken but the
    event cannot be found, the Owner deleted it and Google purged it, and
    nothing is made.
  - Every event has a `source` (the Plan) and is marked free
    (`transparency: transparent`).
  - **The description** is Calendar's little HTML (`calendarHtml` in
    `markdown.ts`): `<b>`, `<a>`, `<br>`, `<ul>`/`<ol>`/`<li>`, with every
    text escaped.
  - **Send test** reads one event at most (`GET …/events?maxResults=1`)
    and writes nothing.
  - `OutboundDelivery` gains the Connection's id (`connectionId`).
    `googleApi` gains Calendar. Its 403 and 404 name a calendar ("share
    the calendar with that account, with permission to make changes to
    events"; "Google Calendar cannot find the calendar or an event on it:
    check its id, and share it with the Google account signed in (404).").
    Its errors are a `GoogleApiError` carrying the status Google gave.
- **The fake** (`google-calendar-fakes.ts`, served by `serveFakeGoogle`
  with `calendars`, `calendarUrl`, `calendarEvents`, `deleteEvent` and
  `calendarRequests`):
  - It keeps calendars and their events. An event's id may be chosen by
    the caller (base32hex, 5 to 1024 characters) and is never given out
    twice, so `insert` with a used id is a 409 `duplicate`.
  - `get` and `patch` find an event, deleted (cancelled) or not, until
    it is purged (404). `patch` changes only the fields given, and never
    un-deletes.
  - An event may not end before it starts (400). `list` leaves out
    deleted events.
  - Only tokens with the `calendar.events` scope are accepted. It
    shares the fake's lost answers and 429s.

### The server, the web app and the docs

- The server needed no change: `defaultTransports({ google })` gives the
  transport. `routes.test.ts` gains a case adding a calendar through the
  API.
- **Web** (`connections-page.tsx`, `google-sign-in.tsx`):
  - The add form offers Google Calendar, with one field, **Calendar id or
    address**, and a hint saying where the id is.
  - The rules describe the event and offer no changelog. A Connection's
    rules read "An event per Batch", and Send test says "the calendar can
    be read".
  - The Google sign-in card names Calendar and its API.
- **Docs**: [`notices-and-skills.md`](../guide/notices-and-skills.md) has
  a new "Google Calendar" entry, Calendar's scope in "Google sign-in",
  and the API's shape. The README's and the guide index's lines are
  updated.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below): 373 test files, 4130 tests passed, 554
      skipped. `drizzle-kit generate` finds nothing more to generate.
- [x] **Contract tests against a fake Calendar API: created on start,
      updated on finish, never duplicated on retry.** They are in
      `packages/communications/src/transports/google-calendar.test.ts`
      (11 tests). Each runs the real Communications Agent, Google sign-in
      (signed in through the fake's consent screen), memory queue and
      event bus against `serveFakeGoogle`.
  - **Created on start.** `batch.started` makes exactly one event on the
    calendar. Its id is `calendarEventId(connection, Batch)`, and it runs
    from 09:00 to 10:00. It is checked field by field: the title, the
    `source` (the Plan) and `transparent`. Its description is compared
    line by line, and its one link is the Plan. The requests are a `GET`
    of that id, then a `POST`.
  - **Updated on finish.** `batch.finished` changes the same event, now
    `sequence` 1, to run from 09:00 to 10:50 with the outcome in its
    title. The description is compared line by line: the counts, tokens
    and cost, each issue's outcome and pull request, and the Plan link.
    So are its six links. The writes are one `POST` and one `PATCH`.
    Another Batch is a second event.
  - **Never duplicated on retry:**
    - **Lost answers.** The start's answer is lost: the event is made,
      and the delivery fails ("Google Calendar answered 502: Bad
      gateway."). The retry finds the event by its id and leaves it,
      untouched (`sequence` 0). The finish's answer is lost too, and its
      retry changes the same event again. That makes one event and the
      writes `POST`, `PATCH`, `PATCH`.
    - **The finish first.** The start is rate-limited for ten minutes, so
      the finish makes the event whole, and its answer is lost. The
      retry changes it. Then the start's retry finds it and leaves it
      finished, not "in progress". One event, writes `PATCH` (404),
      `POST`, `PATCH`.
    - **Added during the Batch.** A Connection added after the start is
      not sent it, and the finish makes its event whole. Two Connections
      on one calendar keep one event each, by their own ids.
    - **Deleted by the Owner.** The finish leaves a deleted event
      cancelled, and makes no other. For a deleted and purged event, the
      finish ends delivered without making one. Every delivery is
      `delivered`.

  **Sabotage**, each restored after with `git checkout`, and each
  failing at least one test:
  1. The event's id made random, not from the Connection and the Batch.
  2. A start changing an event already there.
  3. A finish never making the event when there is none.
  4. Making not taking a 409 as made.
  5. A finish on a deleted and purged event failing instead of ending.
  6. A change that does not know the start moving it to the finish.
  7. The description's text not escaped.
  8. The publication not redacted before its Markdown is written.
  9. `batch.started` not taken in.
  10. Calendar asking for the whole `calendar` scope.

  Restored: 11 passed.

**Beyond the criteria:**

- **Sign-in.** With a Calendar Connection the consent screen asks for
  exactly `…/auth/calendar.events`; beside Docs, for that and `…/auth/drive`.
  A sign-in that did not allow Calendar makes Send test say "The Google
  sign-in does not allow Google Calendar: sign in to Google again to allow
  it." and calls no Calendar API. A revoked grant marks the calendar
  failing like every Google Connection, since `isGoogleConnection`
  includes it; that path is #131's test and was not retested here.
- **Detail level and redaction.** At "titles and summaries" a title
  planted with `<a href="https://evil.example">click</a>`, a Markdown
  link and an Anthropic key reads as that text, the key `[REDACTED]`. No
  `sk-ant-` is in the description, and its only links are AI Office's
  own. At "links only" neither the title nor the description has the
  Floor's name or an issue's title, and the counts and all six links
  remain.
- **What is sent.** Asked for every trigger and a changelog, a calendar
  keeps only its Floors. A Notice and a merge send it nothing (events for
  Notices are out of scope). A Batch on another Floor goes only to the
  Connection with no Floor filter. That Batch has no Wrap-up, so its
  finish takes the counts and tokens from the event and keeps the event's
  09:00 start.
- **Send test and credentials.** Send test reads the calendar (one `GET`)
  and writes nothing, and a calendar that cannot be found says so (404).
  The embed and iCal addresses and `primary` are taken, the hint is
  "Calendar c_0123456789…" or "Primary calendar", and another address is
  refused.
- `apps/server` `routes.test.ts`: added through the API by the embed
  address, it answers `Calendar c_0123456789…` and `On calendar <id>`.
  It keeps its Floors but no triggers or changelog, and a calendar's web
  address is refused (400).
- `apps/web` `connections-page.test.tsx`:
  - Adding a calendar by its embed address, after refusing its web
    address. No triggers, quiet hours or changelog are offered, and the
    body sent holds the id.
  - The rules text "An event per Batch".

### Verified on the host

- [ ] **A real Batch appears in a real Google Calendar (after #135).**
      This needs a real Google Cloud OAuth client with the Calendar API
      enabled, a Google account, a calendar shared with it and the
      network. The fake stands in here.

## Not verifiable in this sandbox

- **Real Google Calendar:**
  - How it shows the description's HTML (its bold, links, lists and
    blank lines), and whether it keeps `source`.
  - That it gives back a 409 for a used id at once. Google says it
    "cannot guarantee that ID collisions will be detected at event
    creation time", which is why a start looks the event up first (see
    Notes).
  - What a deleted event answers. The fake assumes Google's documented
    behaviour: `get` and `patch` find a cancelled event, `patch` without
    `status` leaves it cancelled, and a purged event's id still answers
    409 to `insert`.
  - Calendar's real rate limits (403 `rateLimitExceeded` and 429 are
    retried after their `Retry-After`, as for Drive).
- **Postgres 18** (no Docker): the Postgres variant of the new
  `routes.test.ts` case (skipped with the reason), and migration `0075`
  itself.
- **Playwright** (`pnpm e2e`, needs Docker and Chromium): the Connections
  page in a browser, including its axe check with the new calendar field.

## Notes

- **"From start to finish" before the finish.** Calendar needs an end,
  and a running Batch has none yet. Until it finishes, its event lasts an
  hour from its start and its title says "in progress". The finish sets
  the real end, earlier or later.
- **The id, not a search.** #132's files are found by a private property
  searched in their folder. Calendar can do the same
  (`privateExtendedProperty`), but an id AI Office chooses is stronger:
  both deliveries name the one event without searching, and a second
  `insert` with that id is refused. Because Google does not promise to
  refuse it at once, a start also looks the event up before making it. A
  finish needs no look-up, as a `PATCH` is the same whenever it is
  repeated.
- **A start never overwrites.** If the finish was delivered first (the
  start retried after a failure), a start that changed the event would
  make it "in progress" again, so it leaves any event there alone. The
  event then has the start's time from the Wrap-up.
- **The scope.** `calendar.events` is the narrowest scope that can make
  and change events on a calendar the Owner chooses.
  `calendar.events.owned` reaches only calendars the account owns, and
  `calendar.app.created` only calendars AI Office made, so neither can
  reach a calendar shared with the account. The whole of `calendar`
  could change calendars' settings and sharing. `calendar.events` can
  still change events on every calendar the account can, so, as for
  Drive, the guide's advice is to sign in with an account that has only
  AI Office's calendar and folders shared with it.
- **Free, not busy.** Each event is marked `transparent`, so AI Office's
  work never shows the Owner as busy to people booking time with them.
- **The start's description** names only the issues whose work started
  with the Batch, which is what `batch.started` carries. The finish's
  description lists every issue with its outcome.
- **One event per Batch per Connection.** Each Connection's event id
  includes its own id, so two Calendar Connections on one calendar each
  keep their own event. A reinstalled AI Office, whose Batch numbers
  begin again, never reuses an earlier install's events.
- **Times** are UTC instants (`dateTime` with `Z`); Calendar shows them
  in the calendar's own time zone.

## Noticed, out of scope

- **A flaky web test under load.** Before any change, the first
  `pnpm test` run (load average 20) failed one test in
  `apps/web/src/scene/grilling-room.test.tsx`: "the Manager walks to
  the table as it starts…" (`coder: expected true to be false`). The
  file passed 3 of 3 times alone, and the whole suite passed in the
  final run. Its timing seems to depend on the machine's load. It is not
  touched here.
- **Send test wording for Sheets**, as #132's note says: it still says
  "the parent can be read. Nothing was written." for Google Sheets, whose
  Send test writes a test row.
- **Configuration export** carries no Connections, as #125's, #131's and
  #132's notes say.
- **No end-to-end coverage.** The end-to-end suite has no test of a
  Google Connection.

## Output

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm --filter @ai-office/db exec drizzle-kit generate
No schema changes, nothing to migrate 😴

$ cat /proc/loadavg
38.52 26.91 18.82 4/28802 22534
$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  373 passed (373)
      Tests  4130 passed | 554 skipped (4684)
   Duration  107.03s (tests 42%, import 38%, transform 12%, environment 7%, setup 1%)
test exit=0
```

The baseline run before any change (the flaky test above):

```text
 FAIL  |@ai-office/web| src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > the Manager walks to the table as it starts and sits there while it runs, with the door's sign lit and the whiteboard filled in; it walks back when the session pauses
AssertionError: coder: expected true to be false // Object.is equality
 Test Files  1 failed | 371 passed (372)
      Tests  1 failed | 4116 passed | 553 skipped (4670)

$ pnpm vitest run --project @ai-office/web src/scene/grilling-room.test.tsx   (three times)
      Tests  7 passed (7)
      Tests  7 passed (7)
      Tests  7 passed (7)
```

This issue's tests (verbose):

```text
✓ src/transports/google-calendar.test.ts > Google sign-in for Calendar > asks for calendar.events and nothing else; beside Docs, Drive's too
✓ src/transports/google-calendar.test.ts > Google sign-in for Calendar > a sign-in that did not allow Calendar says so, and calls no Calendar API
✓ src/transports/google-calendar.test.ts > a Batch's event > is made on the calendar when the Batch starts, and changed to its finish when it finishes, with its Plan and outcome
✓ src/transports/google-calendar.test.ts > a Batch's event > is never made twice when an answer is lost and the delivery tried again
✓ src/transports/google-calendar.test.ts > a Batch's event > is made whole by the finish when the start has not arrived, and the start then leaves it as it is
✓ src/transports/google-calendar.test.ts > a Batch's event > is made by the finish for a Connection added during the Batch, and one event per Connection
✓ src/transports/google-calendar.test.ts > a Batch's event > the Owner deleted stays deleted, and is not made again
✓ src/transports/google-calendar.test.ts > detail levels, Floors and what is sent > "links only": counts and links; no Floor name or issue title
✓ src/transports/google-calendar.test.ts > detail levels, Floors and what is sent > only its Floors' Batches; never a Notice or a merge; without a Wrap-up, the finish from the event
✓ src/transports/google-calendar.test.ts > Send test and failures > Send test only reads the calendar, and says when it cannot be found
✓ src/transports/google-calendar.test.ts > Send test and failures > takes a calendar's id, its address or primary, and refuses anything else
 Test Files  1 passed (1)
      Tests  11 passed (11)

$ vitest run --project @ai-office/communications
 Test Files  12 passed (12)
      Tests  118 passed | 18 skipped (136)

✓ (server) routes.test.ts > the Connections API, kept in memory > adds Google Calendar by a calendar's address: its Floors only, and no changelog
↓ (server) routes.test.ts > the Connections API, kept in Postgres 18 > adds Google Calendar by a calendar's address: its Floors only, and no changelog [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 Tests  9 passed | 9 skipped (18)

✓ (web) connections-page.test.tsx > the Connections page > adds Google Calendar by the calendar's address, with no changelog to offer
✓ (web) connections-page.test.tsx > a delivery's outcome > names a publishing destination's Wrap-up reports and changelog
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

Sabotage runs (each restored before the next):

```text
== 1. The event's id random, not from the Connection and the Batch
     Tests  7 failed | 4 passed (11)
== 2. A start changes an event already there
     × is never made twice when an answer is lost and the delivery tried again
     × is made whole by the finish when the start has not arrived, and the start then leaves it as it is
== 3. A finish never makes the event when it is not there
     × is made whole by the finish when the start has not arrived, and the start then leaves it as it is
     × is made by the finish for a Connection added during the Batch, and one event per Connection
== 4. Making refuses to take a 409 as made
     × the Owner deleted stays deleted, and is not made again
== 5. A finish whose event was deleted and purged fails instead of ending
     × the Owner deleted stays deleted, and is not made again
== 6. A change that does not know the start moves it to the finish
     × only its Floors' Batches; never a Notice or a merge; without a Wrap-up, the finish from the event
== 7. The description's text not escaped
     × is made on the calendar when the Batch starts, and changed to its finish when it finishes, with its Plan and outcome
== 8. The publication not redacted before its Markdown is written
     × is made on the calendar when the Batch starts, and changed to its finish when it finishes, with its Plan and outcome
== 9. batch.started not taken in
     Tests  6 failed | 5 passed (11)
== 10. Calendar asks for the whole calendar scope
     Tests  9 failed | 2 passed (11)
== restored
     Tests  11 passed (11)
```
