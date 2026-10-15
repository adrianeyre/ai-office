# Issue #28: Browser notifications with sound for action Notices — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **The rule** (`noticeAlert` in `apps/web/src/notice-alerts.ts`): only a
  newly raised action Notice (`notice.raised` with `kind: "action"`)
  notifies, only while the Owner has notifications on and the browser
  allows them, and with the sound unless the Owner muted it. Info
  Notices, dismissals, actions taken and every other event never notify.
- **The notifier** (`NoticeNotifier`, in the app layout, so on every
  page): while notifications are on, it listens to the event stream for
  `notice.raised`. For each action Notice it shows a notification (the
  Notice's title; "Needs your action on web-shop."; tagged with the
  Notice's id, so several open tabs show it once) and plays a short sound
  of two soft tones made with Web Audio. Clicking the notification
  focuses the window, closes it, and opens `/notices?notice=<id>`, which
  brings that Notice into view on the Notice Board (#27). While they are
  off, no stream is opened for it.
- **The setting** (Admin, **Browser notifications** card):
  - **Notify me of action Notices**, off by default. Turning it on is the
    only thing that asks the browser for permission, never a page load.
    If the browser refuses (or cannot show notifications) it stays off and
    says why. If permission is later withdrawn in the browser, the card
    says so.
  - **Play a sound**, on by default; unticking it mutes the sound.
  - Both are kept in this browser's local storage
    (`ai-office:notice-alerts`).
- **Sound and autoplay:** browsers let a page play sound only after a
  click or key press, so the sound is unlocked by the toggle's click and
  by any later click or key press on the page.
- **README:** "Browser notifications", under the Notice Board.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below).
- [x] **Unit tests: only action Notices notify; muted means no sound.**
      - `apps/web/src/notice-alerts.test.ts` (5): an action Notice notifies
        with the sound; an info Notice never does; muted notifies without
        sound; off, or the browser refusing, does nothing; other events
        (dismissed, acted on, a cap) never notify.
      - `apps/web/src/notice-notifier.test.tsx` (6), the whole app with the
        stream, notifications and sound replaced by stand-ins: an action
        Notice shows a notification and plays the sound; an info Notice
        does neither; muted shows it silently; off opens no stream and
        shows nothing; a refused permission shows nothing; clicking it
        opens that Notice on the Notice Board.
      - `apps/web/src/notice-alerts-card.test.tsx` (4): off by default and
        the browser is not asked on load; turning it on asks once and is
        kept in local storage; muting and turning off; a refusal keeps it
        off with the reason.

      **Negative checks**, each restored afterwards: with `noticeAlert`
      no longer checking the kind, "never notifies of an info Notice" and
      "stays silent for an info Notice" failed; with it ignoring the mute,
      both "muted" tests failed.

### Verified on the host

- [ ] **A real action Notice notifies in Chrome and Firefox.** Not
      verifiable here: the sandbox has no desktop, no Firefox, and nothing
      raises a real Notice yet (the sources come with their issues).

      Short of that, `e2e/tests/notice-alerts.spec.ts` ran in real
      Chromium (its new headless mode, with notifications allowed)
      against the real server and Postgres 18.3:
      1. Signed in, an action Notice raised before turning notifications
         on shows nothing.
      2. In Admin the Owner ticks **Notify me of action Notices**; **Play
         a sound** is ticked.
      3. An info Notice, then an action Notice, are raised in the server.
         The page's `Notification` (wrapped to record its calls) was
         called once, for the action Notice, with its title, "Needs your
         action." and the Notice's id as its tag.
      4. After a reload the setting is still on.

      Whether the notification appears on the desktop, and the sound is
      heard, can only be checked on the host. To check by hand: turn
      notifications on in Admin, then raise an action Notice (for now, as
      the end-to-end harness does, `office.raiseNotice` from
      `e2e/server/main.ts`), in Chrome and in Firefox, with the tab in the
      background; click the notification.

### Not verifiable in this sandbox

- **A real desktop notification and its sound**, in Chrome and Firefox
  (above).
- **The Testcontainers path of `pnpm e2e`**; it ran with
  `E2E_POSTGRES_URL` and the embedded Postgres 18.3, as for #27.

## Notes

- **Where the setting lives.** FR-67 keeps configuration in Postgres.
  This setting is kept in the browser instead, because the permission it
  depends on is the browser's: notifications turned on at the desk would
  otherwise try to fire on a phone or a second browser that has not
  allowed them.
- **Chromium's headless shell** reports `Notification.permission` as
  `denied` whatever permission the test grants, so the end-to-end test
  runs in full Chromium (`channel: "chromium"`), which `playwright
  install chromium` installs alongside it (as CI does).
- **The sound is generated**, not an audio file, so it needs no asset
  (and no licence entry in `THIRD-PARTY-NOTICES.md`).

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
 Test Files  66 passed (66)
      Tests  664 passed | 100 skipped (764)
   Start at  01:36:37
   Duration  7.36s (import 47%, tests 32%, environment 11%, transform 10%)
```

The unit tests (verbose):

```text
✓ src/notice-alerts.test.ts > noticeAlert > notifies of an action Notice, with a sound 2ms
✓ src/notice-alerts.test.ts > noticeAlert > never notifies of an info Notice 0ms
✓ src/notice-alerts.test.ts > noticeAlert > notifies without a sound when the sound is muted 0ms
✓ src/notice-alerts.test.ts > noticeAlert > does nothing while notifications are off, or the browser refuses them 0ms
✓ src/notice-alerts.test.ts > noticeAlert > ignores every other event, a Notice's dismissal and action included 0ms
✓ src/notice-notifier.test.tsx > notifications of action Notices > shows one, with the sound, for a new action Notice 151ms
✓ src/notice-notifier.test.tsx > notifications of action Notices > stays silent for an info Notice 17ms
✓ src/notice-notifier.test.tsx > notifications of action Notices > plays no sound when the sound is muted 17ms
✓ src/notice-notifier.test.tsx > notifications of action Notices > does nothing, and opens no stream for it, while notifications are off 14ms
✓ src/notice-notifier.test.tsx > notifications of action Notices > does nothing when the browser no longer allows notifications 18ms
✓ src/notice-notifier.test.tsx > notifications of action Notices > opens that Notice on the Notice Board when clicked 50ms
✓ src/notice-alerts-card.test.tsx > browser notifications in Admin > starts off, and never asks the browser on load 188ms
✓ src/notice-alerts-card.test.tsx > browser notifications in Admin > asks for permission when turned on, and keeps it on this browser 77ms
✓ src/notice-alerts-card.test.tsx > browser notifications in Admin > mutes the sound, and turns notifications off 71ms
✓ src/notice-alerts-card.test.tsx > browser notifications in Admin > stays off, saying why, when the browser refuses 48ms
Tests  15 passed (15)
```

The negative checks:

```text
     × never notifies of an info Notice 5ms
     × stays silent for an info Notice 31ms
      Tests  2 failed | 9 passed (11)
     × notifies without a sound when the sound is muted 6ms
     × plays no sound when the sound is muted 23ms
      Tests  2 failed | 9 passed (11)
```

`pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.3, Chromium):

```text
  ✓   5 [chromium] › tests/sign-in.spec.ts:48:3 › signing in and out › sends a signed-out visitor to the login page (1.9s)
  ✓   1 [chromium] › tests/sign-in.spec.ts:12:3 › the first run › sends every page to the setup screen, which sets the password once, then signs in with it (2.7s)
  ✓   4 [chromium] › tests/sign-in.spec.ts:58:3 › signing in and out › refuses a wrong password, then signs in (2.6s)
  ✓   7 [chromium] › tests/notices.spec.ts:80:1 › the Notice Board shows one Floor's Notices when asked (2.7s)
  ✓   3 [chromium] › tests/agents.spec.ts:6:1 › the Floor admin lists the four Agents of a new Floor (2.8s)
  ✓   2 [chromium] › tests/notices.spec.ts:8:1 › a raised Notice appears live, then is acted on and dismissed (2.8s)
  ✓   8 [chromium] › tests/floors.spec.ts:18:1 › adds a Floor from the admin page (2.7s)
  ✓   6 [chromium] › tests/floors.spec.ts:53:1 › changes a Floor's settings, then archives it (3.1s)
  ✓   9 [chromium] › tests/sign-in.spec.ts:79:3 › signing in and out › signs out (1.7s)
  ✓  10 [chromium] › tests/sign-in.spec.ts:89:3 › signing in and out › signs out everywhere, ending every other session (1.8s)
  ✓  11 [chromium] › tests/notice-alerts.spec.ts:19:1 › an action Notice notifies once notifications are on; an info one does not (2.1s)
  11 passed (6.7s)
```
