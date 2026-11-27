# A Recurring Goal's Plan waits for the Owner

A Goal the Owner types in the Manager chat stands as its Plan's approval: the Owner has just asked for the work in their own words, and is there to see the Batch start. A Recurring Goal is a Goal the Owner saved once, with a schedule ("every Monday at 09:00, find modules without tests and file issues"), which the Manager works each time it comes round, when nobody may be watching. What it finds depends on the repository as it is that day, which anyone who can push may have shaped. So **a Recurring Goal's run files its issues and proposes a Plan, and the Plan waits on the whiteboard for the Owner's approval**, with an action Notice; no Agent starts its work until the Owner approves it.

## Considered Options

- **Treat it like a typed Goal**, its Plan approved by the Goal itself: the work would be done by the time the Owner looks, but a standing order would spend tokens on work nobody chose that week, and a run steered by what it read in the repository would start a Batch on its own say-so.
- **Run nothing but a report**, as a scheduled Hook would (ADR 0016): safe, but it cannot file issues, which is what the Owner wants from it.
- **File issues and propose the Plan, which waits for the Owner** (chosen).

## Consequences

- A Recurring Goal is the only Goal whose Plan is not approved by the Goal; the Plan's approval, editing and replanning on the whiteboard are as for any other Plan.
- Only the Owner makes, changes, runs or deletes a Recurring Goal, in the Floor admin and its API, as for Hooks (ADR 0016); the Manager and its chat cannot.
- A run is skipped while the previous run's Plan still waits for approval, or its Batch is still running, so unanswered runs never pile up.
- A run's research and filing still spend tokens before the Owner approves anything. So a run may add at most one research Contractor, which changes nothing, and each Recurring Goal has a per-run Token Cap bounding the Manager's calls and the Contractor's.
