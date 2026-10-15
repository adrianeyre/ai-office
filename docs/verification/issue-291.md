# Issue #291: [fix] W1-2 — The App's own installation tokens ask GitHub for no permissions, so each carries every permission the installation was granted — verification

Checks were run in the Sandcastle sandbox (git 2.39.5, Node 26.10.0, pnpm
12.10.0, no Docker, no GitHub, no network beyond the registry and the
model; Postgres variants skip with their reason). The fix is commit
`f650316`,
`fix(security): W1-2 every installation token asks for the permissions its use needs, and no more`,
on top of W1-1's `8eeea47` (#289). Its blocker, the W1 probe (#196), is
in the tree: `docs/pen-testing/assessments/W1.md` and
`packages/github/src/app.pen-test.test.ts`.

This is the remediation of finding **W1-2** (`severity:low`, new,
position 3 after a breach of the app).

## What was fixed

Both of the App's own installation tokens left `permissions` out of the
mint, so GitHub gave each **every** permission the installation was
granted. That meant anything the Owner granted beyond the setup guide's
table, by mistake or for something else, such as **Administration**.
The token that lists repositories also asked for no repositories, so it
covered every repository of the installation with all of them, and was
kept for 55 minutes.

**Now every token AI Office mints asks for what its use needs**
(`packages/github/src/app.ts`, `types.ts`):

- **The token that writes** (`installationToken()`, and the client's own
  calls: push, merge, labels, comments) asks for `appPermissions`, the
  guide's table. It adds **Workflows: write** only when the installation
  was granted it (`writingPermissions`). What was granted is read from
  `GET /repos/{owner}/{repo}/installation` at each mint, so a grant the
  Owner adds or removes counts from the next token.
- **The token that lists the installation's repositories**
  (`repositories()`) asks for `{ metadata: "read" }` alone
  (`listingPermissions`).
- **The sandbox's read-only token** already asked for
  `readOnlyPermissions`, and still does.

The fake GitHub now models an installation's grants
(`grantPermissions`): a token minted with no permissions carries them, a
mint asking beyond them is refused (422), and
`GET /repos/{owner}/{repo}/installation` answers them, as GitHub's does.
The setup guide's **The App's permissions** says what each token asks
for.

### Sibling paths with the same flaw, fixed and tested

There are three mints (`mint(`) in the client, and all three now ask for
permissions:

- **The token that writes.** It serves every caller of
  `installationToken()` and every call the client makes as the App:
  `push-run.ts` (an Agent's branch), `memory/curation.ts` and
  `grilling/documents.ts` (AI Office's own commits). Tested: "the token
  that writes asks for only the permissions AI Office needs", the
  regression test below, and "asks for Workflows too when, and only
  when, the Owner granted it". `app.test.ts`'s "mints one token per
  repository, scoped to it, and reuses it" now expects `appPermissions`
  on each mint.
- **The listing token.** Tested: "the token that lists the
  installation's repositories reads metadata only", and its regression
  test.
- **The read-only token.** Unchanged, and still tested by "the sandbox's
  token: the Floor's repository alone…".

## Decisions

- **Workflows is asked for when, and only when, the installation has
  it.** The setup guide offers **Workflows: Read and write** "only if you
  want Agents to change CI". Asking for `appPermissions` alone would turn
  that choice off without a word: a push changing `.github/workflows/`
  would be refused and the Agent blocked. Asking for it only when
  granted keeps the Owner's choice, and nothing else beyond the table
  reaches a token. It costs one App call (`GET …/installation`) per mint,
  at most once in 55 minutes per repository.
- **The listing token covers the installation's repositories.** Listing
  them is its use, so it cannot be narrowed to one. With metadata alone
  it reads nothing but their names and settings.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** Both are
      `it`s and pass, with their bodies unchanged: "W1-2: the token that
      writes asks for only the permissions AI Office needs
      (appPermissions), not all the installation has" and "W1-2: the
      token that lists the installation's repositories reads metadata
      only".
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
  - *"pins today (W1-2): the token that writes asks for no permissions,
    so it carries every one the installation was granted"* is now
    "regression (W1-2): the token that writes no longer asks for no
    permissions, so it does not carry every one the installation was
    granted". It grants the installation **Administration: read** and
    **Secrets: write** beyond the table. It then asserts that the mint
    has `permissions`, that they are `appPermissions`, and that the
    token's scope on the fake has no `administration`.
  - *"pins today (W1-2): the token that lists repositories asks for
    neither repositories nor permissions…"* is now "regression (W1-2):
    the token that lists repositories no longer asks for no permissions:
    it lists every repository of the installation, with metadata alone".
    It still lists both repositories, and asserts the mint asks for
    `{ metadata: "read" }`.

  No test was deleted.
- [x] **Sibling paths with the same flaw are fixed and tested.** See
      above.
- [x] **The assessment's findings table marks `W1-2` fixed.**
      `docs/pen-testing/assessments/W1.md`: **fixed** (issue #291), with
      the commit's subject (the hash is filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on six `repository` and
      `deployment` tests that fail the same way on the base commit
      (below). Every test of these fixes passes.

## Real output of the checks

The three checks were run on the tree of all six fixes (W1-6 then
uncommitted, since committed as `a579b6a` unchanged), before these notes
were written:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
$ pnpm typecheck
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
$ pnpm test
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 Test Files  4 failed | 473 passed (477)
      Tests  6 failed | 5325 passed | 55 expected fail | 611 skipped (5997)
test exit 1
```

**The six failures are not these fixes'.** They read only
`.env.example`, `docker-compose.yml` and files under `docker/`, which no
commit here touches (`git diff --stat 20b619d HEAD -- docker
.env.example docker-compose.yml test` is empty), and the same six fail
on the base commit, `20b619d`, run in a scratch worktree
(`pnpm vitest run --project repository --project deployment`: "Tests  6
failed | 202 passed | 14 expected fail | 13 skipped (235)"). The full
listing, and what each asserts, is in
[issue #289's note](issue-289.md#real-output-of-the-checks).

### W1-2's tests on their own

```
 ✓ |@ai-office/github| src/app.pen-test.test.ts > what each token is minted for > W1-2: the token that writes asks for only the permissions AI Office needs (appPermissions), not all the installation has
 ✓ |@ai-office/github| src/app.pen-test.test.ts > what each token is minted for > regression (W1-2): the token that writes no longer asks for no permissions, so it does not carry every one the installation was granted
 ✓ |@ai-office/github| src/app.pen-test.test.ts > what each token is minted for > W1-2: the token that writes asks for Workflows too when, and only when, the Owner granted it, so Agents may change CI as the guide offers
 ✓ |@ai-office/github| src/app.pen-test.test.ts > what each token is minted for > W1-2: the token that lists the installation's repositories reads metadata only
 ✓ |@ai-office/github| src/app.pen-test.test.ts > what each token is minted for > regression (W1-2): the token that lists repositories no longer asks for no permissions: it lists every repository of the installation, with metadata alone
 ✓ |@ai-office/github| src/app.test.ts > the GitHub App client > mints one token per repository, scoped to it, and reuses it
```

The orchestrator's tests of pushes, memory curation and Grilling
documents, which push with the token that writes against the fake, all
pass (`pnpm vitest run` in `packages/orchestrator`: "Test Files  152
passed (152)", at the W1-3 commit).

## What could not be verified here

There is no GitHub here. The fake gives a token minted with no
`permissions` its installation's grants, as GitHub does, but that has
not been seen on GitHub itself. On the pen-test stack:

- Grant the stack's App one extra permission (such as **Administration:
  Read-only**) and accept it on the installation. Then check that a
  token from `installationToken()` no longer answers
  `GET /repos/{owner}/{repo}/collaborators`, which needs it (it did
  before this fix), and that a read-only token does not either.
- Check that GitHub accepts `{"metadata":"read"}` for the listing token,
  and the writing token's `appPermissions` (with `metadata` in them), on
  `POST /app/installations/{id}/access_tokens`.
- With **Workflows: Read and write** granted, check that a push changing
  `.github/workflows/` is still taken. Without it, check that GitHub
  refuses it as before.

## Noticed, out of scope

- **The six `repository` and `deployment` tests that fail on the base
  commit** (see [issue #289's note](issue-289.md#noticed-out-of-scope)).
