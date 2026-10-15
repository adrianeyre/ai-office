# The Manager files issues for its chat's requests

The Owner wants to ask a Floor's Manager for work in plain words and have it spun off to Agents, as a coding assistant spins off sub-agents. So a request the Owner makes in the Manager chat becomes a Batch: the Manager files one GitHub issue per piece of repository work, adds Contractors (Agents for that Batch, each at its own desk) when the work needs more hands than the Floor has, and starts the Batch at once, the request standing as the Plan's approval. Until now the Manager could not create issues at all (FR-23); this widens its authority to filing issues for its own chat's requests, and to adding and letting go of Contractors within the Floor's "most Agents" limit. It still may never merge, change repository settings or raise any cap.

## Considered Options

- **The Owner files every issue**, as before, and the Manager only plans a Batch from them: safe, but not what was asked; the Owner would do the splitting.
- **Plan, then wait for "go"**: the Plan's approval on the whiteboard, as for "complete issues" Batches. Rejected by the Owner in favour of starting at once, with "pause", "skip" and "move" still working mid-Batch.
- **Work outside GitHub issues** (a lightweight task with no issue): it would bypass the Stages, the Review Loop and the Merge Policy that keep work safe.

## Consequences

- Issues the Manager files carry the `ai-office` label and enter work only through their Batch; intake still takes only the Owner's own issues.
- Each filing is logged as a comment on the issue, like every Manager decision.
- Contractors are capped by the Floor's "most Agents" setting (default 8, or no limit) and never outnumber what the sandbox limits let run at once; the per-Role maximum of 10 goes.
- A chat Batch skips the Floor's Plan approval; "complete issues" Batches keep it.
- The Manager acts as the orchestrator and never works the repository itself. A Contractor's Role is a one-off the Manager writes for its task, in the work Stage only, so review, QA and docs stay with the Floor's own Agents and the Review Loop and Merge Policy still apply. A research Contractor gets a read-only clone, files nothing and reports its findings to the Manager.
- Each request is its own Batch, running alongside any other; a Floor setting turns the whole behaviour off.
- To match what the Owner gets from Claude Code, the Manager's chat is a continuing agent session with read-only tools: it reads and searches a read-only clone of its Floor's repository and the web, through Claude Code or Codex in its sandbox image, reaching models through the Gateway whether the AI Account is a subscription or an API key, so both get the same tools. It still changes nothing itself: every change goes through an issue, an Agent or a Contractor.
