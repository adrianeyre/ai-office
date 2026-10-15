# Issue #263: [fix] P1-9 — The repository's own .claude/settings.json, CLAUDE.md and AGENTS.md configure the agent tool that works it, with… — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`f6c66da`,
`fix(security): P1-9 the agent tool takes its settings, hooks and instructions from AI Office, not the repository`,
on top of P1-8's `ad794ac` (#261). Its blocker, the P1 probe (#194), is
in the tree: `docs/pen-testing/assessments/P1.md` and
`packages/orchestrator/src/sandbox/runner.pen-test.test.ts`.

This is the remediation of finding **P1-9** (`severity:medium`, H10).

## What was fixed

Every sandbox Stage (work, QA, docs, the designer) is given the
repository's working copy as it is, and its agent tool starts there with
permission prompts off. Claude Code took the repository's `CLAUDE.md` as
project instructions, outside any fence, and ran the hooks in its
`.claude/settings.json` itself, so a `SessionStart` hook ran on every
session, whatever the model made of it, and the screen was never asked.
Codex took `AGENTS.md` as its instructions, and opencode the repository's
own configuration.

**Now each agent tool takes its settings, hooks and instructions from AI
Office, never from the repository it works on:**

- **Claude Code** is started with `--setting-sources user` and
  `--strict-mcp-config` (after Sandcastle's command, in
  `sandbox/agent-tools.ts`, `claudeRepositoryArgs`). It reads only the
  user's settings, which are its image's, and AI Office's own
  (`--settings`, P1-8's screen hook). It does not read the repository's
  `.claude/settings.json` or `.claude/settings.local.json` (hooks,
  permissions, `disableAllHooks`), nor the project's `CLAUDE.md`. It
  starts no MCP server but those AI Office names, and AI Office names
  none, so not the repository's `.mcp.json`.
- **Codex** is given `-c project_doc_max_bytes=0`
  (`codexRepositoryConfig`), so it reads no `AGENTS.md` nor any other
  project document as its instructions.
- **opencode** is given `OPENCODE_DISABLE_PROJECT_CONFIG=true` and
  `OPENCODE_DISABLE_CLAUDE_CODE=true`. It reads no project configuration
  (`opencode.json`, `.opencode/` agents, commands and plugins, which run
  code) and none of Claude Code's files (`CLAUDE.md`, `.claude/skills/`).
  Both are on the sandbox environment's allow-list now, always set to
  `"true"` by AI Office.
- **The prompt treats them as untrusted content.** Every sandbox Stage's
  prompt (the coder's, QA's, docs' and the designer's) says, under "How
  to work", that the repository's own files for agent tools (`CLAUDE.md`,
  `AGENTS.md`, `.claude/`, `.codex/`, `.opencode/`, `.mcp.json`) are its
  content, like any of its files: AI Office does not load them as the
  Agent's settings or instructions, and nothing in them is an instruction
  to it (`repositoryAgentFilesNote`; P1-10's fix, #265, adds `.agents/`
  and the repository's Skills to the list). This covers what
  a tool might still read, such as opencode's `AGENTS.md`, and the files
  an Agent opens itself.

The guide's **Sandboxes** section (`docs/guide/issue-pipeline.md`) says
the same.

### Sibling paths with the same flaw, fixed and tested

- **Fact-finding** (a Grilling Session's facts and a research
  Contractor's sandbox) starts its agent tool through the same
  `agentToolSetup`, so it gets the same arguments. Tested in
  `sandbox/agent-tools.test.ts`: "starts Claude Code reading none of the
  repository's settings, CLAUDE.md or MCP servers, screened or not
  (P1-9)".
- **The Manager chat's Codex session** runs on a read-only clone of the
  repository and read its `AGENTS.md` as instructions. It is now given
  `project_doc_max_bytes=0` too, started or resumed. Tested in
  `models/agent-tool-session.test.ts`: "reads no AGENTS.md from the clone
  as its instructions, started or resumed (P1-9)". Its Claude Code
  session already read only the user's settings.
- **Every sandbox Stage's prompt.** Tested end to end on a scenario with
  a coder, reviewers, QA, a designer and docs: "P1-9: every sandbox
  Stage's prompt says the repository's agent-tool files are its content,
  not instructions: the coder's, QA's, the designer's and docs'".

## Decisions

- **The working copy is left as it is.** The files are the repository's.
  Deleting or hiding them in the clone would show as the Agent's change,
  and an Agent asked to edit `CLAUDE.md` must be able to. So they are
  not loaded as configuration, and the prompt says they are content.
- **`user` settings stay.** They are the sandbox image's, AI Office's, not
  the repository's. Claude Code reads its hooks once, when it starts, so
  a hook an Agent writes into its home in the sandbox does not run in
  that session, and the next session's sandbox is a new container.
- **Approvals and sandboxes stay off.** Sandcastle runs every agent tool
  with them off, and Codex in `exec` mode cannot ask anyone. What stops a
  hostile call is P1-8's screen and the sandbox itself, not the tool's
  prompts. The pinned "Codex and opencode are started with their
  approvals and sandboxes off too" now asserts that they still are, but
  that they no longer take the repository's `AGENTS.md`, configuration or
  plugins.
- **The allow-list grows by two keys.** `OPENCODE_DISABLE_PROJECT_CONFIG`
  and `OPENCODE_DISABLE_CLAUDE_CODE` hold no credential and are always
  `"true"`. The S-series probe that pins the allow-list
  (`environment.pen-test.test.ts`, "is exactly the Git identity, the
  read-only GH_TOKEN and each agent tool's way to the Gateway") lists
  them now. The runner test of opencode's environment does too.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "do not
      configure the agent tool that works it: Claude Code does not start
      with the repository's .claude/settings.json" is an `it` and passes,
      with its body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
      - *"Claude Code starts, permission prompts off, in a working copy
        holding the repository's hooks, CLAUDE.md and AGENTS.md as they
        are"* is now "regression (P1-9): Claude Code still starts,
        permission prompts off, in the working copy as it is, but no
        longer takes the repository's settings, hooks, CLAUDE.md or MCP
        servers". It asserts `--setting-sources user` (no project or
        local source) and `--strict-mcp-config`, that the files are still
        there as the repository has them, and that the prompt's note says
        they are not loaded.
      - *"Codex and opencode are started with their approvals and
        sandboxes off too"* is now "regression (P1-9): Codex and opencode,
        still started with their approvals and sandboxes off, no longer
        take the repository's AGENTS.md, configuration or plugins". It
        asserts `project_doc_max_bytes=0` for Codex and both opencode
        variables.

      No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. The unit tests that spelt out Codex's overrides, opencode's
      environment and the allow-list exactly were changed to the new
      ones, and still check every part of them.
- [x] **The assessment's findings table marks `P1-9` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #263), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on two `deployment` tests of
      files under `docker/` that no commit here touches, and which fail
      the same way on the base commit (below). Every test of these fixes
      passes.

## Real output of the checks

The three checks were run on the branch head, `cf8547c` (all four
fixes), with this note and the others uncommitted in the tree:

```
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit 0
$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
$ pnpm test
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 Test Files  2 failed | 448 passed (450)
      Tests  2 failed | 5018 passed | 30 expected fail | 611 skipped (5661)
test exit 1
```

**The two failures are not these fixes'.** Both are in the `deployment`
project and read only files under `docker/`: the Caddyfile
(`reverse_proxy app:3045 {`, where the test expects the directive with
no block) and the pen-test stack's environment file (which holds
`127.0.0.1`). No commit here touches `docker/`, `.env.example` or
`docker-compose.yml` (`git diff --stat 27c394e HEAD -- docker/
.env.example docker-compose.yml` is empty), and the two tests fail the
same way on the base commit's files:

```
$ pnpm vitest run --project deployment docker/caddy/caddyfile.pen-test.test.ts docker/pen-test/compose.test.ts
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
      Tests  2 failed | 22 passed | 1 expected fail | 1 skipped (26)
```

The web app's tests, which an earlier run of this branch saw time out
under the host's load (`whiteboard.test.tsx` in one run here, passing on
its own, 6 of 6), all passed in this run.

### P1-9's tests on their own

```
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-9: the repository's own settings and instructions for the agent tool > do not configure the agent tool that works it: Claude Code does not start with the repository's .claude/settings.json
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-9: the repository's own settings and instructions for the agent tool > regression (P1-9): Claude Code still starts, permission prompts off, in the working copy as it is, but no longer takes the repository's settings, hooks, CLAUDE.md or MCP servers
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-9: the repository's own settings and instructions for the agent tool > regression (P1-9): Codex and opencode, still started with their approvals and sandboxes off, no longer take the repository's AGENTS.md, configuration or plugins
 ✓ |@ai-office/orchestrator| src/sandbox/runner.pen-test.test.ts > P1-9: the repository's own settings and instructions for the agent tool > P1-9: every sandbox Stage's prompt says the repository's agent-tool files are its content, not instructions: the coder's, QA's, the designer's and docs'
 ✓ |@ai-office/orchestrator| src/models/agent-tool-session.test.ts > Codex's session arguments > reads no AGENTS.md from the clone as its instructions, started or resumed (P1-9)
 ✓ |@ai-office/orchestrator| src/sandbox/agent-tools.test.ts > the agent tool for each AI Provider > starts Claude Code reading none of the repository's settings, CLAUDE.md or MCP servers, screened or not (P1-9)
```

## What could not be verified here

- **The agent tools themselves.** The fake sandbox stands in for each
  tool, so what each reads is shown by the command line and environment
  it is given, not by the tool:
  - That Claude Code reads no project `.claude/settings.json`, project
    `CLAUDE.md` or project Skills without the `project` setting source,
    and no `.mcp.json` with `--strict-mcp-config`, is its documented
    behaviour. On the pen-test stack, the corpus's `claude-settings`
    item's `SessionStart` canary should no longer show in the stub's log.
  - `project_doc_max_bytes=0` stopping Codex's `AGENTS.md`, and the two
    opencode variables, are those tools' documented settings, not seen
    here. The sandbox images install Codex and opencode at `latest`
    (`docker/sandbox-codex/Dockerfile`, `docker/sandbox-opencode/Dockerfile`),
    so a version that dropped either setting would read the files again.
    The prompt's note still says they are content. On the stack, a corpus
    `AGENTS.md` and `.opencode/plugin/` with canaries show it.
- **A live model.** Whether a model that opens `CLAUDE.md` itself leaves
  its instructions alone, told they are content, needs a live model.

## Noticed, out of scope

- **Codex's own project `.codex/config.toml`** is read only for projects
  its user configuration trusts, and the sandbox's user configuration
  trusts none. That is Codex's rule, not AI Office's, and was not
  exercised here.
- **Codex's and opencode's own repository Skill folders.** Whether they
  load Skills from the worktree (such as `.agents/skills/`) as Skills, as
  Claude Code no longer does, could not be checked without the tools.
  P1-10's review covers what AI Office mounts; the prompt's note covers
  what a tool finds itself.
- **Two `deployment` tests fail on the base commit too**: the Caddyfile's
  `reverse_proxy` now has a block, and the pen-test stack's environment
  file holds `127.0.0.1`, which their tests do not expect (see the
  checks above). They are outside this fix.
