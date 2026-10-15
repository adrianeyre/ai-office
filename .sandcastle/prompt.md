# Read first

Before touching anything, read these in full. They are the canon your work is judged against:

- `README.md`
- `GLOSSARY.md` — use its terms exactly (Office, Floor, Agent, Role, Notice, Token Cap, Merge Policy…) and none of the words it lists under _Avoid_
- `docs/product-requirements-document/ai-office.md`
- Every ADR in `docs/architectural-decision-record/`:

!`ls docs/architectural-decision-record/`

# The brief

!`gh issue view {{ISSUE}} --comments`

Every issue listed under "Blocked by" must already be closed. If one is open, stop, comment on this issue saying which, and output <promise>COMPLETE</promise>.

# What already exists and must survive

- The root `package.json` holds the Sandcastle harness that is running you (`@ai-hero/sandcastle`, `tsx`, the `sandcastle` script, `devEngines`). Extend it; never rewrite it from scratch.
- `.sandcastle/` is the harness configuration. Do not edit it unless the issue says to.
- `docs/` is the canon. Do not change the PRD or an ADR to match your code; if they disagree, say so on the issue.

# Invariants

- Follow every ADR in `docs/architectural-decision-record/`. They are decisions, not suggestions.
- Never put a credential in a prompt, a log, a commit, a Notice or the Activity Feed.
- Node 26+ (26.10.0 in the sandbox), pnpm 12+ (12.10.0 in the sandbox), ESM, strict TypeScript.

# Task

Implement the issue above as a single vertical slice that meets every acceptance criterion. Commit in coherent steps with conventional commit messages. Do not widen the scope beyond "What to build"; anything you notice outside it goes in a comment on the issue.

# Verification

Run every check that exists in the workspace (`pnpm lint`, `pnpm typecheck`, `pnpm test` once they exist), plus anything the acceptance criteria name. Paste their **real output** into a comment on the issue, and tick each acceptance criterion you have verified, saying how. Never reach green by skipping, deleting or weakening a test. If something cannot be verified in this sandbox (e.g. a GPU-rendered 3D scene), say so explicitly.

# Done

When every acceptance criterion is met and verified, or you are blocked, output <promise>COMPLETE</promise>.
