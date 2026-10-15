# Issue #151: Built-in Floor Templates: Documentation, Design system, Data & analytics, Infrastructure, Mobile app — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display). `pnpm lint`, `pnpm typecheck` and `pnpm test`
ran in a fresh `git clone` of this branch at `e42d558` (every code and
docs commit of the issue before this note), after `pnpm install
--frozen-lockfile`. The Postgres and Playwright runs were made in the
working tree at the same code.

The blocker is built on this branch: #147, Floor Templates
([`issue-147.md`](issue-147.md)), with the template format, its loader
and checks, adding a Floor from a template and the picker. #150
([`issue-150.md`](issue-150.md)) added the lint and made a template's
Skills join the Skill library, which these five use as they are.

## What was built

### Five built-in Floor Templates (`templates/`, new)

Each is a folder of `template.yaml`, `roles/<role>.md` and
`skills/<name>/SKILL.md` (PRD FR-99, FR-100).

| Template | Roles (Stage, suggested AI Provider) | Required reviewer | Check command | Skills | Icon, theme |
| --- | --- | --- | --- | --- | --- |
| **Documentation** (`documentation`) | technical writer (work, Claude); docs reviewer (review, ChatGPT); example checker (QA, Claude) | docs reviewer | `npm run docs:build && npm run check:links && npm run check:examples` | `docs-checks`, `runnable-examples` | `book-open`, `library` |
| **Design system** (`design-system`) | designer (the built-in Role), front-end developer (work, Claude); accessibility reviewer (review, ChatGPT); visual QA (QA, Claude) | accessibility reviewer | `npm run test:components && npm run test:visual && npm run check:contrast` | `component-checks`, `design-tokens` | `palette`, `atelier` |
| **Data & analytics** (`data-and-analytics`) | analytics engineer (work, Claude); data reviewer (review, ChatGPT); data-quality QA (QA, Claude) | data reviewer | `dbt deps && dbt seed --target ci && dbt run --target ci && dbt test --target ci && sqlfluff lint models` | `dbt-checks` | `chart-column`, `observatory` |
| **Infrastructure** (`infrastructure`) | platform engineer (work, Claude); security reviewer (review, ChatGPT); plan QA (QA, Claude) | security reviewer | `terraform fmt -check -recursive && terraform init -input=false -backend=false && terraform validate && terraform plan -input=false -lock=false -refresh=false && checkov --directory . --quiet` | `terraform-checks` | `server`, `data-centre` |
| **Mobile app** (`mobile-app`) | mobile developer (work, Claude); reviewer (the built-in Role); device-test QA (QA, Claude) | reviewer | `npm run test:unit && npm run test:simulator` | `mobile-checks` | `smartphone`, `device-lab` |

All five:

- start one Agent in each Role, beside the Manager, with the Merge
  Policy "send to me", Round Cap 3 and no labels of their own;
- give the Manager **planning guidance**: what each Role does, who
  reviews and checks, what to plan on its own (a page move with its
  redirects; a change that alters many snapshots; a metric with no
  definition, asked of the Owner; a destroy or replace of a resource that
  holds data; a new permission or native dependency), and what the Floor
  never acts on;
- suggest a **first set-up issue** ("Set up the docs' checks", "… the
  design system's checks", "Set up the data checks on sample data", "Set
  up the infrastructure's checks", "Set up the app's checks") that names
  every check the check command runs, a tool that does it, and
  acceptance criteria;
- say plainly, in the Manager's guidance and every Role's own
  instructions, **what the Floor never acts on** (PRD §4's "Agents
  operating live business systems"), and the reviewers mark as blocking
  a change that would reach it, and any credential in the repository:

  | Template | Never acts on |
  | --- | --- |
  | Documentation | the live docs site or a production API |
  | Design system | a package registry or a live site |
  | Data & analytics | the production warehouse or a live dashboard |
  | Infrastructure | live infrastructure or a cloud account |
  | Mobile app | the app stores or a beta-testing service |

**Checks.** Documentation, Design system and Mobile app run npm scripts
their first issue adds, with #150's setup command `if [ -f package.json
]; then npm install; fi`. Data & analytics and Infrastructure run the
PRD's own tools, as written in the command:

- **Data & analytics**: `dbt test` and SQL lint (`sqlfluff`) on a `ci`
  target that the first issue adds: a local DuckDB file built from seeds
  that stand in for each source, in a committed `profiles.yml`, with no
  credentials. Every dbt command names `--target ci`. The setup command
  is `if [ -f requirements.txt ]; then pip install -r requirements.txt;
  fi`, and the first issue's `requirements.txt` pins `dbt-duckdb`,
  `sqlfluff` and `sqlfluff-templater-dbt`.
- **Infrastructure**: `terraform plan` as the dry run, and checkov as the
  policy checks. **Never an apply**: the init leaves the backend out
  (`-backend=false`) and the plan neither locks (`-lock=false`) nor
  refreshes (`-refresh=false`), so it plans from no state and reads
  nothing deployed. There is no setup command. The first issue keeps the
  `backend` block out of the repository (the Owner's pipeline writes it)
  and lets each provider plan without credentials. The guidance, every
  Role and the Skill say that applying a merged change is the Owner's
  own pipeline's.

**Stages chosen.** The PRD names the Roles, not their Stages:

- the example checker, visual QA, data-quality QA, plan QA and
  device-test QA are in the QA Stage, so they have sandboxes to run the
  checks in;
- the docs, accessibility, data and security reviewers, and Mobile app's
  reviewer, are in the review Stage and are the required reviewers;
- none uses the docs Stage: on Documentation the technical writer's
  work *is* the docs.

**Built-in Roles.** The PRD's "designer" (Design system) and "reviewer"
(Mobile app) are the Role library's built-in designer and reviewer, and
their files are those Roles character for character. Both names are
taken in every library, so a different Role of that name would refuse
the Floor (`409 template_role_name_taken`). And a template Role is added
only where the library has no Role of its id, so different words in the
file would never reach an Agent. Design system's work Roles take turns
in this order: the designer (design tokens and styles), then the
front-end developer (markup, behaviour and tests).

Each Role's instructions are written as its Stage's prompt carries them.
A QA Role whose check or tool is missing, or (Mobile app) whose sandbox
can start no simulator or emulator, says so in its Summary rather than
failing the change for that alone, as #150's QA Roles do.

### The lint, for these five (`packages/orchestrator/src/templates/lint.ts`)

#150's lint held a template to its three templates' words. It now holds
all eight non-Development, non-Blank templates:

- **Live systems per template** (`liveSystemsOf`): the Manager's guidance
  and every Role's instructions name the repository and each live system
  of the template's own kind (the table above; a live store, an ad
  platform and customer email for #150's three). A template the lint has
  none for fails it, so a new one must say.
- **Checks may be a tool's own command** (`checkSteps`): the first issue
  names each step of the check command, an npm script by its name
  (`check:links`) and any other command as it is written (`dbt test
  --target ci`).
- **No command applies, deploys or publishes**: no step of the setup or
  check command, and no line of a shell code block in a Skill or the
  first issue, uses `apply`, `destroy`, `deploy`, `publish`, `release`,
  `upload`, `push`, `submit` or `-auto-approve`.
- **Built-in Roles**: a Role with a built-in Role's id must be exactly
  that Role; its words are the library's own, from before templates, so
  they are not linted (the built-in designer says "type", for fonts).
- **"design token"** is allowed beside the glossary's avoided "token", in
  any case and with a hyphen (the `design-tokens` Skill).

### Tests changed by the new templates

- **Ten built-in templates now**: the expected lists in `load.test.ts`,
  the server's picker test (each template's team) and `floors.spec.ts`
  (10 radios, and Infrastructure's description and team).
- **The designer is now in a starting team** (Design system), so the
  library keeps it (#147's `role_in_starting_team`):
  - `apps/server/src/roles/routes.test.ts`: the designer is
    `inStartingTeam`, and deleting it is refused with "The Design system
    Floor Template starts Floors with a designer Agent, so designer stays
    in the library."; docs is still deleted;
  - `e2e/tests/accessibility.spec.ts` opens the delete confirmation for
    docs instead, as the designer's Delete button is now disabled.

### Docs

- README, "Floor Templates": the five, their Roles and checks, and what
  each never acts on.
- [Floors and Agents](../guide/floors-and-agents.md): the five in the
  table of built-in templates; a section "Documentation, Design system,
  Data & analytics, Infrastructure and Mobile app"; the lint's new rules.
- [Setting up a Floor](../processes/setting-up-a-floor.md): the tools
  the checks need beyond Node, and that an Infrastructure Floor never
  applies.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from a fresh clone at `e42d558` (output below):
  - without Docker: **250 files, 2871 passed, 411 skipped** (the Postgres
    tests skip with the reason);
  - against an embedded **Postgres 18.4**: **250 files, 3260 passed, 22
    skipped**. The 22 are the GitHub contract against the real App (it
    needs `GITHUB_APP_ID`) and the checks that need Docker. A first
    Postgres run had one failure, in `work/queue.test.ts`, which flakes
    the same way before this issue (see "Noticed, out of scope").
- [x] **Schema and lint tests pass for all five templates.**
  - **Schema**, `packages/orchestrator/src/templates/load.test.ts`:
    - "every file under templates/ passes the schema, as part of its
      template" loads ten templates: `development`, `blank`,
      `content-and-blog`, `data-and-analytics`, `design-system`,
      `documentation`, `infrastructure`, `mobile-app`, `online-store`,
      `website-and-marketing`. Every file under `templates/` is one a
      template was loaded from;
    - one test per template, "… starts its Roles on their Stages, with
      its checks, required reviewers, Skills and first issue". It checks
      each Role's id, name, Stage, suggested AI Provider, Skills and
      count; the setup command and the check command built from its
      steps; the required reviewer; the Skills; the first issue's title,
      naming each step; and the guidance's opening line;
    - "a Role with a built-in Role's id is that Role, as the library
      starts with it": Development's three, Design system's designer and
      Mobile app's reviewer, each equal to `builtInRole(id)`.

    Each Role file passes the Role library's `createRoleRequestSchema`,
    through #147's `parseRoleDocument`.
  - **Lint**, `packages/orchestrator/src/templates/lint.test.ts` (21
    tests):
    - **`documentation`, `design-system`, `data-and-analytics`,
      `infrastructure` and `mobile-app` each pass the lint** with no
      problems, as do #150's three;
    - each check command's steps are found, for npm scripts and for
      tools' own commands;
    - each new rule catches what it is for, with its exact problem: plan
      QA and Mobile app's Manager not told their own live systems; Online
      store's words under the `infrastructure` id; a template the lint
      has no live systems for (`garden-centre`); a dbt command the first
      issue does not name; `terraform apply -auto-approve` in the check
      command; `npm publish` in a Skill's shell block, while a JSON
      `"upload"` key is left alone; Mobile app's reviewer with a sentence
      added.

    Linting the templates while they were written found one problem:
    "tokens", in the `design-tokens` Skill, which became the "design
    token" allowance. Avoided words the domains use ("lead", "type",
    "key", "macros", "message", "step", "users", "version") were kept
    out by hand as they were written.
- [x] **Test: the Infrastructure template's commands contain no apply or
      deploy step.**
      `packages/orchestrator/src/templates/infrastructure.test.ts` (4
      tests):
  - "its commands contain no apply or deploy step: the check plans, from
    no state": the setup and check commands' steps are exactly `terraform
    fmt -check -recursive`, `terraform init -input=false -backend=false`,
    `terraform validate`, `terraform plan -input=false -lock=false
    -refresh=false` and `checkov --directory . --quiet`. None matches
    apply, destroy, import, state, taint, untaint, force-unlock, deploy or
    `-auto-approve`; there is a `terraform plan`; the init has
    `-backend=false` and the plan `-lock=false` and `-refresh=false`;
  - "nor do the commands its Skill and first issue show": every line of
    their shell code blocks (the Skill shows the check command);
  - "the lint refuses one that would apply, in either command":
    `terraform apply -auto-approve` as the setup command, and `terraform
    deploy` or `terraform destroy` added to the check command, each give
    the lint's problem;
  - "tells every Role, and the Manager, never to apply a plan or act on
    live infrastructure".

**Negative checks.** Each sabotage was applied to the working tree, then
`src/templates` of `orchestrator` was run in memory (48 tests). Each was
reverted with `git checkout`, and `git status` was clean afterwards.

| Sabotage | Failed |
| --- | --- |
| Infrastructure's check command gains `terraform apply -auto-approve` | 7: the first three Infrastructure tests, Infrastructure's lint and schema tests, and two negative lint tests built on it |
| Infrastructure's setup command becomes `terraform init -input=false` | 2: the no-apply test, Infrastructure's schema test |
| Infrastructure's plan loses `-refresh=false` | 3: the two no-apply command tests, Infrastructure's schema test |
| The platform engineer is not told about live infrastructure | 5: Infrastructure's lint, two Infrastructure tests ("the lint refuses…", which lints it first, and "tells every Role…"), and two negative lint tests built on it |
| Documentation's check command drops `check:examples` | 2: Documentation's schema test, the check-steps test |
| Data & analytics' `dbt test` loses `--target ci` | 2: its schema test, the check-steps test |
| Design system's designer differs from the built-in one ("fonts" for "type") | 4: Design system's lint, the built-in Roles' load test, two negative lint tests built on it |
| Design system's accessibility reviewer is not required | 1: its schema test |
| The mobile developer's instructions say "users" | 3: Mobile app's lint, two negative lint tests built on it |

### Verified on the host

- [ ] **A Floor from each template, on a sample repository, completes one
      issue to a reviewed pull request.** Not verifiable here: there is
      no Docker for real sandboxes and agent tools, no real AI Provider
      and no GitHub. On the host, for each template:
  1. Add the Floor from it on a sample repository (a VitePress site, a
     component library with stories, a dbt repository, a Terraform root
     module with no `backend` block, a React Native app).
  2. File its suggested set-up issue first and merge its pull request.
  3. File one issue of its kind and hand it to the Manager; it should
     reach a pull request its required reviewer approved and QA passed,
     awaiting the Owner.

  The Data & analytics, Infrastructure and Mobile app Floors also need
  their tools in the sandbox (below).

### `pnpm e2e`

The whole suite (46 tests) ran with 4 workers against the embedded
Postgres: **43 passed, 3 failed**.

- The three failures are the ones recorded since #146
  (`agent-editor.spec.ts`, `gateway-requests.spec.ts`,
  `manager-chat.spec.ts`), on the same lines as in
  [`issue-150.md`](issue-150.md#pnpm-e2e). They look on the Admin page
  for what #165 moved to AI Settings.
- The specs this issue changed pass:
  - `floors.spec.ts` > "adds a Floor from the Floor Template picked": 10
    radios, and Infrastructure's accessible description is its
    description and its team ("Starting team: Manager, platform
    engineer, security reviewer, plan QA");
  - `accessibility.spec.ts` > "the editors and forms that open in place"
    (light and dark), with the docs Role's delete confirmation;
  - `role-library.spec.ts`, whose Role library starts with the same five
    built-in Roles.

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
  `LD_LIBRARY_PATH`.

### Not verifiable in this sandbox

- **Docker**: the Testcontainers path of the Postgres tests and of `pnpm
  e2e`. Both ran against the embedded Postgres 18.4 instead; they run in
  CI.
- **Real sandboxes, agent tools and Models**: how well a real Model
  follows the templates' instructions, keeps to its Role's part, reads a
  plan, or judges a visual snapshot.
- **The checks' real tools.** None of VitePress or MkDocs, `lychee` or
  `linkinator`, Vitest or Jest, Playwright's screenshots, `axe`, dbt,
  DuckDB, sqlfluff, Terraform, checkov, Jest for React Native, Maestro
  or Detox ran here. In particular these are for the host:
  - whether `terraform plan` after `terraform init -backend=false` plans
    a real root module with no credentials, given the first issue's
    provider settings. The AWS provider may still want stand-in
    credentials, and plan QA is told to say so rather than ask for any;
  - whether the sandbox images' Python has `pip` for the Data &
    analytics setup command (the images are `node:26.10.0-bookworm`);
  - visual snapshots need a browser in the sandbox: `npx playwright
    install` with its system libraries.
- **The new 3D themes.** The theme ids are in the templates, but nothing
  draws them yet (#153), and there is no GPU or display here.

## Notes

- **Two templates run tools, not npm scripts.** The PRD names `dbt test`
  and `terraform plan`, so their check commands run them as written, and
  the Infrastructure test can see that no step applies. Hiding them in npm
  scripts would hide an apply too. The other three wrap their tools in
  npm scripts, as #150's do, so the check command stays the same whatever
  the repository's generator, test runner or mobile framework.
- **No credentials, by design.** The Data & analytics checks run on a
  local DuckDB file, and the Infrastructure plan on no state. A sandbox
  never needs a warehouse or cloud credential, and AI Office has no way to
  give it one. The reviewers block a `ci` target that is not a local
  file, and a workflow or command that applies.
- **Simulator tests in a Linux sandbox.** An iOS simulator needs macOS,
  and an Android emulator hardware acceleration. The first issue's
  `test:simulator` fails saying so where none can start, never passing
  without running; device-test QA reports it, and the repository's CI
  runs them.
- **Infrastructure has no setup command.** `terraform init` is a step of
  the check command instead, so a sandbox without Terraform still starts,
  and plan QA can report the missing tool.
- **The lint keys live systems by template id.** The format has no field
  for them, and adding one would change FR-99's format; the lint is for
  whoever writes a built-in template, and fails a template it has none
  for.

## Noticed, out of scope

- **The sandbox images carry no tools beyond Node, pnpm, git, `gh` and
  `jq`.** dbt, sqlfluff, Terraform, checkov, a browser for Playwright
  and the mobile toolchains are not on them. The issue puts images with
  more toolchains out of scope. Until an image carries them, a Data &
  analytics Floor's setup command installs dbt with `pip` (if the image's
  Python has it), and an Infrastructure Floor needs a setup command of
  the Owner's that installs Terraform and checkov. The setup guide says
  so.
- **The built-in Roles carry no template's live-systems rule.** Mobile
  app's reviewer and Design system's designer are the library's own, so
  they are not told about the app stores or a package registry. The
  Manager's guidance and the template's other Roles are, and the reviewer
  still reviews "safely". Telling them would mean changing the built-in
  Roles every Floor has.
- **Every office Skill reaches every Role** (#150's note): so the
  designer, which has no Skills, is given `design-tokens` in practice,
  and `terraform-checks` reaches a Development Floor's coder.
- **`work/queue.test.ts` > "two coders share four issues…", in
  Postgres, is flaky.** It expects Grace's `agent.queue_changed` counts
  to be `[1, 0, 1, 0]` and sometimes sees `[1, 0]`. It failed once in
  this issue's first full Postgres run, and in 1 of 3 runs of the file
  alone. At `69bb624`, before this issue, it failed in 5 of 10 runs of
  the file alone. It touches no template.
- **The docs Role** still belongs to no built-in template.

## Output

### `pnpm lint` and `pnpm typecheck`, fresh clone at `e42d558`

```text
$ pnpm install --frozen-lockfile
Done in 1.3s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test`, without Docker, fresh clone at `e42d558`

```text
$ pnpm test --maxWorkers=3
 Test Files  250 passed (250)
      Tests  2871 passed | 411 skipped (3282)
test exit=0
```

Before this issue, at `48456c6` ([`issue-150.md`](issue-150.md)): 249
files, 2852 passed, 411 skipped.

### `pnpm test` against the embedded Postgres 18.4, at `e42d558`

```text
$ SCRATCH_PG_URL=postgres://postgres@localhost:54329/postgres pnpm test --maxWorkers=4
 Test Files  250 passed (250)
      Tests  3260 passed | 22 skipped (3282)
test exit=0
```

The first run, while the fresh clone's lint and typecheck ran beside it:

```text
 FAIL  |@ai-office/orchestrator| src/work/queue.test.ts > the work queue, in Postgres 18 > two coders share four issues, the next going to whichever coder is free
AssertionError: expected [ 1, +0 ] to deeply equal [ 1, +0, 1, +0 ]
 ❯ setup.limit.current src/work/queue.test.ts:243:26
    243|       expect(graceQueue).toEqual([1, 0, 1, 0]);
 Test Files  1 failed | 249 passed (250)
      Tests  1 failed | 3259 passed | 22 skipped (3282)
test exit=1
```

The same file alone against Postgres at `69bb624`, the first six of ten
runs (the other four: two failed, two passed):

```text
      Tests  1 failed | 37 passed (38)
      Tests  38 passed (38)
      Tests  1 failed | 37 passed (38)
      Tests  1 failed | 37 passed (38)
      Tests  38 passed (38)
      Tests  38 passed (38)
```

### This issue's tests (verbose), in memory

```text
$ vitest run src/templates/lint.test.ts src/templates/load.test.ts src/templates/infrastructure.test.ts --reporter=verbose   # packages/orchestrator
 ✓ src/templates/infrastructure.test.ts > the Infrastructure Floor Template > its commands contain no apply or deploy step: the check plans, from no state
 ✓ src/templates/infrastructure.test.ts > the Infrastructure Floor Template > nor do the commands its Skill and first issue show
 ✓ src/templates/infrastructure.test.ts > the Infrastructure Floor Template > the lint refuses one that would apply, in either command
 ✓ src/templates/infrastructure.test.ts > the Infrastructure Floor Template > tells every Role, and the Manager, never to apply a plan or act on live infrastructure
 ✓ src/templates/load.test.ts > the built-in Floor Templates > every file under templates/ passes the schema, as part of its template
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Documentation starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Design system starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Data & analytics starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Infrastructure starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > Mobile app starts its Roles on their Stages, with its checks, required reviewers, Skills and first issue
 ✓ src/templates/load.test.ts > the built-in Floor Templates > a Role with a built-in Role's id is that Role, as the library starts with it
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > documentation passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > design-system passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > data-and-analytics passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > infrastructure passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > mobile-app passes the lint
 ✓ src/templates/lint.test.ts > the built-in Floor Templates' words > each check command's steps are found: npm scripts by name, a tool's own command as written
 ✓ src/templates/lint.test.ts > the lint catches > a check the first issue does not set up, or no checks at all
 ✓ src/templates/lint.test.ts > the lint catches > each template's own live systems, and a template whose live systems it does not know
 ✓ src/templates/lint.test.ts > the lint catches > a command, or a command a Skill shows, that would apply, deploy or publish
 ✓ src/templates/lint.test.ts > the lint catches > a built-in Role's id with other words; the built-in Roles' own words are not linted
 … (#147's and #150's loader, schema and lint cases, all ✓)
      Tests  46 passed (46)
```

### The server's tests this issue changed, in memory and Postgres 18.4

```text
$ SCRATCH_PG_URL=… vitest run src/floors/templates.test.ts src/roles/routes.test.ts --reporter=verbose   # apps/server
 ✓ src/floors/templates.test.ts > Floor Templates through the API > in memory > the picker lists the built-in templates, Development first, with each one's starting team
 ✓ src/floors/templates.test.ts > Floor Templates through the API > in Postgres 18 > the picker lists the built-in templates, Development first, with each one's starting team
 ✓ src/roles/routes.test.ts > the Role library through the API, in memory > a Role in use cannot be deleted; once no Agent fills it, it can
 ✓ src/roles/routes.test.ts > the Role library through the API, in Postgres 18 > a Role in use cannot be deleted; once no Agent fills it, it can
 …
      Tests  18 passed (18)
```

### `pnpm e2e` (`E2E_POSTGRES_URL`, embedded Postgres 18.4, Chromium), at `e42d558`

```text
$ pnpm e2e --workers=4
Running 46 tests using 4 workers
  ✓   6 [chromium] › tests/accessibility.spec.ts:383:3 › the editors and forms that open in place (light) (18.1s)
  ✓   7 [chromium] › tests/accessibility.spec.ts:383:3 › the editors and forms that open in place (dark) (17.7s)
  ✓  26 [chromium] › tests/floors.spec.ts:53:1 › adds a Floor from the Floor Template picked (2.8s)
  ✓  37 [chromium] › tests/role-library.spec.ts:17:1 › makes a proofreader Role, adds a proofreader Agent to a Floor, then edits the Role's instructions (4.1s)
    > 70 |   await account.getByLabel("Account type").selectOption("xAI API key");
    > 82 |   await expect(storage).toBeChecked();
    > 121 |   await form.getByLabel("Name").fill("Work");
  ✘  29 [chromium] › tests/gateway-requests.spec.ts:24:1 › the live stream shows a new request, whose detail opens (7.6s)
  ✘  14 [chromium] › tests/agent-editor.spec.ts:59:1 › an Agent's new AI Provider and Model are what its next task uses (30.2s)
  ✘  30 [chromium] › tests/manager-chat.spec.ts:110:1 › chats with a Floor's Manager: commands in plain code, a reply streamed in (30.3s)
  3 failed
  43 passed (2.4m)
```
