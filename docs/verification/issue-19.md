# Issue #19: `packages/github`: App client, installation tokens and a fake GitHub — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GitHub App) against a fresh `git clone` of this branch at the
issue's last code commit (`6b869b5`), after `pnpm install
--frozen-lockfile`.

## What was built

- **The App client** (`createGitHubApp`, `packages/github/src/app.ts`), on
  `@octokit/rest` 22:
  - It speaks as the App with an RS256 JWT signed by the App's private key
    (`jwt.ts`, `node:crypto`). The JWT is backdated a minute and valid for
    ten minutes in all, and a fresh one is made for each App-level request.
  - It lists the App's installations and every repository they cover.
  - `repository("owner/name")` gives the calls AI Office needs on one
    repository:
    - issues: create, get, list (by labels and state, never including pull
      requests) and close;
    - labels: ensure one exists, add, and remove (removing one the issue
      does not have is no change);
    - comments: create, and list oldest first;
    - branches: get, create at a commit, delete;
    - pull requests: create, get, list (by state and head branch);
    - reviews: create, list;
    - merges: merge, squash or rebase, optionally only if the head is still
      a given commit;
    - check runs on a commit or a branch's head.
  - **Installation tokens** are minted per repository, scoped to that one
    repository (`repositories: [name]`), and kept until five minutes before
    they expire (`tokens.ts`). Concurrent calls share one mint, and a failed
    mint is not kept. `installationToken()` hands one out, for `git push`
    over HTTPS later. Listing an installation's repositories uses a token
    for the whole installation, kept the same way.
  - **Reviews are always comment reviews.** The App opens AI Office's pull
    requests, and GitHub refuses an approval, or a request for changes,
    from a pull request's own author. The Merge Policy decides merges (ADR
    0002).
  - **Failures are `GitHubError`s** with GitHub's status, or 0 when GitHub
    could not be reached. The message is GitHub's own and never holds a
    credential. Octokit's console logging is off.
- **The fake GitHub** (`@ai-office/github/testing`):
  - `createFakeGitHub()` implements the same `GitHubApp` interface in
    memory, acting as `ai-office[bot]`. It has a scenario API for what
    happens on GitHub without the App: `installRepository`,
    `uninstallRepository`, `createIssue` (as the Owner or anyone),
    `setLabel`, `removeLabel`, `labels`, `pushCommit`, `startCI` and
    `finishCI`.
  - Like GitHub, a merge with a stale `sha` is a 409, and merging a closed
    pull request is a 405. A merge into the default branch closes the
    issues its body closes (`Closes #N`). Adding a missing label creates
    it.
  - `serveFakeGitHub(fake, { appId, publicKey })` serves it as the part of
    GitHub's REST API the client calls. It checks the App's JWT signature,
    issuer and lifetime on App endpoints, and that an installation token is
    unexpired and covers the repository (404 otherwise, as GitHub hides
    what a token cannot reach). It refuses an approval from the pull
    request's author with 422, as GitHub does. `createAppKeys()` makes a
    key pair for a fake App.
- **README:** a section on the App client, the fake and the contract suite,
  with the permissions the App needs for the real-App run.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone (output below).
- [x] **Unit tests: tokens are cached until near expiry and refreshed
      after.**
      - `src/tokens.test.ts` (8 tests) runs on a test clock:
        - a token is still used with just over five minutes left;
        - a fresh one is minted at five minutes left, and kept in turn;
        - one token per key;
        - concurrent callers share one mint;
        - a failed mint is not kept;
        - `forget`, and another refresh margin.
      - `src/app.test.ts` checks the same through the real client against
        the fake over HTTP, counting the mints the fake sees:
        - one token per repository, scoped to it, across many calls and
          clients;
        - no new mint 54 minutes later, and a new one at 56;
        - a repository's token cannot reach another repository (404).
- [x] **Contract tests run the same suite against the fake (and against
      the real App when `GITHUB_APP_ID` is set, skipped otherwise).**
      `src/contract.test.ts` holds one suite of 8 tests and runs it against
      three targets:
      - the in-memory fake: 8 passed;
      - the real Octokit client against the fake served over HTTP (JWT,
        token minting and the REST mapping exercised): 8 passed;
      - the real App: 8 skipped, printing "GITHUB_APP_ID is not set, so the
        contract suite does not run against the real App."

      **Checks that the targets really run:**
      - With `GITHUB_APP_ID=1` and a made-up key, the real-App target ran
        against api.github.com, and GitHub answered `404: Integration not
        found` (output below). So the skip depends only on the variable,
        and the real path signs a JWT GitHub could read.
      - **Negative check:** when the fake listed pull requests among
        issues, the contract suite failed it ("opens a pull request…"), 1
        failed of 49. The fake was restored afterwards.

### Verified on the host

- [ ] **With the App from #18 configured, the contract suite passes
      against `ai-office-sandbox`.** Not verifiable here: #18 (creating the
      App and the repository) is the Owner's, and there are no App
      credentials in the sandbox. To run it:

      ```bash
      GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY="$(cat app.pem)" \
        pnpm vitest run --project @ai-office/github
      ```

      - It works on `adrianeyre/ai-office-sandbox` unless
        `GITHUB_CONTRACT_REPOSITORY` says otherwise.
      - The App needs read and write access to issues, pull requests,
        contents (the suite pushes a commit through the contents API) and
        checks (it reports a `CI` check run). If #18's App lacks checks:
        write, the pull request test fails at "CI".
      - The suite closes its issues and deletes its branches afterwards. It
        leaves one squash-merged commit adding a file under
        `ai-office-contract/` on the default branch each run.

### Notes

- The fake's error messages are close to GitHub's but not identical, so
  the contract suite compares statuses, not messages.
- Branch protection is not modelled by the fake: a merge is never refused
  for failing CI. The Merge Policy gate (#22 onwards) checks CI itself
  through `listCheckRuns`, as ADR 0002 describes.

## Output

### Fresh clone (`/tmp/clone19`)

```text
$ pnpm install --frozen-lockfile --offline
Done in 1.1s using pnpm v12.10.0
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0
$ pnpm typecheck
typecheck exit=0
$ pnpm test
 Test Files  41 passed (41)
      Tests  485 passed | 33 skipped (518)
test exit=0
```

The 33 skipped tests are the 25 of #17 (Postgres without Docker, Compose)
and the 8 real-App contract tests.

### `@ai-office/github`, verbose

```text
 ✓ src/tokens.test.ts > the installation token cache > keeps a token until near its expiry
 ✓ src/tokens.test.ts > the installation token cache > mints a fresh one once it is within five minutes of expiry
 ✓ src/tokens.test.ts > the installation token cache > mints after expiry too
 ✓ src/tokens.test.ts > the installation token cache > keeps one token per key
 ✓ src/tokens.test.ts > the installation token cache > shares one mint between concurrent callers
 ✓ src/tokens.test.ts > the installation token cache > does not keep a failed mint
 ✓ src/tokens.test.ts > the installation token cache > mints again for a key it was told to forget
 ✓ src/tokens.test.ts > the installation token cache > takes a different refresh margin
 ✓ src/fake.test.ts > the fake GitHub's scenario API > installs repositories, one installation per owner
 ✓ src/fake.test.ts > the fake GitHub's scenario API > opens issues as the Owner, or as someone else
 ✓ src/fake.test.ts > the fake GitHub's scenario API > labels and unlabels issues, creating labels as GitHub does
 ✓ src/fake.test.ts > the fake GitHub's scenario API > pushes commits, creating the branch
 ✓ src/fake.test.ts > the fake GitHub's scenario API > starts and finishes CI on a branch's head
 ✓ src/fake.test.ts > the fake GitHub's scenario API > acts as the App's bot
 ✓ src/fake.test.ts > the fake GitHub's scenario API > mints tokens that expire after an hour
GITHUB_APP_ID is not set, so the contract suite does not run against the real App.
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > finds the repository among the App's installations
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > mints an installation token for the repository
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > opens, finds, lists and closes an issue
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > creates labels, and adds and removes them
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > comments on an issue, and lists the comments oldest first
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > creates, finds and deletes a branch
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > opens a pull request, reviews it, sees CI finish and merges it
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > fails with GitHub's status for what does not exist
 ✓ src/jwt.test.ts > the App's JWT > is RS256, issued by the App, backdated a minute and valid under ten
 ✓ src/jwt.test.ts > the App's JWT > does not verify with another key
 ✓ src/app.test.ts > the GitHub App client > lists every installation's repositories
 ✓ src/app.test.ts > the GitHub App client > mints one token per repository, scoped to it, and reuses it
 ✓ src/app.test.ts > the GitHub App client > mints a fresh token once the old one is within five minutes of expiry
 ✓ src/app.test.ts > the GitHub App client > cannot reach another repository with a repository's token
 ✓ src/app.test.ts > the GitHub App client > is refused when its key is not the App's
 ✓ src/app.test.ts > the GitHub App client > fails with a 404 for a repository it is not installed on
 ✓ src/app.test.ts > the GitHub App client > never puts a credential in an error
 ✓ src/app.test.ts > the GitHub App client > reports an unreachable GitHub with status 0
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > finds the repository among the App's installations
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > mints an installation token for the repository
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > opens, finds, lists and closes an issue
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > creates labels, and adds and removes them
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > comments on an issue, and lists the comments oldest first
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > creates, finds and deletes a branch
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > opens a pull request, reviews it, sees CI finish and merges it
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > fails with GitHub's status for what does not exist
 ↓ src/contract.test.ts > the GitHub contract, against the real App > finds the repository among the App's installations
 ↓ src/contract.test.ts > the GitHub contract, against the real App > mints an installation token for the repository
 ↓ src/contract.test.ts > the GitHub contract, against the real App > opens, finds, lists and closes an issue
 ↓ src/contract.test.ts > the GitHub contract, against the real App > creates labels, and adds and removes them
 ↓ src/contract.test.ts > the GitHub contract, against the real App > comments on an issue, and lists the comments oldest first
 ↓ src/contract.test.ts > the GitHub contract, against the real App > creates, finds and deletes a branch
 ↓ src/contract.test.ts > the GitHub contract, against the real App > opens a pull request, reviews it, sees CI finish and merges it
 ↓ src/contract.test.ts > the GitHub contract, against the real App > fails with GitHub's status for what does not exist
      Tests  41 passed | 8 skipped (49)
```

### The real-App target with a made-up App id (`GITHUB_APP_ID=1`)

```text
     × finds the repository among the App's installations
     × mints an installation token for the repository
     × opens, finds, lists and closes an issue
     × creates labels, and adds and removes them
     × comments on an issue, and lists the comments oldest first
     × creates, finds and deletes a branch
     × opens a pull request, reviews it, sees CI finish and merges it
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 7 ⎯⎯⎯⎯⎯⎯⎯
GitHubError: GitHub answered 404: Integration not found
```

### Negative check (the fake lists pull requests as issues)

```text
     × opens a pull request, reviews it, sees CI finish and merges it 5ms
 FAIL  |@ai-office/github| src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > opens a pull request, reviews it, sees CI finish and merges it
      Tests  1 failed | 40 passed | 8 skipped (49)
```
