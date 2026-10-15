# Issue #9: `docker compose` stack: app image, Postgres 18, health checks — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, **no
Docker daemon and no Docker CLI**) against a fresh `git clone` of this branch
at the last commit of the issue (`49a12ec`), after
`pnpm install --frozen-lockfile`.

## What was built

- **`Dockerfile`** (multi-stage, at the root):
  - `base`: `node:26.10.0-slim` with pnpm 12.10.0. The versions are
    `ARG`s, and a test keeps them equal to `devEngines.runtime` and
    `packageManager` in `package.json`.
  - `manifests`: the lockfile and every workspace package's `package.json`,
    so installs are cached until a dependency changes.
  - `build`: the full frozen install, then `pnpm build` (the web app).
  - `runtime`:
    - a production-only install of `@ai-office/server...` (the server and
      the workspace packages it uses);
    - the sources Node runs directly (server, db, gateway, shared) and the
      SQL migrations;
    - `apps/web/dist` from `build`.

    It runs as `node`. `CMD` applies pending migrations
    (`packages/db/src/migrate-cli.ts`), then `exec`s the server. A failed
    migration exits, and compose restarts the container.
  - The pnpm store is a BuildKit cache mount. pnpm cannot hard-link from it,
    so the installs use `--store-dir=/pnpm/store
    --config.package-import-method=copy`. Without that, pnpm 12 silently
    creates a second store inside `node_modules`, which I saw happen in this
    sandbox; that store would ship in the image.
- **`.dockerignore`** keeps out `node_modules`, `dist`, `.git`, `.env*`,
  `.sandcastle`, `docs` and the like.
- **`docker-compose.yml`** (project `ai-office`):
  - **`postgres`:**
    - `postgres:18-alpine` (the image the Testcontainers tests use);
    - `POSTGRES_DB=ai_office`, user `ai_office`, password from
      `POSTGRES_PASSWORD` (required);
    - named volume `postgres-data` at `/var/lib/postgresql`, where the
      Postgres 18 images keep their data (`/var/lib/postgresql/18/docker`);
    - a `pg_isready` health check; not published.
  - **`app`:**
    - `build: .`, `image: ai-office:local`, `init: true`;
    - `depends_on: postgres: condition: service_healthy`;
    - a health check that calls `GET /health` with Node's `fetch`. The slim
      image has no curl. A 503 (database down) is unhealthy.
    - `DATABASE_URL` built from `POSTGRES_PASSWORD`. `SESSION_SECRET` and
      `ENCRYPTION_KEY` are required (`${…:?…}`), and the optional settings
      pass through.
    - published on `${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}:${AI_OFFICE_PORT:-3000}`.
    - The AI Gateway listens on 4000 inside the compose network and is only
      `expose`d, never published.
    - **The host's Docker socket** is mounted (`/var/run/docker.sock`), with
      `group_add: ${DOCKER_GID:-0}` so the `node` user can use it. Compose,
      `.env.example` and the README all document this as root-equivalent
      access, needed later for the sandboxes.
- **`.env.example`** now lists every variable, **all with no value**, in
  groups with a comment each:
  - the server's 15 variables;
  - compose's `POSTGRES_PASSWORD`, `AI_OFFICE_BIND_ADDRESS`,
    `AI_OFFICE_PORT` and `DOCKER_GID`.

  Empty values mean "default": the server already treats an empty variable
  as unset (#7). The web app's dev proxy (#8) was changed to treat an empty
  `PORT` the same way.
- **README:** a "Running AI Office with docker compose" section.
- **Checks (`docker/deployment.test.ts`, a new `deployment` Vitest project):**
  - **`.env.example`:** lists every variable the server reads (from the
    config schema, now exported as `environmentKeys`) and every variable
    compose interpolates. It lists nothing else, each variable only once,
    and has no values, not even in commented-out lines.
  - **`docker-compose.yml`:** passes the **Compose Specification JSON
    schema** (vendored as `docker/compose-spec.json` from
    `compose-spec/compose-go@14d7cfa`, Apache-2.0, listed in
    `THIRD-PARTY-NOTICES.md`). It also has to meet what the issue asks of it,
    in five checks:
    - Postgres 18 with `ai_office`, the named volume and a health check;
    - the app waits for a healthy database and has a health check on
      `/health`;
    - the app gets the required settings and nothing the server doesn't
      read;
    - only the app's port is published, on 127.0.0.1 by default;
    - the app gets the Docker socket.
  - **`Dockerfile`:**
    - Node and pnpm match the pins;
    - every workspace package's manifest is copied;
    - the server and every workspace package it uses (walked from the
      `package.json` dependencies) have their `src` copied, with the
      migrations and the web build;
    - migrations run before the server, as `node`.
  - **With Docker Compose installed:** `docker compose config --quiet`. It
    falls back to a standalone `docker-compose` on `PATH`. Without Compose
    it is skipped with the reason, or fails in CI like the Postgres
    harness, so CI cannot pass by skipping it.
  - **With `AI_OFFICE_COMPOSE_E2E=1` and a Docker daemon:** builds the image
    and runs the stack under a throwaway project name on a free port, then:
    - checks `/health` is 200 `{status: ok, database: up}`, a page is
      served and the migrations ran;
    - writes a row, runs `down` and `up` again, and checks the row is still
      there;
    - finally runs `down --volumes`.

    Without the opt-in or a daemon it is skipped with the reason, in CI too,
    since CI does not opt in.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below).
- [x] **`docker compose config` validates (or a schema check of the file
      passes).** Both were done:
      - **Schema check.** It passes in `pnpm test`.
        - **It caught a real bug** while I wrote the file: the unquoted
          health-check script contained `: `, so YAML read it as a mapping
          (`data/services/app/healthcheck/test/3 must be string`).
        - **Negative check:** with `ports: 3000` and a `depends_on`
          condition of `when_ready`, the schema test fails
          (`depends_on/postgres/condition must be equal to one of the
          allowed values`), along with three of the requirement checks
          (`Tests  4 failed | 10 passed | 2 skipped`). The file was then
          restored.
      - **`docker compose config` itself.** There is no Docker CLI in the
        sandbox, so I downloaded the official standalone Compose binary
        (v5.6.0, sha256 checked against the release) into
        `/tmp/compose-bin`, outside the repository. With it on `PATH`, the
        test's `docker compose config validates the file` case **ran and
        passed** (output below). Run by hand, `config --quiet` exits 0, and
        it exits 1 naming each missing secret when they are unset.

### Verified on the host

- [ ] **`docker compose up` from a clean checkout gives a healthy app and
      database.** Not run: there is no Docker daemon here. What was checked
      instead:
      - I rebuilt the image's **runtime stage outside Docker** from the
        fresh clone in `/tmp/rt9`, from the Dockerfile's own lines: the same
        manifests, the same `pnpm install --frozen-lockfile --prod --filter
        "@ai-office/server..." --store-dir=… --config.package-import-method=copy`,
        and the same `COPY` sources plus the web build.
      - I ran the Dockerfile's exact `CMD` against a real Postgres 18.3 (the
        embedded binary from #6 and #33).
      - Migrations applied, `/health` was 200 with the database up, the
        Gateway answered on its port, the SPA was served, and the compose
        file's own health-check script (read from the YAML) exited 0. The
        prod install is 53 MB with no in-project pnpm store (output below).
      - On the host, run `AI_OFFICE_COMPOSE_E2E=1 pnpm exec vitest run
        --project deployment`, or `docker compose up --build --wait`.
- [ ] **Restarting the stack keeps data in the named volume.** Not run here
      (no Docker). The opt-in end-to-end test above checks exactly this:
      a row written before `docker compose down` / `up` is read back after.

## Output

### Fresh clone (`/tmp/clone9`)

```text
$ pnpm install --frozen-lockfile
Done in 259ms using pnpm v12.10.0

$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/server typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  20 passed (20)
      Tests  236 passed | 9 skipped (245)
test exit=0

$ pnpm build
✓ built in 236ms
build exit=0
```

The 9 skipped tests:
- 7 Postgres integration tests (#6 and #33), skipped without Docker;
- `docker compose config validates the file`, skipped without Compose;
- the opt-in compose end-to-end test.

```text
$ pnpm exec vitest run --project deployment --reporter=verbose
 ✓ docker/deployment.test.ts > .env.example > lists every variable the server reads
 ✓ docker/deployment.test.ts > .env.example > lists every variable docker-compose.yml reads
 ✓ docker/deployment.test.ts > .env.example > lists nothing that nothing reads
 ✓ docker/deployment.test.ts > .env.example > lists each variable once, with no value
 ✓ docker/deployment.test.ts > docker-compose.yml > passes the Compose Specification's schema
 ✓ docker/deployment.test.ts > docker-compose.yml > runs Postgres 18 with the ai_office database in a named volume
 ✓ docker/deployment.test.ts > docker-compose.yml > starts the app once the database is healthy, with a health check on /health
 ✓ docker/deployment.test.ts > docker-compose.yml > gives the app every required setting and the server's port
 ✓ docker/deployment.test.ts > docker-compose.yml > publishes only the app, on 127.0.0.1 unless told otherwise
 ✓ docker/deployment.test.ts > docker-compose.yml > gives the app the host's Docker socket
 ✓ docker/deployment.test.ts > the Dockerfile > uses the Node and pnpm versions pinned in package.json
 ✓ docker/deployment.test.ts > the Dockerfile > copies every workspace package's manifest before installing
 ✓ docker/deployment.test.ts > the Dockerfile > copies the sources of the server and every workspace package it uses
 ✓ docker/deployment.test.ts > the Dockerfile > applies migrations before starting the server, as a user without root
 ↓ docker/deployment.test.ts > with Docker > docker compose config validates the file [Docker Compose is not available (spawn docker ENOENT; spawn docker-compose ENOENT)]
 ↓ docker/deployment.test.ts > with Docker > docker compose up gives a healthy app and database, and keeps data across a restart [AI_OFFICE_COMPOSE_E2E is not 1 (bringing the stack up builds the image and takes minutes)]
      Tests  14 passed | 2 skipped (16)

$ PATH=/tmp/compose-bin:$PATH AI_OFFICE_COMPOSE_E2E=1 pnpm exec vitest run --project deployment --reporter=verbose
 ✓ docker/deployment.test.ts > with Docker > docker compose config validates the file
 ↓ docker/deployment.test.ts > with Docker > docker compose up gives a healthy app and database, and keeps data across a restart [The Docker daemon is not reachable (Command failed: docker-compose ls)]
      Tests  15 passed | 1 skipped (16)
```

### `docker compose config` by hand (standalone Compose v5.6.0)

```text
$ docker-compose version
Docker Compose version v5.6.0
$ POSTGRES_PASSWORD=… SESSION_SECRET=… ENCRYPTION_KEY=… docker-compose config --quiet
config --quiet exit=0
$ docker-compose config --quiet        (POSTGRES_PASSWORD, SESSION_SECRET and ENCRYPTION_KEY unset)
error while interpolating services.app.environment.DATABASE_URL: required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD in .env
error while interpolating services.app.environment.ENCRYPTION_KEY: required variable ENCRYPTION_KEY is missing a value: set ENCRYPTION_KEY in .env
error while interpolating services.app.environment.SESSION_SECRET: required variable SESSION_SECRET is missing a value: set SESSION_SECRET in .env
error while interpolating services.postgres.environment.POSTGRES_PASSWORD: required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD in .env
without POSTGRES_PASSWORD exit=1
```

Resolved excerpt (`docker-compose config`, secrets omitted):

```text
  app:
    depends_on:
      postgres:
        condition: service_healthy
    expose:
      - "4000"
    healthcheck:
      test: [CMD, node, --eval, 'fetch(''http://127.0.0.1:3000/health'').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))']
    ports:
      - mode: ingress
        host_ip: 127.0.0.1
        target: 3000
        published: "3000"
    volumes:
      - type: bind
        source: /var/run/docker.sock
        target: /var/run/docker.sock
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: ai_office
      POSTGRES_USER: ai_office
    healthcheck:
      test: [CMD, pg_isready, --username=ai_office, --dbname=ai_office]
    volumes:
      - type: volume
        source: postgres-data
        target: /var/lib/postgresql
```

### The image's runtime stage, rebuilt outside Docker (`/tmp/rt9`)

```text
$ NODE_ENV=production pnpm install --frozen-lockfile --prod --filter "@ai-office/server..." \
    --store-dir=<a store on another filesystem> --config.package-import-method=copy
Packages are copied from the content-addressable store to the virtual store.
Done in 124ms using pnpm v12.10.0
in-project stores: 0
53M                                  (node_modules)
copied sources: apps/server/src packages/db/src packages/gateway/src packages/shared/src
                (+ packages/db/migrations, apps/web/dist)

$ sh -c "node packages/db/src/migrate-cli.ts && exec node apps/server/src/main.ts"   (the Dockerfile's CMD)
Migrations applied.
$ curl localhost:3919/health
{"status":"ok","database":"up"} 200
$ curl localhost:4919/health            (the AI Gateway)
{"status":"ok","account":"none"} 200
$ curl localhost:3919/activity | grep root
<div id="root"></div>
$ node --eval "<the compose app health check, pointed at :3919>"
app healthcheck command exit=0
```

## Notes for the reviewer

- **File locations.** PRD §8 puts the "compose stack" under `docker/`, but
  the issue's host check is `docker compose up` from a clean checkout. That
  needs the compose file at the root, so `docker-compose.yml` and the app's
  `Dockerfile` are at the root. `docker/` holds the deployment checks now;
  the sandbox images (#26) will join them there.
- **Publishing on 127.0.0.1 by default.** Login (#11) does not exist yet, and
  PRD §7 says access should be restricted. `AI_OFFICE_BIND_ADDRESS=0.0.0.0`
  opens it up, for example behind Caddy (#115).
- **The AI Gateway is unauthenticated until #35.** Inside compose it listens
  on `0.0.0.0:4000` so the compose network can reach it (ADR 0001: "reachable
  only inside the compose network"). It is never published to the host.
  Today only the app and Postgres are on that network.
- **`DOCKER_GID`.** On Linux the socket belongs to the `docker` group, whose
  ID varies by host; Docker Desktop's is root's group, hence the default 0.
  Nothing uses the socket yet, so a wrong value shows up only when sandboxes
  arrive.
- **Shell variables.** Compose interpolates from the shell as well as
  `.env`. An exported `ANTHROPIC_API_KEY` (common for Claude Code users)
  therefore becomes the Gateway's AI Account. `.env.example` says so.
- **`POSTGRES_PASSWORD` must be URL-safe**, because it goes into
  `DATABASE_URL` unencoded. `.env.example` suggests `openssl rand -hex 24`.
- **CI.** The `deployment` project runs in `pnpm test`, so on GitHub's
  Ubuntu runners (which have Docker Compose) `docker compose config` runs
  there too. The end-to-end stack test is opt-in and CI does not opt in.
  Running it in CI would be a separate decision, since it builds the image.

## Not verifiable in this sandbox

- `docker build` of the `Dockerfile`: no Docker daemon. Its runtime stage
  was rebuilt by hand as above, but BuildKit itself, the cache mounts, the
  `node:26.10.0-slim` base image and `npm install --global pnpm@12.10.0`
  inside it were not exercised.
- `docker compose up` from a clean checkout, the health checks under
  Docker, and data surviving a restart in the `postgres-data` volume
  (covered by the opt-in end-to-end test, to run on the host).
- The Postgres 18 image's data directory layout at `/var/lib/postgresql`.
- The `node` user's access to the mounted Docker socket with `DOCKER_GID`.
