# Issue #150: Built-in Floor Templates: Online store, Website & marketing, Content & blog — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display). `pnpm lint`, `pnpm typecheck` and `pnpm test`
ran in a fresh `git clone` of this branch at `48456c6` (every code and
docs commit of the issue before this note), after `pnpm install
--frozen-lockfile`. The Postgres and Playwright runs were made in the
working tree at the same code.

Both blockers are built on this branch:

- #147, Floor Templates ([`issue-147.md`](issue-147.md)): the template
  format, its loader and checks, Development and Blank, adding a Floor
  from a template and the picker. This issue's three templates are
  folders in that format;
- #149, ordered work Roles for one issue ([`issue-149.md`](issue-149.md)),
  with #148's routing between work Roles ([`issue-148.md`](issue-148.md)):
  scenario 11's "merchandiser, then copywriter" on one branch.

## What was built

### Three built-in Floor Templates (`templates/`, new)

Each is a folder of `template.yaml`, `roles/<role>.md` and
`skills/<name>/SKILL.md` (PRD FR-99, FR-100).

| Template | Roles (Stage, suggested AI Provider) | Required reviewer | Check command | Skills | Icon, theme |
| --- | --- | --- | --- | --- | --- |
| **Online store** (`online-store`) | merchandiser, copywriter, storefront developer (work, Claude); brand reviewer (review, ChatGPT); store QA (QA, Claude) | brand reviewer | `npm run check:theme && npm run check:links && npm run check:prices && npm run check:images && npm run check:accessibility` | `product-data`, `store-checks` | `shopping-bag`, `stockroom` |
| **Website & marketing** (`website-and-marketing`) | web developer, copywriter, SEO specialist (work, Claude); conversion reviewer (review, ChatGPT) | conversion reviewer | `npm run build && npm run check:links && npm run check:lighthouse` | `site-checks`, `seo-basics` | `megaphone`, `studio` |
| **Content & blog** (`content-and-blog`) | writer, SEO specialist (work, Claude); editor (review, ChatGPT); fact-checker (QA, Claude) | editor | `npm run check:markdown && npm run check:links && npm run check:spelling` | `content-checks`, `fact-checking`, `seo-basics` | `pen-line`, `editorial` |

All three:

- start one Agent in each Role, beside the Manager;
- have the setup command `if [ -f package.json ]; then npm install; fi`,
  the Merge Policy "send to me", Round Cap 3 and no labels of their own
  (#148 already gives each work Role its `role:` label);
- give the Manager **planning guidance**: what each work Role does, who
  reviews and checks, the order work Roles take turns in when an issue
  needs several (merchandiser → copywriter → storefront developer; web
  developer → copywriter → SEO specialist; writer → SEO specialist), and
  that the Floor works on its repository only;
- suggest a **first set-up issue** ("Set up the store's checks", "… the
  site's checks", "… the blog's checks") that adds each npm script the
  check command runs, with a tool that does it, and acceptance criteria;
- **say plainly that the Floor works on the repository only**, never on a
  live store, an ad platform or customer email (PRD §4), in the Manager's
  guidance and in every Role's instructions:
  - work Roles: "Work on this repository only. Never act on a live store,
    an ad platform or customer email…", saying what would need doing
    there in the Handoff, for the Owner; copy for an ad or an email only
    as a file in the repository;
  - reviewers: the same, and they mark as blocking any change that would
    reach one (a workflow that publishes the theme, places ads or sends
    email) and any credential in the repository;
  - QA: never sign in to one, place an order or send an email to check
    something.

Each Role's instructions are written as its Stage's prompt carries them:
a work Role's as `- ` items under "How to work", a QA Role's as a
numbered list from 2 (after "1. Run the tests"), a review Role's as
paragraphs.

**Shared Roles.** The copywriter (Online store, Website & marketing) and
the SEO specialist (Website & marketing, Content & blog) are one Role
each: their files are identical in both templates, as #147's loader
requires. So is the `seo-basics` Skill.

**Stages chosen.** The PRD names each template's Roles but not their
Stages:

- store QA and the fact-checker are in the QA Stage, so they have
  sandboxes to run the checks in. The fact-checker also checks each
  claim of fact against its source;
- the brand reviewer, the conversion reviewer and the editor are in the
  review Stage and are the required reviewers;
- Website & marketing has no QA-Stage Role (the PRD lists none), so its
  work Roles run the checks before they finish (the coder prompt's "Run
  the tests before you finish"), and review leads to the Merge Policy.

### The lint (`packages/orchestrator`, `templates/lint.ts`, new)

**`lintFloorTemplate(template, glossary)`** holds a template's words to
the house rules, beyond the schema. It covers the description, the
Manager's guidance and first issue, each Role's name, description and
instructions, and every Skill file:

- **`GLOSSARY.md`**, read by **`parseGlossary`**:
  - none of the words listed under _Avoid_, in any case or plural;
  - the glossary's terms written with their capitals ("owner" and
    "handoff" fail);
  - fenced code and `inline code` are not prose, so they are skipped;
  - "run", "command", "report" (QA's report, as its prompt names it) and
    "character" (a title's length) are allowed in their everyday sense;
  - terms with an everyday lowercase sense (Notice, Plan, Batch, Model,
    Office, Connection, Digest) are not held to their capitals.
- **Repository only**: the Manager's guidance and every Role's
  instructions mention the repository, a live store, an ad platform and
  customer email.
- **Stage shape**: work, QA and docs, and review instructions as above.
- **Checks**: the check command runs npm scripts, and the first issue
  names each of them.
- **Skills**: every Skill shipped is one of the template's Roles' Skills.

**`lintFloorTemplates(templates)`** checks that a Skill two templates ship
is the same in both. Problems are `<template>/<file>: <what is wrong>`.

### A template's Skills join the Skill library

#147 noted that a template's Skills were never installed, so no Agent
would be given them, and that the first template shipping one would need
to. These are the first, so:

- **`Floors.add`** (`floors/floors.ts`), after the template's Roles,
  adds each of its Skills the office Skill library has no Skill of that
  name for:
  - source **`template`**, enabled and reviewed at once. A built-in
    template ships with AI Office, reviewed as part of it (FR-76);
  - a `skill.added` event with `template: {id, name}`.

  A Skill the library has, perhaps edited by the Owner, is kept, as a
  Role is. The server passes `stores.skills`.
- **shared**: the Skill source `template` ("From a Floor Template").
  `POST /api/skills` still takes only `upload` or `editor`, so the Owner
  cannot claim it.
- **db**: migration **`0071_template_skills`** (written as `0049`,
  renumbered after main's `0044`–`0049` in
  [the merge note](merge-main-into-131-to-153.md)) widens the
  `skills_source` check, as drizzle-kit generated it, with a comment.
- **events**: `skill.added` takes an optional `template`; stored events
  still parse.
- **web**: the Activity Feed reads 'Skill "product-data" added to the
  library by the Online store Floor Template.'.

### Tests changed by the new templates

- **The Corner shop fixture** (`templates/testing.ts`) shares Role ids
  with Online store (merchandiser, copywriter, brand-reviewer) but
  differs from it, which the loader rightly refuses. `templateFolder({
  only })` copies only some built-in templates, and the Corner shop tests
  load it beside **`cornerShopNeighbours`** (Development and Blank).
- **Five built-in templates now**: the expected lists in `load.test.ts`,
  the server's picker test (each template's team) and `floors.spec.ts`
  (5 radios, and Online store's description and team). The server's
  "unknown template" case asks for `garden-centre`, now that
  `online-store` exists.
- **The copywriter is now in a starting team**. Online store and Website
  & marketing start Floors with one, so the library keeps it (#147's
  `role_in_starting_team`). Two delete tests now use a proofreader
  instead: `apps/server/src/roles/routes.test.ts` and
  `e2e/tests/role-library.spec.ts`. The API test also checks that a
  copywriter now stays, naming both templates.

### Docs

- README, "Floor Templates": the three templates, their checks and the
  repository-only rule.
- [Floors and Agents](../guide/floors-and-agents.md), Floor Templates:
  - Skills join the library (step 2);
  - the three in the table of built-in templates;
  - a section "Online store, Website & marketing and Content & blog";
  - the lint.
- [Notices and Skills](../guide/notices-and-skills.md): Skills from a
  Floor Template.
- [Setting up a Floor](../processes/setting-up-a-floor.md): file the
  suggested set-up issue first; change the commands for pnpm or yarn.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `48456c6` (output below):
  - without Docker: **249 files, 2852 passed, 411 skipped** (the Postgres
    tests skip with the reason);
  - against an embedded **Postgres 18.4**: **249 files, 3241 passed, 22
    skipped**. The 22 are the GitHub contract against the real App (it
    needs `GITHUB_APP_ID`) and the checks that need Docker.
- [x] **Schema and lint tests pass for all three templates.**
  - **Schema**, `packages/orchestrator/src/templates/load.test.ts`:
    - "every file under templates/ passes the schema, as part of its
      template" now loads five templates: `development`, `blank`,
      `content-and-blog`, `online-store`, `website-and-marketing`. Every
      file under `templates/` is one a template was loaded from;
    - one test per template, "… starts its Roles on their Stages, with its
      checks, required reviewers, Skills and first issue". It checks:
      - each Role's id, name, Stage, suggested AI Provider, Skills and
        count;
      - the settings, the check command built from its scripts, and the
        Skills;
      - the first issue's title, naming each script;
      - the guidance's opening line;
    - "a Role two of them bring is the same Role, with the same Skills":
      the copywriter, the SEO specialist and `seo-basics`.

    Each Role file passes the Role library's own
    `createRoleRequestSchema`, through #147's `parseRoleDocument`.
  - **Lint**, `packages/orchestrator/src/templates/lint.test.ts` (12
    tests):
    - the glossary is read from `GLOSSARY.md`;
    - **`online-store`, `website-and-marketing` and `content-and-blog`
      each pass the lint** with no problems;
    - every Skill two templates ship is the same in both;
    - each rule catches what it is for, with its exact problem: an
      avoided word ("Users", while `` `preset` `` in code is ignored);
      lowercase "owner" and "handoff"; guidance and a reviewer not told
      "repository only"; instructions in the wrong shape for work, QA and
      review; a check the first issue does not set up, and no checks; a
      Skill no Role has; a Skill two templates ship differently.

    Linting the templates found real slips while they were written, all
    fixed: "type" (fonts), "leads" (links that go to a page),
    "newsletter" (an email to subscribers) and "Steps".
- [x] **Scenario test with fake agent tools: scenario 11 in §5 runs end
      to end on an Online store Floor.**
      `packages/orchestrator/src/templates/online-store.test.ts`, in memory
      and in Postgres 18.4.

  It is wired as the server wires it:
  - the real Floors (with the loaded built-in templates), Batches,
    triage, work queue, coder, review, QA and merge flows;
  - the Floor's Skills mounted into each sandbox through `floorSkills`;
  - a fake model for the Manager and the brand reviewer;
  - the fake GitHub over a local bare `shop-theme` repository;
  - Agents as scripts in the fake sandbox.

  The repository is seeded with a `package.json` whose five
  `check:<name>` scripts run a small `scripts/check.mjs` (no
  dependencies, so the template's `npm install` needs no network), a
  theme layout and a product with its image.

  1. **The Owner adds the Floor from Online store**:
     - `template: {online-store, Online store}`;
     - the team is the Manager, a merchandiser, a copywriter and a
       storefront developer (work), a brand reviewer (review, on
       ChatGPT) and store QA (QA);
     - the template's setup and check commands, "send to me", Round Cap
       3, and the brand reviewer the required reviewer;
     - the Manager's instructions are the template's guidance and first
       issue;
     - the template's theme is `stockroom`;
     - `product-data` and `store-checks` are in the Skill library as
       `template`, enabled.
  2. **"Add the autumn range"**, handed to the Manager:
     - the Plan gives it `roles: ["merchandiser", "copywriter"]`, with the
       merchandiser as its coder;
     - the chat reads "1. #1 Add the autumn range: <merchandiser>
       (merchandiser, then copywriter).";
     - the Manager's Plan prompt had the template's guidance ("…give it
       their turns in this order: the merchandiser first…") and each work
       Role's routing description.

     The sandbox ran the merchandiser, then the copywriter, then store QA:
     - "turn 1 of 2: yours, as the merchandiser", then turn 2 of 2 as the
       copywriter;
     - each prompt carries its Role's instructions from the template ("Never
       make up a price…"; "…write copy for an ad or an email only as a file
       in the repository, for the Owner to use.") and the check command;
     - each sandbox had `product-data` and `store-checks` mounted.

     The branch has exactly the merchandiser's commit, then the
     copywriter's, each with its own `Agent:` trailer.
  3. **The brand reviewer approves**:
     - its prompt is its Role's ("This Floor works on the store's
       repository only…");
     - it reviewed both Roles' files.

     **Store QA**:
     - its prompt has "3. Check the links, prices and images the change
       touches yourself";
     - the sandbox ran the setup command;
     - the Agent ran the Floor's check command, which exited 0 printing
       `check:theme: ok`, `check:links: ok`, `check:prices: ok`,
       `check:images: ok` and `check:accessibility: ok`;
     - `qa.reported` is store QA's `pass`.

     **The pull request awaits the Owner**: PR #2 is open and not
     merged, the Notice "PR #2 awaiting your approval" is open, and there
     is no `pull_request.merged`.

**Beyond the criteria**, `packages/orchestrator/src/floors/templates.test.ts`
has "a template's missing Skills join the Skill library, enabled, so its
Agents are given them; one the library has is kept", in memory and
Postgres:

- a Development Floor adds no Skill;
- Corner shop adds `price-check`: source `template`, enabled, reviewed,
  its files and digest, and its `skill.added` event naming the template;
- the Owner edits it, and a second Floor from Corner shop keeps the edit
  with no second event.

The Activity Feed's text has a test (`activity-feed.test.tsx`).

**Negative checks.** Each sabotage was applied to the working tree, then
`src/templates` and `src/floors/templates.test.ts` of `orchestrator` were
run in memory. Each was reverted with `git checkout`, and `git status` was
clean afterwards.

| Sabotage | Failed |
| --- | --- |
| `Floors.add` never adds the template's Skills | 2: the Skills case, scenario 11 |
| Online store's check command drops `check:links` | 3: Online store's schema test, the check-scripts test, scenario 11 |
| The merchandiser is not told "repository only" | 4: Online store's lint, and the three negative lint tests whose exact lists start from Online store's Roles |
| Online store's brand reviewer is not required | 2: Online store's schema test, scenario 11 |
| The copywriter's instructions say "for the user" | 6: Online store's and Website & marketing's lint, and four negative lint tests built on them |

### Verified on the host

- [ ] **A real Online store Floor on a sample theme repository produces a
      reviewed pull request for a product-range issue.** Not verifiable
      here: there is no Docker for real sandboxes and agent tools, no
      real AI Provider and no GitHub. On the host:
  1. Add the Floor from Online store.
  2. File "Set up the store's checks" and merge its pull request.
  3. File a product-range issue and hand it to the Manager.

### `pnpm e2e`

The whole suite (46 tests) ran with 4 workers against the embedded
Postgres: **43 passed, 3 failed**.

- The three failures are the ones recorded since #146
  (`agent-editor.spec.ts`, `gateway-requests.spec.ts`,
  `manager-chat.spec.ts`), on the same lines. They look on the Admin page
  for what #165 moved to AI Settings
  ([`issue-147.md`](issue-147.md#pnpm-e2e)).
- The specs this issue changed pass:
  - `floors.spec.ts` > "adds a Floor from the Floor Template picked": the
    picker now has 5 radios, and Online store's accessible description is
    its description and its team ("Starting team: Manager, merchandiser,
    copywriter, storefront developer, brand reviewer, store QA");
  - `role-library.spec.ts`, with a proofreader Role.
- `notice-alerts.spec.ts` passed this time: `libcups2` was among the
  libraries extracted.

### How Postgres and Chromium were run here

As for earlier issues, outside the repository:

- **Postgres**: `@embedded-postgres/linux-x64@18.4.0-beta.17`
  (PostgreSQL 18.4) in `/tmp/pg18`, on port 54329.
  - For `pnpm test`, a scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at it
    through `SCRATCH_PG_URL`, with database names unique per test file.
    It was reverted with `git checkout` after each run and never
    committed.
  - `pnpm e2e` used `E2E_POSTGRES_URL`.
- **Chromium**: from `playwright install chromium`. Its missing shared
  libraries came from Debian bookworm's packages, downloaded from
  `deb.debian.org`, extracted to `/tmp/chromelibs` and put on
  `LD_LIBRARY_PATH`. `libcups2` was among them, for the full Chrome.

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`. Both ran against the embedded Postgres 18.4 instead; they run in
  CI.
- **Real sandboxes, agent tools and Models.** The Agents are scripts and
  the Manager and reviewers a fake model. These are for the host:
  - how well a real Model follows the templates' instructions;
  - whether it keeps to its Role's part;
  - whether it routes by the routing descriptions.
- **The checks' real tools.** Theme Check, `linkinator`/`lychee`, axe or
  pa11y, Lighthouse CI, `markdownlint-cli2` and `cspell` are named in the
  first issues and Skills. None of them ran here: the scenario's
  repository has stand-in scripts.
  - Lighthouse needs a Chrome in the sandbox image, which is not checked.
  - The setup command's `npm install` needs the network for real
    dependencies.
- **The stockroom look.** The theme id is in the template, but nothing
  draws it yet (#153), and there is no GPU or display here.

## Notes

- **Checks are npm scripts the first issue adds.** The PRD names each
  template's checks (theme check, prices, Lighthouse…) but not how they
  run in an Owner's repository. So each template's check command runs
  them as `npm run <script>`, and its first set-up issue and its
  `*-checks` Skill say how to add each one, with a tool that does it.
  - Before the set-up issue is merged, the check command fails. A QA
    Agent whose check is missing says so in its Summary rather than
    failing for that alone.
  - The setup command installs only when there is a `package.json`, so
    the set-up issue's own sandbox starts.
- **"Typical checks" are the check command.** FR-99's "setup and check
  commands" are the template's `setupCommand` and `testCommand`, the
  Floor's two commands since #147. No new setting was added.
- **Website & marketing has no QA Agent.** The PRD's list has none, so
  the pipeline skips QA there (`stageAfter`). Its work Roles run
  the checks, and its repository's CI should too, which the guidance
  says.
- **Reviewers suggest ChatGPT**, so a pull request written on Claude is
  reviewed by another AI Provider (PRD goal 5). With no ChatGPT AI
  Account, the office default stands in (FR-98).
- **The rule is in instructions, and by construction.** Sandboxes hold no
  store, ad platform or email credentials, and a GitHub token that
  cannot write (FR-19). The templates add the plain words, and the
  reviewers block a change that would reach one.
- **The lint runs as a test, not at start.** The schema checks run as AI
  Office starts (#147); the lint is about wording, for whoever writes a
  template, so it runs in `pnpm test`. It is held to the three templates
  of this issue:
  - Development's Roles are the built-in ones from before templates,
    character for character, and its QA tries a change "as a user
    would";
  - Blank has no Roles or checks.
- **A template's Skills join the library even if the Owner deleted them
  before.** As with Roles, a Skill missing from the library is added
  again by the next Floor added from the template.

## Noticed, out of scope

- **Every office Skill reaches every Role.** A Role's `skills` field is
  not what decides which Skills its sandbox is given:
  - every enabled office Skill is on for every Role until turned off;
  - the Floor admin's toggles cover only the built-in sandbox Roles
    (coder, QA, docs, designer).

  So `store-checks` also reaches a Development Floor's coder once an
  Online store Floor exists. The scenario test records it: each sandbox
  had both Skills. Mounting only a Role's own Skills, or toggles for
  library Roles, would be a change to FR-75's settings.
- **QA failures go to the last work Role** (#149): a failed price check
  on the autumn range goes to the copywriter, not the merchandiser.
- **The 3D theme is not copied onto the Floor** (#147's note), for #153.
- **docs and designer** still belong to no built-in template (#147's
  note); #151's templates may take them.
- **The fact-checker cannot open web sources** from a sandbox whose
  network is limited. Its Skill says to report such a claim as unchecked
  rather than pass or fail it.

## Output

### `pnpm lint` and `pnpm typecheck`, fresh clone at `48456c6`

```text
$ pnpm install --frozen-lockfile
Done in 1.1s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test`, without Docker, fresh clone at `48456c6`

```text
$ pnpm test --maxWorkers=4
 Test Files  249 passed (249)
      Tests  2852 passed | 411 skipped (3263)
test exit=0
```

Before this issue, at `a106b94` in the working tree: 247 files, 2834
passed, 409 skipped.

### `pnpm test` against the embedded Postgres 18.4, at `48456c6`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=4
 Test Files  249 passed (249)
      Tests  3241 passed | 22 skipped (3263)
test exit=0
```

### This issue's tests (verbose), in memory and Postgres 18.4

```text
$ SCRATCH_PG_URL=… vitest run src/templates src/floors/templates.test.ts --reporter=verbose   # packages/orchestrator
 ✓ src/templates/lint.test.ts > the glossary > is read from GLOSSARY.md: its terms, and the words it avoids
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > online-store passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > website-and-marketing passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > content-and-blog passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > every Skill two templates ship is the same in both
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > each check command's scripts are found
 ✓ src/templates/lint.test.ts > the lint catches > a word the glossary avoids, in any case or plural, but not in code
 ✓ src/templates/lint.test.ts > the lint catches > a glossary term without its capitals
 ✓ src/templates/lint.test.ts > the lint catches > a Role, or the Manager, not told that the Floor works on its repository only
 ✓ src/templates/lint.test.ts > the lint catches > instructions that do not fit their Stage's prompt
 ✓ src/templates/lint.test.ts > the lint catches > a check the first issue does not set up, or no checks at all
 ✓ src/templates/lint.test.ts > the lint catches > a Skill none of the template's Roles has, and a Skill two templates ship differently
 ✓ src/templates/load.test.ts > the built-in Floor Templates > every file under templates/ passes the schema, as part of its template
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Online store starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Website & marketing starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Content & blog starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > a Role two of them bring is the same Role, with the same Skills
 ✓ src/floors/templates.test.ts > … kept in memory > a template's missing Skills join the Skill library, enabled, so its Agents are given them; one the library has is kept
 ✓ src/floors/templates.test.ts > … kept in Postgres 18 > a template's missing Skills join the Skill library, enabled, so its Agents are given them; one the library has is kept
 ✓ src/templates/online-store.test.ts > §5 scenario 11 on an Online store Floor, in memory > adds the Floor from Online store; "add the autumn range" goes to the merchandiser then the copywriter, the brand reviewer approves, store QA runs the checks, and it awaits the Owner
 ✓ src/templates/online-store.test.ts > §5 scenario 11 on an Online store Floor, in Postgres 18 > adds the Floor from Online store; "add the autumn range" goes to the merchandiser then the copywriter, the brand reviewer approves, store QA runs the checks, and it awaits the Owner
 … (#147's loader and Floor Template cases, in memory and Postgres, all ✓)
      Tests  41 passed (41)
$ SCRATCH_PG_URL=… vitest run src/floors/templates.test.ts src/roles/routes.test.ts --reporter=verbose   # apps/server
      Tests  18 passed (18)
$ SCRATCH_PG_URL=… vitest run src/migrate.test.ts --reporter=verbose   # packages/db, with 0049 (now 0055)
      Tests  6 passed (6)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.4, Chromium), at `48456c6`

```text
$ pnpm e2e --workers=4
Running 46 tests using 4 workers
  ✓  26 [chromium] › tests/floors.spec.ts:53:1 › adds a Floor from the Floor Template picked (2.9s)
  ✓  37 [chromium] › tests/role-library.spec.ts:17:1 › makes a proofreader Role, adds a proofreader Agent to a Floor, then edits the Role's instructions (4.5s)
    > 70 |   await account.getByLabel("Account type").selectOption("xAI API key");
    > 82 |   await expect(storage).toBeChecked();
    > 121 |   await form.getByLabel("Name").fill("Work");
  ✘  29 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (7.7s)
  ✘  14 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (30.1s)
  ✘  30 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (30.3s)
  3 failed
  43 passed (2.2m)
```
