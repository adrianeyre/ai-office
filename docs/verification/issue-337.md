# Issue #337: Adrian, each Floor's coder, always looks the same: bald, stubble, blue hoodie — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker, so no Postgres; no GitHub access; no GPU). The work is these
commits on top of `c668195`:

| Commit | Subject |
| --- | --- |
| `ba56cf1` | feat(orchestrator): Adrian, each Floor's coder, always looks the same |
| `a3ae7e8` | feat(orchestrator,server): coders named Adrian on Floors from before take his look, once |
| `e255c0a` | docs(guide): Adrian's look, on new Floors and on Floors from before |

## What was built

- **The look, defined once**: `roleAvatars` in
  `packages/orchestrator/src/agents/names.ts`, beside `roleNames`, keyed
  by Role. The coder's is a valid `Avatar`:
  - male, average build, oval face;
  - bald (`hairColour` `#4a3021`, which tints the stubble), stubble,
    skin `#e0ac69`;
  - no glasses and no accessories;
  - a `hoodie` in `#3f88c5` (blue) with `#2b2b2b` (charcoal);
  - a rubber duck as his desk mascot.

  `roleAvatar(role, name)` returns a copy of it only when `name` is that
  Role's own name (`roleNames`).
- **New Agents** (`newAgentRecord` in `agents.ts`): an Agent whose name
  is its Role's own gets that Role's Avatar, unless it is a copy. Every
  other Agent gets `randomAvatar` as before. That random Avatar must look
  unlike the others on the Floor (`others`), and also unlike `unlike`:
  the Avatars of Agents still to join.
  - `defaultTeam` and `templateTeam` pass Adrian's look as `unlike`, so
    the Manager, which is created before him, also looks unlike him.
  - Adrian's own look is never re-rolled.
  - `copyOfFirst` (raising a Role's team size, `addToTeam`) now marks the
    `NewAgent` as `copy: true`. A copy gets a random Avatar even when
    the free name it gets is "Adrian".
- **The data migration**:
  - `AgentStore.migrateAvatars(name, avatarOf)` is implemented on both
    stores. The Postgres store, in one transaction, inserts
    `data-migration:<name>` into `schema_meta` (`ON CONFLICT DO NOTHING`).
    Only if that row is new does it update each non-removed Agent that
    `avatarOf` gives a different Avatar. The memory store keeps the names
    of the migrations it has run in a set.
  - `Agents.giveRoleAvatars()` runs it as `agents.adrian-avatar` with
    `roleAvatar(role, name)`, so it changes only coders named Adrian. It
    publishes a `config.changed` event (`keys: ["avatar"]`) for each
    Agent it changes, so the change shows in the Activity Feed, and
    returns their ids.
  - `startOffice` (`apps/server/src/server.ts`) runs it once the Agents
    service exists, before the server listens. It logs the Agents it
    changed. If it fails, it logs a warning and the server carries on.
    Because the record is written in the same transaction, a failed run
    is tried again at the next start.
- **Docs**: the "Agents" section of `docs/guide/floors-and-agents.md`.

### Why the data migration is not a SQL migration

The issue asks for "a data migration in the same style as the existing
ones (Postgres and the in-memory store alike)". Today there are no
separate data migrations to copy. Since `f4cdba2` the schema is a single
migration, `0000_schema.sql`, and `pnpm db:generate`
(`packages/db/src/generate-schema.ts`) deletes the migrations folder and
writes that file again. A `0001_*.sql` would be lost at the next
generate, and the in-memory store could not run it at all.

The old data migrations were SQL, such as the deleted
`0077_communications_agent_avatar.sql`. This one is instead a store
method with a Postgres and an in-memory implementation, recorded in
`schema_meta` (the table "of facts about the database itself"). That
keeps the property a SQL migration had: it runs once in the database's
life, so a look the Owner gives Adrian later is kept. Please say if you
would rather have a SQL migration plus a change to `generate-schema.ts`
that keeps it.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** I ran all
      three on the final tree (`e255c0a`); output below. `pnpm test`
      skips 625 tests: the Postgres/Testcontainers ones, because Docker
      is not available. Each prints the reason ("Docker is not available
      … so the Postgres integration tests are skipped").
- [x] **Unit tests: a new Floor's coder Adrian has exactly the fixed
      Avatar; the other Agents look distinct from it; a non-Adrian Agent
      is still random; the fixed Avatar passes `avatarSchema`.**
      In `packages/orchestrator/src/agents/role-avatars.test.ts` (8
      tests, all passing):
      - "is a valid Avatar: male, bald, stubble and a blue hoodie":
        `avatarSchema.parse`, plus presentation, hairstyle, facial hair,
        outfit style and `#3f88c5`.
      - "is the coder's, for the coder's own name alone": not another
        name, not another Role, and a copy rather than the shared object.
      - "has Adrian the coder, with exactly his Avatar, on every Floor":
        `defaultTeam` on five seeds. The coder is named Adrian, has
        `toEqual` the fixed Avatar, and every other Agent passes
        `lookDistinct` against it.
      - "makes an Agent that joins before Adrian look unlike him": a
        scripted `random` makes the Manager's first draw Adrian's look.
        The test first checks that premise with `randomAvatar`, then
        checks that the Manager still looks distinct. I removed `unlike`
        from `newAgentRecord` once to confirm the test fails without it,
        then restored it.
      - "gives a template's second coder a random Avatar unlike
        Adrian's": `templateTeam` with a reviewer before two coders.
      - "has a random Avatar, as before": a reviewer, and a coder named
        Ada, each get exactly the Avatar `randomAvatar` gives from the
        same seed.
      - "copied from its Role's first is random even when named Adrian".
      - "joining Adrian's Floor looks unlike him".

      In `agents.test.ts`, through the Agents service and stores, in
      memory (passing) and Postgres 18 (skipped here):
      - "gives each new Floor's coder Adrian his own look, and the others
        looks unlike it", on two Floors;
      - "gives a coder copied from the Role's first a random Avatar, even
        named Adrian": Adrian is removed and the coder team size raised
        to 1.
- [x] **Migration test: an existing Adrian coder gets the look; other
      Agents are untouched; an Avatar edited afterwards is kept.**
      "gives the coders named Adrian on Floors from before his look,
      once" in `agents.test.ts`. It passes in memory; the Postgres 18 run
      of the same case is skipped here. The test:
      - gives every Agent on two Floors a random look, as before #337;
      - renames one Floor's coder to Ada and adds a reviewer named
        Adrian there;
      - runs `giveRoleAvatars()`;
      - checks that only `web-shop`'s coder Adrian changed (whole records
        compared for everyone else), and that the run produced exactly
        one `config.changed` event with `keys: ["avatar"]`;
      - has the Owner set another Avatar through `agents.update`, runs
        the migration again, and checks it returns `[]` and the Owner's
        Avatar stays.

      One test is Postgres-only, "gives Adrian his look once in the
      database's life, not once a start". It checks the
      `data-migration:agents.adrian-avatar` row in `schema_meta`, then
      has a second set of stores on the same database (a restart) keep
      the Owner's edit. It is written and typechecked, but **not run
      here** (no Docker).

### Verified on the host (not possible in this sandbox)

- [ ] **In the 3D office, Adrian is bald with stubble and a blue hoodie on
      every Floor.** Nothing in this sandbox can draw the scene (no GPU,
      and no browser libraries). To check: run `pnpm dev`, add two Floors
      (Development and another template), and look at each coder's desk
      and his Avatar Editor preview.
- [ ] **Postgres 18 runs** (Docker): `pnpm test` with Docker, in
      particular `packages/orchestrator/src/agents/agents.test.ts`:
      - "Agents, kept in Postgres 18" › the three new cases;
      - "gives Adrian his look once in the database's life, not once a
        start".
- [ ] **On an existing development database**:
      1. Start AI Office (`pnpm dev`) on a database whose Floors were made
         before this change. The log should say "Gave Adrian his own
         look." with the coders' ids, and each Adrian should now look as
         above, with a `config.changed` entry in the Activity Feed.
      2. Change one Adrian in the Avatar Editor and restart. He should
         keep the Owner's look, and nothing more should be logged.
- [ ] `pnpm e2e` and `pnpm scenes` (Docker / Chromium). These need no
      change: the key scenes draw fixed `seededRandom` Avatars from
      `apps/web/screenshots/scene-data.ts`, not `newAgentRecord`.
      `pnpm screenshots` will show the new Adrian when the README's
      pictures are next retaken.

## Notes and things outside the scope

- **The PRD is unchanged and now differs slightly.** FR-13 says "New
  Agents: each one gets a random Avatar distinct from the others on its
  Floor". Adrian's Avatar is fixed, not random, though still distinct
  from the others on his Floor. The issue asks for this, and I have not
  edited the PRD. Its owner may want to add a line to FR-13.
- **A clash on an old Floor is left as it is.** The issue says the
  migration must leave other Agents untouched and must never re-roll
  Adrian. So on a Floor from before, another Agent that happened to look
  close to Adrian's new look (the same in five of the six features
  `lookDistinct` compares) keeps that look. The odds are about 1 in
  4,000 per Agent; the Owner can change it in the Avatar Editor.
- **A copied Adrian is not the real Adrian.** Suppose the coder Adrian is
  removed and the coder team size is raised again. The copy is named
  Adrian (the name is free again) but gets a random Avatar, because the
  issue says copies keep today's behaviour. Worth a decision if that
  surprises anyone.
- **Adding a fixed look for another Role later** means a new migration
  name, not reusing `agents.adrian-avatar`. Otherwise databases that
  have already run it would never apply the new look. The constant's
  comment says so.
- **Git warnings on this machine.** Each commit printed "There are too many unreachable loose objects;
  run 'git prune'" and a `gc.log` warning for the host repository's
  worktree. I left these alone; they are for the host to clean up.

## Real output of the checks

`pnpm lint` (tail):

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck` (tail):

```
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test` (tail):

```
 Test Files  499 passed (499)
      Tests  5970 passed | 625 skipped (6595)
exit 0
```

The new tests, verbose (`vitest run src/agents/role-avatars.test.ts
src/agents/agents.test.ts`, durations removed):

```
 ✓ src/agents/role-avatars.test.ts > Adrian's Avatar > is a valid Avatar: male, bald, stubble and a blue hoodie
 ✓ src/agents/role-avatars.test.ts > Adrian's Avatar > is the coder's, for the coder's own name alone
 ✓ src/agents/role-avatars.test.ts > a new Floor's team > has Adrian the coder, with exactly his Avatar, on every Floor
 ✓ src/agents/role-avatars.test.ts > a new Floor's team > makes an Agent that joins before Adrian look unlike him
 ✓ src/agents/role-avatars.test.ts > a new Floor's team > gives a template's second coder a random Avatar unlike Adrian's
 ✓ src/agents/role-avatars.test.ts > any other new Agent > has a random Avatar, as before
 ✓ src/agents/role-avatars.test.ts > any other new Agent > copied from its Role's first is random even when named Adrian
 ✓ src/agents/role-avatars.test.ts > any other new Agent > joining Adrian's Floor looks unlike him
 ✓ src/agents/agents.test.ts > Agents, kept in memory > gives each new Floor's coder Adrian his own look, and the others looks unlike it
 ✓ src/agents/agents.test.ts > Agents, kept in memory > gives a coder copied from the Role's first a random Avatar, even named Adrian
 ✓ src/agents/agents.test.ts > Agents, kept in memory > gives the coders named Adrian on Floors from before his look, once
 ↓ src/agents/agents.test.ts > Agents, kept in Postgres 18 > … [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
```
