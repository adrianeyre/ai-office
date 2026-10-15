# Issue #265: [fix] P1-10 — A repository Skill takes the place of the reviewed office Skill of its name, unreviewed, in the Manager's chat and… — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no live model, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`6d881c9`,
`fix(security): P1-10 a repository Skill is used only once the Owner has reviewed exactly its files`,
on top of P1-9's `f6c66da` (#263). Its blocker, the P1 probe (#194), is
in the tree: `docs/pen-testing/assessments/P1.md` and
`packages/orchestrator/src/skills/skills.pen-test.test.ts`.

This is the remediation of finding **P1-10** (`severity:medium`, H10).

## What was fixed

FR-76 says Skills are trusted input, and an office Skill added by upload
or from Git waits, disabled, until the Owner reviews exactly the contents
they read. But FR-72's repository Skills (`.agents/skills/`,
`.claude/skills/` on the Floor's repository) were used as soon as they
were on the default branch, reviewed by no one. One of the name of an
office Skill took its place, in the Manager's chat and in every sandbox.

**Now a repository Skill is used only once the Owner has reviewed exactly
the files its folder holds**, as an office Skill is:

- **Read whole, compared by digest.** Each repository Skill folder is read
  whole, every file, from GitHub at the default branch for the Floor's
  list and the Manager's chat, and from the clone for a sandbox. Its
  digest (`skillDigest`, the SHA-256 the office library uses) is compared
  with the one the Owner reviewed for that folder.
- **Until then it is used nowhere.** A repository Skill never reviewed, or
  changed since (a file edited, added or removed), reaches no sandbox
  (`forSandbox`), is not in what the Manager's chat runs (`available`,
  `floorChatSkills`), and does not take an office Skill's place: the
  office Skill of its name stays.
- **The Owner reviews it in the Floor admin.** The **Skills** card lists it
  under **Waiting for your review** ("Never reviewed, so it is not used",
  or "It changed after you reviewed it"), saying when an office Skill is
  used in its place. "Read … to review it" shows every file of its folder
  as it is (not rendered), and "I have read every file: use … on this
  Floor" reviews exactly those, by their digest.
- **A review of other contents is refused.** If the folder's files changed
  between the Owner reading and reviewing them, the review is refused
  (`409 skill_changed`), and the Owner reads them again.
- **Kept per folder, recorded.** The review is kept in a new table,
  `repository_skill_reviews` (one row per Floor and folder, the folder and
  digest checked by the database), and is a `config.changed` event
  (`skills.<name>.reviewed`) in the Activity Feed.
- **API.** `GET /api/floors/:floorId/skills` lists `awaitingReview`;
  `GET /api/floors/:floorId/repository-skills?folder=…` gives a folder in
  full with its digest; `POST /api/floors/:floorId/repository-skills/review`
  takes `{"folder","digest"}`. All need the Owner's session.

The guide's **A Floor's Skills** and **Available Skills** sections
(`docs/guide/notices-and-skills.md`) say the same.

### Sibling paths with the same flaw, fixed and tested

- **A repository Skill of a new name** (no office Skill to replace) was
  just as unreviewed. It waits too. Tested: "P1-10: a repository Skill of
  a new name reaches no Agent's sandbox, nor the chat, until reviewed as
  the clone has it".
- **The sandbox's clone** may be on a branch that changed the Skill since
  the review: the digest is taken from the clone, so it is not given.
  Tested in the same probe test, and in `skills/floor.test.ts`: "gives no
  repository Skill the Owner has not reviewed as the clone has it, the
  office's of its name in its place (P1-10)".
- **A file added after the review** (a script beside `SKILL.md`) makes it
  wait again. Tested: "P1-10: takes its place once the Owner has reviewed
  exactly its files, and not after they change until reviewed again".
- **The agent tool finding the repository's Skill folders itself.** Claude
  Code no longer reads project Skills (P1-9: no project setting source),
  nor opencode Claude Code's files. Every sandbox Stage's prompt now names
  `.agents/` and the repository's Skills among the files that are its
  content, not instructions, and says the Skills AI Office gives are
  mounted.
- **The server, the routes and the web app** are tested:
  `apps/server/src/skills/floor-routes.test.ts` ("keeps a repository
  Skill waiting until the Owner reviews exactly the files they read, the
  office's in its place meanwhile (P1-10)", in memory and in Postgres)
  and `apps/web/src/floor-skills-card.test.tsx` ("shows a repository
  Skill waiting for review, its files as they are, and reviews exactly
  those (P1-10)"). The store has a Postgres test, which skips here.

## Decisions

- **FR-72 is narrowed, not changed in the PRD.** FR-72 says "A repository
  Skill with the same name overrides the office Skill on that Floor", and
  FR-76 that Skills are trusted input reviewed before they are enabled.
  The fix keeps both: a repository Skill still overrides the office one,
  once the Owner has reviewed it. `ai-office.md` is left as it is. The
  Owner may want FR-72 to say "once reviewed".
- **The review is of the whole folder.** A sandbox is given every file of
  a Skill, so the digest covers every file, not only `SKILL.md`. Reading
  whole folders costs more GitHub requests per list (each Skill's folder
  is listed and read), which the Manager chat's 30-second cache absorbs.
- **The files are shown raw for review.** The Available Skills modal
  renders `SKILL.md`. For a review, every file is shown as text, so
  nothing in it is hidden by rendering.
- **A review is per folder, the latest only.** A later review replaces the
  folder's earlier one, so going back to an older version needs another
  review.
- **No Floor admin toggle bypasses it.** The per-Role switches still apply,
  but only to Skills in use. An unreviewed Skill has none to turn on.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "does not
      take the reviewed Skill's place until the Owner has reviewed it" is
      an `it` and passes, with its body unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** *"it takes its place at
      once, in the Floor's Skills and in what the Manager's chat runs,
      reviewed by no one"* is now "regression (P1-10): it no longer takes
      its place at once, in the Floor's Skills or in what the Manager's
      chat runs: it waits for the Owner's review". It asserts the office
      Skill is what the Floor and the chat use, the hostile instructions
      are not in the chat, and the Floor admin lists the repository Skill
      waiting. No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above. The tests that relied on an unreviewed repository Skill being
      used (`skills/floor.test.ts`, `manager/skills-scenario.test.ts` and
      the server's Floor Skills API) now have the Owner review it first,
      the way it is used now, and still check what they checked.
- [x] **The assessment's findings table marks `P1-10` fixed.**
      `docs/pen-testing/assessments/P1.md`: **fixed** (issue #265), with
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

### P1-10's tests on their own

```
 ✓ |@ai-office/orchestrator| src/skills/floor.test.ts > a Floor's Skills > for a sandbox > gives no repository Skill the Owner has not reviewed as the clone has it, the office's of its name in its place (P1-10)
 ✓ |@ai-office/orchestrator| src/skills/skills.pen-test.test.ts > P1-10: a repository Skill of the same name as a reviewed office Skill > does not take the reviewed Skill's place until the Owner has reviewed it
 ✓ |@ai-office/orchestrator| src/skills/skills.pen-test.test.ts > P1-10: a repository Skill of the same name as a reviewed office Skill > regression (P1-10): it no longer takes its place at once, in the Floor's Skills or in what the Manager's chat runs: it waits for the Owner's review
 ✓ |@ai-office/orchestrator| src/skills/skills.pen-test.test.ts > P1-10: a repository Skill of the same name as a reviewed office Skill > P1-10: takes its place once the Owner has reviewed exactly its files, and not after they change until reviewed again
 ✓ |@ai-office/orchestrator| src/skills/skills.pen-test.test.ts > P1-10: a repository Skill of the same name as a reviewed office Skill > P1-10: a repository Skill of a new name reaches no Agent's sandbox, nor the chat, until reviewed as the clone has it
 ✓ |@ai-office/server| src/skills/floor-routes.test.ts > the Floor Skills API, in memory > keeps a repository Skill waiting until the Owner reviews exactly the files they read, the office's in its place meanwhile (P1-10)
 ✓ |@ai-office/web| src/floor-skills-card.test.tsx > a Floor's Skills in its admin > shows a repository Skill waiting for review, its files as they are, and reviews exactly those (P1-10)
```

## What could not be verified here

- **Postgres.** The store's test, and the server's Floor Skills API in
  Postgres, skip without Docker. The migration was regenerated with
  `pnpm --filter @ai-office/db db:generate`, and only adds the table and
  its foreign key. On a development database, `pnpm db:reset` applies it.
- **Codex and opencode finding Skill folders in the worktree.** See #263's
  note: AI Office mounts only reviewed Skills, and the prompt says the
  repository's are content, but whether those tools load a worktree's
  `.agents/skills/` as Skills could not be checked without them.

## Noticed, out of scope

- **Built-in Floor Templates' Skills** join the office library as AI
  Office's own and were not looked at here.
- **Two `deployment` tests fail on the base commit too**: the Caddyfile's
  `reverse_proxy` now has a block, and the pen-test stack's environment
  file holds `127.0.0.1`, which their tests do not expect (see the
  checks above). They are outside this fix.
