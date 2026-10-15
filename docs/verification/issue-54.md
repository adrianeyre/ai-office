# Issue #54: Reviewer Agent: structured verdict posted as an App review — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`1c66967`).

## What was built

- **The GitHub App client** (`packages/github`), for what a reviewer reads
  and posts:
  - `listPullRequestFiles(pr)`: the files a pull request changes, with
    their status and patch (GitHub's `pulls/{n}/files`).
  - `getFileContent(path, ref)`: a file's text at a branch or commit;
    undefined for a missing path or a directory (GitHub's `contents`).
  - `createReview` now posts `comments` inline (it always took them), and
    a `Review` carries its `htmlUrl`.
  - The fake GitHub keeps each commit's files (`pushCommit(…, { files })`),
    compares a pull request's branches, refuses an inline comment off the
    diff with a 422 as GitHub does, records review comments
    (`reviewComments`), and serves the two new endpoints over HTTP. The
    contract suite covers them against the fake, the App client over HTTP
    and (on the host) the real App.
- **The verdict** (`reviewVerdictSchema` in `packages/shared`): `verdict`
  (`approve` or `changes_requested`), a `summary`, and up to 50 `comments`,
  each `{ severity: "blocking" | "nit", path, line, body }`. An approval
  with a blocking comment, or changes requested without one, is not a
  verdict: the Review Loop (#55) acts on blocking comments only.
- **Model calls without a sandbox** (`gatewayModelClient`,
  `packages/orchestrator/src/models/client.ts`): a Messages request to the
  AI Gateway with the Agent's own Gateway Key (`x-api-key`), attributed to
  the issue and pull request (`x-ai-office-issue`,
  `x-ai-office-pull-request`; FR-42). The Gateway serves it from an AI
  Account of the Model's AI Provider, translating where needed (FR-34). The
  server points it at its own Gateway (`GATEWAY_HOST`/`GATEWAY_PORT`, with
  `0.0.0.0` reached as `127.0.0.1`).
- **The reviewer flow** (`createReviewFlow`,
  `packages/orchestrator/src/review/`), the work queue's flow for
  `needs-review`:
  1. Every one of the Floor's enabled required reviewers (FR-27) reviews,
     at once; the issue is held (`in-progress`) meanwhile.
  2. The prompt (`reviewerPrompt`) has the issue, the pull request's
     unified diff and the changed files' text at its head commit, with
     line numbers. Each is quoted between markers it cannot close
     (`<issue>`, `<diff>`, `<file>`), as untrusted text. Long diffs and
     files are cut, saying so. It holds no credential.
  3. The answer is parsed (`parseVerdict`: a bare object, one in a code
     fence, or one among other words) and checked against the schema. An
     answer that is not a verdict is sent back once, as the conversation
     so far plus "That answer is not a valid verdict: <why>. Answer again
     …". If the second is not one either, an action Notice "Agent blocked:
     <reviewer> gave no valid verdict on PR #N (#issue), twice. <why>"
     links the issue, the pull request and the reviewer; the reviewer's
     status becomes `blocked`; the issue is let go at `needs-review`.
  4. Each verdict is posted by the App as a review on the head commit
     (`reviewOf`): its verdict, reviewer, AI Provider and Model, summary and
     counts in the body; each comment inline (`**Blocking:**` /
     `**Nit:**`) when it is on a line the diff shows (`commentableLines`),
     and listed in the body otherwise, so GitHub never refuses the review.
     What is posted passes the central redactor.
  5. `review.posted` (new event: verdict, blocking and nit counts, the
     review's URL) records each one; the Activity Feed describes it and
     links the review.
  - A reviewer refused at its Token Cap puts the round back in the queue
    (`requeued`); no required reviewer, or no open pull request, raises an
    "Agent blocked" action Notice.
- **The work queue** now takes `needs-review` work too. A review round uses
  no sandbox, so it is not counted against, nor held back by, the
  office-wide sandbox limit; it is for no one Agent (`agentId` null), and
  waits while any of its Floor's required reviewers is paused at a Token
  Cap. `executeByStage` runs each stage's work by its own flow.
- **The coder flow** queues the review round when it moves the issue to
  `needs-review`; the server wires both flows.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (1292 passed, 240 skipped).
- [x] **Scenario test with a fake model: verdict parsed and posted;
      malformed output retried then escalated.**
      `packages/orchestrator/src/review/reviewer.test.ts` wires the real
      work queue (in memory), pipeline, Notices and event bus to the fake
      GitHub, with a fake model (`models/fake-model.ts`) standing in for the
      Gateway. The Floor's required reviewers are its starting reviewer
      (Claude, `claude-opus-5-5`) and a second on ChatGPT (`gpt-5.5`). Issue
      #1's pull request #2 adds `src/basket.ts` and changes `README.md`.
  - **Parsed and posted:** one reviewer answers in a code fence (approve,
    one nit, and a key-shaped string in its summary); the other answers
    changes requested with two blocking comments (one on a file outside the
    diff) and a nit. The test checks: each reviewer was asked once, as its
    own Agent, with its own Model, attributed to issue 1 and PR 2; the
    prompt has the quoted issue (whose `</issue>` cannot close the quote),
    the diff and the numbered file; two `COMMENTED` reviews by the App on
    the head commit, with the verdict, reviewer, AI Provider, Model and
    counts; three inline comments on the right files and lines, and the
    off-diff one in the body; the key-shaped string redacted; two
    `review.posted` events with counts and each review's URL; the issue
    held then let go, left at `needs-review`; each reviewer `working` then
    `idle`; no Notice.
  - **Retried:** "Looks good to me!" and a changes-requested verdict with no
    blocking comment are each sent back with the problem
    ("It has no JSON object.", "verdict: Changes requested needs at least
    one blocking comment…"); the second answers are posted.
  - **Escalated:** a reviewer answers prose, then `"verdict": "maybe"`. One
    action Notice, "Agent blocked: Quinta gave no valid verdict on PR #2
    (#1), twice. verdict: The verdict is "approve" or
    "changes_requested".", with the issue, pull request and reviewer; only
    the other reviewer's review is posted; the work `failed`; the issue let
    go at `needs-review`; the reviewer `blocked` with the reason.
  - Also: a reviewer refused at its Token Cap requeues the round with no
    Notice; no required reviewer raises a Notice and calls no model.
  - **Mutation check:** making the flow re-read the first answer instead of
    asking again failed the retry and escalation tests; reverted.

Also covered:

- `review/verdict.test.ts`: the three answer shapes; nits-only and empty
  approvals; ten malformed answers, each refused with its problem.
- `review/diff.test.ts`: commentable lines across hunks (context and added,
  not removed; `\ No newline`), one-line hunks, removed files; the unified
  diff's headers for added, removed and renamed files.
- `review/prompt.test.ts`: the answer's form and rules; quoting of issue,
  diff and files (in any letter case); cutting; no credential.
- `models/client.test.ts` (against a stand-in Gateway over HTTP): the
  Messages request with the Gateway Key, `anthropic-version` and
  attribution headers; the text joined from text blocks only; a 403 cap
  refusal as `ModelCallError` with the Gateway's message and no key; no
  Gateway Key, or an unreachable Gateway.
- `work/queue.test.ts`: review rounds start while the sandbox limit is
  full, for no Agent, and wait while a required reviewer is paused while
  another Floor's start; `ready-to-merge` and `needs-human` are refused.
- `coder/coder.test.ts`: the coder flow queues the review round when its
  pull request is ready, and not when it is blocked.
- `github`: `fake.test.ts` (files per commit, the pull request's files and
  patches, comments off the diff refused) and `contract.test.ts` (files,
  file text at a branch, commit and the default branch, a directory, an
  inline comment, a 422 off the diff, the review's URL).
- `web`: `activity-feed.test.tsx` describes `review.posted` and links its
  review; `events`: `schema.test.ts` parses it.

### Verified on the host

- [ ] **On `ai-office-sandbox`, a reviewer on a different AI Provider posts
      a review on an Agent's pull request.** Not verifiable here: it needs
      the GitHub App and `adrianeyre/ai-office-sandbox` (#18, an Owner
      action not done yet), an AI Account for each AI Provider, and Docker
      for the coder's sandbox. To check on the host: make the Floor's
      required reviewers a Claude and a ChatGPT (or Grok) reviewer, label
      an issue `ai-office`, and watch for two App reviews on its pull
      request, and `review.posted` in the Activity Feed.

## Not verifiable in this sandbox

- **Postgres** (Docker): the work queue's Postgres run of the new case
  ("starts review rounds whatever the sandbox limit…") and of the changed
  "only stages an Agent works" case are skipped here. The new `claimNext`
  SQL was rendered with Drizzle and read: `stage NOT IN (sandbox stages)`
  when the limit is full, and `stage <> 'needs-review' OR NOT
  (floors.required_reviewer_agent_ids && ARRAY[…]::text[])` for paused
  reviewers.
- **Real GitHub:** `pulls/{n}/files`, `contents/{path}?ref=`, inline review
  comments and a review's `html_url` against the real App (the contract
  suite's real-App target, skipped without `GITHUB_APP_ID`).
- **A real model through the Gateway:** a reviewer's Messages request
  served by a ChatGPT, Grok or Gemini AI Account (translated) or a Claude
  one. The Gateway's translation has its own tests, and the recorded
  provider fixtures are #45's.
- **Docker / the compose stack / a browser:** not used by this issue
  beyond the above.

## Notes, and disagreements with the canon

- **Reviewers' Context Usage.** FR-84 says reviewer calls are stateless and
  have none; none is recorded. The retry is the one exception to a single
  call: it sends the conversation so far (the prompt, the bad answer, why).
- **Subscription AI Accounts.** A reviewer's call comes from AI Office, not
  from an AI Provider's agent tool, so the Gateway never serves it from a
  subscription AI Account (FR-35): a reviewer needs an API-key AI Account
  of its AI Provider. That is FR-35 as written, not a change.
- **The issue is left at `needs-review` after a round.** What follows a
  round (back to the coder, on to QA, or the Round Cap) is the Review Loop,
  #55, out of scope here.
- **Comments off the diff** are kept in the review's body rather than
  refused: GitHub would refuse the whole review for one such comment, and
  the reviewer's point is still worth posting.
- **An issue already at `needs-review` before this change** has no queued
  review round; nothing queues one for it (intake leaves issues in the
  pipeline alone).

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  129 passed (129)
      Tests  1292 passed | 240 skipped (1532)
```

The new tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ src/review/reviewer.test.ts > the reviewer flow > asks each required reviewer for a verdict and posts each as an App review with inline comments
 ✓ src/review/reviewer.test.ts > the reviewer flow > sends an answer that is not a verdict back once, saying why, and posts the second
 ✓ src/review/reviewer.test.ts > the reviewer flow > escalates with an action Notice when the second answer is not a verdict either
 ✓ src/review/reviewer.test.ts > the reviewer flow > puts the round back in the queue when a reviewer is refused at its Token Cap
 ✓ src/review/reviewer.test.ts > the reviewer flow > raises an action Notice when no required reviewer can review
 ✓ src/review/verdict.test.ts > parseVerdict > (16 tests)
 ✓ src/review/diff.test.ts > commentableLines / unifiedDiff > (3 tests)
 ✓ src/review/prompt.test.ts > the reviewer's prompt > (5 tests)
 ✓ src/models/client.test.ts > gatewayModelClient > (3 tests)
 ✓ src/work/queue.test.ts > the work queue, in memory > starts review rounds whatever the sandbox limit, for no one Agent, holding them while a required reviewer is paused
 ✓ src/work/queue.test.ts > the work queue, in memory > queues an issue once per stage, and only stages an Agent works
 ✓ src/coder/coder.test.ts > the coder flow > turns a labelled issue into an App-opened pull request authored as the Owner, and raises a Notice
 ✓ github src/fake.test.ts > the fake GitHub's scenario API > keeps each commit's files, and compares a pull request's branches
 ✓ github src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > opens a pull request, reviews it, sees CI finish and merges it
 ↓ src/work/queue.test.ts > the work queue, in Postgres 18 > starts review rounds whatever the sandbox limit, … [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
```
