# Issue #27: Notices and the 2D Notice Board — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **Storage** (migration `0013_notices`): **`notices`**, one row per
  Notice: its kind (`action` or `info`), title, Floor (null for the whole
  Office), Agent, issue and pull request (each a number and its URL), CI
  run URL, actions (`[{ id, label }]`), and when it was raised, dismissed
  and acted on, with the action taken. Check constraints keep a Notice
  closed at most once (dismissed or acted on, not both), and the open
  Notices have a partial index. Rows are kept when a Notice closes.
- **The service** (`createNotices` in `@ai-office/orchestrator`):
  - `raise(notice)` stores a Notice and publishes `notice.raised`. Every
    action it offers needs a handler registered first
    (`registerAction(id, handler)`), so every button on the board works;
    an info Notice offers none. Links must be `http` or `https` (the
    board renders them as links). Titles and links are redacted with the
    server's redactor before they are stored.
  - `open({ floorId })` lists the open Notices, newest first: every
    Floor's, or one Floor's.
  - `dismiss(id)` closes it and publishes `notice.dismissed`.
  - `act(id, action)` runs the action's handler and only then closes the
    Notice and publishes `notice.acted_on`. If the handler fails, the
    Notice stays, with the reason. An action already being taken on a
    Notice refuses a second act or a dismissal meanwhile.
  - Errors are `NoticeError`s with codes in `noticeErrorCodes`
    (`@ai-office/shared`).
- **API** (every route needs a session; changes need the CSRF token):
  - `GET /api/notices` (`?floorId=` for one Floor's);
  - `POST /api/notices/:noticeId/dismiss`;
  - `POST /api/notices/:noticeId/act` with `{"action":"…"}`.

  A missing Notice answers 404 `notice_not_found`; a closed one 409
  `notice_closed`; an action it does not offer 422 `action_not_offered`;
  a failed handler 502 `action_failed`.
- **Server:** one redactor for the event bus and the Notices, and
  `startOffice(env)`, which is `startServer` that also hands back the
  event bus and the Notices (for Notice sources, and the end-to-end
  harness).
- **Web:** the **Notices** page is now the lobby Notice Board (FR-50):
  - every Floor's open Notices, or one Floor's from the **Floor** select
    (kept in the address, `/notices?floorId=…`);
  - each with Action or Info, its Floor, when it was raised, its links
    (Issue #N, PR #N, CI run, the Agent by name), a button per action and
    **Dismiss**; a failed action shows its reason;
  - live: `notice.*` events from the event stream refetch it, as does each
    (re)connection of the stream, so nothing raised while it was down is
    missed;
  - `/notices?notice=<id>` brings that Notice into view and focuses it.
- **End-to-end harness:** each test's server is now `e2e/server/main.ts`,
  AI Office started as `main.ts` starts it plus an IPC channel. A test
  raises a Notice with `office.raiseNotice()` (and can publish an event
  with `office.publish()`), as Notice sources will once they exist.
- **README:** "The Notice Board", and the harness's server.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 at the issue's last commit (output below). A first typecheck
      ran before a last lint fix to `apps/web/src/test-setup.ts`, which
      `tsc` then refused; that was fixed in its own commit and all three
      were run again on a clean tree (`git stash -u` of later work).
- [x] **Integration tests: raise, list, dismiss, act.**
      - `packages/orchestrator/src/notices/notices.test.ts`: 8 cases,
        each run with the Notices in memory and in Postgres 18. They
        cover raising (with its event), listing every Floor's or one
        Floor's, dismissing, acting through a registered handler, a
        failing handler leaving the Notice open, refusals (an action not
        offered, a missing Notice, an action with no handler), and
        redaction of a credential in a title and a link. Four more cases
        cover info Notices with actions, `javascript:` links, duplicate
        handlers and concurrent actions.
      - `apps/server/src/notices/routes.test.ts`: the same through the
        HTTP API, 5 cases in memory and in Postgres 18, plus access (a
        session, and the CSRF token to dismiss).

      Without Docker the Postgres runs are skipped with the reason. They
      were run against an embedded Postgres 18.3 with a scratch Vitest
      config that swaps only the Testcontainers fixture (the method of #12
      to #26; nothing from it is committed). All 31 passed (output below),
      and so did the whole suite that way (709 passed; the 15 skipped are
      the migration tests that start their own container and the real-App
      GitHub contract, which needs #18).
- [x] **Playwright: a raised Notice appears live without reload.**
      `e2e/tests/notices.spec.ts > a raised Notice appears live, then is
      acted on and dismissed`:
      1. The Owner adds `web-shop` and opens the empty Notice Board.
      2. The test raises an action Notice in the server. It appears on
         the open page with Action, its Floor and its PR link. A marker
         set on `window` beforehand is still there, so the page was not
         reloaded.
      3. An info Notice raised next appears too.
      4. Taking the action removes the first, **Dismiss** the second;
         after a reload the board is still empty.

      A second test filters the board by Floor. Both passed with the
      other 8 (10 of 10) in real Chromium against the real server and the
      embedded Postgres 18.3 (`E2E_POSTGRES_URL`; output below).

      **Negative check:** with `useLiveNotices` emptied (no stream), the
      live test failed waiting for the raised Notice; restored afterwards.

### Also checked here

- **Web component tests** (`apps/web/src/notice-board.test.tsx`, 8):
  the list with each link's address and the buttons; the empty board;
  the Floor filter (query and address); dismissing and acting (the posted
  body and CSRF token); a failed action's reason; a streamed
  `notice.raised` refetching the board; and `?notice=` focusing a Notice.

### Not verifiable in this sandbox

- **The Testcontainers Postgres tests as written**, because there is no
  Docker. They ran against an embedded Postgres 18.3 instead (above).
- **`pnpm e2e` with Testcontainers**, for the same reason. It ran with
  `E2E_POSTGRES_URL` instead.

## Notes

- **No Notice sources yet.** Nothing in AI Office raises a Notice yet;
  each source (FR-49) comes with its own issue, which registers its
  actions' handlers. Until then, the end-to-end tests raise them through
  the harness.
- **Wall boards.** FR-50's Floor wall board (that Floor's Notices plus
  every issue in progress) is 3D (#65, #69). The 2D board's Floor filter
  shows one Floor's Notices.
- **The Agent link** goes to the Agent's Floor admin page until the Agent
  live view exists (#32).
- **Info Notices offer no actions.** FR-48 has actions "where applicable"
  and lists only Owner decisions (approve and merge, raise cap, resume,
  open Plan), all of which FR-49 raises as action Notices; an info Notice
  is only dismissed.
- **The two-second target** (PRD §7: Notices appear within 2 seconds) is
  met in the Playwright runs (the Notice was visible well inside the
  test's 5-second wait), but it is not measured as such.
- The route-access test used `/api/notices` as its example of a route not
  yet built; it now uses `/api/plans`.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
packages/gateway typecheck: Done
apps/web typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  63 passed (63)
      Tests  649 passed | 100 skipped (749)
   Start at  01:32:07
   Duration  6.63s (import 49%, tests 31%, transform 10%, environment 9%)
```

The whole suite against the embedded Postgres 18.3 (all but the
Docker-only `deployment` project):

```text
 Test Files  61 passed (61)
      Tests  709 passed | 15 skipped (724)
```

The Notice tests against the embedded Postgres 18.3 (verbose, Postgres
lines):

```text
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > raises an action Notice with its links and actions, as an event 131ms
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > lists the open Notices newest first, every Floor's or one Floor's 44ms
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > dismisses a Notice: it leaves the board, is kept, and cannot be acted on 46ms
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > acts on a Notice through its registered handler, which closes it 42ms
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > keeps an action Notice on the board when its action fails 43ms
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > refuses an action the Notice does not offer, or a Notice that is not there 41ms
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > refuses to raise a Notice offering an action with no handler 48ms
✓ src/notices/notices.test.ts > Notices, kept in Postgres 18 > never stores or publishes a credential in a title or link 39ms
✓ src/notices/routes.test.ts > the Notice API, in Postgres 18 > lists the open Notices of every Floor, or of one 149ms
✓ src/notices/routes.test.ts > the Notice API, in Postgres 18 > dismisses a Notice, which leaves the board 62ms
✓ src/notices/routes.test.ts > the Notice API, in Postgres 18 > acts on a Notice through its handler, which takes it off the board 60ms
✓ src/notices/routes.test.ts > the Notice API, in Postgres 18 > keeps the Notice when its action fails, and says why 55ms
✓ src/notices/routes.test.ts > the Notice API, in Postgres 18 > refuses actions a Notice does not offer, and Notices that are not there 59ms
Tests  31 passed (31)
```

`pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium):

```text
  ✓   8 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (1.7s)
  ✓   1 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.2s)
  ✓   2 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (2.2s)
  ✓   7 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (2.3s)
  ✓   5 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (2.5s)
  ✓   6 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (2.5s)
  ✓   4 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (2.5s)
  ✓   3 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (2.7s)
  ✓   9 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (1.6s)
  ✓  10 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (1.8s)
  10 passed (5.2s)
```

The negative check (live updates removed):

```text
  ✘  1 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (6.6s)
    Error: expect(locator).toBeVisible() failed
    Error: element(s) not found
      - waiting for getByRole('list', { name: 'Notices' }).getByRole('listitem').filter({ has: getByRole('heading', { name: 'PR #14 awaiting your approval' }) })
  1 failed
```
