# Floors and Agents

Floors, Floor Templates, Agents and their editors, Token Caps and the Git identity. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## Floors

Each Floor is one repository the GitHub App is installed on, and each
repository is at most one Floor, archived or not (matched by GitHub's
repository id, so a rename does not matter). In Admin, **Floors** lists the
Floors in use, each with the [Floor Template](#floor-templates) it
started from, and the repositories the App is installed on; **Add Floor**
makes one from the template picked above them. Each Floor's admin page (`/floor-settings/<id>`, PRD FR-66) has
its settings, its team and Agents (see [A Floor's team](#a-floors-team)),
its Skills, its token usage and caps, and an **Archive** action.

[Setting up the GitHub App and your Floors](../../docs/processes/setting-up-a-floor.md) is the
Owner's guide to the GitHub side: creating and installing the App, its
permissions, protecting the default branch for each Merge Policy, the
labels AI Office creates, and what intake picks up.

- A new Floor takes its id from the repository's name (`web-shop`, then
  `web-shop-2` for another owner's `web-shop`), its name and default branch
  from GitHub. Its team, setup and test commands, Merge Policy, Round Cap
  and required reviewers come from its Floor Template. From Development,
  the default, its Merge Policy is "send to me", its Round Cap 3 and its
  setup and test commands empty. Plan approval is on, "Most Agents" is 8,
  "Manager spins off work from chat" is on, and it overrides no Token Cap
  or concurrency limit, whatever the template.
- Settings (PRD FR-7) are changed with `PATCH /api/floors/:floorId`. A new
  default branch must exist on GitHub. Each change records a
  `config.changed` event naming the settings, never their values.
- **Name** (FR-7, `name`): what the Office shows for the Floor everywhere:
  the lift's floor picker, the wall board, the Manager chat, the Floor's
  admin page, the Notice Board and Activity Feed filters, Notices,
  Analytics, Agent Settings, the Gateway's requests and keys, the
  Manager's system prompt and the Communications Agent's messages and
  Digests. A new Floor starts with its repository's name; the Owner
  renames it in General Settings → **Floors** (the pencil beside each Floor in use)
  or in its settings. A chosen name is trimmed, 1 to 60 characters, and
  unique among the Floors in use whatever its case (`409
  floor_name_taken` otherwise; an archived Floor's name is free). The
  Floor's id, and so its addresses (`/floors/web-shop/manager`), never
  change, and its repository is still shown beside the name. A rename
  records `floor.renamed` (the new and previous names) as well as
  `config.changed`, so open pages show the new name at once, and the
  Activity Feed lists it under **Floors**. The configuration export
  carries each Floor's name, and importing one renames a Floor here.
- **Most Agents** (FR-10, `mostAgents`) caps how many Agents the Floor
  has besides its Manager, the Owner's and Contractors alike: a whole
  number from 1 (at most 1,000), or **No limit** (`null`). Lowering it
  below the team removes no one; it only stops more being added.
- **Manager spins off work from chat** (FR-24, `spinOffFromChat`, on by
  default) lets the Manager turn chat requests into Batches it files and
  staffs with [Contractors](#contractors); off, it only talks and takes
  typed commands.
- **Hourly Status updates while Agents work** (FR-23a,
  `hourlyStatusUpdates`, on by default) gives the Floor's
  [Status update](web-app.md#the-status-update) every hour while its
  Agents are working; off, only the Owner's and the day's own.
- **Required reviewers** (FR-27) are chosen in the settings among the
  Floor's reviewer Agents, at least one (`requiredReviewerAgentIds`; one
  that is not a reviewer is `422 not_a_reviewer`). They follow the team:
  a removed reviewer is no longer required, and a Floor with reviewers but
  none required requires its oldest.
- Archiving (`POST /api/floors/:floorId/archive`) stops the Floor's intake
  and hides it from the Floor list. Its row and history are kept, and its
  settings can no longer be changed. Its Agents' Gateway Keys, the
  Manager's too, call no model from then on (pen-testing G1-4; see
  [Gateway Keys](ai-gateway.md#gateway-keys)).
- `GET /api/github/repositories` lists every GitHub App's and access
  token's repositories, each once, with the Floor each one is (if any).
  Without an App or a token it answers `503 github_not_configured`. When
  GitHub cannot be reached it answers `502 github_unavailable`.
- The GitHub Apps and access tokens are the Owner's to add in Floor
  Settings' **GitHub** card, and are kept in the `github_connections`
  table, the private key and tokens sealed with `ENCRYPTION_KEY` (ADR
  0011). `GET /api/github/connections` lists them, Apps first, with an
  App's ID and the last characters of its key or the token, never the
  secrets; `POST /api/github/connections/apps` (`appId`, `privateKey`,
  optional `name`) adds an App, `409 github_app_taken` if it is added
  already; `POST /api/github/connections/access-tokens` (`token`,
  `readOnlyToken`, optional `name`) adds a token; `PATCH
  /api/github/connections/:id` changes its `name` or `enabled`; `DELETE`
  removes it. Each change is used at once, with no restart; one made in
  the database by another process is taken up within a minute.
- `GITHUB_API_URL` points the App at GitHub Enterprise Server's API
  (default `https://api.github.com`).

### Floor Templates

Adding a Floor means picking a Floor Template (PRD FR-6, FR-97): the
starting set-up of its team, settings and labels. **Add a Floor** in General Settings
shows each template's icon, name, description and starting team, with
Development chosen; the **Add Floor** beside a repository uses the one
chosen. Adding a Floor from a template:

1. adds each of the template's Roles to the [Role library](#roles-and-the-role-library)
   where the library has no Role of that id. A Role it has already,
   perhaps edited by the Owner, is kept as it is. Each one added is a
   `role.created` event naming the template. A template Role whose name
   another Role in the library has, under another id, refuses the Floor
   (`409 template_role_name_taken`) before anything changes;
2. adds each of the template's Skills to the office
   [Skill library](notices-and-skills.md#the-skill-library) where the
   library has no Skill of that name, so its Agents are given them in
   their sandboxes. A Skill it has already, perhaps edited by the Owner,
   is kept. A built-in template ships with AI Office, reviewed as part of
   it, so its Skills start enabled, with the source "From a Floor
   Template". Each one added is a `skill.added` event naming the template;
3. creates the template's labels on the repository, leaving one that is
   there already as it is;
4. gives the Floor its team: a Manager, then as many Agents of each Role as
   the template says, each on its Role's suggested AI Provider and Model.
   The Manager's own instructions are the template's planning guidance
   and suggested first set-up issue;
5. gives it the template's setup and test commands, Merge Policy, Round
   Cap and required reviewers (the template's review-Stage Roles whose
   Agents every Review Loop round needs).

The Floor remembers which template it started from, by id and by name as
it was then, and shows it in General Settings, on its admin page ("It started from
the Development Floor Template.") and in its `floor.created` event. It
keeps the template's 3D theme too (`theme` on the Floor, PRD FR-57,
FR-99), which dresses it in the Office: stock shelves and parcels for an
Online store, server racks for Infrastructure (see
[the 3D Office](web-app.md#the-3d-office)). The theme is decoration only.
Nothing reads the template again: everything it set up stays editable,
and a Floor keeps working, and keeps its look, if its template is changed
or removed. Floors added before Floor Templates are recorded as
Development, which set them up the same way, in its `office` theme; a
Floor added from a template before themes takes that template's theme.

The built-in templates are:

| Template | Its team besides the Manager | Its settings |
| --- | --- | --- |
| **Development** (the default) | a coder, a reviewer (its required reviewer) and a QA Agent, in the built-in Roles | Merge Policy "send to me", Round Cap 3, no setup or test command, no labels; the Manager has no instructions of its own |
| **Blank** | none: the Owner adds Agents in any Role in Floor Settings | as Development's, with no required reviewer; the Manager's instructions say the Floor has no team yet |
| **Online store** | a merchandiser, a copywriter and a storefront developer (work), a brand reviewer (review, its required reviewer) and store QA | checks: theme check, links, prices, images and accessibility; Skills `product-data` and `store-checks`; theme `stockroom` |
| **Website & marketing** | a web developer, a copywriter and an SEO specialist (work), and a conversion reviewer (review, its required reviewer) | checks: build, links and Lighthouse; Skills `site-checks` and `seo-basics`; theme `studio` |
| **Content & blog** | a writer and an SEO specialist (work), an editor (review, its required reviewer) and a fact-checker (QA) | checks: Markdown lint, links and spelling; Skills `content-checks`, `fact-checking` and `seo-basics`; theme `editorial` |
| **Documentation** | a technical writer (work), a docs reviewer (review, its required reviewer) and an example checker (QA) | checks: the docs build, links and runnable examples; Skills `docs-checks` and `runnable-examples`; theme `library` |
| **Design system** | the built-in designer and a front-end developer (work), an accessibility reviewer (review, its required reviewer) and visual QA | checks: component tests, visual snapshots and contrast; Skills `component-checks` and `design-tokens`; theme `atelier` |
| **Data & analytics** | an analytics engineer (work), a data reviewer (review, its required reviewer) and data-quality QA | checks: `dbt test` and `sqlfluff lint` on the sample data's `ci` target; Skill `dbt-checks`; theme `observatory` |
| **Infrastructure** | a platform engineer (work), a security reviewer (review, its required reviewer) and plan QA | checks: `terraform fmt`, `validate`, `plan` from no state, and checkov's policy checks, never an apply; Skill `terraform-checks`; theme `data-centre` |
| **Mobile app** | a mobile developer (work), the built-in reviewer (its required reviewer) and device-test QA | checks: unit and simulator tests; Skill `mobile-checks`; theme `device-lab` |

#### Online store, Website & marketing and Content & blog

These three set up Floors that are not for software (PRD FR-100, §5
scenario 11). They share their settings' shape:

- **Each works on its repository only.** Every Role's instructions, and
  the Manager's planning guidance, say plainly that the Floor never acts
  on a live store, an ad platform or customer email (PRD §4). An issue
  that needs one (publishing a theme, a live price, a newsletter, an ad)
  is for the Owner: the Manager says so and asks with a Notice. Copy for
  an ad or an email can still be written as a file in the repository. The
  reviewers make blocking any change that would reach one, such as a
  workflow that publishes the theme or sends email.
- **Checks are npm scripts.** Each template's check command (the Floor's
  test command) runs its checks one after another, such as Online store's
  `npm run check:theme && npm run check:links && npm run check:prices &&
  npm run check:images && npm run check:accessibility`, and its setup
  command is `if [ -f package.json ]; then npm install; fi`. The Owner
  changes either in Floor Settings, for a repository that uses pnpm or
  yarn, say.
- **The first set-up issue adds them.** The Manager suggests filing it
  first ("Set up the store's checks", "Set up the site's checks", "Set up
  the blog's checks"): it names each script, a tool that does it, and
  asks for each to fail naming the file. Until it is merged, a QA Agent
  whose check is missing says so rather than failing for that alone. The
  template's Skill (`store-checks`, `site-checks`, `content-checks`) says
  how each check is set up and run.
- **All three send each pull request to the Owner** (Merge Policy "send
  to me", Round Cap 3).
- **Their Roles and Stages.** The reviewers (brand, conversion, editor)
  suggest ChatGPT, so each pull request is reviewed by another AI
  Provider than the one that wrote it; the rest suggest Claude. Store QA
  runs the store's checks and checks the change's links, prices and
  images. Content & blog's fact-checker is in the QA Stage, so it has a
  sandbox: it runs the blog's checks and checks each claim of fact
  against its source. Website & marketing has no QA Agent, so its work
  Roles run the checks before they finish, and review leads to the Merge
  Policy.
- **Shared Roles.** The copywriter (Online store and Website &
  marketing) and the SEO specialist (Website & marketing and Content &
  blog) are one Role each in the library, the same in both templates, as
  is the `seo-basics` Skill.
- **Several work Roles on one issue.** Each Manager's guidance gives the
  order its work Roles take turns in when an issue needs more than one:
  on Online store the merchandiser, then the copywriter, then the
  storefront developer (a new product range is the merchandiser, then
  the copywriter); on Website & marketing the web developer, then the
  copywriter, then the SEO specialist; on Content & blog the writer, then
  the SEO specialist. See
  [several work Roles on one issue](batches-and-memory.md#several-work-roles-on-one-issue).

#### Documentation, Design system, Data & analytics, Infrastructure and Mobile app

These five (PRD FR-100) are built the same way as the three above: one
Agent in each Role, the Merge Policy "send to me", Round Cap 3, no
labels, reviewers suggesting ChatGPT and the rest Claude, and a first
set-up issue the Manager suggests filing first. What differs:

- **What each Floor never acts on.** Every Role's instructions, and the
  Manager's guidance, name the live systems of its kind of work, and an
  issue that needs one is for the Owner:

  | Template | Never acts on | Its reviewer blocks |
  | --- | --- | --- |
  | Documentation | the live docs site or a production API | a workflow that publishes the site, an example that calls a production API |
  | Design system | a package registry or a live site | a workflow that publishes the package or deploys its stories |
  | Data & analytics | the production warehouse or a live dashboard | a `ci` target that is not a local file, a workflow that runs the models in production |
  | Infrastructure | live infrastructure or a cloud account | a workflow that applies the plan, a check command that applies, deploys or imports |
  | Mobile app | the app stores or a beta-testing service | (the built-in reviewer, which reviews the change as on any software Floor) |

  Every reviewer also blocks a credential in the repository.
- **Checks are npm scripts or a tool's own commands.** Documentation
  (`npm run docs:build && npm run check:links && npm run check:examples`),
  Design system (`test:components`, `test:visual`, `check:contrast`) and
  Mobile app (`test:unit`, `test:simulator`) run npm scripts their first
  issue adds, with the setup command `if [ -f package.json ]; then npm
  install; fi`; a repository whose tools are not npm packages (MkDocs,
  Gradle, Flutter) wraps them in the same scripts. The other two run the
  PRD's own tools:
  - **Data & analytics**: `dbt deps && dbt seed --target ci && dbt run
    --target ci && dbt test --target ci && sqlfluff lint models`, with the
    setup command `if [ -f requirements.txt ]; then pip install -r
    requirements.txt; fi`. The first issue adds a `ci` target in a
    committed `profiles.yml`: a local DuckDB file built from seeds that
    stand in for each source, with no credentials. No dbt command on the
    Floor names another target.
  - **Infrastructure**: `terraform fmt -check -recursive && terraform
    init -input=false -backend=false && terraform validate && terraform
    plan -input=false -lock=false -refresh=false && checkov --directory .
    --quiet`, with no setup command. The plan is the dry run: it never
    reaches the remote state, never locks it and never reads what is
    deployed, so it plans the whole configuration from nothing. The first
    issue keeps the `backend` block out of the repository (the Owner's own
    pipeline writes it) and lets each provider plan without credentials.
    **Nothing on the Floor applies**: no command applies, destroys,
    imports or changes state, a test says so
    (`packages/orchestrator/src/templates/infrastructure.test.ts`), and
    applying a merged change is the Owner's pipeline's.
- **Missing tools are reported, not failed.** The sandbox images carry
  Node and pnpm, not dbt, sqlfluff, Terraform, checkov or a simulator.
  The setup command installs what the repository lists where it can; a
  QA Agent whose check or tool is missing, or (on Mobile app) whose
  sandbox can start no simulator or emulator, says so in its Summary
  rather than failing the change for that alone. Change the setup and
  test commands in Floor Settings for another stack.
- **Built-in Roles.** Design system's designer and Mobile app's reviewer
  are the Role library's own designer and reviewer, the same in their
  templates as the library starts with them: a template Role is added
  only where the library has no Role of its id, and these names are
  taken. Design system is the only one of the five with two work Roles:
  the designer (design tokens and styles) takes its turn before the
  front-end developer (markup, behaviour and tests). Once visual QA has
  passed a pull request, the designer also reviews its UI against the
  repository's style guide, as on any Floor with a designer (see
  [the designer](issue-pipeline.md#the-designer)).
- **The QA Roles.** The example checker runs every code example the change
  touches as a reader would; visual QA looks at each differing snapshot
  and never updates a baseline itself; data-quality QA checks the
  change's rows against the seeds; plan QA reads the plan for anything it
  would destroy or replace; device-test QA tries the change on a small
  and a large screen, in light and dark mode.

#### The template format

Each built-in template is a folder under `templates/` in the AI Office
repository, so a new one is a pull request (PRD FR-99, FR-100). The
folder's name is the template's id (`templates/development`):

```text
templates/<id>/template.yaml          the manifest
templates/<id>/roles/<role id>.md    each of its Roles
templates/<id>/skills/<name>/…       each of its Skills (SKILL.md and its files)
```

`template.yaml` holds:

```yaml
name: Development                # at most 40 characters
description: A software team…    # one line, for the picker
icon: code                       # code, square, shopping-bag, megaphone, pen-line,
                                 # book-open, palette, chart-column, server or smartphone
theme: office                    # the 3D theme its Floor is dressed in: office, stockroom,
                                 # studio, editorial, library, atelier, observatory,
                                 # data-centre or device-lab
roles:                           # besides the Manager, in the team's order
  - role: coder                  # roles/coder.md
    count: 1                     # 0 to 10; 0 adds the Role without an Agent
settings:
  setupCommand: ""
  testCommand: ""
  mergePolicy: send_to_me        # or auto_merge
  roundCap: 3                    # 1 to 10
  requiredReviewers: [reviewer]  # review-Stage Roles it starts Agents in
manager:
  planningGuidance: ""           # how its Manager plans this kind of work
  firstIssue: null               # or { title, body }: the set-up issue to suggest first
labels:                          # created on the repository; never AI Office's own
  - { name: product, color: c2e0c6, description: A product's data }
```

Each `roles/<role id>.md` is a Role in the library: YAML frontmatter with
its `name`, `stage`, one-line `description`, `skills` (each a Skill in the
template's `skills/` folder), `deskDressing`, `aiProvider` and `model`
(either null for the default), then its instructions as Markdown, exactly
as its Stage's prompt carries them. Each `skills/<name>/` is a Skill in
the [Agent Skills format](notices-and-skills.md#the-skill-library), whose
`SKILL.md` names it as its folder is named.

The built-in templates are loaded and checked as AI Office starts. Every
file under `templates/` must be part of a template, and every template
must hold together: the Roles its manifest lists each have a file and no
others do, its required reviewers are review-Stage Roles it starts Agents
in, and its Roles' Skills are beside them. A Role two templates both bring
is one Role in the library, so its files must be the same. A file that
fails any of this stops AI Office starting, with its path and what is
wrong:

```text
AI Office failed to start: /app/templates/blank/template.yaml: settings.roundCap: The Round Cap is at least 1.
```

A lint, run by the tests (`packages/orchestrator/src/templates/lint.ts`),
holds a template's words to more than the schema does. It reads
`GLOSSARY.md` and checks that the template:

- uses none of the words the glossary lists under _Avoid_ (in any case or
  plural; code is not prose, so `` `inline code` `` and code blocks are
  left out), except "run", "command", "report" and "character", which
  the instructions need in another sense;
- writes the glossary's terms with their capitals ("the Owner", "a
  Handoff");
- tells every Role, and the Manager, that the Floor works on its
  repository only, never on the live systems the lint names for the
  template (`liveSystemsOf`): a live store, an ad platform or customer
  email for the three above, and for the five others the table above
  says. A template the lint has no live systems for fails it;
- writes each Role's instructions as its Stage's prompt carries them: a
  work Role's as `- ` list items, a QA or docs Role's as a numbered list
  from 2, and a review Role's as paragraphs;
- runs its checks as npm scripts or a tool's own commands, each named by
  its first issue (a script by its name, a command as it is written);
- has no command, and shows none in a Skill's or the first issue's shell
  code blocks, that applies, destroys, deploys, publishes, releases,
  uploads, pushes or submits;
- ships only Skills its Roles have, and each Skill the same in every
  template that ships it;
- brings a built-in Role, if any, exactly as the library starts with it.
  Its words are the library's own, from before templates, so they are
  not linted ("design token" is allowed beside the glossary's avoided
  "token").

It holds every built-in template but two to all of this. Development's
Roles are the built-in ones from before templates, character for
character, and Blank has no Roles, so neither is linted.

- **API.** `GET /api/floor-templates` lists the templates, the built-in
  ones (Development first) then the Owner's own by name, each with its
  starting team (the Manager, then each Role it starts Agents in, named
  as the library has it), whether it is `builtIn` and whether it is
  `enabled`, and `defaultTemplate`. The picker offers the enabled ones.
  `POST /api/floors` takes `{"repository": "owner/name", "template":
  "blank"}`; without `template` it is Development. A template there is
  not, or one waiting for review, is `422 template_not_found`.
- **The Role library** keeps the Roles a built-in template starts Floors
  with: deleting one is `409 role_in_starting_team`, naming the template.
  The Owner's own templates hold their own copy of their Roles, so they
  keep nothing in the library.

#### Your own Floor Templates

In **Admin → Floor Templates** (`/general-settings/templates`, PRD FR-101) the Owner
makes templates of their own. The page lists every template with its kind
(**Built in**, **Yours** or **Waiting for review**) and starting team, and
each one can be opened, duplicated and exported; the Owner's own can be
deleted. The built-in templates are read-only: opening one shows its full
contents, and changing it means duplicating it and editing the copy
(`409 template_built_in` for an edit, a deletion or a review of a built-in
one).

- **Duplicate and edit.** **Duplicate** copies a template as "<its name>
  copy" (then "copy 2", …) and opens the copy in its editor: its name,
  description, icon and 3D theme; its Roles and how many Agents of each,
  chosen from the Role library; its setup and check commands, Merge
  Policy, Round Cap and required reviewers; the Manager's planning
  guidance and suggested first issue; and its labels. Saving sends only
  what changed, and the `floor_template.changed` event names which parts.
- **Save a Floor as a template.** A Floor's admin page has **Save as a
  Floor Template**: a name and a description, and the template is the
  Floor's set-up as it is. Its Roles are those of the Floor's Agents (not
  the Manager, nor one leaving), each with how many Agents fill it, in
  the team's order; its settings are the Floor's setup and test commands,
  Merge Policy and Round Cap, and its required reviewers the Roles of the
  Floor's required reviewer Agents; the Manager's own instructions become
  its planning guidance (a template's guidance and first issue were joined
  into them when the Floor was added, so a Floor added from the new
  template gets the same instructions); its theme is the Floor's; its
  icon and labels are those of the template the Floor started from, if
  that is still here (a Floor keeps no record of its labels). An Agent's
  own AI Provider, Model, effort, instructions and Token Caps are not part
  of a template: a new Floor's Agents start on their Roles' suggestions.
- **Each template holds its own Roles and Skills.** Whenever the Owner
  makes or edits a template, each of its Roles is copied in as the Role
  library has it (a Role the library no longer has keeps the template's
  copy), and each of their Skills as the Skill library has it. So a
  template is whole when exported, and nothing depends on the libraries
  afterwards: adding a Floor from it adds its missing Roles and Skills to
  the libraries, as a built-in template does, and keeps the libraries'
  own where they have them.
- **Export.** **Export** downloads `<id>.floor-template.json`
  (`floorTemplateBundleSchema`): `{"format": "ai-office.floor-template",
  "version": 1, "exportedAt", "id", "files"}`, where `files` are the
  template's folder in the [format above](#the-template-format)
  (`template.yaml`, `roles/<role id>.md`, `skills/<name>/…`), each `{path,
  content}`. A built-in template can be exported too.
- **Import from a file or Git.** **Import a Floor Template** takes such a
  file, or a public Git repository over HTTPS (with a branch or tag, and
  the folder of its `template.yaml` when the repository holds several).
  The repository is cloned as a [Skill's](notices-and-skills.md#the-skill-library)
  is: shallowly, with no hooks, no LFS filters and no submodules, into a
  scratch directory deleted afterwards, reading regular text files only
  and refusing a symbolic link, and never from an
  [internal address](ai-gateway.md#internal-addresses) the Owner has not
  allowed. Either way the folder is checked exactly
  as a built-in template is, and a file that fails is refused with its
  path and what is wrong (`422 invalid_template`). A name another
  template has is refused (`409 template_name_taken`): import it under
  another name. Its id is the file's (or the folder's name), or the next
  free one.
- **Reviewed before it is enabled.** Role instructions and Skills reach
  models (ADR 0003), so an imported template arrives **disabled**: the
  picker does not offer it and no Floor can be added from it. Opening it
  shows where it came from, every Role's instructions, every Skill's
  files, its settings, the Manager's guidance and its labels, and its
  clashes with the libraries:
  - a Role the Role library has under the same id but differently: a
    Floor from the template gets the library's;
  - a Role whose name another library Role has under another id: adding a
    Floor from it is refused until one is renamed;
  - a Skill the Skill library has under the same name but differently: a
    Floor from the template keeps the library's.

  **I have read it: enable** sends the digest of the contents shown, so
  the review covers exactly what was read; if the template changed since,
  it is refused (`409 template_changed`). A copy of a template not yet
  reviewed waits for review too.
- **Deleting one** keeps every Floor added from it as it is: a Floor keeps
  its template's name and theme, and nothing reads the template again.
- **Every add, change and removal is in the Activity Feed**:
  `floor_template.added` (with its source: duplicated, saved from a Floor,
  imported from a file or Git, and whether it is enabled),
  `floor_template.changed` (`edited` with the parts, `reviewed`, or
  `replaced` by a configuration import) and `floor_template.removed`.
- **Stored in AI Office**, in the `floor_templates` table: each one's
  files, digest, source (and Git origin) and when it was reviewed. They
  are part of [configuration export and import](running.md#configuration-export-and-import).
- **API.** `GET /api/floor-templates/:id` gives a template's full
  contents and clashes; `POST /api/floor-templates` saves a Floor
  (`{floorId, name, description}`); `POST …/:id/duplicate` (`{name?}`),
  `PATCH …/:id` (any of `name`, `description`, `icon`, `theme`, `roles`,
  `settings`, `manager`, `labels`) and `DELETE …/:id`; `GET …/:id/export`;
  `POST /api/floor-templates/import` (`{bundle, name?}`) and
  `…/import/git` (`{url, ref?, path?, name?}`); and `POST …/:id/review`
  (`{digest}`).

## Agents

Each Floor starts with its Floor Template's team. From Development, the
default, that is four Agents: a Manager, a coder, a reviewer and a QA
Agent (PRD FR-10). They work as a team:

- Each has a random name (from `packages/orchestrator/src/agents/names.ts`)
  and a random Avatar, both unlike the others on the Floor (an Avatar
  differs from each other one in at least two of presentation, hairstyle,
  hair colour, skin tone, outfit style and outfit colour).
- Except the coder: he is **Adrian** (`roleNames`), and he looks the same
  on every Floor (`roleAvatars`): male, bald, with stubble and a blue
  hoodie. The others on his Floor are made to look unlike him, even the
  Manager, which joins before him; his look is never changed to look
  unlike theirs. A coder copied from the Role's first (raising its count,
  below) gets a random Avatar, even when he is named Adrian. On Floors
  from before, each coder named Adrian takes this look once, as AI Office
  starts (`giveRoleAvatars`, recorded as
  `data-migration:agents.adrian-avatar` in `schema_meta`, so it never
  runs again); a look the Owner gives him in the Avatar Editor afterwards
  is kept.
- All four use Claude with its default Model: `claude-opus-5-5` until the
  Owner chooses another in AI Settings' **AI Providers** (below). Agents
  from another template start on their Role's suggested AI Provider and
  Model.
- The reviewer is the Floor's required reviewer.

A Floor has exactly one Manager: a second is refused, and the `agents`
table's `agents_one_manager_per_floor` index refuses it too. It is never
removed (`409 manager_not_removable`). Each Floor's admin page lists its
Agents (`GET /api/floors/:floorId/agents`, PRD FR-12), each with its
status and current issue as its Floor's wall board has them (working,
waiting on review or idle; paused; leaving), kept live by the Floor's
events, and its tokens against its caps.

### Roles and the Role library

An Agent's Role is data, kept in the office Role library (the `roles`
table; PRD FR-98, [ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)),
not a list in code. A Role is:

- a **name** and an id (`coder`, `QA`…), and its **Stage**: work, review,
  QA or docs;
- a one-line **routing description**, for the Manager to choose between
  work Roles by: on a Floor with several, its triage reads them to give
  each issue to one, and an issue's `role:<name>` label overrides it
  ([routing](issue-pipeline.md#routing-between-work-roles));
- its **instructions**, which its Stage's prompt carries where the work is
  set out: a work Role's in its list of how to work, a QA Role's in its
  numbered list of what to check, a docs Role's in its numbered list of
  what to do, and a review Role's as what to review for. An Agent's own
  extra instructions still come after them, as the Owner's;
- its **Skills** and its **desk dressing** in the Office (a monitor, a
  designer's two, a reviewer's printouts, QA's test devices, a writer's
  books, a copywriter's notebooks or a merchandiser's product samples):
  every desk of an Agent in the Role is dressed so, decoration only;
- a **suggested AI Provider and Model** for new Agents in it. When the
  Owner has no AI Account for the suggested AI Provider, a new Agent
  starts on the office default (Claude) and its default Model instead.

The library starts with today's Roles, each with the instructions its
prompt has always had: coder and designer (work), reviewer (review), QA
(qa) and docs (docs, suggesting Claude's small Model,
`claude-haiku-5-5`). Development's coder, reviewer and QA are the same
Roles, as its `roles/` files have them. A Floor added from another
template adds that template's Roles. Their ids are the ones Agents had before Roles were
data, so every existing Agent kept its Role. The Manager and the
Communications Agent are built in, not library Roles.

The pipeline, the Review Loop, Round Caps, the Merge Policy and dispatch
go by a Role's **Stage**, never its name: an Agent in a new work-Stage
Role is given work exactly as a coder is, and a Floor's required
reviewers are its review-Stage Agents. Each task reads its Agent's Role
afresh as it starts, so changing a Role changes the next task of every
Agent with it.

#### The Role library page

**Admin → Open the Role library** (`/general-settings/roles`; PRD FR-98, FR-65)
lists every Role with its Stage, its routing description and how many
Agents fill it, on every Floor (leaving ones too; archived Floors' too).

- **Open** shows a Role's form: every field above, its Skills chosen from
  the office [Skill library](notices-and-skills.md#the-skill-library) and
  its suggested Model from its AI Provider's catalogue (or its default).
  It says how many Agents a change reaches: **Save** changes every one of
  them from its next task, and each one's own extra instructions still
  apply on top. A new suggested AI Provider without a Model of its own
  suggests its default Model. Only what changed is saved.
- **New Role** makes one in any Stage; its id is made from its name
  (`Brand reviewer` is `brand-reviewer`, numbered if taken). Names are
  unique in the library, whatever their case, and none is `manager`.
- **Duplicate** copies a Role as "*name* copy" and opens the copy.
- **Delete** asks first, then deletes a Role and its Role memory on every
  Floor. It is refused, saying why, while any Agent that is not removed
  fills the Role, and for the Roles a Floor Template starts Floors with
  (Development's coder, reviewer and QA). A removed Agent's row is kept but no longer keeps its
  Role in the library (`agents.role_id` is null once it is removed).
- **A Role's Stage** is what its Agents' work goes by, so it changes only
  while no Agent fills the Role: to try a Role in another Stage, duplicate
  it.
- **Floor Settings** offers every Role in the library in **Add Agent**,
  and its Team card counts each one.
- **Events.** Every change is `role.created` (with the Role it was
  duplicated from, if any, or the Floor Template that added it), `role.changed` (which fields changed, never
  what they say, and how many Agents fill it) or `role.removed` in the
  Activity Feed, which links to the Role.
- **API.** `GET /api/roles` lists them (each with `agents` and
  `inStartingTeam`); `GET /api/roles/:roleId` gives one; `POST
  /api/roles` makes one (`{"name","stage","description","instructions",
  "skills","deskDressing","aiProvider","model"}`); `POST
  /api/roles/:roleId/duplicate` copies one (`{"name"}` optional); `PATCH
  /api/roles/:roleId` takes any of the fields; `DELETE /api/roles/:roleId`
  deletes one (`204`). A Role in use is `409 role_in_use`, one a Floor
  Template starts Floors with `409 role_in_starting_team`, a Stage change while
  Agents fill it `409 role_stage_in_use` and a taken name `409
  role_name_taken`; a Skill the library does not have is `400
  role_skill_not_found` and a Model not in the catalogue `400
  model_not_in_catalogue`.

### A Floor's team

Floor Settings' **Team** card sets how many Agents of each Role work the
Floor (PRD FR-10). A new Floor has one Manager, coder, reviewer and QA
Agent, and no docs or designer Agent. The Manager is fixed at 1; any other
Role goes from 0 up to what the Floor's **Most Agents** allows, counting
every Agent on it but the Manager (or without bound, with no limit). A
change that would take the team past it is refused with `409
most_agents_reached`, saying to raise "Most Agents" first; so is adding
one Agent.

- **Raising a count** adds Agents copied from the Role's first Agent: its
  AI Provider, Model, effort, extra instructions and Token Caps. Each new
  one gets its own name, an Avatar unlike the others on the Floor, and its
  own Gateway Key (through `agent.created`), and can then be edited on its
  own. A Role with no Agent starts from the defaults.
- **Lowering it** removes idle Agents first, the newest first. An Agent in
  the middle of a task (work of its running, or a review round running
  while it is a required reviewer) is **leaving**: it takes no new work, and
  work waiting for it moves to another Agent of its Role, but it finishes
  its task and is removed when the work queue says the task has ended (or
  when the server starts again, its work queued for another Agent). Work
  is never cut off. A leaving Agent is not counted in its Role's number.
- **Removing** an Agent (`agent.removed`) revokes its Gateway Key and lets
  go of any Token Cap pause. Its row in `agents` is kept, marked
  `removed_at`, for the work, keys and requests that name it, and its name
  is free again.
- **One at a time.** **Add Agent** below the Agents table adds one Agent
  in any Role but the Manager's, copied the same way, named by the Owner or
  at random, and opens its editor, to choose its AI Provider and Model.
  **Remove** beside an Agent removes it after asking.
- **The concurrency warning.** The card warns when the Floor has more
  sandbox Agents (those whose Role is in the work, QA or docs Stage) than
  may run at once: the
  office's sandbox limit, or the Floor's own concurrency limit when lower
  (see [The work queue](issue-pipeline.md#the-work-queue)). The rest wait their turn.
- **API.** `PUT /api/floors/:floorId/team/:role` with `{"count"}`, `POST
  /api/floors/:floorId/agents` with `{"role","name"}` (`name` optional;
  `201` with the Agent) and `DELETE /api/floors/:floorId/agents/:agentId`.
  The `PUT` and the `DELETE` answer `{"added","removed","leaving"}`, each a
  list of Agents. Agents carry `leavingAt`, null while they stay, and
  their Role's `stage` (null for the Manager). A Role the library does
  not have is `404 role_not_found`. Leaving is a `config.changed` event
  (scope `agent`, `leaving`).

### Contractors

A Contractor is an Agent the Manager adds to its Floor, at a desk of its
own, for a Batch from its chat (PRD FR-10,
[ADR 0004](../architectural-decision-record/0004-the-manager-files-issues-for-its-chats-requests.md));
when and how many is described with
[the Manager chat](events-and-chat.md#requests-batches-and-contractors).

- **Its Role.** A library Role where one fits, such as a second coder; or
  a one-off Role the Manager named for its task (a name and a
  description), always in the work Stage. Its instructions are AI
  Office's own (`oneOffRoleInstructions`), never the Manager's (P2-4): a
  Role's instructions reach its Agent's model as trusted, and the Manager
  writes a one-off Role after reading the repository, web pages and
  attachments, which no one reviews (ADR 0003). What the Manager wrote
  for the Role goes into the issues it works, under "The Manager's notes
  for the …", which every Stage quotes as untrusted issue text. A
  Contractor kept on the team takes AI Office's instructions into the
  library, where the Owner edits them. A one-off Role is kept in
  `roles` with the Floor it was written on (`floor_id`): it is in no Role
  library, so the Role library page, Floor Templates, team sizes and
  `role:` labels never show it, and its name may be a library Role's.
  Review, QA and docs stay with the Floor's own Agents.
- **Its work.** A Contractor in a one-off Role takes only the work its
  Batch's Plan gives that Role, never the Floor's other issues; one in a
  library Role works like any Agent in it.
- **Its name and Model.** Named after its Role ("Migration writer", then
  "Migration writer 2" while that is taken), with a random Avatar unlike
  the others. It starts on its Role's suggested AI Provider and Model, or
  the office default, as any new Agent does (`newAgentRecord`): never a
  Model the Manager chose, and never Token Caps of its own.
- **Leaving.** Once its Batch has finished and held its Wrap-up, it
  leaves as a removed Agent does: at once when idle, or once its task ends
  (`createContractorDepartures`, on `batch.finished` and as the server
  starts). Its one-off Role goes with it. A research Contractor leaves as
  soon as it has reported back.
- **Keep on the team.** Its card in the Office and Floor Settings'
  Agents card offer **Keep on the team**: it becomes an ordinary Agent
  that never leaves on its own, and its one-off Role joins the library
  (as "Migration writer 2" if the library has that name).
- **Events.** `contractor.added` (its Role, whether one-off, `work` or
  `research`, and its Batch), `contractor.kept` and `contractor.left`,
  besides `agent.created` and `agent.removed`, all in the Activity Feed.
- **API.** Agents carry `contractor`: null for an ordinary Agent, else
  its `kind`, `batchId` and `oneOffRole` (`{"name","description"}`, or
  null). `POST /api/floors/:floorId/agents/:agentId/keep` keeps one,
  answering the Agent; an Agent that is not a Contractor (or is already
  leaving) is `409 not_a_contractor`. A Contractor is not exported with
  the configuration.

### The Agent editor

**Edit** beside an Agent in Floor Settings' Agents table opens its
editor (PRD FR-11, FR-12). Changes apply from the Agent's next task: each
task reads the Agent afresh when it starts, and work already started
carries on as it began.

- **Name**, unique on the Floor (`agent_name_taken`).
- **AI Provider**: one with a default Model (`model_required` otherwise).
  Moving to another AI Provider starts from its default Model and effort.
- **Model**: the AI Provider's default, or one of its Models in the model
  catalogue (`model_not_in_catalogue` otherwise). A Model chosen before it
  left the catalogue is kept until it is changed.
- **Effort**, where the agent tool takes one: Claude Code's `low` to
  `max`, Codex's `minimal` to `high`; opencode (Grok, Gemini) takes none
  (`effort_not_supported`).
- **Extra instructions**, added to the Agent's prompt for every task (up
  to 4,000 characters).
- **Enabled or paused**: no new work goes to a paused Agent, and its
  Gateway Key calls no model while it is paused (pen-testing G1-4), so
  work it had running stops at its next model call. Enabled again, the
  same key works again.

The editor speaks of the Agent as he, she or they, following its Avatar's
presentation (FR-14). `PATCH /api/floors/:floorId/agents/:agentId` takes
any of `name`, `aiProvider`, `modelOverride` (null for the default),
`effort` (null for the default), `extraInstructions`, `enabled` and
`avatar` (from the [Avatar Editor](#the-avatar-editor)), and
answers the Agent. Each change is a `config.changed` event (scope
`agent`) naming the settings, never their values. Agents on an archived
Floor cannot be edited.

### The Avatar Editor

**Avatar** beside an Agent in Floor Settings' Agents table, or **Open
Ada's Avatar Editor** on the Agent's card in the 3D Office (see
[Agent cards](web-app.md#agent-cards-and-flying-to-an-agent)), opens its Avatar
Editor (PRD FR-13, FR-14; §5 scenario 7; `apps/web/src/avatar-editor.tsx`).

- **Every part of the Avatar:** sex (male, female or androgynous; the
  schema calls it `presentation`), body shape, face, hairstyle and hair colour, skin tone,
  facial hair, glasses, accessories, the outfit's style and its two
  colours, the desk mascot, and **On the desk**: up to five of thirty
  things for the desk, each at its real size, placed in the order ticked
  wherever the desk has room (Randomise keeps them).
  Each colour is a swatch with a name, so
  none is told by colour alone.
- **A live 3D preview** (`scene/avatar-preview.tsx`, loaded with three.js
  only when the editor opens): the Avatar at the finest LOD, standing idle
  on a turntable beside its mascot (on a plinth at desk height, at twice
  its size), lit as the Office is. It shows each change at once, before
  it is saved. Drag to look around it; **Left** and **Right** turn it 30°
  at a time, from the keyboard too. With reduced motion it holds still.
  A browser without WebGL 2 is told so, and the rest of the editor works.
- **Randomise** gives a look unlike every other Agent's on the Floor and
  unlike the one before (as a new Agent's is; see [Agents](#agents)).
  **Reset** goes back to the saved Avatar. **Save** stores it.
- **The Office shows it at once.** Saving puts the Agent's new look
  straight into what the Office draws from, so in the Office the Agent
  at its desk changes as the panel saves. A save in another window
  reaches the Office by its `config.changed` event.
- **Pronouns** for the Agent follow the presentation (FR-14): the editor
  speaks of it as he, she or they as the presentation is chosen, and the
  Agent editor does once it is saved.
- **Never in a prompt.** The Avatar is how an Agent looks, never how it
  works: no prompt holds any part of it. A test
  (`packages/orchestrator/src/avatar-never-in-prompts.test.ts`) gives
  every prompt builder whole Agents, Avatars and all, and holds each
  prompt to the same text whatever the Avatars, with none of their parts
  in it.
- **API.** `PATCH /api/floors/:floorId/agents/:agentId` with `{"avatar"}`
  (the whole Avatar, `avatarSchema` in `@ai-office/shared`, which refuses
  any part the character kit does not have). Its `config.changed` event
  names `avatar`, never its parts; saving the same Avatar changes nothing.

### Agent Settings

**Agent Settings** in the navigation (`/agent-settings`,
`apps/web/src/agent-settings-page.tsx`) shows everyone in one place,
opening on wherever the lift is; its **Floor** list picks the lobby or
another Floor (`?floor=web-shop`, `?floor=lobby`).

- **On a Floor**, each Agent's card gives its Role, sex, AI Provider and
  Model, whether it is enabled, and its Token Caps. **Edit Ada's
  settings** opens the [Agent editor](#the-agent-editor) (name, AI
  Provider, Model, effort, Token Caps, Fresh Start threshold, extra
  instructions, enabled or paused); **Edit Ada's Avatar** opens the
  [Avatar Editor](#the-avatar-editor) (sex, skin, hair, clothes and the
  rest).
- **In the lobby**, the receptionist, who is the Communications Agent
  (PRD FR-96), and the visitor (see
  [the lobby's people](web-app.md#the-3d-office)) each have a name and an
  Avatar, edited the same way. The Communications Agent's card links to
  the Connections admin for the rest of it (its AI Provider, Model,
  status and Connections); its name and Avatar are saved with
  `PATCH /api/communications-agent` (`communications_agent.avatar`,
  migration `0076`, which gave it the look the receptionist had been
  given, if any; null is the default look, `defaultCommunicationsAgentAvatar`).
  The visitor's default is Victor (`defaultLobbyCast` in
  `packages/shared/src/people.ts`). Neither works on issues.
- **API.** `GET /api/office/lobby-cast` gives the lobby's cast;
  `PUT /api/office/lobby-cast/:role` (`receptionist` or `visitor`) with
  `{"name", "avatar"}` sets one. They are kept in `office_settings`
  (`lobby_cast`), and `config.changed` names `lobbyCast.receptionist` or
  `lobbyCast.visitor`. The lobby no longer shows the cast's
  receptionist: the Communications Agent sits at reception in its place.

### The Owner's passwords

AI Office has one Owner's access, shared by as many people as need it:
each signs in with an **Owner password** of their own. They are listed in
**API Key Management** (`/api-keys`, `apps/web/src/owner-passwords.tsx`),
above the API keys:

- **The first**, set at setup, cannot be removed, but it can be changed.
  Its name, nickname and time zone are the Owner's profile
  (`office_settings.owner_profile`, the name kept as the forename).
- **Add an Owner password** gives someone else one: a name, a nickname, a
  time zone (this browser's to start with) and a password as strong as the
  first must be, and unlike every other Owner password,
  so a password always says who signed in. They are kept in
  `owner_passwords`, as Argon2id hashes, never in clear. A new password
  signs in after **sign out everywhere**, so adding one asks for your
  **current password** (and a code from your authenticator app when TOTP
  is on), which a session begun with an API key cannot give.
- **Each password's card** sets its name, nickname and time zone (British
  time until another is chosen) and previews the receptionist's greeting.
  The receptionist greets whoever signed in by their nickname, else their
  name. **Change password** replaces it, the first's too, so a leaked one
  stops signing in: it asks for that password as it is now (not another
  Owner password), and a code when TOTP is on, and signs out every session
  the old one began, yours too if you signed in with it. **Remove** (not
  the first) signs it out everywhere.
- **Two-factor sign-in**, when on, applies to every password: they share
  the authenticator app's codes.
- **API.** `GET /api/owner-passwords`; `POST` with `{"name", "password",
  "currentPassword"}`, and `"code"` when TOTP is on (`403
  proof_required` without them, or from a session begun with an API key;
  `422 wrong_password` or `wrong_code`; then `409 password_in_use` for
  one another password already is); `PUT
  /api/owner-passwords/:id` with `{"name", "nickname", "timeZone"}` (`first`
  for the first), adding `"password"` and the proof of the password it
  replaces (`"currentPassword"`, and `"code"` when TOTP is on) to replace
  the password itself (`403 proof_required`, `422 wrong_password` for any
  other password, `409 password_in_use`); `DELETE /api/owner-passwords/:id` (`409
  first_password_not_removable` for the first). `GET /api/session` gives
  the `passwordId` that signed in (null for the first). Each password
  added, replaced or removed is in the Activity Feed (`config.changed`,
  scope `security`), by what changed, never the password.

### Renaming and removing a Floor

A Floor's name starts as its repository's. **Rename Floor** at the top of
the Floor in Agent Settings (or **Name** in its Floor admin) changes it
everywhere but the repository. **Remove Floor** beside it in General Settings'
**Floors in use** archives it, after asking: its work stops and it is
hidden, and its history is kept; its repository can be added again.

## Token accounting and Token Caps

Every request through the Gateway counts towards Token Caps (PRD FR-31,
FR-32): its input plus output tokens, with cache reads (and cache writes)
shown apart and an estimated cost for information only. They are added up
from `gateway_requests` per Agent, Floor, issue and Owner tool, for the day
and the month, in UTC.

A Token Cap limits the tokens an Agent may use in a period. Caps are set at
four levels, and for an Agent's work the most specific one set applies,
day and month each on its own:

1. **Issue**: an issue's own cap counts the tokens every Agent used on that
   issue, and applies in place of the Agent's while it works the issue.
2. **Agent**: its own cap, in the Agent editor.
3. **Floor**: a default for the Floor's Agents, in its settings.
4. **Office**: the default for every Agent, 5,000,000 tokens a day and
   100,000,000 a month until the Owner changes them. It is also each
   Owner tool's cap (see [Owner tools' caps](#owner-tools-caps)).

Each is shown with its use:

- **AI Settings' Token Caps card** sets the office's caps, and shows the Office's
  use today and this month, per Floor and per Owner tool, and the Agent
  nearest its cap. `GET` and `PUT /api/office/token-caps` with
  `{"daily","monthly"}`.
- **Floor Settings** shows each Agent's tokens today and this month
  against the cap in force for it, and where that cap is set. Its **Token
  usage** card shows the Floor's use, its Agents' default caps, and its
  issues' caps against their use, where an issue's caps are set or removed
  (`PUT /api/floors/:floorId/issues/:issue/token-caps` with
  `{"daily","monthly"}`, null for none). `GET
  /api/floors/:floorId/token-usage` answers all of it. Issues' caps live in
  `issue_token_caps`.
- **The Agent editor** sets the Agent's own caps (`tokenCaps` in `PATCH
  /api/floors/:floorId/agents/:agentId`), showing its use against the cap
  in force.

Every change is a `config.changed` event naming the caps, never their
values.

### Enforcement

Token Caps are enforced as Agents call models (PRD FR-33, §5 scenario 5).
Before each of an Agent's calls the AI Gateway checks the caps in force
for its work (with the issue AI Office gave it, never one its call names;
see [Gateway Keys](ai-gateway.md#gateway-keys)), and after each call is
recorded it checks them again:

- **One call at a time.** A call's tokens are known only once it is
  answered, so an Agent's calls go through the Gateway one after another:
  each waits, unasked, until the Agent's call before it has been recorded
  and counted (pen-testing G1-2). However many calls an Agent sends at
  once, its use stops within one call of its cap. Different Agents' calls
  never wait for each other. The Communications Agent's calls, and each
  Owner tool's, go one at a time too.

- **At 80%** of a cap, the Owner gets an action Notice, "Token Cap
  warning: Ada has used 85% of its own daily Token Cap (850 of 1,000
  tokens)", and a `cap.warning` event. It is raised once per cap and
  period.
- **At 100%**, the Agent is **paused**: a `cap.reached` event, its status
  becomes `capped`, and an action Notice, "Token Cap reached: Ada is
  paused at its own daily Token Cap", offers **Raise cap** and **Resume
  tomorrow** (**Resume next month** for a monthly cap).
- **While it is paused**, the Gateway refuses every one of its calls with
  a cap error: `403`, `permission_error` (or OpenAI's format to OpenAI
  clients), the header `x-ai-office-refusal: token_cap`, and a message
  saying which cap it reached. Nothing goes to the AI Provider. Agent
  tools do not retry a 403, so the Agent stops at its next call: the safe
  point. The coder flow then pushes whatever the Agent committed (no
  pull request yet), lets the issue go at `needs-work` and puts the work
  back in the queue, with a "Paused" progress comment and no "Agent
  blocked" Notice. No work starts for a paused Agent, and new work goes
  to another Agent in its Role if there is one.
- **Raise cap** raises the cap that was reached for this Agent's work, and
  resumes it at once. An issue's cap is raised for the issue; otherwise
  the Agent gets its own cap for that period, leaving the Floor's and the
  office's as they are. The new cap is double the old one, or what is
  used plus the old cap if that is more.
- **Resume tomorrow** leaves the Agent paused until its cap's day (or
  month) is over, then resumes it (checked every minute, and at each of
  its calls).
- **A cap raised anywhere** (AI Settings, Floor Settings or the Agent editor)
  resumes every paused Agent that is no longer at its cap, and closes its
  Notice as acted on.

Pauses are kept in `agent_cap_pauses`, so they outlast a restart. For the
Gateway's checks, the day's and the month's use is kept in memory: read
from the request history once, then each request added as it is
recorded. Requests deleted by retention or the storage clean-up still
count, by their UTC day (see [Storage](running.md#storage)).

### Owner tools' caps

Owner tools can have caps too (PRD FR-33; pen-testing G1-3). Each Owner
tool's Gateway Key, the Terminal's included, is held to the office's daily
and monthly caps against its own tokens, as each Agent is by default: one
Owner tool's use never counts against another's, nor against an Agent's.
Its calls go one at a time, as an Agent's do. At a cap, the Gateway
refuses its next call with the same cap error (`403`,
`x-ai-office-refusal: token_cap`), saying which cap it reached, until the
day (or month) is over or the Owner raises the office's cap. Nothing is
paused and no Notice is raised: the Owner's own tool shows the refusal.
AI Settings' Token Caps card shows each Owner tool's use.

## Git identity

Agents' commits are authored and committed as the Owner, never as the
Agent ([ADR 0002](../../docs/architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md)).
By default that is GitHub user `adrianeyre` with their GitHub noreply
address (`21265837+adrianeyre@users.noreply.github.com`).

- **Office-wide:** General Settings' **Git identity** sets another
  (`GET` and `PUT /api/office/git-identity`).
- **Per Floor:** each Floor can set its own in its settings
  (`gitIdentity` in `PATCH /api/floors/:floorId`; `null` goes back to the
  office's).

AI Office injects the identity, so an Agent never chooses it.
`gitEnvironment(identity)` (in `@ai-office/orchestrator`) gives the
`GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables for a sandbox.
`withAgentTrailer(message, agent)` ends each commit message with a trailer
naming the Agent, its Role, and its AI Provider and Model:

```text
Agent: Ada (coder, Claude claude-opus-5-5)
```

It is the only line in the message naming who made the commit: any
`Agent:` line, or any `…-by:` line such as `Co-authored-by:`,
`Signed-off-by:` or `Reviewed-by:`, that the Agent wrote is dropped
(`withoutWhoMadeIt`), so a commit authored as the Owner names no other
Agent and nobody else.
