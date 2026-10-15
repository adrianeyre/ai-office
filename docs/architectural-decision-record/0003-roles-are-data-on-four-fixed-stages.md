# Roles are data on four fixed Stages

Floors are not only for software: a Floor Template can set up an online store, a blog or a data team. So a Role is data (a name, a routing description, instructions, Skills and desk dressing) kept in an office Role library, not a fixed list in code. Every Role belongs to one of four fixed Stages: work, review, QA and docs. The label pipeline, the Review Loop, Round Caps, Merge Policy and the Manager's dispatch rules are written once against Stages, so a new kind of Floor costs a template and some Roles, never orchestrator code.

## Considered Options

- **More fixed Roles in code** (copywriter, merchandiser, SEO specialist…): every new job would need a code change and a release, and the list would never be complete.
- **Free-form Roles and pipelines per Floor:** the most flexible, but each Floor would need its own pipeline, caps and escalation rules, and the safety properties of the Review Loop would have to be re-established for every shape.

## Consequences

- `needs-code` is renamed `needs-work`; `needs-review`, `needs-qa` and `needs-docs` keep their names, so labels and Stages match.
- Within the work Stage the Manager chooses the Role for an issue (or the Owner forces one with a `role:<name>` label), and a Plan may give one issue an ordered list of work Roles on one branch.
- Role instructions reach models, so they are trusted input: imported Roles and Floor Templates are reviewed before they are enabled, like imported Skills.
- The Manager and the Communications Agent are not library Roles. They stay built in, one per Floor and one per Office.
