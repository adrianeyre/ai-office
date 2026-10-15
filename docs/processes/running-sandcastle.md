# Running Sandcastle

[Sandcastle](https://github.com/mattpocock/sandcastle) runs a coding agent
against this repository inside a Docker container and brings the commits it
makes back to a branch. It is how AI Office's own issues get worked without somebody at
the keyboard: an issue is picked up by an agent in a sandbox, and a person
reviews and lands the result.

`.sandcastle/` holds the configuration. This file says how to use it **in this
project**. The upstream README is the reference for `run()`, the providers and
the hooks; this is the part that is ours.

---

## What is in `.sandcastle/`

| Path           | What it is                                                                         |
| -------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`   | The sandbox image: Node 26.10.0, pnpm 12.10.0, `git`, `gh`, `claude`               |
| `main.ts`      | The orchestration entrypoint: prompt selection, branch guard, hooks, sandbox       |
| `prompt.md`    | The committed prompt template, with the parts every brief here must have           |
| `prompt-*.md`  | Your working briefs. Ignored, so they stay out of the branch's diff                |
| `.env.example` | Every variable a run needs, with the reason it exists and no values                |
| `.gitignore`   | Keeps `.env`, `logs/`, `worktrees/` and every prompt but the template out of git   |

`logs/` and `worktrees/` appear the first time you run something. Both are
ignored, and so is `.env`. **Never commit a credential.**

---

## One-time setup

### 1. Docker

Docker must be running: `docker info` should print rather than fail.

### 2. Dependencies at this checkout

```bash
pnpm install
```

`@ai-hero/sandcastle` and `tsx` are root devDependencies. An
`ERR_MODULE_NOT_FOUND` naming `@ai-hero/…` means this step was skipped.

### 3. Credentials

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

**A key named with no value is filled from your shell.** Sandcastle forwards
exactly the keys `.sandcastle/.env` names, using the file's value if it has one
and `process.env`'s if it doesn't. So you can leave secrets out of the file
entirely and export them from your shell instead.

The flip side is a quiet failure: **a variable your shell exports that `.env`
does not name is not forwarded.** The agent comes up unauthenticated and nothing
in the log says a variable was dropped. If you add a variable to your
environment, add its name to `.env`.

- `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on the host) runs the
  agent on your Claude subscription. Alternatively set `ANTHROPIC_API_KEY`.
- `GH_TOKEN` is a
  [fine-grained token](https://github.com/settings/personal-access-tokens/new)
  scoped to this repository with **Issues: read and write**, **Metadata: read**
  and **Contents: read**. The agent reads the issue and the docs it cites, and
  comments its verification back on the issue. It deliberately has no
  `Contents: write` and no `Pull requests: write`: the commits come back over
  the bind mount and a person pushes and opens the pull request.

If you reach Anthropic through a gateway with its own certificate authority,
export `NODE_EXTRA_CA_CERTS` on the host as usual. `main.ts` mounts that file
into the container and points the variable at the mounted copy. Forwarding
the host path alone fails with `unable to verify the first certificate`.

### 4. Build the image

```bash
pnpm exec sandcastle docker build-image
```

This builds `.sandcastle/Dockerfile` as `sandcastle:<repo-directory-name>` and
passes your own UID/GID, so files written by the image and files written through
the bind mount have the same owner. Rebuild after any Dockerfile edit;
`pnpm exec sandcastle docker remove-image` throws it away. Use `pnpm exec`
rather than `npx`: the root `devEngines` requires pnpm, so npm refuses with
`EBADDEVENGINES`.

---

## The image has to match the project

The root `package.json` requires Node 26 or later and pnpm 12 or later
(`engines` and `devEngines`). The image pins exact versions inside those
ranges (Node 26.10.0, pnpm 12.10.0) so every sandbox is the same. If the
minimums change, change the Dockerfile in the same pull request: a sandbox on
the wrong Node or pnpm usually installs fine and only fails later, which is
much harder to diagnose.

Whatever else you add, keep the four things Sandcastle itself needs: the
non-root `agent` user (Claude Code refuses to run as root), `git`, `gh`, and
`claude` on `PATH`. pnpm is AI Office's own addition.

---

## Dependencies are installed by a hook, not baked into the image

The image installs no workspace dependencies, because they'd be stale by the
next lockfile change. `main.ts` installs them when the sandbox comes up:

```ts
onSandboxReady: [{ command: "pnpm install --frozen-lockfile", timeoutMs: 600_000 }]
```

`--frozen-lockfile` is deliberate. A slice that legitimately adds a dependency
has to commit the lockfile change, which keeps the lockfile reviewable. pnpm 12
refuses to run a dependency's install scripts unless the package is listed under
`allowBuilds` in `pnpm-workspace.yaml`. `esbuild` (pulled in by `tsx`) is listed
there for this reason.

Docker is a bind-mount provider, so the worktree the agent works in is on your
disk under `.sandcastle/worktrees/…`. Edits are visible on the host as soon as
the agent makes them.

**`onSandboxReady` hooks run in parallel.** A hook that needs `node_modules`
must not be a separate entry next to the one that installs them. Chain
commands with `&&` in a single entry instead, for example
`pnpm install --frozen-lockfile && pnpm build`.
The symptom of getting this wrong is a "command not found" for a tool the
install was about to provide.

---

## Running it

```bash
pnpm sandcastle 9                      # .sandcastle/prompt.md, against issue #9
pnpm sandcastle prompt-issue-9.md 9    # a prompt you wrote beside it
pnpm sandcastle                        # only for a prompt that names no issue
```

| Invocation                             | Prompt                          | Issue |
| -------------------------------------- | ------------------------------- | ----- |
| `pnpm sandcastle 9`                    | `.sandcastle/prompt.md`         | #9    |
| `pnpm sandcastle prompt-issue-9.md 9`  | `.sandcastle/prompt-issue-9.md` | #9    |
| `pnpm sandcastle`                      | `.sandcastle/prompt.md`         | none  |

A bare number is read as the issue. A bare file name is looked up inside
`.sandcastle/` unless it contains a `/`. If the prompt file doesn't exist, the
script prints the usage and exits. The committed `prompt.md` contains
`{{ISSUE}}`, so running it without an issue number is refused on the host
before any container is built.

Progress streams to the terminal and a full log is written under
`.sandcastle/logs/`. When the run finishes, `main.ts` prints the commit count,
the completion signal, the log path, and any worktree it had to keep.

`claudeCode()` takes the model and options such as `effort`. Note that setting
`permissionMode` **replaces** Sandcastle's default
`--dangerously-skip-permissions`, which is what lets a run proceed unattended.

### One prompt is tracked; the rest are yours

`.sandcastle/prompt.md` is the committed template. Every other `prompt*.md` is
ignored, so a brief written for one issue never ends up in a commit. Copy the
template rather than editing it:

```bash
cp .sandcastle/prompt.md .sandcastle/prompt-issue-9.md
$EDITOR .sandcastle/prompt-issue-9.md
pnpm sandcastle prompt-issue-9.md 9
```

---

## Branch strategy: `merge-to-head`

| Strategy        | Where the commits land                                        |
| --------------- | ------------------------------------------------------------- |
| `head`          | Straight into this working directory, with no worktree or branch |
| `merge-to-head` | A temporary worktree branch, merged back to HEAD              |
| `branch`        | A named branch in a worktree, kept                            |

`head` is Sandcastle's default for bind-mount providers, which means an agent
editing the files you're looking at. This project uses `merge-to-head`: the
agent gets its own worktree, and its commits are merged back onto the branch
you launched from.

**Launch from a fresh branch cut from `origin/main`. Never launch from `main`
itself, or from the previous run's branch.** `main.ts` refuses to start on
`main`. If you build on the last run's branch, its commits end up in your pull
request too, and the review covers two issues instead of one.

```bash
git fetch origin
git checkout -b issue-9-walking-skeleton origin/main
pnpm sandcastle 9
```

Work through issues in dependency order: the prompt tells the agent to stop and
say so if any issue under "Blocked by" is still open.

---

## Writing a prompt

Three pieces of syntax do the work:

- <code>!&#96;command&#96;</code> is replaced by the command's stdout **before**
  the agent sees the prompt. These commands run inside the sandbox after the
  `onSandboxReady` hooks have finished. If one exits non-zero, the run fails
  immediately.
- `{{KEY}}` is filled in from `promptArgs` on the host before any of those
  commands run, so `{{ISSUE}}` is already substituted by the time
  `gh issue view` runs. `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` are built
  in.
- `<promise>COMPLETE</promise>` ends the iteration loop early. Sandcastle never
  adds it for you. If the prompt doesn't ask the agent to output it, the run
  continues until `maxIterations` or the idle timeout.

### What a prompt here must include

`prompt.md` has these parts, and any brief you write should keep them:

1. **The reading, before the task:** `README.md`, `GLOSSARY.md`, the PRD and
   each ADR, named individually.
2. **The brief, fetched live** with <code>!&#96;gh issue view {{ISSUE}}&#96;</code>
   rather than pasted, so it can't drift from the issue.
3. **What already exists and must survive.** In particular, the root
   `package.json` contains the harness that is running the agent. An agent given
   a scaffolding task will otherwise rewrite it from scratch.
4. **The invariants:** every ADR is binding, and no credential ever appears in
   a prompt, log, commit, Notice or the Activity Feed.
5. **Verification:** the exact commands to run, an instruction to paste their
   real output back on the issue, and an instruction never to get to green by
   weakening a test.

Point 5 matters most. An agent that grades its own work will report success
from the same wrong assumptions it built with. The pasted output is what a
person checks before opening the pull request.

---

## What a sandbox here cannot do

- **It has no Docker of its own.** The sandbox is a container, so it cannot
  start the Postgres container from `docker compose`. Tests that need a
  database must say how they get one; anything that could only be checked
  against the real compose stack is listed on the pull request as unverified.
- **It has no GPU or display.** The 3D office can be built and unit-tested, but
  how it looks and how smoothly it runs can only be judged in a real browser on
  the host. Say so on the pull request.
- **It must not reach real AI accounts or GitHub repositories other than this
  one.** Load-balancer behaviour is tested against fakes, never against live
  provider accounts.
- **It cannot push or open a pull request.** This is by design, because
  `GH_TOKEN` has no write access to contents. A person lands the work.

A pull request should list, individually, every test that was skipped or could
not run in the sandbox, so the reviewer knows exactly what still has to be
proven on the host or in CI.

---

## Landing a run

A run isn't finished when the agent stops. It's finished when the work is on
the remote, behind a pull request, on a branch that contains this issue and
nothing else. Do these steps on the host:

```bash
# 1. The gate. Run every check that exists.
pnpm lint && pnpm typecheck && pnpm test

# 2. Commit anything the agent left uncommitted, as coherent commits.
git add -A && git commit

# 3. Bring main in, and resolve any conflicts here rather than in the PR.
git fetch origin && git merge origin/main

# 4. Re-run the gate on the merged result. A clean merge doesn't mean a passing build.
pnpm lint && pnpm typecheck && pnpm test

# 5. Push and open the pull request, closing the issue.
git push -u origin HEAD
gh pr create --base main --fill
```

Then check the diff covers only this issue: `git diff origin/main --stat`
should show this issue's files and nothing from an earlier run.

### What the pull request should say

1. **What the slice does**, in the vocabulary of `GLOSSARY.md`, and
   `Closes #<issue>`.
2. **Which acceptance criteria are met, and how each was verified.**
3. **The verification output, pasted**: the real output from step 4, not a
   claim that it passed.
4. **What wasn't verified here**, such as the look and feel of the 3D office in
   a browser, and **what is deliberately left out**, with the reason.

---

## Cleaning up

Worktrees live under `.sandcastle/worktrees/`. A clean worktree is deleted when
the run ends. A worktree with uncommitted changes is **kept** so that work
survives a crash, and `main.ts` prints its path. Remove it with
`git worktree remove` once you've dealt with it.
`pnpm exec sandcastle docker remove-image` drops the image.

---

## Troubleshooting

| Symptom                                             | Cause                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ERR_MODULE_NOT_FOUND` for `@ai-hero/…`             | `pnpm install` not run at this checkout                                                   |
| The agent exits asking to authenticate              | `.sandcastle/.env` missing, or it names no working credential                             |
| The agent is unauthenticated despite a set variable | `.sandcastle/.env` does not name that key, so it was never forwarded                      |
| `unable to verify the first certificate`            | A private CA that isn't reachable inside the container. Export `NODE_EXTRA_CA_CERTS` on the host so `main.ts` mounts it |
| `gh` says it cannot read the issue                  | `GH_TOKEN` has no **Issues: read** on this repository                                     |
| Permission errors on files the agent wrote          | Image built without your UID. Rebuild with `pnpm exec sandcastle docker build-image`            |
| ``Refusing to run on `main` ``                      | Working as intended. Cut a branch; the message prints the command                         |
| The run hangs long after the work is done           | The prompt never asked for `<promise>COMPLETE</promise>`                                  |
| A tool is "not found" in an `onSandboxReady` hook   | Hooks run in parallel and it raced the install. Chain them with `&&`                      |
| `npm error EBADDEVENGINES`                         | Ran via `npx`. Use `pnpm exec sandcastle …`                                               |
| `ERR_PNPM_IGNORED_BUILDS`                           | pnpm 12 needs the package in `allowBuilds` in `pnpm-workspace.yaml`                       |
| A usage message instead of a run                    | No prompt at that path, or the prompt names `{{ISSUE}}` and no issue was given            |

---

## See also

- [Sandcastle](https://github.com/mattpocock/sandcastle): the upstream
  reference for `run()`, providers and hooks
- [`GLOSSARY.md`](../../GLOSSARY.md): the vocabulary the agent's output is
  judged against
- [`docs/product-requirements-document/ai-office.md`](../product-requirements-document/ai-office.md):
  the requirements every issue cites
- [`docs/architectural-decision-record/`](../architectural-decision-record/):
  the decisions an agent must not quietly reverse
