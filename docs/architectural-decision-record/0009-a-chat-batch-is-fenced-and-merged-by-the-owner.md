# A chat request's Batch is fenced, and only the Owner merges it

A request in the Manager chat starts its Batch at once (ADR 0004), on a Plan the Manager's session wrote after reading the repository, the web and attachments, any of which may hold an instruction someone planted (pen-test finding P2-3). A check that read none of that already binds the Plan to the Owner's own words (`manager/request-binding.ts`), but it is a model's judgement: a Plan crafted to look like what the Owner asked may pass it. So, as the Owner decided in #199 (P2-3's option 4), two deterministic rules hold beside it, and the request still starts its Batch at once. **Before anything is filed**, a Plan whose issues name a file that holds secrets or credentials, says what CI runs or installs (dependencies among them), or is read by later Agents as memory, Skills or instructions, files nothing unless the Owner's own words name that file too (`manager/request-fence.ts`). **When its work is ready to merge**, an issue a chat request's Batch holds always goes to the Owner, whatever the Floor's Merge Policy, unless the Owner added `ai-office:auto-merge` to it themselves (`merge/merge.ts`).

## Considered Options

- **Accept the binding check alone**, the remaining risk bounded by the Review Loop, the "send to me" default and read-only tokens: no change, but the property rests on one model's judgement.
- **Start at once only when the session read nothing but the Owner's words**, and otherwise hold the Plan for "go": partly reverses ADR 0004, as almost every useful turn reads the repository.
- **Plan approval for every chat Batch**: reverses ADR 0004; the option it records the Owner rejecting.
- **A deterministic fence on what a chat Batch may touch, and its merges sent to the Owner** (chosen): keeps ADR 0004, and narrows what injected content can make land rather than whether it can start work.

## Consequences

- The fence uses the Merge Policy's own rules for what CI runs and what Agents read (`merge/owner-only.ts`, P1-2 and P1-3), with a rule for files that hold secrets, so the Plan and the merge agree on what is the Owner's alone. It reads each issue's files and every path in its title, body, acceptance criteria and its one-off Roles' text. A bare word ("make CI pass") is not a path; a file named without a dot or slash counts only when it is a well-known one, such as `Dockerfile`.
- The Owner names a fenced file in their own words (its path, its name, or a folder it is in) to have a chat request change it, or files the issue themselves and says "complete issues …", which keeps the Floor's Plan approval.
- A chat Batch's pull requests wait for the Owner's "Approve and merge" even on an auto-merge Floor; the Notice says it was filed for a chat request. A Batch handed over by "complete issues" keeps the Floor's policy.
- What an Agent changes beyond what its issue names is not fenced before it runs; the merge rule is what catches it.
