# Issue #187: [pen-test] E1 — The pen-test stack and its teardown — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GitHub token), in the working tree at `7c4e590`, the last code
commit. `pnpm test` was also run at `22cd46b`, the commit before this
issue, for comparison.

**Blockers.** The issue names none. The PRD's
[Sequence](../product-requirements-document/pen-testing.md#sequence) puts
E1 first among the Enablement issues ("E1 comes before E2"). E1 needs only
the PRD (`21eac51`), which is on this branch. E5 (#191) is on it too, and
this issue adds the stack to its index.

## What was built

All in [`docker/pen-test/`](../../docker/pen-test/), plus
[`docs/pen-testing/stack.md`](../pen-testing/stack.md).

### The stack (`compose.yml`, `.env.example`)

- **Its own project**, `ai-office-pen-test`, separate from
  `docker-compose.yml` (`ai-office`) and `docker-compose.dev.yml`
  (`ai-office-dev`):
  - Postgres 18 in the volume `ai-office-pen-test-postgres-data`;
  - the sandboxes network `ai-office-pen-test-sandboxes` (Postgres and the
    stub are not on it);
  - the sandbox work directory `PEN_TEST_SANDBOX_WORK_DIR`, mounted at
    the same path in the app as on the host, because the host's Docker
    bind-mounts the clones;
  - the app built as `ai-office:pen-test`, never the Owner's
    `ai-office:local`.
- **Only `PEN_TEST_` variables.** None of the real stack's variables, from
  its `.env` or exported in the shell, can reach the pen-test stack.
  Every secret (`PEN_TEST_POSTGRES_PASSWORD`, `PEN_TEST_SESSION_SECRET`,
  `PEN_TEST_ENCRYPTION_KEY`, the GitHub App's ID and key) is required
  with `:?` and has no default. They are read from
  `docker/pen-test/.env`, which `.gitignore`'s `.env` already ignores.
  `docker/pen-test/.env.example` (kept by `!.env.example`) names every
  variable, each with an empty value.
- **On loopback.** Only the app is published, on
  `${PEN_TEST_BIND_ADDRESS:-127.0.0.1}:${PEN_TEST_PORT:-3145}`. That port
  differs from the real stack's 3045, so the two can run side by side.
  The AI Gateway (3047) and the sign-in callback (1455) are not
  published.
- **The stub upstream** is a service running `stub-upstream.ts` read-only
  from `node:26.10.0-slim`, at `stub-upstream:3050`, on the default
  network only.
- **`ai-accounts`** (the `setup` profile) runs in the app's image. It
  applies the migrations, then `add-ai-accounts.ts` adds the stack's AI
  Accounts with the AI Gateway's own code (`createAiAccounts` on the
  database store, with events to the Activity Feed). Each points at the
  stub upstream with a new canary credential,
  `pen-test-canary-<provider>-<36 hex>`, which is stored only encrypted.
  An account already there, by name, is kept.

### The stub upstream (`stub-upstream.ts`, `stub-accounts.ts`)

A Node-only server. It answers each AI Account's routes in its AI
Provider's own shape, streamed and not:

| Prefix | AI Account | Routes |
| --- | --- | --- |
| `/anthropic` | Claude, Console API key | Messages, token counts, models |
| `/xai` | Grok, API key | Chat Completions, Responses, models |
| `/gemini` | Gemini, API key | the same, under `/v1beta/openai` |
| `/openai/v1` | OpenAI-compatible endpoint | the same; Codex's Responses |

It logs every request as one JSON line: time, method, URL, every header
as received, the body (cut at 1 MiB, with its full length) and the
status. Its own `/health` is the one request it does not log.

### `stand-up` and `teardown`

Each is a `sh` wrapper for `stack.ts`, which needs only Node 26 and the
Docker CLI.

- **stand-up**:
  1. Makes `.env` from `.env.example` the first time.
  2. Writes new secrets and the default work directory
     (`$XDG_STATE_HOME` or `~/.local/state`, then
     `ai-office-pen-test/sandboxes`) where they are empty.
  3. Refuses to go on, listing each problem, when:
     - the App's ID, private key or the target repository is missing;
     - the App ID is the real stack's;
     - a secret is also in the real stack's `.env` or the root
       `.env.example`;
     - the work directory is relative, inside the repository, holds the
       home directory or the repository, or is the real stack's;
     - the bind address is every interface (`0.0.0.0`, `::`), or is
       beyond loopback without `PEN_TEST_RED_TEAM_ADDRESS`.
  4. Builds the app, starts Postgres and the stub, runs `ai-accounts`,
     then starts the app and waits for it.
  5. Prints the address, the stub's log command and, when the stack is
     opened, two `DOCKER-USER` iptables rules that admit only the red
     team's address.
- **teardown**:
  1. Says what it will remove.
  2. Removes the sandbox containers on the stack's sandboxes network, then
     runs `compose down --volumes --remove-orphans`.
  3. Removes by name any project-labelled network or volume left over. If
     a volume is still there afterwards, it fails, naming it.
  4. Deletes the work directory, but only one marked by stand-up
     (`.ai-office-pen-test`) and passing the same checks.
  5. Empties the generated secrets in `.env`.
  6. Says what it removed, and that it kept the image and the Owner's
     settings.

### `docs/pen-testing/stack.md`

- What the stack is for, and what it must never be.
- What is in it, and how it differs from the real stack.
- Before you start, standing it up, and the stub upstream with its log and
  canary credentials.
- Opening it to the red team's host.
- Tearing it down, and checking nothing is left.
- The tests.

The pen-testing index and the README's Documentation table link it.

## Acceptance criteria

### Verified in the sandbox

- [x] **Deployment tests check the compose file statically**
      (`docker/pen-test/compose.test.ts`, 17 tests, in the `deployment`
      project):
  - **separate project name, volumes and network:** the project name
    differs from both other compose files; the volume and network names
    Docker would give both stacks are compared and share none; no volume
    is `external`;
  - **no secret shared:** only `PEN_TEST_` variables, none of the real
    file's; each secret is required with no default; no root
    `.env.example` value and no PEM key are in the file; `.env.example`
    has every value empty and names exactly the variables compose and
    `stack.ts` read;
  - **loopback:** only the app is published, at
    `${PEN_TEST_BIND_ADDRESS:-127.0.0.1}:${PEN_TEST_PORT:-3145}:3045`,
    and 3047 and 1455 are not;
  - **the stub upstream wired as the AI Accounts' endpoint:**
    `ai-accounts` gets `STUB_UPSTREAM_URL`, the stub's own host and port;
    every account `stubAccounts()` makes has an endpoint under it; it runs
    after the migrations; no service holds an AI Account credential
    variable.

  A Docker-only test, `docker compose config`, is skipped here with its
  reason (in CI it fails rather than skips). **Negative checks:** five
  edits to `compose.yml`, each reverted afterwards, each failed the tests:
  - the app reads `SESSION_SECRET` (3 failed);
  - the default bind is `0.0.0.0`;
  - the sandboxes network is renamed `ai-office-sandboxes`;
  - `STUB_UPSTREAM_URL` is a real API;
  - the project is named `ai-office`.
- [x] **The stub upstream has unit tests: it answers, and it logs what it
      received** (`stub-upstream.test.ts`, 15 tests):
  - each route, streamed and whole, with the events in order;
  - each model list in its AI Provider's shape;
  - its errors;
  - the log entry for each request: every header (a canary `x-api-key`,
    a bearer token, `x-ai-office-issue`), the body, its length, the
    status; a long body cut at 1 MiB; no entry for `/health`.

  Then the same accounts behind the real AI Gateway (`startGateway`), all
  served by the stub:
  - Claude Code's Messages (streamed and not);
  - opencode's Chat Completions through Grok and Gemini;
  - Codex's Responses through the OpenAI-compatible endpoint.

  Each time, the stub received that account's canary credential, and
  `createModelCatalogue` lists all four kinds' Models with no failure.
  **Negative check:** with the stub's `/responses` route broken, the stub
  test and the Gateway test both failed.
- [x] **Teardown's list of what it removes is tested**
      (`stack.test.ts`, 17 tests, the Docker CLI faked, files in a
      temporary directory):
  - `teardownList` names the sandboxes, containers, both networks, the
    volume, the work directory and the secrets;
  - one teardown shows each Docker command and the exact "Removed:" lines;
    the work directory is gone, the secrets are emptied, and the App's
    settings are kept;
  - a volume that `down` leaves is removed by name; one that stays makes
    it fail;
  - an unmarked directory is not deleted;
  - with nothing to remove, it says so;
  - without the env file, compose gets placeholders.

  Stand-up's generation, refusals, command order and environment are
  tested too.
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck exit 0. `pnpm test` exits 1, on two tests this issue does
      not touch:
  - `docker/deployment.test.ts` › "publishes only the app, on 127.0.0.1
    unless told otherwise". This is the failure #191's note recorded: it
    fails the same way at `22cd46b`, before this issue (below), because
    `docker-compose.yml` publishes `127.0.0.1:1455:1455`. It is not
    changed here.
  - `apps/web` › `grilling-room.test.tsx` › "the Manager walks to the
    table…". It failed in both full runs at this issue's commits, on its
    assertion that no idle Agent stands in the meeting room after 60 s.
    It passed in the full run at `22cd46b`, and **13 times out of 13
    alone** at this issue's code. Idle activities pick at random
    (`Math.random` in `idle-behaviours.ts`), and the test is not seeded.
    This issue changes nothing in `apps/web` or anything it loads.

  Everything else passes: **388 files, 4343 passed, 2 failed, 567
  skipped**. Compared with `22cd46b` (4295 passed, 1 failed, 566
  skipped), that is this issue's 49 tests passing, its 1 Docker test
  skipped, and the web test failing.

### Verified on the host

- [ ] **The stack stands up, the Owner can sign in, and teardown leaves no
      volume behind.** Not verifiable here: there is no Docker. What could
      be run without Docker was, below.

## Run without Docker: the stack's parts, for real

An embedded Postgres 18.3 (`@embedded-postgres/linux-x64`, in `/tmp`, as
in #61's and #147's notes) stood in for the stack's Postgres. The stub ran
as the container runs it (`node stub-upstream.ts`), on port 3950.
Nothing of this is in the repository.

1. `node packages/db/src/migrate-cli.ts`, then
   `node docker/pen-test/add-ai-accounts.ts` with a new `ENCRYPTION_KEY`
   and `STUB_UPSTREAM_URL=http://127.0.0.1:3950`. It added the four AI
   Accounts in 0.8 s and exited. Run again, it kept all four.
2. The server (`apps/server/src/main.ts`) was started on that database
   with the same key and a new session secret.
   - At start it fetched the four model lists from the stub and gave
     Claude, Grok, Gemini and OpenAI-compatible their default Models from
     them (ChatGPT none: below).
   - `POST /api/setup` returned 204 and `POST /api/login` 200: **the
     Owner set a password and signed in**. `GET /api/ai-accounts` listed
     the four accounts at the stub.
3. An Owner tool's Gateway Key was made through the API. With it, the
   Gateway answered `/v1/messages` for `claude-opus-5-5` (from the Claude
   account) and for `gpt-stub` (translated to the OpenAI-compatible
   account's Chat Completions) with the stub's text.
4. The stub's log held a line for each of those requests, with the canary
   credentials. **`grep -c pen-test-canary- server.log` was 0:** none
   reached the server's log.
5. `docker/pen-test/stand-up` itself:
   - With no `.env`, it made one, wrote the three secrets and the work
     directory, and refused, listing the three empty Owner settings.
   - With fake App settings, it made the work directory with its marker,
     then stopped: "The Docker CLI (docker) is not on the PATH."
   - `teardown` printed its list, then stopped the same way.

   The trial `.env` and the work directory were then deleted. `git
   check-ignore` showed `docker/pen-test/.env` ignored and
   `.env.example` not.

## Not verifiable in this sandbox

- **Docker:**
  - building `ai-office:pen-test`;
  - `ai-accounts` in that image: its mounts at `/app/docker/pen-test/`,
    and resolving `../../packages/…` there;
  - the stack's networks and its `user:` override;
  - the app starting sandboxes on `ai-office-pen-test-sandboxes` with the
    work directory mounted at the same path;
  - `compose down --volumes` and teardown's real output;
  - that no volume is left afterwards;
  - `docker compose config` (skipped with its reason).
- **The firewall rules** for opening the stack to the red team: written
  from Docker's documentation of `DOCKER-USER`, but not run.
- **A real GitHub App**: stand-up only checks that the ID is numeric and
  not the real stack's. That the App is installed on the target
  repository alone is the Owner's check (the document says how).

## Notes

- **Why a one-off service adds the AI Accounts.** The issue's AI Accounts
  live in the database, not in compose. A service the compose file names,
  with `STUB_UPSTREAM_URL`, makes the wiring visible to the static tests.
  It also uses the AI Gateway's own code, so every credential is
  encrypted as the app encrypts it. The app starts after it, so its first
  catalogue refresh reads the stub.
- **Why `PEN_TEST_` names.** Compose prefers the shell's variables over
  an env file. With the real stack's names, an Owner who had exported
  `SESSION_SECRET` would have put it into the pen-test stack without
  knowing.
- **Choices the issue leaves open**, for the Owner to change:
  - port 3145;
  - the work directory under `~/.local/state`;
  - teardown also emptying the generated secrets (a destroyed database's
    keys protect nothing, and a new round gets new ones);
  - keeping the image;
  - publishing the stack only after stand-up's checks, with the firewall
    rules printed rather than applied (they need root).
- **What the stack keeps of the real one, on purpose:**
  - the Docker socket;
  - the callback listener on `0.0.0.0` inside;
  - `restart: unless-stopped`;
  - `PEN_TEST_TRUST_PROXY`.

  That way H1, H3, H7 and H14 probe what a real deployment has.

## An incident in this sandbox: `git worktree prune`

To run `pnpm test` at `22cd46b`, I made a separate worktree with `git
worktree add /tmp/…`. The run finished, but `git worktree remove` then
failed: the worktree's metadata was already gone, apparently pruned from
the host, where that path does not exist. I then ran **`git worktree prune` inside the sandbox**. The
sandbox's `.git` is the host repository's, and the host's worktree paths
do not exist in here. So prune **deleted two other worktrees' admin
directories** in `/home/eyread01/projects/a/temp3/.git/worktrees/`:

- this run's, `sandcastle-20261011-133341-a4e3ad`;
- **another Sandcastle run's**, `sandcastle-20261011-140501-e52854`
  (branch `sandcastle/20261011-140501-e52854`, at `93f7a02`).

Branch refs and objects are in the common directory, so no commit was
lost (both refs were checked). I rebuilt both admin directories as the
surviving `temp3-pte` one is laid out:

- `HEAD`: `ref: refs/heads/<branch>`;
- `commondir`: `../..`;
- `gitdir`: `<worktree path>/.git`, the paths `git worktree list`
  printed;
- each index from its branch with `git read-tree`.

This run's worktree is back on its branch with a clean status.
**The other run lost its reflog, and any changes it had staged but not
committed are now unstaged**: their content is still in its working
tree, but it is no longer staged. Its git commands will have failed
in the few minutes between the prune and the rebuild. The Owner may want
to check that run. The comparison run at `22cd46b` had finished before
any of this, and its directory in `/tmp` was then deleted with `rm`, not
with git.

## Noticed, out of scope

- **`pnpm test` is red** from `docker/deployment.test.ts` (1455), as #191
  recorded.
- **Two web tests are flaky under the full suite's load:**
  - `grilling-room.test.tsx`: random idle activities, not seeded;
  - `idle-behaviours.test.ts`: it failed when the web project ran alone
    here, and #191 saw it time out at 30 s.
- **ChatGPT has no default Model in the pen-test stack.** ChatGPT takes
  only subscriptions, so the stub's `gpt-stub` becomes the
  OpenAI-compatible account's default, not ChatGPT's. A Codex Agent needs
  the Owner, or the seed (#188), to choose `gpt-stub` for ChatGPT.
- **The real stack does not set `SANDBOX_WORK_DIR`.** Under
  `docker-compose.yml` the app would then clone into
  `/tmp/ai-office-sandboxes` inside its container. The host's Docker
  bind-mounts that path from the host, where it does not exist. This was
  read, not run (no Docker here). The pen-test stack mounts its work
  directory at the same path inside and out for that reason.

## Output

### `pnpm lint` and `pnpm typecheck`, at `7c4e590`

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0
```

### `pnpm test`, at `7c4e590`

```text
 FAIL  |deployment| docker/deployment.test.ts > docker-compose.yml > publishes only the app, on 127.0.0.1 unless told otherwise
AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
 ❯ docker/deployment.test.ts:179:23
 FAIL  |@ai-office/web| src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > the Manager walks to the table as it starts and sits there while it runs, with the door's sign lit and the whiteboard filled in; it walks back when the session pauses
AssertionError: coder: expected true to be false // Object.is equality
 ❯ src/scene/grilling-room.test.tsx:174:9
 Test Files  2 failed | 386 passed (388)
      Tests  2 failed | 4343 passed | 567 skipped (4912)
   Duration  105.02s
test exit=1
```

### `pnpm test`, at `22cd46b` (before this issue)

```text
 FAIL  |deployment| docker/deployment.test.ts > docker-compose.yml > publishes only the app, on 127.0.0.1 unless told otherwise
 Test Files  1 failed | 384 passed (385)
      Tests  1 failed | 4295 passed | 566 skipped (4862)
test exit=1
```

### The grilling-room test alone, and the web project alone

```text
$ for i in $(seq 1 10); do pnpm exec vitest run src/scene/grilling-room.test.tsx; done   # apps/web
     10       Tests  7 passed (7)
(and 3 of 3 earlier)

$ pnpm exec vitest run --project @ai-office/web
 FAIL  |@ai-office/web| src/scene/idle-behaviours.test.ts > the trip to an idle activity > for each of 21 Agents and each place, starts in its chair, ends at its place, and keeps clear of furniture and walls once off the chair
      Tests  1 failed | 1496 passed (1497)
```

### This issue's tests (verbose), at `7c4e590`

```text
$ pnpm exec vitest run --project deployment docker/pen-test --reporter=verbose
 ✓ stack.test.ts > stand-up > makes .env from .env.example, generates the secrets and the work directory, then asks for the GitHub App
 ✓ stack.test.ts > stand-up > generates new secrets each time, never .env.example's or the real stack's
 ✓ stack.test.ts > stand-up > builds, starts Postgres and the stub upstream, adds the AI Accounts, then starts the app
 ✓ stack.test.ts > stand-up > refuses a secret the real stack also holds, and the real stack's GitHub App
 ✓ stack.test.ts > stand-up > refuses every interface, and beyond loopback without the red team's address
 ✓ stack.test.ts > the checks > bind addresses: loopback, or one interface with the red team's address
 ✓ stack.test.ts > the checks > the firewall rules drop the port for all but the red team, the accept first
 ✓ stack.test.ts > the checks > work directories: absolute, outside the repository, holding neither it nor home, not the real stack's
 ✓ stack.test.ts > the checks > shared secrets are found under any name
 ✓ stack.test.ts > the checks > the env file is read and written line by line
 ✓ stack.test.ts > the checks > compose's environment drops the shell's PEN_TEST_ variables
 ✓ stack.test.ts > teardown > lists what it removes: sandboxes, containers, networks, the volume, the work directory and the secrets
 ✓ stack.test.ts > teardown > removes them all, down with its volumes, and says what it removed
 ✓ stack.test.ts > teardown > removes by name a volume down left behind, and fails if one is still there
 ✓ stack.test.ts > teardown > deletes no directory stand-up did not make
 ✓ stack.test.ts > teardown > says when there was nothing to remove
 ✓ stack.test.ts > teardown > takes the stack down without its env file, the values compose needs only placeholders
 ✓ compose.test.ts > the pen-test stack's compose file > passes the Compose Specification's schema
 ✓ compose.test.ts > the pen-test stack's compose file > has a project name of its own
 ✓ compose.test.ts > the pen-test stack's compose file > keeps Postgres's data in a volume of its own, which no other stack names
 ✓ compose.test.ts > the pen-test stack's compose file > puts sandboxes on a network of its own, which Postgres and the stub upstream are not on
 ✓ compose.test.ts > the pen-test stack's compose file > has a sandbox work directory of its own, at the same path in the app as on the host
 ✓ compose.test.ts > the pen-test stack's compose file > builds the app as an image of its own, never the Owner's ai-office:local
 ✓ compose.test.ts > no secret shared with the real stack > reads only PEN_TEST_ variables, so none of the real stack's is ever read
 ✓ compose.test.ts > no secret shared with the real stack > takes every secret from its own variable, required, with no default
 ✓ compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 ✓ compose.test.ts > no secret shared with the real stack > has an .env.example with every value empty, and an .env that git ignores
 ✓ compose.test.ts > no secret shared with the real stack > names in .env.example every variable compose and stand-up read, and nothing else
 ✓ compose.test.ts > no secret shared with the real stack > gives the app nothing the server would not read
 ✓ compose.test.ts > reach > publishes only the app, on 127.0.0.1 unless told otherwise, on a port the real stack does not use
 ✓ compose.test.ts > the stub upstream > runs stub-upstream.ts, read-only, from the pinned Node image, on 3050
 ✓ compose.test.ts > the stub upstream > is the endpoint of every AI Account the stack adds
 ✓ compose.test.ts > the stub upstream > is added as the AI Accounts after the migrations, before the app starts, once
 ✓ compose.test.ts > the stub upstream > lets nothing else in the stack hold an AI Account credential
 ↓ compose.test.ts > with Docker > docker compose config validates the pen-test stack [Docker Compose is not available (spawn docker ENOENT)]
 ✓ stub-upstream.test.ts > the stub upstream answers > Anthropic Messages, whole, with the Model asked for and its usage
 ✓ stub-upstream.test.ts > the stub upstream answers > Anthropic Messages, streamed, from message_start to message_stop
 ✓ stub-upstream.test.ts > the stub upstream answers > Anthropic's token count
 ✓ stub-upstream.test.ts > the stub upstream answers > Chat Completions, whole and streamed, with usage when asked for
 ✓ stub-upstream.test.ts > the stub upstream answers > Responses, whole and streamed, ending with response.completed
 ✓ stub-upstream.test.ts > the stub upstream answers > each AI Provider's model list, in its own shape
 ✓ stub-upstream.test.ts > the stub upstream answers > an error, in the AI Provider's shape, for what it does not serve
 ✓ stub-upstream.test.ts > the stub upstream logs > every request: method, URL, every header (credentials included), body and status
 ✓ stub-upstream.test.ts > the stub upstream logs > a long body cut at the limit, with its whole length
 ✓ stub-upstream.test.ts > the stub upstream logs > nothing for the health check, and answers it
 ✓ stub-upstream.test.ts > the stack's AI Accounts > each point at the stub upstream, with a canary credential, and are valid to add
 ✓ stub-upstream.test.ts > through the AI Gateway > serves Claude Code's Messages from the Claude account, streamed or not
 ✓ stub-upstream.test.ts > through the AI Gateway > serves opencode's Chat Completions from the Grok and Gemini accounts
 ✓ stub-upstream.test.ts > through the AI Gateway > serves Codex's Responses from the OpenAI-compatible endpoint
 ✓ stub-upstream.test.ts > through the AI Gateway > lists every account's Models in the catalogue
      Tests  49 passed | 1 skipped (50)
```

### The run without Docker (embedded Postgres 18.3)

```text
$ node packages/db/src/migrate-cli.ts
Migrations applied.
$ time node docker/pen-test/add-ai-accounts.ts
Added the AI Account "Claude (pen-test stub)", at http://127.0.0.1:3950/anthropic.
Added the AI Account "Grok (pen-test stub)", at http://127.0.0.1:3950/xai.
Added the AI Account "Gemini (pen-test stub)", at http://127.0.0.1:3950/gemini.
Added the AI Account "OpenAI-compatible (pen-test stub)", at http://127.0.0.1:3950/openai/v1.
real	0m0.805s
$ node docker/pen-test/add-ai-accounts.ts
Kept the AI Account "Claude (pen-test stub)".
Kept the AI Account "Grok (pen-test stub)".
Kept the AI Account "Gemini (pen-test stub)".
Kept the AI Account "OpenAI-compatible (pen-test stub)".

$ node apps/server/src/main.ts   # then:
{"status":"ok","database":"up"}
setup 204
login 200
# the stub's log, as the server started:
      1 "url":"/anthropic/v1/models?limit=1000"
      1 "url":"/gemini/v1beta/openai/models"
      1 "url":"/openai/v1/models"
      1 "url":"/xai/v1/models"
# AI Providers' default Models:
[["Claude","claude-opus-5-5"],["ChatGPT",null],["Grok","grok-stub"],["Gemini","gemini-stub"],…,["OpenAI-compatible","gpt-stub"]]
# the server's log:
"AI Providers with a new AI Account were given a default Model."
"The Owner's password was set."
"The Owner signed in."

# with an Owner tool's Gateway Key, POST :3947/v1/messages:
{"id":"msg_stub_e2a47477bacdaa98","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"This is the pen-test stub upstream. No AI Provider read this request."
{"id":"msg_chatcmpl-stub-d5f9a15795cf939d","type":"message","role":"assistant","model":"gpt-stub","content":[{"type":"text","text":"This is the pen-test stub upstream. No AI Provider read this request
"url":"/anthropic/v1/messages"
"url":"/openai/v1/chat/completions"
canary in server log: 0
```

### `docker/pen-test/stand-up` and `teardown`, without Docker

```text
$ docker/pen-test/stand-up
Made /home/agent/workspace/docker/pen-test/.env from .env.example.
Wrote new PEN_TEST_POSTGRES_PASSWORD, PEN_TEST_SESSION_SECRET, PEN_TEST_ENCRYPTION_KEY, PEN_TEST_SANDBOX_WORK_DIR to /home/agent/workspace/docker/pen-test/.env.
The pen-test stack cannot stand up. In /home/agent/workspace/docker/pen-test/.env:
  - PEN_TEST_GITHUB_APP_ID is empty.
  - PEN_TEST_GITHUB_APP_PRIVATE_KEY is empty.
  - PEN_TEST_TARGET_REPOSITORY is empty.
exit=1

$ docker/pen-test/stand-up   # with fake App settings
The Docker CLI (docker) is not on the PATH.
exit=1

$ docker/pen-test/teardown
Tearing down the pen-test stack: removing
  - every sandbox container on the ai-office-pen-test-sandboxes network
  - the stack's containers (project ai-office-pen-test)
  - its networks, ai-office-pen-test_default and ai-office-pen-test-sandboxes
  - its database volume, ai-office-pen-test-postgres-data
  - its sandbox work directory, /home/agent/.local/state/ai-office-pen-test/sandboxes
  - its generated secrets in docker/pen-test/.env (PEN_TEST_POSTGRES_PASSWORD, PEN_TEST_SESSION_SECRET, PEN_TEST_ENCRYPTION_KEY)
The Docker CLI (docker) is not on the PATH.
exit=1
```
