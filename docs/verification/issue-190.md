# Issue #190: [pen-test] E4 — The credentials package and its delivery — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GitHub token), in the working tree at `da6667c`, on top of
`95efd27`. The minting and revocation were also run for real against an
embedded Postgres 18.3 and the real server (below), as earlier notes do
without Docker.

## Blockers

The issue is **Blocked by #188** (E2, the seed fixtures), and the PRD's
Sequence puts E2 before E4. #188's work is on this branch and in the tree:
`docker/pen-test/seed.ts`, `seed-cli.ts`, `corpus.ts`, `generate-target.ts`
and `fixtures.ts`, with the `seed` service that writes the fixture ID
listing to `pen-test-fixtures.json` in the sandbox work directory, and its
verification at [`issue-188.md`](issue-188.md). E4 reads that listing into
the package. #188 itself built on #187 (the stack, its stand-up and
teardown, [note](issue-187.md)), which E4 extends. The blocker is met.

## What was built

### The package and its checks (`docker/pen-test/credentials.ts`)

- **`mintCredentials`** mints, through AI Office's own stores:
  - a further Owner password named **Pen-test red team**: 32 random
    characters, kept only as its Argon2id hash (`hashPassword`, as the
    server hashes every password);
  - an Owner tool's key **Pen-test red team (UI)** with `proxy_and_ui`
    access, the UI-capable API key;
  - an Owner tool's key **Pen-test red team (Gateway)** with `proxy` access,
    the Gateway Key.

  The keys go through `createGatewayKeys`, so each is in the Activity Feed
  as made. Minting refuses:
  - before the Owner has set the stack's password, because the setup screen
    is still open then (H4);
  - while any of the three is in use: one of each, revoked before the next.
- **`credentialsPackage`** puts them together with the address to use them
  at, the AI Gateway's address, the pinned commit
  (`source: {commit, access: "read-only"}`) and E2's fixture ID listing.
- **`packageProblems`** says why a package may not be handed over, naming
  what is wrong and never its value. It refuses:
  - anything but exactly `ownerPassword`, `uiApiKey` and `gatewayKey`;
  - a UI-capable API key without UI access, or a Gateway Key with more;
  - an empty credential;
  - the value of `ENCRYPTION_KEY`, `SESSION_SECRET`,
    `GITHUB_APP_PRIVATE_KEY` or `POSTGRES_PASSWORD`, or the password in
    `DATABASE_URL`, wherever they were given (`forbiddenValues`);
  - any of those settings named as a key;
  - a database URL, a private key, a GitHub token (CI's, or one that
    writes) or an AI Account's canary credential.
- **`writeCredentialsPackage`** writes a package only if it passes. It
  writes `mode: 0o600` with `flag: "wx"` (never over another), then
  `chmod 0600` and checks the mode.
- **`revokeCredentials`** removes the red team's Owner password (its
  sessions go with it, `ON DELETE CASCADE`) and revokes both keys. It names
  any other Owner password or Owner tool's key made since the package was
  minted, without revoking it. A second run revokes nothing.
- **`runCredentials`** is `mint` or `revoke` as the service runs them. If
  the package cannot be written, it revokes what it just minted. What it
  says names each credential by name and id only.

### The service and its CLI (`credentials-cli.ts`, `compose.yml`)

- **A `credentials` service** in the `setup` profile, in the app's image,
  run as stand-up's user and group IDs. Its entrypoint is
  `node docker/pen-test/credentials-cli.ts`, with the command `mint` or
  `revoke`.
- **What it is given:** only `DATABASE_URL`, `PUBLIC_URL`, `PACKAGE_FILE`
  and `FIXTURES_FILE`. It never gets `ENCRYPTION_KEY`, `SESSION_SECRET` or
  the GitHub App's settings. An Owner tool's key is never sealed, so the CLI
  gives `createGatewayKeys` an encryptor that refuses to seal or open
  anything.
- **What it mounts:** the credentials directory at `/credentials`, which no
  other service mounts (so not the app, so no sandbox), and the sandbox
  work directory read-only, for the fixture ID listing.
- **What it prints:** an unexpected error is printed only by its name and
  code, in case its message quotes what it was given.

### The host side (`stack.ts`, `docker/pen-test/credentials`)

- **`PEN_TEST_CREDENTIALS_DIR`** (in `.env.example`). Stand-up generates it,
  by default `…/ai-office-pen-test/credentials` under the state directory.
  `credentialsDirProblem` holds it to the work directory's checks, and
  refuses it inside the sandbox work directory or holding it.
- **`docker/pen-test/credentials mint`**, which:
  - refuses before stand-up, without the seed's listing, and over a package
    already there;
  - makes the directory `0700` with the stack's marker;
  - runs `compose … run --rm --env PINNED_COMMIT credentials mint`. The
    commit comes from `git rev-parse HEAD` and goes through the
    environment, with no value on the command line;
  - checks the file is `0600`, and deletes it if not;
  - prints the path and the delivery rules.
- **`docker/pen-test/credentials revoke`** runs `credentials revoke`, then
  deletes the host's copy. After teardown it says the credentials went with
  the volume.
- **Teardown** lists and deletes the credentials directory (only one it
  made), with any package in it.
- **The refactor:** `address` and `machineSettings` were taken out of
  `standUp`, unchanged, so mint and revoke use the same address, user IDs
  and Docker group.

### The documents

- **[`docs/pen-testing/credentials-package.md`](../pen-testing/credentials-package.md)**
  (new). What the red team gets and why the keys are Owner tools' keys,
  what it never gets and what enforces that, minting, delivery, revocation
  per credential, destruction at teardown, and the tests.
- **Links into it:**
  - `README.md` (pen-testing): a row in the Documents table, and the "joins
    this table when it lands" sentence goes;
  - `stack.md`: the `credentials` service, the credentials directory, the
    mint step after setup, teardown's step 6 and the tests;
  - `rules-of-engagement.md`: closing the window revokes the package,
    position 4 links it, teardown's list, and what the record's
    **Credentials package delivered** row holds.

## Acceptance criteria

### Verified in the sandbox

- [x] **Tests: the package contains exactly the allowed credentials and
      none of the forbidden ones; the file is written `0600`; nothing is
      echoed.** Checked by `credentials.test.ts`, against memory stores:
  - **Exactly the allowed credentials.** The top-level keys are `about`,
    `credentials`, `fixtures`, `mintedAt`, `source` and `stack`. The
    credentials are exactly `ownerPassword`, `uiApiKey` and `gatewayKey`,
    with `proxy_and_ui` and `proxy` access. Each works: the password
    verifies against the stored hash and passes `ownerPasswordSchema`, the
    API key is a `uiKey`, and the Gateway Key authenticates but is not a
    `uiKey`.
  - **None of the forbidden ones.** Mint ran with obviously fake
    `ENCRYPTION_KEY`, `SESSION_SECRET`, `GITHUB_APP_PRIVATE_KEY`,
    `POSTGRES_PASSWORD` and `DATABASE_URL` in its environment. The file
    holds none of their values or names, no `postgres://`, no private key,
    no AI Account canary and no GitHub token.

    Eleven forbidden packages are each refused with a problem that names
    the fault but never the value, and no file is written: a fourth
    credential, an API key without UI access, a Gateway Key with it, the
    encryption key, the session secret, the database password, a setting
    by name, a database URL, a private key, an AI Account canary and a
    `ghs_` token.
  - **`0600`.** `statSync(…).mode & 0o777` is `0o600`. A second write over
    it is refused, leaving the file as it was. The host side checks `0600`
    and `0700` for its directory (`stack.test.ts`), and deletes a package
    written with `0644`.
  - **Nothing is echoed.** `process.stdout.write`, `process.stderr.write`
    and `console.{log,info,warn,error,debug}` were captured through mint
    and revoke. Neither they nor what was said holds any of the three
    credentials, nor even `aio_gk_` followed by key text. What was said is
    exactly the seven name-and-id lines. The host side puts no `=` value in
    any Docker argument, and prints no credential.

  Also tested:
  - minting refuses before setup and while in use;
  - a failed write revokes what was minted;
  - revocation leaves the password, its sessions and both keys unusable,
    and leaves the Owner's own password alone;
  - revocation names what else was made since;
  - `compose.test.ts`: the service's environment, mounts, profile and
    network;
  - `stack.test.ts`: teardown removes the credentials directory.

  A `postgresTest` runs the CLI itself as a child process against a real
  database. It is skipped here without Docker and runs in CI. The same
  thing was **run for real** against an embedded Postgres (below).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck exit 0. `pnpm test` exits 1 on **the two pre-existing
      failures #188's and #189's notes recorded**, both in `apps/web` on
      the CHANGELOG's first heading (below). This issue touches neither:
      `git diff 95efd27 HEAD -- CHANGELOG.md apps/web` is empty.
      Everything else passes, including this issue's 55 tests in
      `credentials`, `stack` and `compose` (2 skipped without Docker).

### Verified on the host

- [ ] **Minted and revoked against the stood-up stack.** Not verifiable
      here: there is no Docker, so no stack, no `credentials` container and
      no `docker compose run`. What could be run without Docker was: the
      same CLI against a real Postgres and the real server, below.

## Run without Docker: minted and revoked, for real

An embedded Postgres 18.3 (`@embedded-postgres/linux-x64@18.3.0-beta.16`,
under `/tmp`, outside the repository, as #187's and #188's notes do) stood
in for the stack's database. It had a role with an obviously fake password,
so the database password was in `DATABASE_URL` as it is in the service.
After the migrations, the real server (`apps/server/src/main.ts`) ran on it
with a new session secret and encryption key, on 3945 with its AI Gateway
on 3947. The CLI ran exactly as the service runs it, with
`PACKAGE_FILE` in a `0700` directory and a fixture ID listing. A throwaway
checker outside the repository used the package against the server and
printed only status codes. Nothing of this is in the repository.

```text
# before the Owner's setup
$ node docker/pen-test/credentials-cli.ts mint
The pen-test stack has no Owner password yet: open it and set one on the setup screen, then mint the credentials package.
exit=1                                   # and the directory stayed empty

POST /api/setup → 204

$ node docker/pen-test/credentials-cli.ts mint
Minted the Owner password "Pen-test red team" (8d6d8ff8-9ae5-4192-a66f-b17872697933).
Minted the UI-capable API key "Pen-test red team (UI)" (241ac669-c853-4133-b522-2b49efc4a64d).
Minted the Gateway Key "Pen-test red team (Gateway)" (52398907-3f2c-494c-8672-09486034fb9b).
Wrote the credentials package, 0600, to /tmp/embpg/run/credentials/credentials-package.json.
exit=0
700 /tmp/embpg/run/credentials
600 /tmp/embpg/run/credentials/credentials-package.json
top-level: about,mintedAt,stack,source,credentials,fixtures
credentials: ownerPassword,uiApiKey,gatewayKey
access: proxy_and_ui proxy
source: {"commit":"b99059ae00d4b392723693ae8f830ba543cf81fc","access":"read-only"}
stack: {"url":"http://localhost:3945","gatewayUrl":"http://app:3047"}
fixture floors: pen-test-target,pen-test-review

# each credential against the real server
Owner password sign-in: 200; its session: 200
UI-capable API key sign-in: 200
Gateway Key as a UI sign-in: 401
Gateway Key at the AI Gateway: 503        # accepted; this database has no AI Account (FR-38)

$ node docker/pen-test/credentials-cli.ts revoke
Revoked the Owner password "Pen-test red team" (8d6d8ff8-…), and its sessions.
Revoked the Gateway Key "Pen-test red team (Gateway)" (52398907-…).
Revoked the UI-capable API key "Pen-test red team (UI)" (241ac669-…).
exit=0

# the copy handed over, after revocation
Owner password sign-in: 401; its session: none
UI-capable API key sign-in: 401
Gateway Key as a UI sign-in: 401
Gateway Key at the AI Gateway: 401
A session the password began, after revocation: 401
A session the API key began, after revocation: 401

$ node docker/pen-test/credentials-cli.ts revoke
None of the credentials package's credentials is in use.

# nothing echoed: the CLI's output and the server's log
mint.out holds a credential: false | aio_gk_ followed by key text: false
revoke.out holds a credential: false | aio_gk_ followed by key text: false
server.log holds a credential: false | aio_gk_ followed by key text: false

# a package already there: refused, and what it minted revoked again
$ node docker/pen-test/credentials-cli.ts mint
/tmp/embpg/run/credentials/credentials-package.json is already there: revoke its credentials, or hand that one over.
exit=1
gateway_keys: Tim (the Communications Agent's) in use; all four "Pen-test red team" keys revoked
owner_passwords: 0
Activity Feed, gateway changes: created created revoked revoked created created revoked revoked
```

So against a real database and server:
- minting refused before setup;
- after setup it minted one of each credential and wrote the package `0600`
  in a `0700` directory;
- each credential did what it should, and nothing more;
- revocation left none of them, and no session they began, working;
- no credential reached the CLI's output or the server's log;
- the refused second mint left nothing in use;
- the Activity Feed recorded every key made and revoked.

## Not verifiable in this sandbox

- **Docker**:
  - the `credentials` service in the built image, and the bind mounts with
    the host's user and group IDs;
  - `docker compose config` with the new service (skipped with its reason;
    CI runs it, and its environment now sets `PEN_TEST_CREDENTIALS_DIR`);
  - the `postgresTest` that runs the CLI against Testcontainers' Postgres
    (run against embedded Postgres instead, above).
- **The stood-up stack**: minting against it after `stand-up` and the
  Owner's setup, signing in at its published address, and revoking it,
  which is the host criterion.
- **Delivery out of band** is a human act. The page says how; the Owner
  records it in the rules' record.

## Notes: choices the issue leaves open

- **Minted in the database by a one-off service, not over the HTTP API.**
  Minting over the API would need a signed-in session, so the Owner's own
  password would have to be handed to a script, as a flag, on stdin or in
  a file. The service uses the same stores and functions the routes use
  (`AuthStore.addOwnerPassword`, `createGatewayKeys`) and needs no
  credential but the database's.
- **The keys are Owner tools' keys**, named for the red team, not an
  Agent's. An Agent's key is rotated, never revoked, and belongs to its
  sandboxes.
- **The Owner password is a further Owner password**, not the Owner's own,
  so it is revoked without touching the Owner's sign-in.
- **The package is one JSON file.** Its credentials, where to use them, the
  pinned commit and the fixture listing travel together.
- **Revoking deletes the host's copy too.** Teardown deletes the directory
  whatever is left, as the issue says.
- **The pinned commit is `git rev-parse HEAD`.** Stand-up builds the
  checked-out tree, so a tree with local changes is not exactly that
  commit. The rules of engagement already ask the Owner to check out the
  pinned commit; nothing checks the tree is clean.

## Noticed, out of scope

- **The package's Gateway Key cannot reach the AI Gateway from the red
  team's host.** The stack publishes only the app (`stack.md`, and
  `compose.test.ts` pins it): the Gateway is `app:3047` on the stack's
  networks. So a position-4 probe with the Gateway Key works only from
  inside the stack: the sandbox harness, or `docker compose exec`.
  Publishing the Gateway on the bind address, behind the same firewall
  rules, is the stack's decision (E1, #187).
- **There is no way to hand the AI red team a file.** An Agent's sandbox
  takes in only its repository, its issue and an allow-listed environment,
  none of which may carry the package. So the page has whoever runs the
  position-4 probes receive it out of band. A sealed, per-Floor secret an
  Agent could be given would be a product decision.
- **Adding an Owner password is not in the Activity Feed.**
  `POST /api/owner-passwords` only writes a server log line
  (`password-routes.ts`), and the red team's password, added through the
  same store, is not in the Feed either. The keys are. FR-52 asks for
  configuration changes in the Feed; this sits with H5.
- **A revoked API key's web sessions linger as rows** until their next
  request, which is refused and deletes them (`sessions.ts`), or until they
  expire. They cannot be used, as the run above shows.
- **The two `apps/web` CHANGELOG failures** remain until `CHANGELOG.md`'s
  first heading carries a release date (as #188's and #189's notes say).
- **`pnpm lint` checks no Markdown** (`*.md` is in `.prettierignore`). The
  new page is hand-wrapped like its neighbours. Every relative link and
  anchor in it, the index, `stack.md` and the rules of engagement was
  resolved by a throwaway script outside the repository: `bad= 0` for each.

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
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
TYPECHECK_EXIT=0
```

### `pnpm test`

```text
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/
 ❯ src/site-footer.test.tsx:84:25
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/
 ❯ src/legal/legal.test.tsx:119:7
 Test Files  2 failed | 406 passed (408)
      Tests  2 failed | 4590 passed | 600 skipped (5192)
TEST_EXIT=1
```

`CHANGELOG.md` starts `## 1.0.0`, with no date. Before this issue (#189's
note) the counts were 2 failed | 4570 passed | 599 skipped (5171). The
difference, 21 tests (20 passed, 1 skipped), is this issue's new tests.

### This issue's tests (verbose, `deployment` project)

```text
✓ credentials.test.ts > minting > mints one Owner password, one UI-capable API key and one Gateway Key, each of which works
✓ credentials.test.ts > minting > refuses before the Owner has set the stack's password
✓ credentials.test.ts > minting > refuses while the red team's credentials are in use, and mints new ones once they are revoked
✓ credentials.test.ts > the package > holds exactly the allowed credentials, the fixture IDs and the pinned commit, and none of the forbidden ones
✓ credentials.test.ts > the package > is written 0600, and never over a package already there
✓ credentials.test.ts > the package > refuses to write a package holding anything forbidden, naming it but never its value
✓ credentials.test.ts > the package > revokes what it minted when the package cannot be written
✓ credentials.test.ts > nothing is echoed > minting and revoking say each credential's name and id, and print no credential anywhere
✓ credentials.test.ts > revocation > removes the Owner password with its sessions, and revokes both keys, so none of them works
✓ credentials.test.ts > revocation > names what else was made while the package was out, and leaves it for the Owner
↓ credentials.test.ts > the credentials CLI, against a database > mints and revokes in a process of its own, writing 0600 and printing no credential
  [Docker is not available …, so the Postgres integration tests are skipped. They run in CI and on the host.]
✓ stack.test.ts > stand-up > refuses a credentials directory the sandboxes would reach
✓ stack.test.ts > the checks > credentials directories: as work directories, and never inside the sandbox work directory or holding it
✓ stack.test.ts > teardown > lists what it removes: sandboxes, containers, networks, the volume, the work directory, the credentials package and the secrets
✓ stack.test.ts > teardown > removes them all, down with its volumes, and says what it removed
✓ stack.test.ts > teardown > says when there was nothing to remove
✓ stack.test.ts > the credentials package > has the credentials service mint it into a 0700 directory of its own, with no credential on any command line or in what it says
✓ stack.test.ts > the credentials package > refuses before stand-up, before the seed's listing, and over a package already there
✓ stack.test.ts > the credentials package > deletes a package the service wrote with any mode but 0600
✓ stack.test.ts > the credentials package > revokes its credentials through the service, then deletes the host's copy
✓ stack.test.ts > the credentials package > says there is nothing to revoke once the stack is torn down
✓ compose.test.ts > the credentials package's service > mints and revokes in the setup profile, as the user who stood the stack up
✓ compose.test.ts > the credentials package's service > is given the database and where to write, and none of the stack's other secrets
✓ compose.test.ts > the credentials package's service > alone mounts the credentials directory, so neither the app nor a sandbox reaches the package
↓ compose.test.ts > with Docker > docker compose config validates the pen-test stack [Docker Compose is not available (spawn docker ENOENT)]
 Test Files  3 passed (3)
      Tests  55 passed | 2 skipped (57)
```

(The other 32 tests in those three files, #187's, pass unchanged. Three
of #187's teardown tests, listed above, now also expect the credentials
directory's line.)

### The pen-test deployment suite

```text
$ pnpm exec vitest run --project deployment docker/pen-test
 Test Files  8 passed (8)
      Tests  91 passed | 3 skipped (94)
```
