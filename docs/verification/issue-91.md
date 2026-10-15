# Issue #91: Repository Skills, overrides and sandbox mounting — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `599b89b` (every code commit of the issue and the
README).

## What was built

- **The GitHub client** (`packages/github`): `RepositoryClient.listDirectory(path, ref)`
  answers what a directory holds (each entry's name, path and type: file,
  dir, symlink or submodule), or `undefined` for a file or nothing. The
  real client reads GitHub's contents API; the fake and its HTTP server
  answer it the same way, and the contract suite checks it against both.
- **Shared schemas** (`packages/shared`, `skills.ts`):
  `repositorySkillFolders` (`.agents/skills`, then `.claude/skills`),
  `sandboxRoles` (coder, QA, docs, designer: the Roles whose Agents work
  in sandboxes), `floorSkillSchema`, `floorSkillListSchema`,
  `floorSkillToggleSchema`, and the error code `not_sandbox_role`.
- **`floor_skill_toggles`** (`packages/db`, migration
  `0032_floor_skill_toggles`): a Skill (by name) on or off for one Role on
  one Floor. A Skill is on until a row turns it off. Checks keep the Role to
  the sandbox Roles and the name to a Skill name.
- **Repository Skills** (`packages/orchestrator/src/skills/repository.ts`):
  `discoverRepositorySkills(reader)` finds one Skill per folder under
  `.agents/skills/` and `.claude/skills/`, checked with the library's own
  `skillProblems` (the name must match the folder). A name found in both is
  taken from `.agents/skills/`. Anything unusable is listed in `ignored`
  with why. Two readers:
  - `fileSystemSkillReader(clone)` reads a clone in full. It follows no
    symbolic link: a Skills folder that is a link counts as none, and a Skill
    holding a link is left out. It refuses non-UTF-8 files and stops at 200
    files or 4 MB.
  - `gitHubSkillReader(client, ref)` reads each folder's `SKILL.md` through
    the GitHub App, for the Floor admin's list.
- **Overrides and toggles** (`skills/floor.ts`, `skills/toggles.ts`):
  - `resolveFloorSkills(office, repository)` gives the Floor's Skills by
    name. A repository Skill replaces the office Skill of its name on that
    Floor (`overridesOffice: true`), and its files are the ones used.
  - `createFloorSkills` has three methods:
    - `list(floorId)`: the library's *enabled* Skills, plus the
      repository's (from GitHub, at the default branch), each with every
      sandbox Role's setting. If GitHub cannot be read, it still lists the
      office's and gives a `repositoryError`.
    - `setEnabled(floorId, name, role, enabled)`: refuses a Role without a
      sandbox, a name that is no Skill's, and a missing or archived Floor.
      Each real change is a `config.changed` event (`skills.<name>.<role>`).
    - `forSandbox(floorId, role, clone)`: the Skills on for that Role, with
      the repository's read in full from the clone.
- **Mounting** (`sandbox/skills.ts`, `sandbox/runner.ts`):
  - After the clone is made, the runner asks for the Agent's Skills, writes
    them to `<workDir>/<sandboxId>-skills/<name>/…` (beside the clone, never
    in it, so they cannot be committed), with each file mode `0444`.
  - That folder is passed to the sandbox provider as a mount with
    `readonly: true`, at the agent tool's user Skills folder:
    - `/home/agent/.claude/skills` (Claude Code);
    - `/home/agent/.agents/skills` (Codex);
    - `/home/agent/.config/opencode/skills` (opencode).
  - `dockerSandbox` hands the mount to Sandcastle's Docker provider
    read-only. `discard()` deletes the folder with the clone. With no
    Skills, nothing is mounted.
  - The server wires `createFloorSkills(…).forSandbox` into the runner.
- **Sandbox images:** each Dockerfile now makes the mount's folder as
  `agent`, so Docker does not create `~/.claude` (or the others) as root.
  The tags are `ai-office/sandbox-{claude,codex,opencode}:2`, with the new
  Dockerfile hashes recorded in `docker/sandbox-images.test.ts`.
- **API** (`apps/server/src/skills/routes.ts`):
  - `GET /api/floors/:floorId/skills`.
  - `PUT /api/floors/:floorId/skills/:name/roles/:role` with `{"enabled"}`.
  - Errors: `404 floor_not_found`, `409 floor_archived`,
    `422 not_sandbox_role`, `400` for a bad body.
- **Floor admin** (`apps/web/src/floor-skills-card.tsx`): a **Skills** card.
  - It lists each Skill with its description and where it comes from
    ("Office library", or "Repository, `.claude/skills/pdf` (overrides the
    office Skill)").
  - Each Skill has a checkbox per sandbox Role, disabled on an archived
    Floor.
  - It shows ignored folders with why, and the `repositoryError` when there
    is one.
- **README:** a new **A Floor's Skills** section; the Sandboxes and Sandbox
  images sections mention the mount and the `:2` tags.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker the Postgres tests skip with the
      reason: 1423 passed, 262 skipped.
- [x] **Tests: override resolution.**
  - `packages/orchestrator/src/skills/floor.test.ts`:
    - `resolveFloorSkills`: a repository `pdf` replaces the office `pdf`
      (`overridesOffice: true`, the repository's files), and keeps the
      office-only and repository-only Skills.
    - "lists the office's enabled Skills and the repository's from GitHub":
      against the fake GitHub, `.claude/skills/pdf` overrides the office
      `pdf`. A disabled library Skill and another branch's Skill are absent,
      and a broken folder is in `ignored`.
    - "gives each Role the Skills on for it…": the sandbox gets the
      repository's `pdf` with its supporting file, not the office's.
  - The discovery rules have their own tests in the same file:
    `.agents/skills` is preferred over `.claude/skills`; misnamed,
    frontmatter-less, binary and `SKILL.md`-less folders are ignored with
    reasons; symbolic links (to a host file, to a folder, and a linked
    `.claude/skills`) are never followed and the host file's text never
    appears; 201 files are refused.
  - `apps/server/src/skills/floor-routes.test.ts` checks the same through
    the API: the repository's `pdf` overrides the office's.
- [x] **Tests: per-Role toggles.**
  - `floor.test.ts`:
    - turning `pdf` off for QA shows `qa: false`, with the other Roles still
      on; turning it back on restores it;
    - a repeat changes nothing and publishes no event;
    - each change is a `config.changed` naming `skills.pdf.qa`;
    - `forSandbox` gives coder, QA and docs each their own set;
    - turning off an overridden Skill turns off the repository's copy;
    - a reviewer Role, a bad name, a missing Floor and an archived Floor are
      refused.
  - `floor-routes.test.ts` checks the API: `PUT` turns one off and the list
    shows it; `reviewer` is `422 not_sandbox_role`; a bad body is `400`; an
    unknown Floor is `404`.
  - `apps/web/src/floor-skills-card.test.tsx`:
    - the card shows each Skill's source and its switches;
    - a click sends `PUT …/skills/pdf/roles/qa` `{"enabled":false}` with the
      CSRF token, and the switch turns off;
    - every switch is disabled on an archived Floor.
  - The `floor_skill_toggles` store and its checks have a Postgres test
    (skipped here; see below).
- [x] **Tests: mounts are read-only.**
  - `packages/orchestrator/src/sandbox/runner.test.ts`, with real Sandcastle
    and the fake sandbox provider:
    - the provider is given exactly one mount,
      `{hostPath: <workDir>/<sandboxId>-skills, sandboxPath: "/home/agent/.claude/skills", readonly: true}`;
    - it is outside the clone, its files are there with mode `0444`;
    - the Agent's commit holds only its own file, and `discard()` deletes
      the folder;
    - with no Skills, nothing is mounted;
    - the Skills are asked for after cloning, with the clone's path and the
      Agent's Role.
  - `packages/orchestrator/src/sandbox/skills.test.ts`:
    - `skillMounts` is read-only for every agent tool, at each tool's
      folder;
    - `dockerSandbox` (with Sandcastle's Docker provider replaced to see
      its options) passes the mount as `{…, readonly: true}` and passes no
      `mounts` when there are none.

### Real output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck`:

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`:

```text
 Test Files  148 passed (148)
      Tests  1423 passed | 262 skipped (1685)
exit 0
```

The new and changed tests (`--reporter=verbose`, excerpt):

```text
 ✓ src/sandbox/skills.test.ts > Skill mounts > put the Skills where each agent tool looks for its user's Skills
 ✓ src/sandbox/skills.test.ts > Skill mounts > are given to Docker read-only, and only when there are Skills
 ✓ src/skills/floor.test.ts > resolveFloorSkills > lets a repository Skill override the office Skill of its name, keeping the rest
 ✓ src/skills/floor.test.ts > repository Skills in a clone > finds each folder's Skill under .agents/skills and .claude/skills, with its supporting files
 ✓ src/skills/floor.test.ts > repository Skills in a clone > takes a Skill in both folders from .agents/skills, and leaves out what is not a valid Skill, saying why
 ✓ src/skills/floor.test.ts > repository Skills in a clone > follows no symbolic link, so a repository cannot point a Skill at the host's files
 ✓ src/skills/floor.test.ts > repository Skills in a clone > leaves out a Skill beyond the format's limits
 ✓ src/skills/floor.test.ts > a Floor's Skills > lists the office's enabled Skills and the repository's from GitHub, the repository's overriding
 ✓ src/skills/floor.test.ts > a Floor's Skills > still lists the office's Skills when GitHub cannot be read, saying why
 ✓ src/skills/floor.test.ts > a Floor's Skills > turns a Skill off and on per Role, as a configuration change naming the Skill and Role
 ✓ src/skills/floor.test.ts > a Floor's Skills > refuses a Role that works in no sandbox, a name that is no Skill's, and a Floor that is archived or missing
 ✓ src/skills/floor.test.ts > a Floor's Skills > for a sandbox > gives each Role the Skills on for it, the repository's read in full from the clone and overriding the office's
 ✓ src/skills/floor.test.ts > a Floor's Skills > for a sandbox > turning off an overridden Skill turns off the repository's copy, which is what the Floor has
 ↓ src/skills/floor.test.ts > the Floor's Skill settings are kept in floor_skill_toggles, a Skill on until turned off [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 ✓ src/sandbox/runner.test.ts > the sandbox runner > mounts the Skills on for the Agent's Role read-only where its agent tool finds them, beside the clone rather than in it
 ✓ src/sandbox/runner.test.ts > the sandbox runner > mounts nothing when the Agent has no Skills
 ✓ src/skills/floor-routes.test.ts > the Floor Skills API, in memory > lists the Floor's Skills, the repository's overriding the office's, each on for every Role
 ✓ src/skills/floor-routes.test.ts > the Floor Skills API, in memory > turns a Skill off for one Role, recorded as a configuration change
 ✓ src/skills/floor-routes.test.ts > the Floor Skills API, in memory > refuses a Role without a sandbox, a bad body and an unknown Floor
 ✓ src/floor-skills-card.test.tsx > a Floor's Skills in its admin > lists each Skill with where it comes from, on or off for each Role
 ✓ src/floor-skills-card.test.tsx > a Floor's Skills in its admin > turns a Skill off for one Role
 ✓ src/floor-skills-card.test.tsx > a Floor's Skills in its admin > changes nothing on an archived Floor
 ✓ src/contract.test.ts > the GitHub contract, against the App client against the fake GitHub over HTTP > opens a pull request, reviews it, sees CI finish and merges it
```

## Not verifiable in this sandbox

- **Postgres 18 (Docker):** `floor_skill_toggles` (the store, its upsert and
  its checks) and the Floor Skills API's Postgres cases skip here with the
  reason. They run on the host and in CI.
- **Real Docker sandboxes:** that Docker really mounts the folder read-only
  (`:ro`), and that the rebuilt `:2` images (`pnpm sandbox:build`) have the
  folder owned by `agent`. Here the Docker provider's options are checked,
  not a container.
- **The agent tools finding the Skills:** that Claude Code reads
  `~/.claude/skills`, Codex `~/.agents/skills` and opencode
  `~/.config/opencode/skills` as user Skills. These are the tools'
  documented folders, but they can only be checked against the real tools
  on the host. Codex's documentation has also named `~/.codex/skills` in
  the past; if the installed Codex lists none of the mounted Skills, that
  is the folder to try.
- **The real GitHub App:** listing `.agents/skills` and `.claude/skills`
  through the real contents API runs only in the contract suite's real-App
  case (it needs #18's App and `ai-office-sandbox` repository).
- **Playwright:** the Floor admin's Skills card has a component test but no
  end-to-end test here (Playwright needs Docker for Postgres).

## Notes

- **Toggles and the worktree.** A repository's own `.agents/skills` and
  `.claude/skills` folders are part of the repository the Agent works on,
  so each agent tool may also find them in its worktree (Claude Code reads
  `.claude/skills`; Codex `.agents/skills`; opencode both). Turning a
  repository Skill off for a Role leaves it out of the read-only mount, but
  AI Office does not hide it from the worktree. Deleting or masking it
  there would show up as a deletion the Agent could commit. The README
  says so.
- **What is toggled.** Toggles are for the Roles whose Agents work in
  sandboxes (FR-75 is about sandboxes). Using Skills in the Manager chat
  (`/skill-name`) comes later.
- The Skill list UI beside the Manager chat (the Available Skills list) is
  #92, out of scope here.
