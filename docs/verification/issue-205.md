# Issue #205: [pen-test] P2 — The Manager chat's agent session, Contractors and chat Batches — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no live model, no EC2, no network beyond the registry and the
model). The probe was assessed at commit `3c081be` (the branch head; the
worktree was clean). `pnpm lint`, `pnpm typecheck` and `pnpm test` were run
with the probe's tests and assessment present.

This issue is a **probe**, not a fix: it answers H18, produces an
assessment and committed probe tests, and changes no production code.

## What was produced

- **Assessment** `docs/pen-testing/assessments/P2.md`. It has a verdict on
  every "What to probe" bullet (read-only really; injection to action;
  authority limits; exfiltration; attachments; `@` file mentions; host-side
  git on the read-only clone) and the commit it was assessed at. Its
  Findings table (P2-1…P2-4) gives each finding's one-line statement,
  attacker position, hypothesis, claimed severity against the PRD's
  definitions, probe tests, and what the fix must make true. The index
  (`docs/pen-testing/README.md`) lists P2 (and the A1/S1/S2 assessments its
  table had left unlisted).
- **Five probe test files**, beside the code they probe:
  - `packages/orchestrator/src/models/agent-tool-session.pen-test.test.ts`:
    the session's Bash allow-rules modelled as Claude Code matches them,
    real `git diff --no-index`/`--output` showing reads outside the clone
    and writes, and the Gateway Key in the session's environment (P2-1,
    P2-2).
  - `packages/orchestrator/src/manager/requests.pen-test.test.ts`: the real
    `createChatRequests().batch()` driven with a `batch` decision, showing a
    filed issue, an added Contractor and a started Batch with no approval
    and the one-off Role's instructions verbatim; and the authority limits
    (P2-3, P2-4).
  - `packages/orchestrator/src/manager/chat-sessions.pen-test.test.ts`: the
    real `dockerSessionTool` against a local bare repository, showing the
    read-only clone mount and that `refresh` runs none of a hostile `.git`'s
    programs.
  - `apps/server/src/manager-chat/routes.pen-test.test.ts`: the real Fastify
    app serving an XML attachment holding script markup as an inert
    download, and cross-Floor attachment isolation.
  - `packages/orchestrator/src/manager/repository-files.pen-test.test.ts`:
    the real `createChatRepositoryFiles`, showing `@` mention path checks.

### The findings

| ID | Statement | Severity |
|---|---|---|
| P2-1 | Allowed `git diff --no-index` reads any file in the container, including the Gateway Key at `/proc/self/environ` and the private clone; `WebFetch` sends it out (H18) | high |
| P2-2 | Allowed `git diff --output`/`git log --output` write any file in the container, including the persistent tool-home mount (H18) | medium |
| P2-3 | A chat Batch files issues, adds Contractors and starts work on one Model decision, with no Owner approval and nothing binding it to the Owner's request (H18) | high |
| P2-4 | A one-off Contractor Role's instructions reach a work-Stage Contractor verbatim, enabled without the review ADR 0003 requires (H18) | high |

What holds, each kept holding by a plain `it`:

- The clone is mounted read-only, so the session cannot write its own
  `.git`; the host-side `refresh` runs none of a hostile `fsmonitor`,
  `hooksPath` or `post-commit` hook (the S1 fix covers the Manager's clone).
- Project/local settings and MCP config in the clone are not read
  (`--setting-sources user`, `--strict-mcp-config`, explicit disallowed
  write tools; Codex `--sandbox read-only`).
- The Manager's authority is confined to filing issues and adding or
  releasing Contractors; merge, a settings change and a cap raise are
  refused through the chat and the Manager's GitHub client.
- A Manager-filed issue is authored by the App, so intake ignores it; it
  enters work only through its Batch.
- Attachments: images checked by magic bytes; SVG and HTML not allowed;
  served with `Content-Disposition: attachment` for text, `nosniff`, a
  `sandbox` CSP and `same-origin` CORP; isolated to their Floor; the image
  path inside the container cannot traverse out.
- `@` mentions reject traversal, absolute and `.`-segment paths and read
  through the GitHub App against the Floor's own repository.
- The session's environment carries no GitHub token and no AI Account
  credential, only the Gateway Key.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      `P2.md` has a section per bullet, each with a verdict (FINDING /
      HOLDS / NO) for every item it names.
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.** There are four `it.fails` (P2-1, P2-2,
      P2-3, P2-4), each beside a passing pin, and the table names the file
      and test. Each `it.fails` was flipped to `it` once by hand to see it
      fails on its own assertion — four `AssertionError`s (`expected true to
      be false` ×3 and `expected [ … ] to have a length of +0 but got 1`) —
      then put back.
- [x] **Nothing in production code changes.** The staged diff is only the
      five `*.pen-test.test.ts` files, `P2.md` and the index row in
      `docs/pen-testing/README.md`:

  ```
  A  apps/server/src/manager-chat/routes.pen-test.test.ts
  M  docs/pen-testing/README.md
  A  docs/pen-testing/assessments/P2.md
  A  packages/orchestrator/src/manager/chat-sessions.pen-test.test.ts
  A  packages/orchestrator/src/manager/repository-files.pen-test.test.ts
  A  packages/orchestrator/src/manager/requests.pen-test.test.ts
  A  packages/orchestrator/src/models/agent-tool-session.pen-test.test.ts
  ```
- [x] **`pnpm lint`, `pnpm typecheck` pass; `pnpm test`.** See below. Every
      probe test passes. The two `pnpm test` failures are pre-existing, the
      same two #192/#193 recorded, and outside the probe's diff.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck`: exit 0

```
packages/orchestrator typecheck: Done
apps/server typecheck: Done
apps/web typecheck: Done
e2e typecheck: Done
```

### `pnpm test`: the probe's tests pass; the suite carries two pre-existing failures

```
 Test Files  2 failed | 427 passed (429)
      Tests  2 failed | 4769 passed | 34 expected fail | 600 skipped (5405)
   Duration  157.01s
```

The **34 expected fail** are A1's 18, S2's 12 and this probe's 4 (P2-1,
P2-2, P2-3, P2-4). They pass by failing, as the findings workflow intends.
The skips are the Postgres and Docker tests, skipped with their reason in
this sandbox. **Neither failure is in a file this probe added.** Both are in
`@ai-office/web` and read the root `CHANGELOG.md`, whose top entry is
`## 1.0.0` with no release date while the tests expect `1.0.0 (YYYY-MM-DD)`:

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/
```

The changelog came from main (`3ca0165 docs: Changelog`); this probe
changes neither it nor `apps/web`. No test was skipped, deleted or weakened
to reach this state.

The four probe projects run green on their own:

```
# vitest run of the five probe files
 Test Files  5 passed (5)
      Tests  17 passed | 4 expected fail (21)
```

## What could not be exercised here

- **The injection-to-decision step itself** (hostile content steering the
  Manager's Model to emit a `batch` decision) needs a live model; the
  mechanism after the decision is pinned deterministically. On the pen-test
  stack, position 2 with the hostile-content corpus (E2) would drive a real
  Claude Code/Codex session and show a planted instruction producing a
  filed-and-started Batch.
- **The container-side read and write** (`git diff --no-index
  /proc/self/environ`, `--output` into the tool home) were shown with real
  git on this host and with the flags and environment AI Office passes, not
  from inside a live session in a Docker sandbox. Position 3's harness would
  run them on the stack.
- **WebFetch egress** reaching a red-team host is S2-1's exercise; here only
  that `WebFetch` is an allowed tool was pinned.
