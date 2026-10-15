# Issue #197: [pen-test] I1 — Infrastructure and delivery — verification

Checks were run in the Sandcastle sandbox: Node 26.10.0, pnpm 12.10.0,
git 2.39.5. There was no Docker, no EC2, no second host, no GitHub and no
live model, and no network beyond the registry and the model (`pnpm
audit` reached the registry). The probe was assessed at commit `7b0bdb4`,
the branch head with a clean worktree at the start. `pnpm lint`, `pnpm
typecheck` and `pnpm test` were run with the probe's tests and assessment
committed.

This issue is a **probe**, not a fix. It answers H13, H15 and H17,
re-assesses H20 and the "Confirm, don't re-test" CI line, produces an
assessment and committed probe tests, and changes no production code.

## Blockers

The issue names none directly; it builds on the surface earlier slices
established. Everything I1 uses exists in the tree:

- the real Gateway and its test support (`packages/gateway`);
- the real AI Account, webhook and import schemas, and `gitSkillRepository`;
- the real version-check route (`apps/server/src/version`) and `buildApp`;
- the compose file, Dockerfiles and `.github/workflows/`;
- the cross-reference test (`test/pen-testing.test.ts`).

The siblings whose findings I1 cross-references (S2-1/S2-2 egress and
IMDS, A1-1/A1-6 the limiter and headers, G1/G1-7 the Gateway) are present
in `docs/pen-testing/assessments/` and the code.

## What was produced

- **Assessment** `docs/pen-testing/assessments/I1.md`. It records the
  commit it was assessed at, and has a verdict on each "What to probe"
  bullet:
  - the EC2 + Caddy deployment: ports (HOLDS), TLS (HOLDS), the
    restriction to the Owner (HOLDS), IMDS (S2-2), backups (HOLDS);
  - Owner-triggered fetches: the custom AI endpoint (FINDING I1-1), the
    webhook Connection (FINDING I1-2), Skill/Template import (FINDING
    I1-3), the outbound proxy (HOLDS, folded in);
  - images: tag not digest (FINDING I1-4), `curl | bash` (FINDING I1-5);
  - dependency advisories (HOLDS for prod; two dev-only, recorded);
  - CI: SHA-pinned, `contents: read`, `persist-credentials: false`, no
    `pull_request_target`/`workflow_run` (HOLDS); `release.yml` (FINDING
    I1-6) and `pages.yml` (FINDING I1-7);
  - documentation drift: FR-1/FR-2 (I1-8), `.env.example` (I1-9), the
    compose comment (I1-10); the Gateway-port comment and the guide HOLD;
  - the version check (FINDING I1-11);
  - the website (HOLDS).

  Its **Findings** table (I1-1 to I1-11) gives, for each: a one-line
  statement, the attacker position, the hypothesis it confirms (or
  "new"), the claimed severity with the PRD's definitions, the probe
  tests, and what the fix must make true. It says what could not be
  exercised here and how the stack would exercise it.

- **Eight probe test files**, beside the code they probe:
  - `packages/gateway/src/endpoint-ssrf.pen-test.test.ts` (I1-1, Gateway
    half): the real Gateway returns a loopback endpoint's body to a
    Gateway Key holder.
  - `packages/shared/src/ai-accounts.pen-test.test.ts` (I1-1, schema
    half): the endpoint URL accepts internal hosts and plain http.
  - `packages/communications/src/transports/webhook.pen-test.test.ts`
    (I1-2): the real transport POSTs to a loopback service; a blind SSRF
    with a status oracle.
  - `packages/orchestrator/src/skills/git.pen-test.test.ts` (I1-3): the
    real `gitSkillRepository` as an existence oracle; the import schemas.
  - `docker/supply-chain.pen-test.test.ts` (I1-4, I1-5, bullet 1): image
    pins, installers, and the loopback-bound ports.
  - `test/ci-workflows.pen-test.test.ts` (I1-6, I1-7, the CI line).
  - `test/documentation-drift.pen-test.test.ts` (I1-8, I1-9, I1-10).
  - `apps/server/src/version/routes.pen-test.test.ts` (I1-11): the real
    route with a fake GitHub answer.

### The findings

| ID | Statement | Severity |
|---|---|---|
| I1-1 | A custom AI endpoint is fetched with no block on its host, so the Gateway reads an internal service (the metadata service, Postgres, `app:3047`) and returns its body to the Gateway Key holder (H13) | medium |
| I1-2 | The generic webhook Connection accepts http and internal hosts: a blind SSRF with a status/reachability oracle (H13) | low |
| I1-3 | Skill and Floor Template import accept internal https hosts with no address block: an existence/error oracle (H13) | low |
| I1-4 | Images are pinned by tag, not digest, so a re-pointed tag runs new code everywhere (H15) | low |
| I1-5 | The sandbox images install Claude Code by `curl \| bash`, and gh/pnpm/Codex/opencode at a moving version (H15) | low |
| I1-6 | `release.yml` runs its dependency tree under a `contents`/`issues`/`pull-requests: write` token (H20) | low |
| I1-7 | `pages.yml` grants `pages`/`id-token: write` to the build job, which never uses them (H20) | low |
| I1-8 | FR-1/FR-2 describe one password; the code has several and API-key sign-in (H17) | low |
| I1-9 | `.env.example` says the Gateway has no authentication yet; the code requires a Gateway Key (H17) | low |
| I1-10 | The compose comment claims sandboxes reach only the Gateway; the app's 3045 and 1455 answer too (H17) | low |
| I1-11 | The latest-version answer is accepted as any string and shown unchecked (new) | low |

What holds, each kept holding by a plain `it`:

- The deployment binds the app, the OAuth callback and the Gateway to the
  host's loopback; Postgres publishes no port; only Caddy's 80/443 face
  the network.
- CI SHA-pins every action, checks out with `persist-credentials: false`,
  uses no `pull_request_target`/`workflow_run`, and `ci.yml` is `contents:
  read`.
- `pnpm audit --prod` is clean; the two advisories are development-only.
- The version check asks one fixed GitHub URL, is owner-access, and caches
  a failure for only a minute; the string it shows is escaped and the link
  URL-encoded.
- The website serves nothing the running app trusts.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      Each of the eight bullets is a section of `I1.md` with a HOLDS or
      FINDING verdict on every part, including what could not be exercised
      and the stack check for it.
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.** There are twelve `it.fails` (I1-1 has two:
      the schema and the Gateway half; I1-2…I1-11 one each), each beside a
      passing pin, and the table names the file(s) and both tests. Each
      `it.fails` was flipped to `it` once, all together, to see it fails on
      its own property assertion and not a setup error: twelve failed, each
      with an `AssertionError`:

      ```
       Test Files  8 failed (8)
            Tests  12 failed | 30 passed (42)
      ```

      among them `expected '{"AccessKeyId":"AKIA…"}' not to contain
      'AKIAFAKEFAKEFAKEFAKE'`, `expected [ 'contents', 'issues', … ] to
      deeply equal []` and `expected 200 to be 502`. They were then put
      back as `it.fails`, and the eight files run green:

      ```
       Tests  30 passed | 12 expected fail (42)
      ```

      The cross-reference test (`repository` project) finds each of the
      eight files linked from `I1.md`.
- [x] **Nothing in production code changes.** `git diff 7b0bdb4 --stat`
      lists only probe tests and the assessment:

      ```
       apps/server/src/version/routes.pen-test.test.ts    | 124 ++++++
       docker/supply-chain.pen-test.test.ts               | 150 ++++++++
       docs/pen-testing/assessments/I1.md                 | 417 ++++++++++++
       .../src/transports/webhook.pen-test.test.ts        | 126 +++++++
       .../gateway/src/endpoint-ssrf.pen-test.test.ts     | 153 ++++++++
       .../orchestrator/src/skills/git.pen-test.test.ts   | 121 ++++++
       packages/shared/src/ai-accounts.pen-test.test.ts   |  69 ++++
       test/ci-workflows.pen-test.test.ts                 | 155 ++++++++
       test/documentation-drift.pen-test.test.ts          |  91 +++++
       9 files changed, 1406 insertions(+)
      ```

- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails with the **two pre-existing
      `@ai-office/web` failures** recorded by #192–#196, plus one
      **load-induced timeout** in a 3D-scene test that passes on its own.
      None is in this probe's diff or a project it touches. See below.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck`: exit 0

```
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

### `pnpm test`: the probe's projects are green; the suite carries pre-existing failures and one flake

The whole-repository run (`vitest run`, 268.19 s) finished:

```
 Test Files  3 failed | 459 passed (462)
      Tests  3 failed | 4931 passed | 89 expected fail | 600 skipped (5623)
```

The **89 expected fail** are the earlier probes' `it.fails` and this
probe's 12. They pass by failing, as the findings workflow intends. The
skips are the Postgres and Docker tests, skipped with their reason here.

**None of the three failures is in a file this probe added, or in a
project it touches.** The projects I1's files live in are green on their
own, and so is the cross-reference test (`repository`):

```
# @ai-office/communications, @ai-office/shared, @ai-office/gateway
 Test Files  101 passed (101)
      Tests  1090 passed | 6 expected fail | 118 skipped (1214)
# @ai-office/orchestrator
 Test Files  147 passed (147)
      Tests  1353 passed | 37 expected fail | 278 skipped (1668)
# deployment, repository
 Test Files  17 passed (17)
      Tests  193 passed | 14 expected fail | 13 skipped (220)
# @ai-office/server (the version-check probe)
 ...all passed; 1 expected fail in routes.pen-test.test.ts
```

The three failures:

1. **`@ai-office/web` `src/site-footer.test.tsx`** and
2. **`@ai-office/web` `src/legal/legal.test.tsx`** — the two pre-existing
   failures #192–#196 recorded. Both read the root `CHANGELOG.md`, whose
   first heading is `## 1.0.0` with no release date, while the tests
   expect `1.0.0 (YYYY-MM-DD)`:

   ```
    FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
   AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/
    FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
   AssertionError: expected '1.0.0' to match /^1.0.0 \(/
   ```

3. **`@ai-office/web` `src/scene/idle-behaviours.test.ts`** — a
   CPU-heavy 3D-pathfinding test (`it.each([2, 5, 6, 9, 12, 21])`) that
   **timed out at 30 s** under the load of the full parallel run (which
   took 268 s). It passes on its own:

   ```
   Error: Test timed out in 30000ms.
    ❯ src/scene/idle-behaviours.test.ts:294:32

   # run on its own:
   # pnpm exec vitest run --project @ai-office/web src/scene/idle-behaviours.test.ts
    Test Files  1 passed (1)
          Tests  45 passed (45)
   ```

   This probe adds no web or scene code, so the timeout is a load-induced
   flake, not a regression.

No test was skipped, deleted or weakened to reach this state.

## What could not be exercised here

- **A real EC2 instance and Docker:** the metadata service reached end to
  end through a custom AI endpoint (I1-1), a webhook aimed at `app:3047`
  and `postgres:3048` (I1-2), a re-pointed image tag (I1-4), and
  `claude.ai/install.sh` fetched at build time (I1-5). Here loopback
  stand-ins and the parsed files proved each property; `I1.md` gives the
  stack check for each.
- **A real release run:** `GITHUB_TOKEN` present while dependency code
  runs (I1-6). `I1.md` gives the canary-dependency check.
- **An on-path attacker to raw.githubusercontent.com** (I1-11): shown with
  a fake `fetch`, not a real intercept, which is outside positions 1–5.
- **`pnpm audit` at the exact pinned commit on the stack:** run here
  against the live registry (two dev-only advisories, clean `--prod`);
  re-run on the stack to confirm.
