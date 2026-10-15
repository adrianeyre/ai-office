# Issue #251: [fix] P1-3 — An Agent's pull request that writes what later Agents read (.agents/MEMORY.md, a repository Skill, CLAUDE.md, AGENTS.md, .claude/settings.json) is merged by policy — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`31c1963`,
`fix(security): P1-3 a pull request that changes what later Agents read goes to the Owner`,
on top of P1-2's `b8d085b` (#249), whose file rules it extends. Its
blocker, the P1 probe (#194), is in the tree:
`docs/pen-testing/assessments/P1.md`,
`packages/orchestrator/src/merge/merge.pen-test.test.ts` and
`docker/pen-test/corpus.pen-test.test.ts`.

This is the remediation of finding **P1-3** (`severity:medium`, H9, H10).

## What was fixed

FR-53 says the repository's memory, `.agents/MEMORY.md`, changes only
through pull requests the Manager curates, which the Owner merges. FR-76
says a Skill reaches Agents only once the Owner has reviewed it. On an
auto-merge Floor, though, an Agent's own pull request that wrote the
memory, a repository Skill, `CLAUDE.md`, `AGENTS.md` or
`.claude/settings.json` was merged by policy like any other. Every later
Agent on the Floor then read it.

**Such a pull request now goes to the Owner, on any Floor:**

- P1-2's file rules (`merge/owner-only.ts`) gain a second rule,
  `readByAgents`. A pull request that changes what later Agents read as
  memory, Skills or their agent tool's instructions and settings goes to
  the Owner whatever its reviewers and CI say, and whatever its label:
  "PR #2 awaiting your approval: not merged automatically, as it changes
  what later Agents read as memory, Skills or instructions." One that
  also changes what CI runs gives both reasons.
- **What counts**, matched on every path the pull request changes, a
  renamed file's old path too, at any depth and in any case:
  - anything under `.agents/`: the memory and the repository's Skills.
    The rule is tied to `memoryPath` and `repositorySkillFolders` in
    `@ai-office/shared`, so it moves if they do;
  - anything under `.claude/` (settings, hooks, Skills, commands,
    subagents), `.codex/` or `.opencode/`;
  - every `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
    `AGENTS.override.md`, `.mcp.json`, `opencode.json` and
    `opencode.jsonc`.
- The guides say the same: `docs/guide/issue-pipeline.md` (The Merge
  Policy), `docs/guide/batches-and-memory.md` (Repository memory: "Only
  that way") and `docs/guide/notices-and-skills.md` (Repository Skills:
  "Never added by policy").

The Manager's own curation pull request (`ai-office/memory`) and a
Grilling Session's pull request never went through the Merge Policy.
The Owner merges both, so nothing about them changed.

### Sibling paths with the same flaw, fixed and tested

- **Every other file an agent tool reads as instructions or settings.**
  This covers a nested `CLAUDE.md` (Claude Code reads one in each folder
  it works in) and `CLAUDE.local.md`. It also covers a Claude Code Skill
  or slash command under `.claude/`, an MCP server in `.mcp.json`, and
  Codex's and opencode's settings, along with a lower-case `claude.md`.
  Tested: "P1-3: so is one that writes a nested CLAUDE.md, a Claude Code
  Skill or command, an MCP server, or Codex's or opencode's settings".
- **The memory moved out of the way** (a rename's old path). Tested in
  `owner-only.test.ts` ("names what later Agents read, beside what CI
  runs").
- **The Owner's `ai-office:auto-merge` label on a "send to me" Floor.**
  Tested: "P1-3: so is one the Owner labelled ai-office:auto-merge, on a
  send-to-me Floor".
- **E2's corpus.** Its `CLAUDE.md` and `.claude/settings.json`, together
  and each on its own. Its memory proposal and its Skill are tested too,
  written into the repository by an Agent's pull request rather than
  proposed. Tested in `corpus.pen-test.test.ts`: "P1-3: nor the corpus's
  memory proposal or Skill, written into the repository by an Agent's
  pull request".
- **Both rules together.** Tested: "P1-3: one that changes what CI runs
  and what Agents read says both".

## Decisions

- **Whole folders, not named files.** `.agents/`, `.claude/`, `.codex/`
  and `.opencode/` count whole, wherever they are. Each agent tool keeps
  adding files it reads there (hooks, commands, subagents, plugins), and
  none of them is the code an issue asks for.
- **Codex's and opencode's files count too**, although the probe named
  Claude Code's. AI Office runs all three in its sandboxes, and the
  finding is about what later Agents read, whichever tool they use.
- **To the Owner, not refused.** A pull request that rightly changes
  `CLAUDE.md` (an issue that asks for it, say) still lands, by the Owner's
  merge. The finding asks only that it never lands by policy.
- **The Notice names the rule, not the file**, as for P1-2: paths are
  text the work Agent writes (P1-6).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** All six
      are `it`s and pass, with their bodies unchanged: the five "is sent
      to the Owner, not merged by policy (<path>)" in
      `merge.pen-test.test.ts` (`.agents/MEMORY.md`,
      `.agents/skills/test/SKILL.md`, `.claude/settings.json`,
      `CLAUDE.md`, `AGENTS.md`), and "are sent to the Owner, not merged by
      policy, as every later Agent's agent tool reads them" in
      `corpus.pen-test.test.ts`.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
      - *"pins today: each is merged by the App: the repository's memory
        changes without the Manager's curation or the Owner's merge, and a
        Skill without the Owner's review"* is now "regression (P1-3): none
        is merged by the App any more: the repository's memory does not
        change without the Manager's curation and the Owner's merge, nor a
        Skill without the Owner's review". For each file it asserts the
        pull request is not merged and that the Notice gives the reason.
      - The corpus's *"pins today: the App merges them, as any approved
        pull request with passing CI"* is now "regression (P1-3): the App
        no longer merges them, together or each on its own, approved with
        passing CI".

      No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above, and `merge/owner-only.test.ts` ("what later Agents read
      (P1-3)", 21 paths that count and 6 that do not).
- [x] **The assessment's findings table marks `P1-3` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #251), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` has two failures, both in
      `@ai-office/web`, both failing before this fix and outside it (see
      below).

## Real output of the checks

The three checks were run on the branch head after this commit
(`31c1963`). The full output, and why the two failures are not these
fixes', is in [#247's note](issue-247.md#real-output-of-the-checks).
In short:

```
lint exit 0
typecheck exit 0
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  2 failed | 442 passed (444)
      Tests  2 failed | 4912 passed | 42 expected fail | 603 skipped (5559)
test exit 1
```

Both failures are the root `CHANGELOG.md`'s undated `## 1.0.0` entry,
and they failed the same way before any fix (at `1bb3183`). No test was
skipped, deleted or weakened to reach this state.

### The probe and the rules on their own (P1-3's tests)

```
# vitest run merge.pen-test.test.ts corpus.pen-test.test.ts owner-only.test.ts --reporter=verbose
✓ owner-only.test.ts > what later Agents read (P1-3) > is the repository's memory and Skills, and every agent tool's instructions and settings, at any depth and in any case
✓ owner-only.test.ts > what later Agents read (P1-3) > is not the code, the tests or other documentation
✓ owner-only.test.ts > ownerOnly > names what later Agents read, beside what CI runs
✓ corpus.pen-test.test.ts > P1-3: the corpus's CLAUDE.md and .claude/settings.json, in an Agent's pull request > are sent to the Owner, not merged by policy, as every later Agent's agent tool reads them
✓ corpus.pen-test.test.ts > P1-3: the corpus's CLAUDE.md and .claude/settings.json, in an Agent's pull request > regression (P1-3): the App no longer merges them, together or each on its own, approved with passing CI
✓ corpus.pen-test.test.ts > P1-3: the corpus's CLAUDE.md and .claude/settings.json, in an Agent's pull request > P1-3: nor the corpus's memory proposal or Skill, written into the repository by an Agent's pull request
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > is sent to the Owner, not merged by policy (.agents/MEMORY.md)
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > is sent to the Owner, not merged by policy (.agents/skills/test/SKILL.md)
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > is sent to the Owner, not merged by policy (.claude/settings.json)
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > is sent to the Owner, not merged by policy (CLAUDE.md)
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > is sent to the Owner, not merged by policy (AGENTS.md)
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > regression (P1-3): none is merged by the App any more: the repository's memory does not change without the Manager's curation and the Owner's merge, nor a Skill without the Owner's review
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > P1-3: so is one that writes a nested CLAUDE.md, a Claude Code Skill or command, an MCP server, or Codex's or opencode's settings
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > P1-3: so is one the Owner labelled ai-office:auto-merge, on a send-to-me Floor
✓ merge.pen-test.test.ts > P1-3: a pull request that writes what later Agents read as memory, Skills or instructions > P1-3: one that changes what CI runs and what Agents read says both
 Test Files  5 passed (5)
      Tests  84 passed (84)
```

(The last two lines are the whole run of the five files: these three,
`gate.test.ts` and `pipeline.test.ts`.)

## What could not be verified here

- **Claude Code, Codex and opencode reading these files.** That each
  reads the files listed is their documented behaviour, not seen here (no
  live agent tool). On the pen-test stack: an Agent's pull request
  carrying the corpus's `claude-settings` item, on an auto-merge Floor,
  should end with "… not merged automatically, as it changes what later
  Agents read as memory, Skills or instructions."

## Noticed, out of scope

- **The same files reach later Stages of the same issue without any
  merge.** QA, docs and the designer work on the issue's own branch.
  Their sandboxes' repository Skills are read from that clone
  (`floorSkills.forSandbox`), and their agent tool starts in it. So a
  Skill, `CLAUDE.md` or `.claude/settings.json` the coder commits reaches
  them before the Merge Policy is ever asked. That is P1-9's (the
  repository configures the agent tool) and P1-10's (a repository Skill
  is unreviewed), each with its own remediation.
