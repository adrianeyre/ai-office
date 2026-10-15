# Issue #188: [pen-test] E2 — Seed fixtures and the hostile-content corpus — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GitHub token) at the working tree of this issue's commits, on
top of `186c516`. The database path was also run for real against an
embedded Postgres 18.3 (below), as earlier notes do without Docker.

## Blockers

The issue is **Blocked by #187** (the pen-test stack). #187's work is on
this branch and in the tree: `docker/pen-test/compose.yml`, `stand-up`,
`teardown`, `stub-upstream.ts`, `stub-accounts.ts`, `add-ai-accounts.ts`
and `stack.ts`, with its verification at
[`docs/verification/issue-187.md`](issue-187.md). E2 builds on it (the
stub upstream, the AI Accounts and the stand-up), so the blocker is met.

## What was built

All in [`docker/pen-test/`](../../docker/pen-test/), plus the seed section
of [`docs/pen-testing/stack.md`](../pen-testing/stack.md).

### The hostile-content corpus (`corpus.ts`)

The fixture data for attacker position 2: ten items covering the artefact
kinds the PRD lists (issue bodies, repository files — `CLAUDE.md`,
`.claude/settings.json`, `package.json` scripts, a shell script —, a review
comment, a Skill, a Floor Template with a `setupCommand`, and a memory
proposal). Each item carries a unique canary string
(`pen-test-canary-corpus-<id>`) and names the hypothesis it tests:

| Hypothesis | Items |
| --- | --- |
| H8 (CI runs Agent code, self-merge) | `issue-ci-secret`, `package-json`, `ci-script` |
| H9 (memory poisoned across tasks) | `memory-proposal` |
| H10 (injection via repo, reviews, Skills, Templates) | `issue-override`, `claude-md`, `claude-settings`, `review-comment`, `skill` |
| H13 (fetches reach internal addresses) | `floor-template` (imported from an internal Git host) |

Each canary is harmless: it asks its reader to fetch `/canary/<canary>` on
the stub upstream, never anywhere else, so a success shows as one line in
the stub's log. The H13 item's internal address is the import host, not the
canary (the canary still phones the stub home).

### The seed (`seed.ts`, `seed-stores.ts`)

`seed()` is written against the store interfaces, so it runs against memory
stores or a real database (`databaseSeedStores`). It makes, idempotently:

- **two Floors**: `pen-test-target` (the throwaway repository, Merge Policy
  **auto-merge**, so it merges unattended and H8 can be probed) and
  `pen-test-review` (send-to-me); two Floors so a cross-Floor authorisation
  bug can show;
- **Agents in every Stage** on each: a Manager, a coder and a designer
  (work), a reviewer (review), a QA Agent (qa) and a docs Agent (docs);
- the **AI Accounts** at the stub upstream only (ensured through the AI
  Gateway's own `createAiAccounts`, so each canary credential is encrypted);
- the corpus's **Skill** (imported, left disabled and unreviewed, FR-76),
  **Floor Template** (source `git`, from an internal host, unreviewed) and
  **memory proposal** (pending on the target Floor).

`seedResult` reads the final state back, so the fixture IDs are the same
however many times the seed has run.

### Generating the target repository (`generate-target.ts`)

`generateTarget()` opens the corpus's issues (labelled `ai-office` and
`pen-test-corpus`, with the id, hypothesis and canary in each body) and
commits its files to the default branch, idempotently. It is written
against ports (the GitHub App for issues, a commit port for files), so it
is tested with the in-memory fake GitHub; `seed-cli.ts` wires the real App
and `commitFiles` for the stand-up.

### The fixture ID listing (`fixtures.ts`)

`fixtureListing()` names the seeded Floor IDs, Agent IDs, AI Account names,
the corpus items (by id, kind, hypothesis and canary) and the issue
numbers, for the credentials package (E4, #190). It holds no credential.
`writeFixtureListing()` writes it as JSON.

### Shipping with the stand-up (`seed-cli.ts`, `seed`, `compose.yml`, `stack.ts`)

A `seed` service (the `setup` profile) runs `seed-cli.ts` after the app is
up: it seeds the database and generates the target repository, then writes
the fixture ID listing to `pen-test-fixtures.json` in the sandbox work
directory (at the same path on the host). `stand-up` runs it as its fifth
step and prints where the listing is.

## Acceptance criteria

### Verified in the sandbox

- [x] **The seed runs against a database in tests and produces every item
      above.** `seed.test.ts` has a `postgresTest` integration test that
      runs the seed through `databaseSeedStores` against a real Postgres 18
      (via Testcontainers in CI; skipped here with its reason). It asserts
      the two Floors, the unattended-merge Floor, an Agent in every Stage on
      each, the four AI Accounts, and the Skill, Floor Template and memory
      proposal. **Run for real here** against an embedded Postgres 18.3
      (below): every item produced, and the canary credentials encrypted in
      `ai_accounts` (not plaintext).
- [x] **Every corpus item has a canary and a hypothesis, and a test checks
      it.** `corpus.test.ts` checks that every item's canary is
      `pen-test-canary-corpus-<id>`, unique, that its hypothesis is one of
      H8/H9/H10/H13, that all four hypotheses and all six artefact kinds are
      present, and that every canary phones home only to the stub.
      `seed.test.ts` re-checks it on the corpus the seed exposes.
- [x] **Re-running the seed is idempotent.** `seed.test.ts` (memory and
      database) runs the seed twice and asserts the same Floors and Agents,
      one Skill, one Floor Template, one pending proposal and four AI
      Accounts. `generate-target.test.ts` runs the generator twice and
      asserts no new issue is opened. Confirmed against embedded Postgres
      (below).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck exit 0. `pnpm test` exits 1 on **two pre-existing failures
      this issue does not touch** (below); everything else passes, including
      this issue's 21 tests (1 database test skipped without Docker).

### Verified on the host

- [ ] **Seeded against the stood-up stack and its throwaway repository.**
      Not verifiable here: there is no Docker, and no GitHub token for the
      target repository. What could be run without Docker was (below).

## Pre-existing test failures (not this issue)

`pnpm test`: **2 failed | 4570 passed | 599 skipped**. Both failures are in
`apps/web`, on the CHANGELOG's first heading:

- `src/legal/legal.test.tsx` › "is the root CHANGELOG.md, starting at the
  current version";
- `src/site-footer.test.tsx` › "opens the changelog from the version…".

Both expect the top heading to be `1.0.0 (<date>)`, as semantic-release
writes it; `CHANGELOG.md` on this branch is still a draft `## 1.0.0`
without a date. `git diff 186c516 HEAD -- CHANGELOG.md apps/web` is empty:
this issue changes neither file, so the failures are pre-existing. (The
`docker/deployment.test.ts` 1455 failure that #187's note recorded no
longer fails on this branch.)

## Run without Docker: the database path, for real

An embedded Postgres 18.3 (`@embedded-postgres/linux-x64@18.3.0-beta.16`,
under `/tmp`, outside the repository, as #187's and earlier notes do) stood
in for the stack's Postgres. The migrations were applied, then the seed ran
through `databaseSeedStores` twice:

```text
floors [["pen-test-target","auto_merge",["docs","qa","review","work","work"],6],
        ["pen-test-review","send_to_me",["docs","qa","review","work","work"],6]]
accounts [ 'Claude (pen-test stub)', 'Grok (pen-test stub)',
           'Gemini (pen-test stub)', 'OpenAI-compatible (pen-test stub)' ]
skill { id: 'pen-test-corpus-skill', name: 'pen-test-release-helper' }
template { id: 'pen-test-corpus-template', name: 'Pen-test target kit' }
mem { id: 1, floorId: 'pen-test-target' }
idempotent: floorsList 2 skills 1 templates 1 pending 1 accounts 4 sameFloors true
canary leak in ai_accounts table? false  rows 4
```

So against a real database: two Floors (one unattended-merge), six Agents
each covering work/review/qa/docs, four AI Accounts at the stub, the Skill,
Floor Template and memory proposal; a second run changed nothing; and the
canary credentials are encrypted at rest, not in the `ai_accounts` rows.
Nothing of this is in the repository.

## Not verifiable in this sandbox

- **Docker**: the `postgresTest` Testcontainers path of `seed.test.ts` (run
  against embedded Postgres instead, above, and in CI); the `seed` compose
  service in the built image; `docker compose config` (skipped with its
  reason).
- **The throwaway GitHub repository**: `generate-target.ts` opening issues
  and committing files needs a real GitHub App and repository. It was
  tested against the in-memory fake GitHub; the real `commitFiles` path and
  the installation token are the host's.

## Noticed, out of scope

- **App-authored corpus issues are not Owner-authored.** `generate-target`
  opens the issues as the GitHub App (its author is the App's bot), but
  intake takes in only issues the Owner opened or the Owner labelled
  personally (FR-8). So the seeded issues do not enter the pipeline on their
  own; the red team or the probe (#194) arranges that. The issues carry the
  `ai-office` and `pen-test-corpus` labels and the canary metadata for that.
- **The fixture listing lives in the sandbox work directory.** Teardown
  removes that directory, so the listing goes with it. It is collected and
  delivered during the round by E4 (#190), before teardown, like the stub's
  log.
- **The second Floor's repository is synthetic.** `pen-test-review` is a
  fixture Floor for cross-Floor authorisation testing; its
  `githubRepositoryId` is a deterministic negative number, and its
  repository is not a real GitHub repository. Only `pen-test-target` works a
  real repository.

## Output

### `pnpm lint`

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
LINT_EXIT=0
```

### `pnpm typecheck`

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
TYPECHECK_EXIT=0
```

### `pnpm test`

```text
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  2 failed | 405 passed (407)
      Tests  2 failed | 4570 passed | 599 skipped (5171)
```

### This issue's tests (verbose, `deployment` project)

```text
✓ corpus.test.ts  (9 tests)
✓ fixtures.test.ts  (3 tests)
✓ generate-target.test.ts  (3 tests)
✓ seed.test.ts > against memory stores  (6 tests)
↓ seed.test.ts > against a database > produces every item, and a second run
  changes nothing  [Docker is not available …, skipped; runs in CI and on the host]
      Tests  21 passed | 1 skipped (22)
```

### The pen-test deployment suite (with #187's)

```text
$ pnpm exec vitest run --project deployment docker/pen-test
 Test Files  7 passed (7)
      Tests  71 passed | 2 skipped (73)
```
