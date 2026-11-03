# Roles, Stages and Floor Templates

An overview of the Roles every Agent fills, the Stages an issue moves
through, and the Floor Templates a Floor starts from. The detail is in
[Floors and Agents](floors-and-agents.md).

## Roles and Stages

Every Agent but the Manager fills a Role from the office Role library
(the `roles` table): a name, instructions, Skills, desk dressing, a
suggested AI Provider and Model, and one of four fixed Stages: work,
review, QA and docs
([ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)).
The library starts with coder, reviewer, QA, docs and designer. Each
Stage has its label, and an issue moves through them:

```text
needs-work → needs-review → needs-qa → needs-docs → ready-to-merge (or needs-human)
```

The pipeline, the Review Loop, Round Caps, the Merge Policy and dispatch
go by a Role's Stage, never its name, so a new work-Stage Role is
dispatched like a coder. When a Floor has several work Roles (a
merchandiser and a copywriter, say), the Manager's triage gives each
issue to one by the Roles' routing descriptions; a `role:<name>` label,
which AI Office creates for each work Role, forces one, and when the
Manager cannot tell it asks the Owner with a Notice offering each
candidate Role
([routing](issue-pipeline.md#routing-between-work-roles)).
A Batch's Plan may instead give an issue an ordered list of work Roles
(the merchandiser, then the copywriter), which take turns on its one
branch, each handing it to the next, before review; the Owner can
reorder or remove them on the whiteboard, and a Review Loop fix goes
back to the Role whose changes it concerns
([several work Roles on one issue](batches-and-memory.md#several-work-roles-on-one-issue)).
In **Admin → Role library** (`/general-settings/roles`) the
Owner makes, duplicates and edits Roles, and deletes one no Agent fills;
Floor Settings adds Agents in any of them. Changing a Role changes every
Agent with it from its next task (the editor says how many), and an
Agent's own extra instructions still apply on top. Every change is in
the Activity Feed. `needs-work`
was called `needs-code`: on a Floor added before, AI Office renames the
repository's label when it starts, and GitHub keeps it on its issues. See
[Floors and Agents](floors-and-agents.md#roles-and-the-role-library).

## Floor Templates

Adding a Floor means picking a Floor Template: its starting team,
settings and labels. **Admin → Add a Floor** shows each template's name,
description, icon and starting team, and starts on **Development**, the
team every Floor had before templates (a Manager, a coder, a reviewer and
QA). **Blank** is a Manager only. **Online store** (a merchandiser, a
copywriter, a storefront developer, a brand reviewer and store QA),
**Website & marketing** (a web developer, a copywriter, an SEO specialist
and a conversion reviewer) and **Content & blog** (a writer, an SEO
specialist, an editor and a fact-checker) set up Floors that are not for
software: each runs its checks as npm scripts that its suggested first
issue sets up, and works on its repository only, never on a live store,
an ad platform or customer email. **Documentation** (a technical writer,
a docs reviewer and an example checker), **Design system** (a designer, a
front-end developer, an accessibility reviewer and visual QA), **Data &
analytics** (an analytics engineer, a data reviewer and data-quality QA),
**Infrastructure** (a platform engineer, a security reviewer and plan
QA) and **Mobile app** (a mobile developer, a reviewer and device-test
QA) do the same for their own checks: the docs build, links and runnable
examples; component tests, visual snapshots and contrast; `dbt test` and
SQL lint on sample data; `terraform plan` from no state and policy
checks, and never an apply; unit and simulator tests. Each says plainly
what its Floor never acts on (the live docs site, a package registry,
the production warehouse, live infrastructure, the app stores).
**Local** (a local coder, a local reviewer and local QA) is a software
team on the Owner's own Models: every Role suggests the Ollama AI
Provider and one shared Model, `qwen3.6:27b`, and its Manager plans
small issues that name their files, with explicit acceptance criteria,
one change per pull request. The
template's Roles and Skills join
the Role and Skill libraries where they are missing; the Floor remembers
which template it started from, and nothing depends on the template
afterwards. Each template has a 3D theme, which the Floor keeps: stock
shelves and parcels for Online store, a photo studio for Website &
marketing, bookshelves and a printing press for Content & blog, a wall of
bookcases for Documentation, colour swatches for Design system, wall
dashboards for Data & analytics, server racks for Infrastructure and a
wall of phones for Mobile app; Development, Blank and Local keep the office as
it was. Each desk is dressed as its Role is in the Role library (a
copywriter's notebooks, a merchandiser's product samples). Themes and
dressing are decoration only. Built-in
templates are folders under [`templates/`](../../templates/) (`template.yaml`,
`roles/<role>.md` and `skills/<name>/`), loaded and checked as AI Office
starts.

In **Admin → Floor Templates** (`/general-settings/templates`) the Owner makes
templates of their own: they duplicate one (the built-in ones are
read-only) and edit its Roles and counts, settings, the Manager's
guidance, labels and theme; save a Floor's set-up as a new template from
its admin page; export a template, with its Roles and Skills, to a file;
and import one from such a file or a Git repository. An imported template
shows its full contents (every Role's instructions and every Skill) and
its clashes with the Role and Skill libraries, and no Floor can be added
from it until the Owner has read it and enabled it. The Owner's templates
are stored in AI Office, every add, change and removal is in the Activity
Feed, and they are part of configuration export and import. See
[Floors and Agents](floors-and-agents.md#floor-templates).
