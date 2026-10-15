# Issue #336: Branches page: a lane view of each Floor's AI Office branches, ahead/behind the default branch — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker, so no Postgres; no GitHub access; no GitHub App credentials).
The work is these commits on top of `9fe356b`:

| Commit | Subject |
| --- | --- |
| `d18ce9a` | feat(github): list branches by prefix and compare a branch with another |
| `41939c6` | feat(events): a repository.changed event for a Floor's webhooks |
| `375d2d5` | feat(orchestrator): a Floor's AI Office branches as lanes off its default branch |
| `04c482e` | feat(server): GET /api/floors/:floorId/branches |
| `4ea8252` | feat(web): a Branches page, with each Floor's AI Office branches as lanes |
| `4459236` | test(e2e): open Branches, pick a Floor, see a lane and its badge; docs |
| `60aa878` | fix(branches): an undated commit, and only http(s) links from GitHub |

## What was built

- **GitHub client** (`packages/github`): `listBranches(prefix)` (one call
  to `git/matching-refs/heads/<prefix>`) and `compareBranches(base, head)`,
  which returns `aheadBy`, `behindBy`, the merge base and the branch's own
  commits (the newest 100, oldest first; for a longer branch it reads the
  compare's last pages). The fake GitHub now keeps a commit graph (each
  commit's parents, message, author and time; a merge commit has two
  parents, a squash or rebase one), and the fake server serves
  `git/matching-refs` and the compare's counts, merge base and pages of
  commits.
- **Event**: `repository.changed` (`floorId`, `change`: `push`,
  `pull_request`, `check_run` or `check_suite`), which the webhook
  receiver publishes for a signed delivery about a Floor's repository.
  Nothing of the payload is kept: like every webhook, it only says when
  to look.
- **Orchestrator** (`createBranches`): a Floor's AI Office branches
  (`ai-office/<issue>-<slug>` from `issueBranch()`, and
  `ai-office/grilling-<id>` from `grillingBranch()`) as lanes off its
  default branch (the Floor's `defaultBranch` setting). Each lane has its
  commits, issue, open pull request, CI, and the Agent working on it or
  the stage it waits in. A lane more than 20 commits behind, or with a
  merge base older than 7 days, is marked likely to conflict.
- **Server**: `GET /api/floors/:floorId/branches`, read-only, behind
  `access: "owner"` like the other Floor routes.
- **Web**: **Branches** in the main menu (after Analytics), at
  `/branches?floor=<id>`. It has the Floor selector (the last Floor picked
  is remembered in `localStorage`), the SVG lane view and a table with
  the same information. It updates live from the event stream.
- **Docs**: a "The Branches page" section in
  `docs/guide/events-and-chat.md`, the new webhook effect in
  `docs/guide/issue-pipeline.md`, and **Push** added to the events the App
  subscribes to in `docs/processes/setting-up-a-floor.md`.

### How GitHub is spared (the "rate-limit friendly" requirement)

- **Server**: what GitHub said of a Floor is kept for 60 s. It is read
  again sooner only after the Floor's repository changed: a
  `repository.changed` webhook, or a `branch.pushed`,
  `pull_request.opened`, `pull_request.merged`,
  `grilling.documents_written` or `grilling.pull_request_opened` event.
  Even then it waits until 5 s after the previous read. Concurrent
  requests share one read.
- **What is kept between reads**: a comparison, by its two commit SHAs;
  finished CI, by commit, until a `check_run` or `check_suite` change; an
  issue, for 5 minutes; and the repository's address. A steady-state
  refresh is 3 calls (default branch, branch list, open PRs), plus one
  per branch whose head moved or whose CI is unfinished.
- **Web**: refetches 1 s after a burst of events (debounced), and
  otherwise only on a 60 s `refetchInterval`. Nothing polls GitHub on a
  timer faster than once a minute.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Run on the
      final tree (`60aa878`); output below.
- [x] **Unit tests: lane layout from a set of branches and merge bases;
      the ahead/behind badge; the behind warning thresholds; mapping a
      branch to its issue, PR and Agent.**
      - Lane layout: `apps/web/src/branches.test.ts > layoutLanes` (5
        tests). They cover merge bases on the trunk oldest first, each
        lane leaving at its own merge base, rows ordered so lanes do not
        cross, commit spacing, the "…" for undrawn older commits, and the
        width needed for names.
      - Badge: `apps/web/src/branches.test.ts > the ahead/behind badge`
        (`↑3 ↓12`, and "3 commits ahead of main, 12 behind").
      - Thresholds: `packages/shared/src/branches.test.ts >
        likelyToConflict`: 20 behind and exactly 7 days are not flagged;
        21 behind, or 7 days and 1 s, are. Applied to real lanes in
        `packages/orchestrator/src/branches/branches.test.ts > marks a
        lane more than 20 commits behind, or split off more than 7 days
        ago, as likely to conflict`.
      - Mapping: `officeBranchOf` (issue branches with and without a
        slug, Grilling branches, and twelve names that are not AI
        Office's). The orchestrator tests build branch names with the
        real `issueBranch()` and `grillingBranch()` and map each lane to
        its issue (title and URL; `null` when GitHub has no such issue),
        its open PR, its CI (`ciStatusOf`), and its Agent (a running
        work item) or stage (a queued work item, or else the issue's
        pipeline label). A running Grilling Session maps to the Manager.
- [x] **Contract tests: the new GitHub client methods behave the same on
      the fake and the real client's request shapes.** In
      `packages/github/src/contract.test.ts`, "lists branches by prefix,
      and compares a branch with another: ahead, behind, merge base and
      commits" runs against the in-memory fake and against the real App
      client (Octokit, JWT, installation token) talking HTTP to the fake
      server. It covers ahead only, behind only, diverged, by branch and
      by SHA, and a 404 for a missing branch. "gives the newest of a long
      branch's commits, oldest first, counting them all" (230 commits)
      exercises the real client's paging. Against the **real App** both
      are skipped here, since `GITHUB_APP_ID` is not set (see the
      host-only list). The fake's commit graph has its own tests in
      `fake.test.ts`: parents, message, author and time; merge versus
      squash and rebase.
- [x] **Server tests: the endpoint returns the Floor's branches, refuses
      a signed-out request and a Floor the user cannot see, and surfaces
      a GitHub error without crashing.** In
      `apps/server/src/branches/routes.test.ts`, in memory:
      - lanes with commits, `Agent:` trailers, issue and Agent; an empty
        Floor; no token in the body;
      - `401` signed out, `404` for an unknown Floor, `409` for an
        archived one; `POST`, `PUT`, `PATCH` and `DELETE` answer `404`;
      - a GitHub 403 gives a `502` with GitHub's message, `/api/floors`
        still answers, and the next request succeeds.
      The same cases in Postgres 18 are skipped (no Docker).
- [x] **Web tests: the menu item, the floor selector (switching Floors
      updates the URL and the lanes), empty and error states, and a live
      update from a `push` event.** In
      `apps/web/src/branches-page.test.tsx` (6 tests):
      - the menu link;
      - the first Floor put into the address;
      - switching to `blog` puts `?floor=blog` in the address, reads its
        branches and shows the empty state; the Floor is remembered for
        the next visit;
      - a 502 shown in an alert, the selector still working, and
        **Try again** recovering;
      - two `repository.changed` events (`push`, then `check_suite`)
        cause exactly one refetch, which shows the new badge (`↑4 ↓12`)
        and a new lane.
      The dots are links with full `aria-label`s, and focusing one shows
      a `role="tooltip"` tied to it by `aria-describedby`. `app.test.tsx`
      checks the menu's order and the page's title.
- [ ] **Playwright: open Branches from the menu, pick a Floor, see a
      lane with its ahead/behind badge.** Written
      (`e2e/tests/branches.spec.ts`), typechecked and linted. **Not run
      here**: the e2e harness needs Postgres through Testcontainers, so
      without Docker it skips, as designed (output below). Branches was
      also added to `accessibility.spec.ts` (axe on the page) and
      `phone.spec.ts` (no sideways scroll at phone width). Those are
      unrun for the same reason.

### Verified on the host (not possible in this sandbox)

- [ ] Against a real repository with real AI Office branches, the counts
      match `git rev-list --left-right --count main...<branch>` (left is
      behind, right is ahead). Run `pnpm dev` with the real App, open
      `/branches?floor=<id>`, and compare each lane's `↑n ↓m` with that
      command on a fresh `git fetch`.
- [ ] `pnpm e2e` (Docker): `branches.spec.ts`, plus Branches in
      `accessibility.spec.ts` and `phone.spec.ts`.
- [ ] The Postgres 18 variants of `apps/server/src/branches/routes.test.ts`
      and of the new webhook case in `webhooks.test.ts` (Docker).
- [ ] The contract suite against the real App (`GITHUB_APP_ID`,
      `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CONTRACT_REPOSITORY`). In
      particular, check that GitHub accepts Octokit's encoded slashes in
      `git/matching-refs/heads%2Fai-office%2F…` and in
      `compare/<sha>...<sha>`. `deleteBranch` already relies on the same
      encoding.
- [ ] **How it looks**: the lane view and table in light and dark
      themes, at desktop and phone width, and the tooltip's position. I
      built the web app and installed Playwright's Chromium to screenshot
      the page with a mocked API, but the browser cannot start here: the
      sandbox lacks `libnspr4.so` and other system libraries, and there
      is no root to install them. The colours are all theme tokens
      (`stroke-primary`, `stroke-foreground`, `stroke-card`, and
      `tone-warning-foreground` for lanes likely to conflict, always with
      a "Likely to conflict" badge and icon). Nothing was eyeballed.
- [ ] **Live, end to end**: with the App's webhooks on and subscribed to
      **Push** (now in the setup guide), a push to an AI Office branch
      updates the page within about 5 s, without a reload. Also an Agent
      starting work on an issue (`sandbox.started`), which changes the
      lane's "Agent or stage".

## Real output of the checks

`pnpm lint` (tail):

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck` (tail):

```
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test` (tail):

```
 Test Files  498 passed (498)
      Tests  5959 passed | 621 skipped (6580)
   Start at  07:25:41
   Duration  182.50s (tests 66%, import 20%, transform 6%, environment 5%, setup 3%)
exit 0
```

The skipped tests are those needing Docker (Postgres via Testcontainers)
and the real-App contract suite. They are skipped with their reasons, for
example
`[Docker is not available (Could not find a working container runtime strategy), so the Postgres …]`.

`pnpm --filter @ai-office/e2e exec playwright test tests/branches.spec.ts`:

```
Docker is not available (Could not find a working container runtime strategy), so the end-to-end tests are skipped. They run in CI and on the host, or set E2E_POSTGRES_URL.

Running 1 test using 1 worker

  -  1 [chromium] › tests/branches.spec.ts:9:1 › opens Branches from the menu, picks a Floor and sees a lane with its ahead/behind badge

  1 skipped
```

The new tests, verbose (`✓` passed, `↓` skipped):

```
✓ |@ai-office/github| src/fake.test.ts > the fake GitHub's scenario API > keeps each commit's parents, message, author and time, as a branch's history
✓ |@ai-office/github| src/fake.test.ts > the fake GitHub's scenario API > merges with two parents, and squashes or rebases with one, as GitHub does
✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > lists branches by prefix, and compares a branch with another: ahead, behind, merge base and commits
✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > gives the newest of a long branch's commits, oldest first, counting them all
✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > lists branches by prefix, and compares a branch with another: ahead, behind, merge base and commits
✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > gives the newest of a long branch's commits, oldest first, counting them all
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > lists branches by prefix, and compares a branch with another: ahead, behind, merge base and commits
↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > gives the newest of a long branch's commits, oldest first, counting them all
✓ |@ai-office/shared| src/branches.test.ts > officeBranchOf > knows an issue's branch, with its slug or without one
✓ |@ai-office/shared| src/branches.test.ts > officeBranchOf > knows a Grilling Session's documents branch
✓ |@ai-office/shared| src/branches.test.ts > officeBranchOf > knows no other branch, AI Office's prefix or not
✓ |@ai-office/shared| src/branches.test.ts > likelyToConflict > is not for a branch at most 20 commits behind that split off at most 7 days ago
✓ |@ai-office/shared| src/branches.test.ts > likelyToConflict > is for a branch more than 20 commits behind
✓ |@ai-office/shared| src/branches.test.ts > likelyToConflict > is for a branch that split off more than 7 days ago, however few commits behind
✓ |@ai-office/shared| src/branches.test.ts > branchCommitSchema > takes only an http(s) address for a commit's page, as it becomes a link
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > ciStatusOf > is none with no check runs, pending while one runs, and success only when every one passes
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > branchCommitOf > keeps a commit's subject, and the Agent its trailer names
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > branchCommitOf > draws a commit GitHub gives no time for as the oldest, rather than failing
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > a Floor's branches > draws each AI Office branch as a lane off the default branch, ahead and behind it, with its own commits, newest commit first
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > a Floor's branches > names the Agent working on a branch, or the stage it waits in
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > a Floor's branches > gives a branch its open pull request and the CI on its head
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > a Floor's branches > marks a lane more than 20 commits behind, or split off more than 7 days ago, as likely to conflict
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > a Floor's branches > is empty for a Floor with no AI Office branches
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > asking GitHub sparingly > keeps what GitHub said for a minute, then asks again
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > asking GitHub sparingly > asks again once the repository changed, no sooner than 5 seconds after it last asked, and once for many callers
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > asking GitHub sparingly > reads CI again after a check changes, and keeps finished CI otherwise
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > what the branches refuse > refuses a Floor that does not exist, or is archived
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > what the branches refuse > says so when the GitHub App is not configured
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > what the branches refuse > says GitHub could not be asked when it fails, and asks again next time
✓ |@ai-office/orchestrator| src/branches/branches.test.ts > what the branches refuse > refuses a default branch GitHub does not have
✓ |@ai-office/orchestrator| src/webhooks/webhooks.test.ts > GitHub webhooks, settings kept in memory > say the Floor's repository changed for a push, a pull request, a check run or a check suite, and for nothing else
↓ |@ai-office/orchestrator| src/webhooks/webhooks.test.ts > GitHub webhooks, settings kept in Postgres 18 > say the Floor's repository changed for a push, a pull request, a check run or a check suite, and for nothing else
✓ |@ai-office/server| src/branches/routes.test.ts > GET /api/floors/:floorId/branches > answers a Floor's AI Office branches as lanes, in memory
✓ |@ai-office/server| src/branches/routes.test.ts > GET /api/floors/:floorId/branches > refuses a signed-out request and a Floor that cannot be seen, in memory
✓ |@ai-office/server| src/branches/routes.test.ts > GET /api/floors/:floorId/branches > answers a GitHub failure with 502 and what GitHub said, and keeps serving
↓ |@ai-office/server| src/branches/routes.test.ts > GET /api/floors/:floorId/branches > answers a Floor's AI Office branches as lanes, in Postgres 18
↓ |@ai-office/server| src/branches/routes.test.ts > GET /api/floors/:floorId/branches > refuses a signed-out request and a Floor that cannot be seen, in Postgres 18
✓ |@ai-office/web| src/branches.test.ts > layoutLanes > draws the trunk alone for no lanes
✓ |@ai-office/web| src/branches.test.ts > layoutLanes > puts each merge base on the trunk once, oldest first, and each lane off it at its own
✓ |@ai-office/web| src/branches.test.ts > layoutLanes > puts a lane's commits along it, oldest first, a step apart, its name after them
✓ |@ai-office/web| src/branches.test.ts > layoutLanes > marks the older commits of a long lane that are not drawn
✓ |@ai-office/web| src/branches.test.ts > layoutLanes > is wide enough for the longest lane's name
✓ |@ai-office/web| src/branches.test.ts > the ahead/behind badge > shows how far ahead and behind, with arrows
✓ |@ai-office/web| src/branches.test.ts > the ahead/behind badge > says it in words against the default branch
✓ |@ai-office/web| src/branches.test.ts > a commit's words > gives its short sha, message, author, Agent and time
✓ |@ai-office/web| src/branches.test.ts > a commit's words > says how long ago it was
✓ |@ai-office/web| src/branches-page.test.tsx > the Branches page > is in the main menu
✓ |@ai-office/web| src/branches-page.test.tsx > the Branches page > opens on the first Floor, puts it in the address, and shows each lane with its badge, issue, pull request, CI and Agent
✓ |@ai-office/web| src/branches-page.test.tsx > the Branches page > marks a lane far behind as likely to conflict, and says what waits where no Agent works
✓ |@ai-office/web| src/branches-page.test.tsx > the Branches page > switches Floors from the selector, updating the address and the lanes, and remembers the Floor picked
✓ |@ai-office/web| src/branches-page.test.tsx > the Branches page > shows a GitHub error plainly, keeps the rest of the page usable, and tries again
✓ |@ai-office/web| src/branches-page.test.tsx > the Branches page > reads the lanes again when GitHub says the repository had a push, without a reload
```

## Decisions and notes for the reviewer

- **"A Floor the user cannot see."** There is one Owner (PRD §4), so no
  per-user Floor access exists. An unknown Floor answers `404
  floor_not_found`, and an archived one `409 floor_archived` (archiving
  "hides the Floor", FR-9). Both reuse the Floor routes' existing error
  codes.
- **The default branch** is the Floor's `defaultBranch` setting (FR-7),
  not the repository's, as the rest of the pipeline uses it. If GitHub
  has no such branch, the endpoint answers `422 branch_not_found`.
- **"No write calls."** The endpoint makes only `GET`s. It still goes
  through `RepositoryClient`, whose installation token is the App's
  writing one, since that is the client the issue names. A read-only
  token (`readOnlyToken()`) is minted fresh on every call and must be
  revoked, so it would cost a mint and a revoke per read. Left as is.
- **The Manager's GitHub client** (`managerRepository` in
  `manager/authority.ts`) passes the two new read methods through, and
  `gitBackedGitHub` (the sandbox scenario wrapper) catches up first, as
  for its other reads. Both are needed because `RepositoryClient` grew.
- **Activity Feed volume.** `repository.changed` is a stored event, as
  every event on the bus is (PRD §8: the web app is a view over one event
  stream). So each push, pull request, check run and check suite delivery
  for a Floor is now a line in the Activity Feed, filed under "Pull
  requests". That matches FR-52 ("records everything … commits, pull
  request events"), but a busy CI produces many `check_run` lines. If
  that is too noisy, the next decision is a transient (unstored) event
  kind, which the bus does not have today.
- **Live latency.** After a change, the web waits 1 s for more events,
  and the server waits until 5 s after its previous read of the Floor.
  So a burst of webhooks costs one GitHub read, and the page updates
  within about 5 s of a push.
- **The Agent's "avatar"** is a small flat 2D likeness (outfit colour,
  skin tone, hair colour) drawn in SVG beside the Agent's name and Role.
  It is not the 3D Avatar, which the 2D pages do not render.
- **Phones.** PRD §7 lists the Notice Board, the Activity Feed and the
  admin pages for phones. The Branches page works at phone width too
  (the lane view and table scroll sideways inside their own frames).
  That is not a conflict with the PRD, but the PRD does not list it.
- **Out of scope, noticed:** GitHub's compare API always sends the
  changed `files` along with the commits, and cannot be asked not to.
  For a branch with a very large diff, that is wasted bytes per compare,
  bounded by the compare cache. A GraphQL query could fetch just counts
  and commits; that is a separate decision.
- **The fake's `compareCommits`** (pre-existing) compares two trees
  directly rather than from their merge base. That was unchanged, and is
  the same on the linear histories the existing tests use.
