# Issue #62: Setup guide: GitHub App and branch protection — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no `GH_TOKEN`, no GitHub App) on this branch, after the issue's
last commit (`4920caf` to `285e7bb`).

**Blocked by #60.** Its work is built on this branch, though the issue is
still open: the Merge Policy and its auto-merge gate (`createMergeFlow`,
`gate.ts`, the `ai-office:auto-merge` and `ai-office:manual` labels,
`RepositoryClient.requiredChecks`; [`issue-60.md`](issue-60.md)). The
guide's branch protection for each Merge Policy describes that gate.

## What was built

- **The guide** (`docs/processes/setting-up-a-floor.md`; PRD FR-70,
  ADR 0002). It takes the Owner from nothing to a first issue picked up:
  - **Creating the GitHub App**, field by field: name, homepage, no
    callback or OAuth, webhook off (AI Office polls; it has no webhook
    endpoint), installable only on the Owner's account.
  - **The App's permissions**, as a table: Checks read; Contents, Issues
    and Pull requests read and write; Metadata read. Each row says what
    AI Office does with the permission. Then three it does not ask for,
    on purpose, and why: Administration (AI Office never changes
    protection or settings), Workflows (a push changing
    `.github/workflows/` is refused and the Agent blocked), and Commit
    statuses (the gate reads check runs). It also says what a sandbox's
    read-only token can do.
  - **The App ID and private key** in `.env`, with a one-line command
    (Node, so it is the same on Windows, macOS and Linux) that prints
    `GITHUB_APP_PRIVATE_KEY="…"` on one line. Also how to keep the key
    secret, replace it, and set `GITHUB_API_URL` for GitHub Enterprise
    Server.
  - **Installing the App** on chosen repositories, and **adding the
    Floor** in Admin, with its defaults. Before labelling anything, set
    the Owner's GitHub login on Admin's **Intake** card and the **Git
    identity**.
  - **Branch protection**, as a ruleset or a classic rule:
    - **Every Floor:** require a pull request (no direct pushes) and
      status checks; block force pushes and deletions; no signed commits
      (ADR 0002); no linear history, and merge commits allowed (the App
      merges with a merge commit); allow the App if pushes are
      restricted; protect only the default branch, not `ai-office/*`.
    - **Send to me:** any approval rules. Approve on GitHub before
      **Approve and merge** when an approval is required.
    - **Merge automatically:** required approvals 0; no Code Owners
      review, last-push approval or conversation resolution (AI Office
      never resolves its reviewers' conversations); at least one required
      check; and why "up to date" is best left off.
    - **At a glance:** a table of both columns, and what the per-issue
      labels mean for protection.
  - **Labels AI Office creates**, as a table: each label's name, colour,
    description and meaning. A label the repository already has is left
    as it is. It also says which labels the Owner adds and which are AI
    Office's, and that ADR 0003's `needs-work` is still `needs-code` in
    code.
  - **How intake decides what to pick up**: open issues labelled
    `ai-office`, on every Floor that is not archived, every 60 seconds
    (10 s to 1 h). It skips issues already in the pipeline, takes only
    the Owner's (by author, or by who last added the label), then the
    Manager triages each: clear ones go to `needs-code`, and unclear
    ones wait on an action Notice. Naming issues to the Manager does not
    pick them up yet, since Batches are not built, and webhooks are not
    supported.
  - **Checking it works**, **Troubleshooting** and **See also**.
- **The permissions in code** (`@ai-office/github`): `appPermissions`,
  next to `readOnlyPermissions`, is what the App is registered with. It
  is now also what the fake GitHub enforces, so the list cannot quietly
  drift from what the client calls:
  - Each of the fake's 27 repository routes (`serveFakeGitHub`) names the
    permission GitHub requires for it. A call needs that permission's
    read access for a `GET`, and its write access otherwise; metadata is
    always readable. Before, the fake only refused writes from a token
    with no write permission at all.
  - A token minted with no permissions has `appPermissions`.
  - A token asking for more than `appPermissions` is refused with a 422,
    as GitHub refuses one asking for more than the installation was
    granted. `grants()` in `fake.ts` does the check for both.
- **A unit test that reads both**
  (`packages/orchestrator/src/intake/setup-guide.test.ts`). It parses the
  guide's two tables and holds them to the code.
- **README:** a link to the guide from "Let Agents work issues", Floors,
  the Merge Policy and Documentation. The contract suite's paragraph now
  says the real-App run needs `appPermissions` plus **Checks: Read and
  write** (it reports CI itself), and how the fake checks permissions.
  It used to say "read and write access to issues, pull requests,
  contents and checks", which overstated what AI Office needs.

## Acceptance criteria

### Verified in the sandbox

- [x] **The guide matches the permissions and labels in code (checked by
      a unit test that reads both).** `setup-guide.test.ts` reads
      `docs/processes/setting-up-a-floor.md`, `appPermissions` and
      `pipelineLabels`, in 3 cases:
  - *"lists exactly the permissions the GitHub App needs, each with its
    access"*: the "The App's permissions" table, with GitHub's settings
    page's words turned into API names ("Pull requests" is
    `pull_requests`; "Read-only" is `read`, "Read and write" is `write`).
    It must equal `appPermissions`, with no row twice. An access GitHub
    does not offer fails.
  - *"asks for nothing it says is not asked for"*: the bold names under
    "Not asked for, on purpose:" are exactly Administration, Workflows
    and Commit statuses, and none is in `appPermissions`. "Commit
    statuses" is `statuses` in the API.
  - *"lists exactly the labels intake creates, each with its colour and
    description"*: the "Labels AI Office creates" table's name, colour
    (`#` dropped) and description, row by row, must equal
    `pipelineLabels` in order, and every row says what the label means.

  **Mutation checks**, each reverted after (failing tests in brackets):
  - In the guide:
    - Checks changed to Read and write (1);
    - the Metadata row deleted (1);
    - one colour changed, `#fbca04` to `#fbca05` (1);
    - the `in-progress` row deleted (1);
    - one description changed (1).
  - In code:
    - `needs-code` renamed `needs-work` in `pipelineLabels` (1);
    - `workflows: "write"` added to `appPermissions` (2);
    - `statuses: "read"` added to `appPermissions` (2, once the
      `statuses` naming was fixed; it was 1 before).

  **That `appPermissions` is what the client needs** (the fake's checks):
  - Removing any permission from `appPermissions` fails the github
    package:
    - `contents`: 7 tests;
    - `checks`: 3;
    - `issues`: 11;
    - `pull_requests`: 4.

    Downgrading `contents` to read fails 3: creating a branch, comparing
    commits, and the merge.
  - Two new tests in `app.test.ts`:
    - *"cannot make a call its token's permissions do not cover"*: a
      token with only `issues: write` reads the repository and its
      issues, and is refused (403) on pulls, contents, check runs and a
      merge.
    - *"cannot mint a token with more than the App was granted"*:
      `administration` or `checks: write` is refused in memory, and
      `workflows: write` gets a 422 over HTTP while `contents: read` gets
      a 201. The sandbox's read-only token is minted as
      `readOnlyPermissions`.
  - Every existing test passes unchanged against the stricter fake.

Also checked by hand:

- **Every link in the guide** resolves, and so does every new link to it
  in the README. A small script checked each relative link's file and
  `#anchor` against the target's headings.
- **The key's one-line form** was checked with a throwaway RSA key. It is
  read back unchanged by `node --env-file` (as `pnpm dev` reads `.env`)
  and parses with `crypto.createPrivateKey`.
- **The guide's other claims** were checked against the code:
  - existing labels are left as they are (`ensureLabel` takes GitHub's
    422 `already_exists`);
  - labels are created once per Floor per process, and archived Floors
    are not listed;
  - who counts as the Owner (author, or the latest `labeled` event);
  - issues already in the pipeline are skipped;
  - the merge method is `merge`;
  - the Floors card's message when the App is not configured;
  - the server refuses to start with only one of `GITHUB_APP_ID` and
    `GITHUB_APP_PRIVATE_KEY`;
  - a refused push blocks the Agent with an action Notice;
  - with no required checks, the gate waits five minutes.

### Verified on the host

None are listed on the issue. These are left for the host because the
sandbox has no GitHub App and no Docker:

- **Following the guide on github.com:** creating the App with exactly
  these permissions, installing it on `ai-office-sandbox`, and running
  the contract suite's real-App target (which then also needs Checks:
  Read and write). Each permission the fake requires per route follows
  GitHub's documented fine-grained permissions, but has not been tried
  against GitHub here. One case is `GET /branches/:branch`, which the
  fake files under Contents (GitHub may only need Metadata); the App has
  both either way.
- **Each protection setting's effect on github.com:**
  - signed commits and linear history refusing the App's merges;
  - conversation resolution holding back auto-merge;
  - "Require branches to be up to date" refusing a merge that is behind;
  - a ruleset covering `ai-office/*` refusing the App's pushes.

  These follow GitHub's documented behaviour. The Merge Policy's handling
  of a refused merge is tested (#60); the refusals themselves are not.
- **Workflows**: that a push changing `.github/workflows/` is refused
  without the Workflows permission.
- **The key in compose:** that `docker compose` reads the quoted one-line
  `GITHUB_APP_PRIVATE_KEY`. If compose does not turn `\n` into newlines,
  the server's config does (`replaceAll("\\n", "\n")`), so either way
  works, but it was not run (no Docker).
- **That branch protection on private repositories needs a paid plan**,
  as GitHub documents it today.

## Not verifiable in this sandbox

- **Postgres** (Docker): the Postgres runs are skipped with the reason,
  321 tests, the same 321 as before this issue (checked by running
  `pnpm test` on `49885c3`: 2532 passed, 321 skipped).
- **`pnpm e2e`** was not run. It needs Postgres and Chromium, which the
  sandbox does not have without unpacking them by hand, and the issue
  does not ask for it. The end-to-end server reaches the fake GitHub
  over HTTP, which now checks permissions. Its App tokens are minted with
  no permissions, so they have every permission a route requires: each
  of the 27 routes names one of `appPermissions`, at an access
  `appPermissions` gives. The sandboxes' read-only tokens only clone (in
  the end-to-end tests, sandbox tasks go to a stand-in runner). So no
  end-to-end call should change, but it was not run.

## Notes, and disagreements with the canon

- **`needs-code`, not `needs-work`.** ADR 0003 renames the work Stage's
  label `needs-work`; the code still creates and uses `needs-code`
  (noted in #60 too). The guide documents what AI Office does, says so,
  and its test will fail when the rename lands, so the guide changes
  with it.
- **Intake by naming issues to the Manager** (PRD FR-8) is not built:
  "complete issues 1 to 5" is understood but changes nothing until
  Batches exist. The guide says to use the label for now.
- **Webhooks** (FR-8, FR-65) are not built, so the guide has the App's
  webhook turned off and no events subscribed. When webhooks arrive, the
  guide gains a webhook URL, a secret and the events.
- **`role:<name>` labels** (ADR 0003, FR-23) are not in code yet, so
  they are not in the guide's labels.
- **Floor Templates** (FR-97) are not in code yet. "Add the Floor"
  describes today's Development-like default team.
- **"Forbid direct pushes"** (FR-70) is met with "Require a pull request
  before merging", plus "Do not allow bypassing the above settings" in a
  classic rule. That is how GitHub forbids them; "Restrict who can push"
  is only mentioned, since it would also need the App allowed.
- **Checks: read, not write.** AI Office only reads check runs. The
  README used to say the App needs write access to checks; that is only
  the contract suite's own need, reporting CI on its test repository,
  and the README now says so.

## Noticed, out of scope

- **A label already on the repository keeps its colour and
  description.** If the Owner made an `ai-office` label before, it keeps
  theirs, and nothing reports the difference. Harmless; the guide says
  so.
- **CI on the App's pull requests** starts only because pushes made with
  an installation token start workflows (unlike `GITHUB_TOKEN`'s).
  Nothing in AI Office checks that CI started. On a Merge automatically
  Floor whose CI never starts, the gate sends each pull request to the
  Owner after five minutes, saying no CI ran.
- **EC2** set-up (#115) is out of scope, as the issue says.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (exit 0; tail):

```text
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (exit 0; tail):

```text
 Test Files  211 passed (211)
      Tests  2537 passed | 321 skipped (2858)
```

The new tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ |@ai-office/orchestrator| src/intake/setup-guide.test.ts > the setup guide, docs/processes/setting-up-a-floor.md > lists exactly the permissions the GitHub App needs, each with its access
 ✓ |@ai-office/orchestrator| src/intake/setup-guide.test.ts > the setup guide, docs/processes/setting-up-a-floor.md > asks for nothing it says is not asked for
 ✓ |@ai-office/orchestrator| src/intake/setup-guide.test.ts > the setup guide, docs/processes/setting-up-a-floor.md > lists exactly the labels intake creates, each with its colour and description
 ✓ |@ai-office/github| src/app.test.ts > the GitHub App client > cannot make a call its token's permissions do not cover
 ✓ |@ai-office/github| src/app.test.ts > the GitHub App client > cannot mint a token with more than the App was granted
 ✓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > mints a read-only token that can read but not write
 ↓ |@ai-office/github| src/contract.test.ts > the GitHub contract, against the real App > mints a read-only token that can read but not write
```

Before this issue (`49885c3`), for comparison:

```text
 Test Files  210 passed (210)
      Tests  2532 passed | 321 skipped (2853)
```
