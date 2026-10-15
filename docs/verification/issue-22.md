# Issue #22: Issue intake and the label pipeline — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit.

## What was built

- **Who labelled an issue** (`packages/github`). Intake has to know
  whether the Owner applied the `ai-office` label, so
  `RepositoryClient.labelEvents(issue)` lists an issue's `labeled`
  and `unlabeled` events, oldest first, each with its actor. It is
  built in four places:
  - **The real client:** `GET /repos/{o}/{r}/issues/{n}/events`,
    keeping only label events.
  - **The fake:** it records an actor for every label change. That is
    the repository's owner unless the scenario names another
    (`setLabel(…, { actor })`), and the App's bot for its own changes.
  - **The fake server:** it serves these events over HTTP.
  - **The contract suite:** a new case holds the fake, the client over
    HTTP and (on the host) the real App to the same behaviour.
- **Settings** (migration `0011_intake_settings`). `office_settings`
  gains `owner_login` and `intake_interval_seconds`, both null to use
  the defaults:
  - **Owner's login:** GitHub user `adrianeyre`, as for commits
    (FR-68).
  - **Interval:** 60 seconds, and at least 10.

  `GET` and `PUT /api/office/intake` read and set them, and Admin
  has an **Intake** card. Each change records `config.changed` with
  the keys, never the values.
- **The pipeline** (`packages/orchestrator/src/pipeline/pipeline.ts`).
  The labels on GitHub are the source of truth: each move reads the
  issue's labels, checks the move against `transitions`, applies it on
  GitHub, then publishes `issue.label_changed`.
  - **Allowed moves:**
    - forward through the stages, with QA and docs optional (a Floor
      may have no Agents for them);
    - back to `needs-code` from review or QA (the Review Loop);
    - to `needs-human` from any other stage.
  - **Refused moves:** skipping review, any other backward move,
    standing still, and leaving `needs-human` (only the Owner does
    that, on GitHub).
  - **Holding:** `hold` and `release` add and remove `in-progress`
    at a workable stage, and a move releases the hold.
  - **Two stage labels:** refused as `conflicting_labels`. The
    exception is a move that stopped after adding its new label: the
    retry finishes it.
- **Intake** (`packages/orchestrator/src/intake/intake.ts`). On each
  round, for each Floor in use (archived Floors are skipped), intake:
  1. creates the pipeline's labels if missing (`ai-office`, the six
     stages and `in-progress`);
  2. lists the open `ai-office` issues, oldest first, skipping any
     already at a stage;
  3. checks the issue came from the Owner: either the Owner opened it,
     or the **latest** `labeled` event for `ai-office` is the
     Owner's (logins compared without regard to case). Other issues are
     ignored;
  4. moves the issue to `needs-code`, publishes `issue.picked_up`,
     and queues it.

  Rounds repeat at the interval, which is read afresh each round, so a
  change applies without a restart. A failure on one issue or Floor
  does not stop the others. The server starts intake when the GitHub
  App is configured, and stops it on close. Until the persistent work
  queue (#25), picked-up work is queued in memory.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All
      three exit 0 (output below).
- [x] **Scenario tests on the fake GitHub.**
      `packages/orchestrator/src/intake/intake.test.ts` runs intake
      against `createFakeGitHub()` with a real Floor added through
      `createFloors`:
      - **An Owner issue is picked up:** labelled `needs-code` on
        GitHub, queued, and recorded as `issue.label_changed` (null →
        `needs-code`) and `issue.picked_up`. It is not picked up
        again on the next round.
      - **Another author's issue is ignored:** this holds even when that
        author labelled it `ai-office`. Its labels are unchanged,
        nothing is queued, and nothing is recorded.
      - **Another author's issue labelled by the Owner is picked up:**
        `setLabel(…, { actor: "adrianeyre" })`.
      - **Also covered:**
        - an issue the Owner labelled, then a stranger unlabelled and
          relabelled, is ignored;
        - the Owner's login comes from the settings, in any case;
        - closed issues, unlabelled issues, repositories that are not
          Floors, and archived Floors are left alone;
        - the labels are created on the repository;
        - one failing issue or Floor does not stop the rest;
        - with fake timers, rounds follow the interval, which is read
          afresh each round, and stop when told.
- [x] **Illegal transitions are refused.**
      `packages/orchestrator/src/pipeline/pipeline.test.ts`:
      - **The table:** every illegal pair in it is refused, including
        null → `needs-review`, `needs-code` → `ready-to-merge`,
        `ready-to-merge` → `needs-code` and `needs-human` → anything.
      - **On the fake GitHub:** a refused move throws
        `PipelineError` (`illegal_transition`) and changes neither
        the labels nor the event log. Holding where no Agent works,
        holding twice, releasing what is not held, and moving an issue
        with two stage labels are refused too.
      - **A legal sequence:** code → hold → review → hold → release →
        QA → docs → ready-to-merge. It is applied on GitHub and recorded
        in order.

### Not verifiable in this sandbox

- **The Postgres 18 variants** of the settings tests
  (`packages/orchestrator/src/office/settings.test.ts` and
  `apps/server/src/office/routes.test.ts`), which also apply migration
  `0011`. They need Docker, so they are skipped here with the reason,
  and run in CI and on the host.
- **`labelEvents` against the real App.** The contract suite's
  real-App run needs `GITHUB_APP_ID`, and the GitHub App and
  `ai-office-sandbox` (#18) do not exist yet.
- **Intake against real GitHub.** It runs on the host once #18 is done.

## Notes and decisions

- **Where the Owner's login comes from.** The PRD has no setting naming
  the Owner's GitHub account. Intake uses an office setting that
  defaults to `adrianeyre`, the same GitHub user as the default commit
  identity (FR-68).
- **Optional QA and docs stages.** The PRD lists the stages in order
  but lets the Owner remove any Agent (FR-10). So QA and docs can be
  skipped, but review (FR-27, required reviewers) cannot.
- **Which issues intake queues.** Intake queues only issues it picks
  up. An issue left at `needs-code` by a crash between labelling and
  queueing is the Manager's watchdog's to recover (#79, #80).

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/web typecheck$ tsc
packages/orchestrator typecheck$ tsc
packages/gateway typecheck: Done
e2e typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  55 passed (55)
      Tests  586 passed | 74 skipped (660)
   Start at  00:45:04
   Duration  5.70s (import 50%, tests 30%, transform 11%, environment 8%)
```
