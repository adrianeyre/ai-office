# Issue #283: [fix] G1-8 — An Office served beyond localhost starts with .env.example's public SESSION_SECRET, ENCRYPTION_KEY and database password — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `238fb5d`,
`fix(security): G1-8 AI Office served beyond this machine refuses to start with .env.example's public secrets, the database password included`,
on top of `afb2036`. Its blocker, the G1 probe (#195), is in the tree:
`docs/pen-testing/assessments/G1.md` and
`apps/server/src/config.pen-test.test.ts`.

This is the remediation of finding **G1-8** (`severity:low`, H16). This
run also fixed G1-9 ([issue-285.md](issue-285.md)), whose commit
`7882474` adds one sentence to this fix's refusal (below). The real output
of the checks, run once on the finished tree for both, is
[below](#real-output-of-the-checks).

## What was fixed

`.env.example` ships public sample secrets so that a copied `.env` runs in
development as it is. The server only warned when it started with them,
wherever it was served. With the public `ENCRYPTION_KEY`, anyone holding a
copy of the database (a dump, a backup) can open every credential sealed in
it. The sample database password (`devpassword`, from which compose builds
`DATABASE_URL`) was not even named in the warning.

Now `loadConfig` (`apps/server/src/config.ts`) refuses to start when AI
Office is **served beyond this machine** and any of these is still
`.env.example`'s public sample:

- `SESSION_SECRET`;
- `ENCRYPTION_KEY`;
- the database password: `POSTGRES_PASSWORD`, as the password in
  `DATABASE_URL` holds it, outside compose and under it.

It raises a `ConfigError`, as for any other configuration problem, so
`main.ts` prints it and exits. The error has one problem per sample. Each
names the sample and the settings that serve AI Office beyond this machine,
never a value. For example:

```
SESSION_SECRET is the public sample from .env.example, which AI Office refuses once it is served beyond this machine (HOST, PUBLIC_URL, TRUST_PROXY): generate your own (see .env.example)
```

AI Office counts as served beyond this machine (`servedBeyondThisMachine`)
when any of these holds:

- **its port is reached from beyond loopback**: `HOST` is not
  `localhost`, `*.localhost`, `127.0.0.0/8` or `::1`. Under compose the
  check reads `PUBLISHED_ADDRESS` instead.
- **`PUBLIC_URL` names anything else**: not `localhost`, `*.localhost` or
  a loopback address.
- **`TRUST_PROXY` is set**: a proxy (Caddy's `tls` profile) is in front of
  it.

On this machine alone the samples still run, with the warning as before,
which now names the database password too. So `cp .env.example .env` is
still all `pnpm dev` and a local `docker compose up` need.

### Sibling paths

- **Compose's own `HOST` is `0.0.0.0`**, inside its container, whatever
  the app is published on. Checking `HOST` alone would refuse every local
  compose run, and checking `PUBLIC_URL` alone would miss
  `AI_OFFICE_BIND_ADDRESS=0.0.0.0` with `PUBLIC_URL` left on `localhost`.
  So compose now passes the app the address Docker publishes its port on,
  as `PUBLISHED_ADDRESS: ${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}`, and that
  is what the check reads there. The pen-test stack's compose file does
  the same from `PEN_TEST_BIND_ADDRESS`. Its secrets are always generated,
  so it is never refused.
- **The database password** was not named at all. It is now one of
  `developmentSecrets` and counts as a sample wherever `DATABASE_URL`
  comes from: compose's `@postgres:3048` URL as much as `.env.example`'s.
- **Each sample alone, under each way of serving AI Office beyond this
  machine**, is refused, not only the probe's combination of all of them.
- **The probe's own fixture.** Since A1-1, `TRUST_PROXY` is accepted only
  together with `PROXY_SECRET`. The probe's `exposed` environment set
  `TRUST_PROXY` alone, so at `afb2036` both G1-8 tests were already failing
  (`issue-277.md` lists them among the ten failures already present). The
  fixture now sets a fake `PROXY_SECRET` beside it. That changes neither
  test's assertion: without it, `loadConfig` threw for that other reason
  and the `it.fails` "passed" for the wrong one.

The documents say so: `.env.example` (the Required section,
`POSTGRES_PASSWORD`, `PUBLISHED_ADDRESS`), the header of
`docker-compose.yml`, `docs/guide/running.md` (step 4) and
`docs/processes/deploying-to-ec2.md` (§6).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-8: an
      Office served beyond localhost does not start with .env.example's
      public secrets" is an `it`. Its assertion is unchanged:
      `expect(() => loadConfig(exposed)).toThrow()`.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-8): an
      Office served beyond localhost no longer loads with .env.example's
      secrets, and the database password is named among them". It checks
      the refusal's three problems, in order: `SESSION_SECRET`,
      `ENCRYPTION_KEY`, then `POSTGRES_PASSWORD (the password in
      DATABASE_URL)`. Each names `(HOST, PUBLIC_URL, TRUST_PROXY)` and
      contains no sample value. It also checks that the example as copied
      still loads on this machine, with the warning naming all three.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `config.pen-test.test.ts`: "G1-8: each public secret alone is
        refused, by each way of serving AI Office beyond this machine".
        That covers each of the three samples under `HOST` (`0.0.0.0`,
        `::`, a LAN address, a host name), `PUBLISHED_ADDRESS`,
        `PUBLIC_URL` (a domain, an address) and `TRUST_PROXY`. With the
        Owner's own secrets, each of those configurations starts.
      - `config.pen-test.test.ts`: "G1-8: on this machine alone the samples
        still run, as `pnpm dev` and compose's defaults use them". That
        covers `localhost`, `127.0.0.1`, `::1`, `*.localhost`, and compose's
        `HOST=0.0.0.0` with `PUBLISHED_ADDRESS=127.0.0.1`.
      - `docker/deployment.test.ts`: "tells the app where its port is
        published, so it refuses .env.example's secrets once that is beyond
        this machine (pen-testing G1-8)". It builds the app's environment
        as compose does from a copied `.env`: as copied, it starts; with
        `AI_OFFICE_BIND_ADDRESS=0.0.0.0`, all three samples are refused,
        naming `PUBLISHED_ADDRESS`.
      - `config.test.ts`: `developmentSecretsInUse` names the database
        password.
      - `deployment.test.ts`, "works for development as copied, with only
        the sample secrets that the server warns about": now three.

      With the refusal disabled (`if (beyond.length > 0 && false)` in
      `loadConfig`):

      ```
      × regression (G1-8): an Office served beyond localhost no longer loads with .env.example's secrets, and the database password is named among them 13ms
      × G1-8: an Office served beyond localhost does not start with .env.example's public secrets 6ms
      × G1-8: each public secret alone is refused, by each way of serving AI Office beyond this machine 3ms
      × tells the app where its port is published, so it refuses .env.example's secrets once that is beyond this machine (pen-testing G1-8) 7ms
            Tests  4 failed | 30 passed | 1 expected fail | 4 skipped (39)
      ```

      With the refusal restored, all of them pass.
- [x] **The assessment's findings table marks `G1-8` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #283), with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** `pnpm lint`
      and `pnpm typecheck` pass. `pnpm test` still fails on eight tests
      that were already failing before this run, in what other probes pin,
      none of them this finding's. See
      [the output](#real-output-of-the-checks). G1-8's two, which were
      among the ten failing before, now pass.

## Decisions

1. **What "served beyond this machine" means:** `HOST` (or
   `PUBLISHED_ADDRESS`) beyond loopback, a `PUBLIC_URL` that is not this
   machine's, or `TRUST_PROXY` set. A `HOST` given as a host name other
   than `localhost` counts as beyond: AI Office cannot tell where a name
   resolves to, so it takes the cautious reading.
2. **`GATEWAY_HOST` and `OAUTH_CALLBACK_HOST` do not count.** On Linux,
   `pnpm dev` needs `GATEWAY_HOST` on the docker0 bridge so the sandbox
   relay reaches the Gateway (`.env.example`), and compose sets both to
   `0.0.0.0` inside its container without publishing them (or publishing
   1455 to loopback only). Neither serves the web app or its API, and
   counting them would refuse every Linux `pnpm dev` that uses the
   samples.
3. **A new variable, `PUBLISHED_ADDRESS`, which compose sets.** Inside a
   container, `HOST` cannot say whether the app is served beyond the host.
   An Owner who sets `PUBLISHED_ADDRESS` by hand outside a container
   replaces `HOST` in this check. `.env.example` leaves it empty and says
   compose sets it.
4. **The refusal is a `ConfigError` from `loadConfig`**, as for any other
   bad configuration, not a check later in start-up. `main.ts` already
   prints those (keys only) and exits.
5. **The database password is named `POSTGRES_PASSWORD (the password in
   DATABASE_URL)`.** It is detected from `DATABASE_URL`, the only form the
   server sees, but `POSTGRES_PASSWORD` is what the Owner changes under
   compose and in `pnpm dev`'s Postgres. The documents now say that
   Postgres takes it only when it creates its volume, so an existing
   database also needs `ALTER USER`.
6. **On this machine, the samples still run with a warning**, because the
   README and the guide promise that a copied `.env` is all development
   needs.

## Noticed, out of scope

- **The `tls` profile without `PUBLIC_URL` or `TRUST_PROXY`.** Caddy
  publishes 80 and 443 on every interface. The app recognises the profile
  through the `PUBLIC_URL` and `TRUST_PROXY` its documentation requires.
  An Owner who runs `--profile tls` with neither (leaving
  `AI_OFFICE_DOMAIN=localhost`, so Caddy serves only the name `localhost`)
  is not refused. The app cannot see which compose profiles are running.
- **I2's pin "a copied .env yields public secrets (owned by G1-8)"**
  (`docker/sandbox-dir.pen-test.test.ts`) still holds, and should: the
  samples stay for development.
- **Eight failing tests that predate this run**, listed under the output
  below. They are I1's six and I2-1's two.

## What could not be verified here

- **A real `docker compose up`**, as copied (it should start and warn) and
  with `AI_OFFICE_BIND_ADDRESS=0.0.0.0` (it should exit with the refusal).
  There is no Docker here. `deployment.test.ts` builds the app's
  environment from `docker-compose.yml` and a copied `.env` as compose
  would, and drives the real `loadConfig`. `docker compose config`, and
  bringing the stack up, are among the tests skipped without Docker.
- **The EC2 deployment** (`--profile tls` with a real domain). The
  configuration it documents (`PUBLIC_URL=https://…`, `TRUST_PROXY=1`) is
  among the combinations tested.

## Real output of the checks

The checks were run once on the finished tree, at `7882474`, after both
fixes of this run (#283, #285). [issue-285.md](issue-285.md) points here.

### The probe tests, verbose

`pnpm exec vitest run apps/server/src/config.pen-test.test.ts --reporter=verbose`:

```
 ✓ G1-8 (H16): the public sample secrets > regression (G1-8): an Office served beyond localhost no longer loads with .env.example's secrets, and the database password is named among them 7ms
 ✓ G1-8 (H16): the public sample secrets > G1-8: an Office served beyond localhost does not start with .env.example's public secrets 1ms
 ✓ G1-8 (H16): the public sample secrets > G1-8: each public secret alone is refused, by each way of serving AI Office beyond this machine 5ms
 ✓ G1-8 (H16): the public sample secrets > G1-8: on this machine alone the samples still run, as `pnpm dev` and compose's defaults use them 1ms
 ✓ G1-9 (H16): rotating ENCRYPTION_KEY > the sealed format is ready for it: values carry their key version, and a keyring opens each with its own 1ms
 ✓ G1-9 (H16): rotating ENCRYPTION_KEY > regression (G1-9): the server is configured with every key, the new one as a version of its own, and a value sealed with the previous key still opens 1ms
 ✓ G1-9 (H16): rotating ENCRYPTION_KEY > G1-9: the server's configuration can carry a retired ENCRYPTION_KEY beside the current one, so a rotation keeps sealed values readable 0ms
 ✓ G1-9 (H16): rotating ENCRYPTION_KEY > G1-9: once AI Office has started beside the retired key, every value is the new key's, and opens with it alone 1ms
 ✓ G1-9 (H16): rotating ENCRYPTION_KEY > G1-9: a rotation that would leave two keys one version, or the new key not the newest, is refused, naming no key 1ms
 ✓ G1-9 (H16): rotating ENCRYPTION_KEY > G1-8 and G1-9 agree: the public sample key is refused as ENCRYPTION_KEY beyond this machine, but is how an Office leaves it, as a retired key 1ms
 ✓ secrets at rest and in logs > a sealed value is bound to its key version and its field: it opens in no other 1ms
 ✓ secrets at rest and in logs > every configured secret, the GitHub App's private key included, is one the logger removes 1ms
      Tests  12 passed (12)
```

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
...
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: eight failures, all present before this run

```
 FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > I2-1: an answer on /v1 at the app's port carries the app-wide security headers (nosniff and Referrer-Policy at least)
 FAIL  |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-1: app-wide security headers on /v1 > pins today: an app-wide onRequest hook sets a header on the app's answers and never runs for /v1, whose answers carry no security header
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > pins today: the compose file says sandboxes reach 'the AI Gateway as app:3047 and nothing else of the stack'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > the compose comment reflects that a sandbox also reaches the app's 3045 and 1455 (S2-3)
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 Test Files  3 failed | 468 passed (471)
      Tests  8 failed | 5374 passed | 50 expected fail | 608 skipped (6040)
[ELIFECYCLE] Test failed. See above for more details.
test exit 1
```

These are eight of the ten failures that [issue-269.md](issue-269.md) and
[issue-277.md](issue-277.md) record. They are pins and `it.fails` from
other probes, which went stale when main's one-entry-point merge and
earlier pen-testing fixes changed what they pin. The other two were G1-8's
own, and this run fixed them.

- **I1's six** (`supply-chain.pen-test.test.ts`,
  `documentation-drift.pen-test.test.ts`) read the Dockerfiles,
  `docker-compose.yml` and `.env.example`. This run changed the last two,
  so those two files were put back to `afb2036` and the I1 files run
  again. They fail the same six ways:

  ```
        Tests  6 failed | 7 passed | 3 expected fail (16)
   FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
   FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
   FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > pins today: the compose file says sandboxes reach 'the AI Gateway as app:3047 and nothing else of the stack'
   FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > the compose comment reflects that a sandbox also reaches the app's 3045 and 1455 (S2-3)
   FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
   FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
  ```

- **I2-1's two** (`gateway-entry.pen-test.test.ts`) test the Gateway's
  `/v1` hooks. This run changed nothing on that path: `gateway-entry.ts`,
  `app.ts` and `packages/gateway` are untouched, and `server.ts` changed
  only in how its encryptor is built (G1-9). They fail exactly as
  [issue-277.md](issue-277.md) records them failing before this run.
