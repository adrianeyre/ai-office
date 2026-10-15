# Issue #58: Docs Agent stage — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's code commits (`1643a08`,
`7a59d25`).

## What was built

- **The docs flow** (`createDocsFlow`,
  `packages/orchestrator/src/docs/docs.ts`; PRD FR-18, FR-19). Work at
  `needs-docs` is done by the Floor's docs Agent (the work queue already
  assigned `needs-docs` work to the `docs` Role) in a sandbox on the pull
  request's branch:
  - it holds the issue and takes the Handoff left for it (QA's, or the
    reviewers' on a Floor without QA), emitted as a `handoff` event and
    quoted in its prompt;
  - its prompt (`docsPrompt`) asks it to read the branch's diff from the
    default branch, update the README where the change affects it, add a
    changelog entry if the repository keeps one, add or update the
    docstrings of the code the change adds or changes, change
    documentation only, commit as `docs` commits, and end with a
    `<handoff>` block;
  - what it committed is pushed by AI Office as the Owner's commits with
    its `Agent:` trailer (`createPushRun`), on the same branch;
  - the issue then moves `needs-docs → ready-to-merge`, with its Handoff
    (`docsHandoff`: its own words, filled in from its commits and the
    Handoff it took). A run that changes nothing still moves on.
  - A failed run blocks the Agent with an action Notice, leaving the issue
    at `needs-docs`; a docs Agent paused at a Token Cap keeps what it
    committed and its work waits; an archived Floor's work stops.
- **A small Model by default:** a docs Agent added without a Model of its
  own gets its AI Provider's small Model as its override (`smallModels` and
  `roleDefaultModel` in `@ai-office/shared`: `claude-haiku-5-5` for Claude;
  the AI Provider's default where none is known). The Owner changes it in
  the Agent editor like any other.
- **Skipping:** `stageAfter` (from #57) sends a pull request past
  `needs-docs` when the Floor has no docs Agent; with one, QA's pass (or
  the reviewers' approval, without QA) queues the docs Agent's work.
- The server runs the docs flow for `needs-docs` work.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason (1349 passed, 244 skipped).
- [x] **Scenario tests: with and without a docs Agent.**
      `packages/orchestrator/src/docs/docs-loop.test.ts`, end to end through
      intake, the coder, both reviewers, QA and docs from one work queue,
      with real Sandcastle `run()` in the fake sandbox (scripts stand in for
      each Agent's Claude Code) and a local bare repository as GitHub's
      remote:
  - **With a docs Agent:** the docs Agent's Model is `claude-haiku-5-5`; it
    ran once, after QA, with a prompt naming pull request #2, the diff
    command, the README, changelog and docstrings, "documentation only" and
    QA's Handoff; its `docs: the basket` commit is on the branch after the
    coder's, with the trailer `Agent: Dora (docs, Claude
    claude-haiku-5-5)`, and the branch's README has its text; `branch.pushed`
    by the coder then the docs Agent; the issue at `ready-to-merge`
    through `needs-qa → needs-docs → ready-to-merge`; one `handoff` QA →
    docs; its Handoff kept for `ready-to-merge`; no action Notice; four work
    items, all finished.
  - **With a docs Agent but no QA Agent:** `needs-review → needs-docs →
    ready-to-merge`, the reviewers' Handoff to the docs Agent.
  - **Without a docs Agent:** no docs run; `needs-qa → ready-to-merge`; only
    the coder's commit on the branch.
  - **Mutation checks** (each reverted): making `stageAfter` look for
    another Role than docs failed both scenarios with a docs Agent; making
    it find one on every Floor failed the scenario without.

Also covered: `docs/docs.test.ts` (the prompt's asks, its trailer and
Handoff form; the issue and the Handoff it takes quoted so neither can close
its quote; the docs Handoff from its own words, or filled in, or "Nothing
needed documenting."), and `agents/agents.test.ts` (a docs Agent gets the
small Model unless it is given one; an AI Provider without a known small
Model, and other Roles, use the default).

## Not verifiable in this sandbox

- **Docker sandboxes and a real agent tool:** a docs Agent on a real Claude
  Haiku account actually editing a README, changelog and docstrings.
- **Real GitHub** (#18): the docs commits pushed to a real pull request.
- **Postgres** (Docker): the Postgres run of the Agents tests (including
  the new small-Model case) is skipped here with the reason.

## Notes, and disagreements with the canon

- **"A small Model by default"** is applied when a docs Agent is created
  without a Model of its own, as its `modelOverride`. There is no API to add
  Agents yet (team size, FR-10, is later work), so today docs Agents come
  from `createAgents().add`. Only Claude has a known small Model; other AI
  Providers' docs Agents use their default Model until the Owner chooses.
- **No docs Agent in the default team.** FR-10's Development template is a
  Manager, a coder, a reviewer and a QA Agent, so a new Floor skips docs
  until a docs Agent is added.
- **Docs commits are not reviewed again**; what happens at
  `ready-to-merge` is the Merge Policy's (a later issue).
- **Repository memory** (#87) is out of scope.

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
 Test Files  139 passed (139)
      Tests  1349 passed | 244 skipped (1593)
```

The new tests (`vitest run --reporter=verbose`, excerpt):

```text
 ✓ |@ai-office/orchestrator| src/docs/docs.test.ts > the docs Agent's prompt > asks for the README, the changelog and docstrings, documentation only, and a Handoff
 ✓ |@ai-office/orchestrator| src/docs/docs.test.ts > the docs Agent's prompt > quotes the issue and the Handoff it takes so neither can close its quote
 ✓ |@ai-office/orchestrator| src/docs/docs.test.ts > docsHandoff > takes the docs Agent's own words
 ✓ |@ai-office/orchestrator| src/docs/docs.test.ts > docsHandoff > fills in from its commits and the Handoff it took, or says nothing needed documenting
 ✓ |@ai-office/orchestrator| src/agents/agents.test.ts > Agents, kept in memory > gives a docs Agent its AI Provider's small Model, unless it is given one
 ↓ |@ai-office/orchestrator| src/agents/agents.test.ts > Agents, kept in Postgres 18 > gives a docs Agent its AI Provider's small Model, unless it is given one 0ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ |@ai-office/orchestrator| src/docs/docs-loop.test.ts > the docs stage > documents the change on the pull request's branch with a small Model, then moves the issue to ready-to-merge
 ✓ |@ai-office/orchestrator| src/docs/docs-loop.test.ts > the docs stage > follows review directly on a Floor with a docs Agent but no QA Agent
 ✓ |@ai-office/orchestrator| src/docs/docs-loop.test.ts > the docs stage > is skipped on a Floor without a docs Agent
```
