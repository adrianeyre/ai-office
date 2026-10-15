# Issue #193: [pen-test] S2 — Sandbox and host isolation — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no EC2, no network beyond the registry and the
model). The probe was assessed at commit `b19d98f` (the branch head; the
worktree was clean). `pnpm lint`, `pnpm typecheck` and `pnpm test` were run
at `0d148df`, with the probe's tests and assessment committed.

This issue is a **probe**, not a fix: it answers H2, H3 (reach) and H14,
produces an assessment and committed probe tests, and changes no
production code.

## What was produced

- **Assessment** `docs/pen-testing/assessments/S2.md`. It has a verdict on
  every "What to probe" bullet (egress and the metadata service; reach to
  `app:3045`, `app:1455`, `app:3047`, Postgres, Caddy and other sandboxes;
  the OAuth callback listener; run flags; mounts; environment) and the
  commit it was assessed at. It covers both deployment shapes: under
  compose, and outside it, where Agents work today. Its Findings table
  (S2-1 to S2-5) gives each finding's one-line statement, attacker
  position, hypothesis, claimed severity against the PRD's definitions,
  probe tests, and what the fix must make true.
- **Four probe test files**, beside the code they probe:
  - `packages/orchestrator/src/sandbox/docker-run.pen-test.test.ts`: the
    real `dockerSandbox` (through `allowListed`) and `dockerToolRunner`,
    driven against a stand-in `docker` CLI that records the exact
    `docker run` they issue.
  - `docker/sandbox-isolation.pen-test.test.ts`: the compose files, the
    EC2 process and the real `loadConfig` with compose's own environment.
  - `apps/server/src/ai-accounts/oauth-callback.pen-test.test.ts`: the real
    callback listener, bound `0.0.0.0` as compose binds it, in front of the
    real AI Accounts and a fake OpenAI-shaped OAuth server, reached from a
    non-loopback address.
  - `packages/orchestrator/src/sandbox/environment.pen-test.test.ts`: the
    allow-list, the credential refusal, and the read-only `GH_TOKEN` minted
    by the real GitHub App client against the fake GitHub.

### The findings

| ID | Statement | Severity |
|---|---|---|
| S2-1 | Sandboxes have open egress: their network has a route anywhere and nothing filters it (H2) | high |
| S2-2 | On the documented EC2 set-up a sandbox can reach the instance metadata service: Ubuntu 24.04 with IMDSv2 defaults to a hop limit of 2, which the document never lowers (H2) | high |
| S2-3 | A sandbox reaches the app's web app, API and sign-in routes (3045) and the OAuth callback (1455), not only the AI Gateway (H3 reach, H14 reach) | high |
| S2-4 | Sandboxes start with Docker's defaults only: no capability drop, no `no-new-privileges`, no memory or PID limit, a writable root filesystem (new) | medium |
| S2-5 | Every Floor's sandboxes share one bridge network with inter-container traffic on (new) | medium |

What holds, each kept holding by a plain `it`:

- A sandbox cannot cancel, fail or race the Owner's ChatGPT sign-in through
  the callback listener (`?error=`, missing, guessed or made-up states, and
  late callbacks all change nothing; the state is 256 bits; PKCE is S256).
- IMDSv1 is off on the documented EC2 set-up.
- Postgres and Caddy are off the sandboxes' network, and the development
  Postgres is on loopback only.
- No sandbox is privileged, given a device, given a host namespace or the
  Docker socket. Seccomp and AppArmor are left on.
- Sandboxes run as AI Office's own non-root user.
- Each sandbox mounts only its own clone read-write, and its Skills and the
  Manager's clone read-only.
- The environment allow-list holds, including against what Sandcastle
  gathers from a repository's `.sandcastle/.env`.
- AI Account credentials are refused by shape and by value, and every agent
  tool takes a Gateway Key only.
- `GH_TOKEN` is one repository's, read-only: comment, issue, pull request
  and ref writes are each refused with 403.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      `S2.md` has a section per bullet (egress, reach into the stack, the
      OAuth callback listener, run flags, mounts, environment), with a
      verdict for every item each bullet names. The run flags are a table
      of capabilities, `no-new-privileges`, user, memory and PID limits,
      read-only root, seccomp/AppArmor and devices.
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.** There are 12 `it.fails`: S2-1 ×1, S2-2 ×1,
      S2-3 ×1, S2-4 ×4 for each of the two `docker run`s (8), and S2-5 ×1.
      Each sits beside a passing pin, and the table names the file and
      test. Each `it.fails` was also flipped to `it` once, by hand, to see
      that it fails on its own assertion about the property (12 failures,
      every one an `AssertionError`, such as `expected [] to include
      'ALL'` and `expected undefined to be true`). It was then put back.
- [x] **Nothing in production code changes.** `git diff b19d98f --stat`
      lists only the four `*.pen-test.test.ts` files and `S2.md` (this note
      was added after):

  ```
   .../ai-accounts/oauth-callback.pen-test.test.ts    | 167 +++++++++++
   docker/sandbox-isolation.pen-test.test.ts          | 190 +++++++++++++
   docs/pen-testing/assessments/S2.md                 | 304 +++++++++++++++++++++
   .../src/sandbox/docker-run.pen-test.test.ts        | 303 ++++++++++++++++++++
   .../src/sandbox/environment.pen-test.test.ts       | 212 ++++++++++++++
   5 files changed, 1176 insertions(+)
  ```
- [x] **`pnpm lint`, `pnpm typecheck` pass; `pnpm test`.** See below. Every
      probe test passes. The two failures are pre-existing, the same two
      that #192's note recorded, and outside the probe's diff.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck`: exit 0

```
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

### `pnpm test`: the probe's tests pass; the suite carries two pre-existing failures

The whole-repo run (`vitest run`, 221.44 s) finished:

```
 Test Files  2 failed | 413 passed (415)
      Tests  2 failed | 4654 passed | 30 expected fail | 597 skipped (5283)
```

The **30 expected fail** are A1's 18 `it.fails` and this probe's 12. They
pass by failing, as the findings workflow intends. The skips are the
Postgres and Docker tests, skipped with their reason in this sandbox.
**Neither failure is in a file this probe added or in a project it
touches.** The three projects its files live in are green on their own:

```
# pnpm exec vitest run --project @ai-office/orchestrator --project @ai-office/server --project deployment
 Test Files  191 passed (191)
      Tests  1823 passed | 30 expected fail | 452 skipped (2305)
```

Both failures are in `@ai-office/web`, and both read the root
`CHANGELOG.md`. It opens `## 1.0.0` with no release date, while the tests
expect `1.0.0 (YYYY-MM-DD)`. The changelog came from main (`3ca0165 docs:
Changelog`); this probe changes neither it nor `apps/web`. The two files
fail the same way run alone:

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/

# cd apps/web && pnpm exec vitest run src/site-footer.test.tsx src/legal/legal.test.tsx
 Test Files  2 failed (2)
      Tests  2 failed | 14 passed (16)
```

No test was skipped, deleted or weakened to reach this state. One probe
test is conditional: the callback's reach from a non-loopback address
(`it.skipIf` when the machine has no such address). It ran here, from
`eth0`.

## What could not be exercised here

- **A live sandbox** needs Docker. The run flags are the exact arguments
  AI Office's code passes to `docker`, recorded by a stand-in CLI. What
  Docker then gives a container (its default capabilities, seccomp and
  AppArmor profiles) is from Docker's documentation. The checks to make
  from inside a sandbox on the pen-test stack are listed in `S2.md`, under
  "Could not be exercised here".
- **Egress, reach and sandbox-to-sandbox traffic** were read from the
  compose files and `loadConfig`, not sent over a Docker network.
- **The EC2 metadata hop limit** needs an instance. That Ubuntu 24.04 AMIs
  (`ImdsSupport: v2.0`) default to a hop limit of 2 is from AWS's EC2
  documentation and Canonical's LP #2075385, found by web search during the
  probe. On the stack, `aws ec2 describe-instances` shows it.
- **Outside compose**, the reach of a sandbox on the default bridge to the
  host's `0.0.0.0` listeners was established from `loadConfig`'s defaults
  and Docker's bridge networking, not run.
