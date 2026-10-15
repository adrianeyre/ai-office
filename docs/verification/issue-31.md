# Issue #31: Batched progress comments on issues — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, Git
2.39.5, no Docker) on this branch, after the issue's last code commit.

## What was built

- **Editing a comment** (`packages/github`).
  `RepositoryClient.updateComment(commentId, body)` (GitHub's `PATCH
  /repos/{owner}/{repo}/issues/comments/{id}`) is on the App client, the
  fake GitHub and the fake's HTTP server. The contract suite holds all
  three to the same behaviour: the body is replaced in place under the
  same id and author, and an unknown id is a 404.
- **Progress comments** (`createProgressComments` in
  `packages/orchestrator/src/progress/progress.ts`). `start(subject)`
  begins one issue's comment, and `finish(summary)` ends it.
  - **What it says:**
    - the stage, and the Agent (name and Role) with a link to its live
      view (`/floors/<floor>/agents/<agent>` at `PUBLIC_URL`);
    - how many steps it has taken, and the last five. The steps are its
      `sandbox.tool_call`, `sandbox.diff` and `sandbox.text` events, from
      the event bus, filtered to that Agent and issue.
    - when the work ends, a final summary: the pull request (opened or
      updated) and the new stage, why the Agent is blocked, or that AI
      Office stopped.
  - **One comment, edited in place.** It is created at the start. A
    comment that starts with `<!-- ai-office:progress -->` from earlier
    work on the issue is edited instead.
  - **At most once a minute.**
    - A step marks the comment as changed, and a timer writes it once a
      minute has passed since the last write.
    - Writes are serialised, and the minute is checked again just
      before each one. So even when GitHub is slow, or steps arrive
      while a write is in flight, two writes never start less than a
      minute apart.
    - Quiet work is not rewritten.
    - The final summary waits for its minute too, in the background:
      the work never waits for it.
    - `stop()` (when AI Office stops) writes whatever is pending at
      once.
  - **Safety:**
    - Step and reason text is one line in a code span, without
      backticks, so issue-borne text cannot add mentions or Markdown.
    - The whole comment is redacted with the server's redactor before
      it is written.
    - A write GitHub refuses is reported to `onError` and never stops
      the work.
- **The coder flow** (#30) starts a progress comment for each issue it
  works, and finishes it with the pull request, the "blocked" reason, or
  "stopped" on cancellation. The server creates the progress comments
  (with the shared redactor and `PUBLIC_URL`) and stops them after the
  work queue on shutdown.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm test` was green twice in a row.
- [x] **Scenario test: fifty events produce one comment with at most
      one edit per minute.**
      `packages/orchestrator/src/progress/progress.test.ts` uses Vitest's
      fake timers and clock, a real event bus and the fake GitHub. A
      wrapper notes the time of every comment it creates or edits.
      - **Fifty events, one every three seconds (2.5 minutes), then the
        final summary:**
        - The issue has exactly one comment, created once (at 0 s), then
          edited at 60 s, 120 s and 180 s. No two writes are less than a
          minute apart.
        - The final body has the marker, "AI Office finished working on
          this issue", the stage `needs-review`, the Agent with its
          live-view link, the pull request, "Steps taken: 50", and steps
          46 to 50 (not 45).
        - A later event writes nothing.
      - **Fifty events in a burst:** nothing more is written until
        exactly 60 s, then one edit shows all 50. Ten quiet minutes
        write nothing more.
      - **A slow GitHub** (20 s per write) while 100 steps arrive one a
        second: writes start at 0 s, 60 s and 120 s only.
      - **Mutation check:** with the minute set to 0, five of the eight
        tests fail, the fifty-events test among them. I restored it.
      - **Also covered:**
        - other Agents' and other issues' events are ignored;
        - an earlier run's progress comment is edited, not duplicated;
        - the blocked summary is redacted (a registered secret and a
          `ghp_` token are not written), and backticks are neutralised;
        - a refused write is reported and the work goes on;
        - `stop()` writes the pending summary at once.
      - **End to end:** `coder/coder.test.ts` (#30's scenario) now also
        checks that after the run the issue has exactly one comment, by
        the App. It holds the final summary with the pull request link,
        the live-view link and the Agent's `Bash pnpm test` step. A
        blocked run's comment says why it is blocked.
      - **Contract:** "edits a comment in place, by its id" passes
        against the fake and against the real App client over the fake's
        HTTP.

## Not verifiable in this sandbox

- **Real GitHub:** the contract suite's real-App run of
  `updateComment` (skipped without `GITHUB_APP_ID`; it needs #18's App
  and `ai-office-sandbox`), and how GitHub renders the comment.
- **A real Agent's progress** on a real issue needs Docker and the App,
  as for #30.

## Notes

- **How the minute is counted.** It runs from when each write starts.
  The comment's creation counts as its first write, so the first edit
  comes at least a minute after it.
- **The final summary can lag by up to a minute.** It respects the same
  limit, so it can appear up to a minute after the pull request opens.
  The only exception is when AI Office stops: then the pending edit is
  written at once rather than lost.
- **A process restart forgets the timer.** The comment's id is found
  again by its marker, but the minute is counted afresh. So an edit
  could follow one made just before the restart by less than a minute.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test` (tail):

```text
 Test Files  74 passed (74)
      Tests  724 passed | 104 skipped (828)
```

The new and extended tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ src/contract.test.ts > the GitHub contract, against the in-memory fake GitHub > edits a comment in place, by its id
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > edits a comment in place, by its id
 ↓ src/contract.test.ts > the GitHub contract, against the real App > edits a comment in place, by its id
 ✓ src/progress/progress.test.ts > progress comments > turns fifty events into one comment, edited at most once a minute
 ✓ src/progress/progress.test.ts > progress comments > shows a burst of steps a minute later, in one edit
 ✓ src/progress/progress.test.ts > progress comments > waits a minute after a slow write before the next, whatever arrives meanwhile
 ✓ src/progress/progress.test.ts > progress comments > follows only its own Agent and issue
 ✓ src/progress/progress.test.ts > progress comments > edits the issue's progress comment from an earlier run instead of adding one
 ✓ src/progress/progress.test.ts > progress comments > says why the Agent is blocked, writing no credential
 ✓ src/progress/progress.test.ts > progress comments > keeps the work going when GitHub refuses a write
 ✓ src/progress/progress.test.ts > progress comments > writes what is pending at once when AI Office stops
 ✓ src/coder/coder.test.ts > the coder flow > turns a labelled issue into an App-opened pull request authored as the Owner, and raises a Notice
 ✓ src/coder/coder.test.ts > the coder flow > raises an action Notice when the Agent commits nothing, letting the issue go
```
