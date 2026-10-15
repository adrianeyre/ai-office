# Issue #321: [fix] I1-11 — The latest-version answer is accepted as any non-empty string and shown to the Owner — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker and no Postgres). The fix is commit `8558a06`,
`fix(security): I1-11 the latest version is taken only as a version number before it is kept, shown or linked`,
on top of `1413188` (I1-10's fix, #319). Its blocker, the I1 probe
(#197), is in the tree: `docs/pen-testing/assessments/I1.md` and
`apps/server/src/version/routes.pen-test.test.ts`.

This is the remediation of finding **I1-11** (`severity:low`, new). The
full output of the checks, run once on the finished tree for all four
fixes, is in [#315's note](issue-315.md#real-output-of-the-checks).

## What was fixed

`latestVersionSchema` was `version: z.string().min(1)`. Whatever
GitHub's answer put in `package.json`'s `version` (or an on-path
attacker's answer did) was:

- kept for ten minutes;
- handed to the web app whole, a 5,000-character string included;
- shown to the Owner as the latest version, with a standing out-of-date
  nag;
- built into the release link.

`packages/shared/src/version.ts` now takes a version number only:

- **`isVersion`:** semantic versioning's `1.2.3`, with an optional
  pre-release (`-rc.1`) and build (`+build.5`). No leading zeros, no
  leading `v`, no spaces, no other characters, and at most
  `maxVersionLength` (64) characters.
- **`latestVersionSchema`:** `version` must pass `isVersion`.

`apps/server/src/version/routes.ts` checks GitHub's answer against the
schema **before it is kept**. Anything else is "could not find out": a
`502 version_check_failed`. When the answer had a non-empty `version`
string, the message is "Its package.json's version is not a version
number."; otherwise it is "Its package.json has no version.", as
before. The failure is kept for its one minute like any other. The
refused text is never echoed, shown or logged; the log records only the
fixed message.

### Sibling paths

The same answer reached the Owner in two more places:

- **The web app** (`apps/web/src/version-check.tsx`) parses the
  server's answer with the same schema. So even an answer that got past
  the server, from an older server or another proxy in front, is
  refused before it is shown or linked. The check used to call such an
  answer "The server could not be reached."; it now says "The answer
  was not a version number." At start-up, no dialog opens.
- **`releasePageOf`**, which builds the "What's new" link, now links a
  tag only for a version number, and otherwise the releases page. It
  already encoded the text, so no scheme could be injected. Now no tag
  an attacker names is linked either.

The footer's version (`__APP_VERSION__`) is compiled in from
`package.json` at build time, so it is not affected.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "the
      latest version is validated as a version number before it is
      shown" is an `it`. Its assertion is unchanged: `"not a version
      <script>"` gets a `502`.
- [x] **Both "pins today" tests become regression tests; neither is
      deleted.**
      - "regression (I1-11): a string that is not a version number is no
        longer accepted as the latest version, returned to the web app
        or linked to". The hostile string gets a `502` with the fixed
        message, and none of it is in the body. The schema refuses it,
        and `releasePageOf` gives the releases page, not a tag.
      - "regression (I1-11): a huge version string is no longer accepted
        whole". The same for `1.0.0-` followed by 5,000 `A`s.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - In `routes.pen-test.test.ts`:
        - a refused answer is kept as a failure for its minute, nothing
          of it comes back, and a version number is taken after;
        - eight hostile shapes are refused: a scheme, markup, trailing
          text, a newline, a leading `v`, two numbers, a leading zero,
          and 65+ characters;
        - three answers with no version are refused: a number, `""`,
          and an object;
        - four real versions are still taken.
      - In `routes.test.ts`: "answers 502 when its package.json's
        version is not a version number".
      - In `packages/shared/src/version.test.ts`: `isVersion` and
        `latestVersionSchema` take five versions and refuse fourteen
        non-versions, and accept exactly 64 characters but not 65.
        `releasePageOf` gives the releases page for non-versions.
      - In `apps/web/src/version-check.test.tsx`: the dialog says the
        check failed and shows neither the text nor a "What's new"
        link, and the start-up check opens no dialog.

      Mutation check: with the old schema and `releasePageOf` put back
      (the new route and tests kept), 29 of the 73 tests in these four
      files fail, the regression tests and the former `it.fails` among
      them. With the fix, all 73 pass.
- [x] **The assessment's findings table marks `I1-11` fixed.** The row
      reads **fixed** (issue #321), with the commit's subject.
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on three older tests that
      this work does not touch (see
      [#315's note](issue-315.md#noticed-out-of-scope)).

### The probe tests, verbose (I1-11)

```
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11: a hostile version answer is accepted and shown unchecked > regression (I1-11): a string that is not a version number is no longer accepted as the latest version, returned to the web app or linked to
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11: a hostile version answer is accepted and shown unchecked > regression (I1-11): a huge version string is no longer accepted whole
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11: a hostile version answer is accepted and shown unchecked > the latest version is validated as a version number before it is shown
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > a refused answer is kept as a failure, never as the latest version, and a version number is taken once GitHub gives one
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses a version with a scheme
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses markup
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses a version with a space and text after it
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses a version with a newline
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses a leading v
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses two numbers
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses a leading zero
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > refuses a version too long to be one
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > says there is no version for a number
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > says there is no version for an empty string
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > says there is no version for an object
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > still takes 1.2.3
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > still takes 10.20.30
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > still takes 1.2.3-rc.1
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > I1-11 siblings: what is kept, and every shape a hostile answer can take > still takes 1.0.0-alpha.beta+build.5
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > the version check where it holds > asks GitHub itself over the one fixed URL, so the browser loads nothing from other sites
✓ |@ai-office/server| src/version/routes.pen-test.test.ts > the version check where it holds > needs a signed-in session: the route is owner-access
```

## Decisions

These are for the Owner to review.

1. **Strict semantic versioning, at most 64 characters.** The release
   workflow (semantic-release) writes `package.json`'s version, so a
   real answer is always `MAJOR.MINOR.PATCH`, with a pre-release or
   build at most. Anything looser (two numbers, a leading `v`, leading
   zeros) is refused. `compareVersions` still accepts those for the
   version running, which is compiled in. 64 characters is six times
   the longest pre-release the workflow is likely to write.
2. **A refused answer is cached as a failure for one minute**, like an
   unreachable GitHub, not for the ten minutes a success gets. This is
   the issue's "treated as could not find out". The Owner sees "AI
   Office couldn't find out the latest version" and can check again.
3. **The refused text is never logged.** The server logs the fixed
   message only, so a hostile answer cannot write into the logs either.
4. **`releasePageOf` falls back to the releases page** rather than
   throwing. Its callers render a link, and a link to every release is
   harmless where a tag named by the answer is not.

## Noticed, out of scope

- **Other text fetched from fixed hosts and shown to the Owner**, such
  as AI Providers' model catalogues and published prices, comes from the
  AI Provider's own authenticated API. That is a different trust and a
  different finding's question. It was not changed here.
- **The three older failures and the one-off whiteboard timeout:** see
  [#315's note](issue-315.md#noticed-out-of-scope).

## What could not be verified here

There is no network to GitHub's raw content host from the tests, and no
browser was driven against a running app. The route was exercised
through `buildApp` with a fake `fetch`, and the dialog in jsdom with a
stubbed server. On the pen-test stack, answering the version check from
a stub upstream with a hostile `package.json` and opening Admin →
**Check for latest version** would confirm it end to end.
