# Running AI Office

Running AI Office in development, with docker compose, the server's first run and sign-in, freeing storage, retention, and configuration export and import. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## Running in development

AI Office avoids the common default ports (3000, 4000, 5173, 5432), so it
doesn't clash with other projects:

| Port | What                                                                    |
| ---- | ----------------------------------------------------------------------- |
| 3045 | AI Office's one address: the web app, its `/api` and the AI Gateway's `/v1`. Vite in development, the published app under compose |
| 3046 | The server (`PORT`); in development Vite proxies `/api` and `/v1` to it |
| 3047 | The AI Gateway's own port (`GATEWAY_PORT`): the sandboxes' way to it only, never published |
| 3048 | Postgres: `docker-compose.dev.yml` in development, and the compose database |

These steps work on Windows, macOS and Linux. Each command runs in a
terminal: PowerShell on Windows (Git Bash also works), Terminal on macOS, or
your usual shell on Linux. Where a step differs by system, each version is
listed.

### 1. Install the prerequisites

You need Git, Node 26 or later, pnpm 12 or later, and Docker (for
Postgres).

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Git | `winget install Git.Git` | `xcode-select --install` | your package manager, e.g. `sudo apt install git` |
| Docker | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | [Docker Engine](https://docs.docker.com/engine/install/), then add yourself to the `docker` group |
| Node (via [fnm](https://github.com/Schniz/fnm)) | `winget install Schniz.fnm` | `brew install fnm` | `curl -fsSL https://fnm.vercel.app/install \| bash` |

Then install Node 26 with fnm. Follow fnm's instructions to add it to your
shell profile so `node` is on your PATH in new terminals.

```bash
fnm install 26
fnm default 26
node --version   # v26 or later
```

Install pnpm with its standalone installer.

```powershell
# Windows (PowerShell)
iwr https://get.pnpm.io/install.ps1 -useb | iex
```

```bash
# macOS and Linux
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

Open a new terminal and check the version with `pnpm --version` (12 or
later). If an older pnpm still shows on Windows, run `where.exe pnpm` (or
`which -a pnpm` in Git Bash). The installer's copy lives in
`%LOCALAPPDATA%\pnpm` and must come first on your PATH. Remove any other
copies, such as one installed with npm.

### 2. Clone and install

```bash
git clone https://github.com/adrianeyre/temp3.git
cd temp3
pnpm install
```

### 3. Start Docker

`pnpm dev` runs every service in Docker, so make sure Docker is running: on
Windows and macOS, open Docker Desktop and wait until it says the engine is
running. `docker info` should answer without an error.

The development database is the `postgres` service in
`docker-compose.dev.yml`, published on `127.0.0.1:3048` so the tests and
`pnpm db:schema` reach it from the host. Use `pnpm db:up` to start it on its
own and `pnpm db:down` to stop it. Its data stays in a Docker volume between
runs, until `pnpm db:reset`.

### 4. Create `.env`

Copy the example file to `.env` in the repository root.

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
```

```bash
# macOS, Linux and Git Bash
cp .env.example .env
```

That's all you need for development (`pnpm dev` copies it for you if there
is no `.env`). `.env.example` already has working
values: the development Postgres from step 3 (port 3048, password
`devpassword`), the ports in the table above, and sample `SESSION_SECRET` and
`ENCRYPTION_KEY` values.

The sample secrets are public, because they're in the repository, and the
server logs a warning when it starts with them. Once AI Office is served
beyond this machine, it refuses to start with any of them, the database
password included (pen-testing G1-8). It counts as served beyond this
machine when the app's port is reached from beyond loopback (`HOST`, or
`AI_OFFICE_BIND_ADDRESS` under compose, which passes it to the app as
`PUBLISHED_ADDRESS`), when `PUBLIC_URL` names anything but `localhost` or a
loopback address, or when `TRUST_PROXY` is set. The refusal names each
sample it found and the setting that serves AI Office beyond this machine,
never a value. For anything other than local development, generate your own
and put them in `.env`. Node is already
installed, so these commands work on every system:

```bash
# SESSION_SECRET: 32 random bytes as 64 hex characters (at least 32 are required)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ENCRYPTION_KEY: exactly 32 random bytes, base64-encoded
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

On macOS and Linux, `openssl rand -hex 32` and `openssl rand -base64 32` do
the same job. Also change `POSTGRES_PASSWORD` (and the password in
`DATABASE_URL`) to match your database. Postgres takes `POSTGRES_PASSWORD`
only when it makes its data volume, so for a database that already exists,
change the user's password as well (`ALTER USER ai_office PASSWORD '…'`).

Never commit `.env`. `ENCRYPTION_KEY` encrypts the AI Account credentials
stored in the database (and Agents' Gateway Keys, Connections' credentials,
the TOTP secret, the webhook secret, the outbound proxy's password and any
stored request bodies). Changing `SESSION_SECRET` signs everyone out.

#### Replacing `ENCRYPTION_KEY`

To replace `ENCRYPTION_KEY` (it leaked, or an Office is still on the
sample) without losing what it sealed (pen-testing G1-9):

1. Move its value, exactly as written, to `RETIRED_ENCRYPTION_KEYS`.
2. Set `ENCRYPTION_KEY` to a new key, after the next key version and a
   colon: `2:<new key>` the first time (the sample, and any key written
   alone, is version 1), `3:<newer key>` the next.
3. Restart AI Office. Before it serves anything, it opens each value
   sealed with a retired key and seals it again with the new one, in
   place, and logs how many. Once the log says "RETIRED_ENCRYPTION_KEYS can
   be removed", remove it, and keep the new `ENCRYPTION_KEY` as it is
   written, version and all.

AI Office refuses a new key without a version of its own (after every
retired one), two keys with one version, and the new key among the
retired ones, naming the problem, never a key. If the re-seal cannot
finish (the database is unreachable, say), every value still opens with
the retired key, and the next start tries again; a value no configured key
opens is left as it is and the log counts it, by table and column. Changed
any other way, `ENCRYPTION_KEY` leaves everything sealed with the old key
unreadable.

### 5. Run

```bash
pnpm dev
```

`pnpm dev` (`docker/dev.ts`) builds any sandbox image not built yet, then
runs the development stack, `docker-compose.dev.yml`, in the foreground,
prefixing each output line with its service; Ctrl+C stops it all
(`pnpm dev:down` stops one left running). Nothing runs on the host but
Docker, and the repository is bind-mounted, so editing a file is all it
takes:

- `deps` installs the workspace's dependencies inside Docker, into volumes
  of their own, so your own `node_modules` (if any) is never used or
  touched, then exits;
- `postgres`, the development database (above);
- `server`, the server and AI Gateway, which applies the schema as it
  starts and restarts when its code changes (`node --watch`);
- `web`, the web app's Vite dev server with hot reload, which proxies
  `/api`, `/health` and the AI Gateway's `/v1` to the server. Vite is often
  ready before the server, and the server restarts on every change: while
  it is not listening, these requests wait for it (up to 30 seconds, saying
  "Waiting for AI Office's server" once) rather than fail, so a page left
  open carries on once it is back;
- `sandbox-relay`, Agents' sandboxes' way to the AI Gateway (step 6);
- `proxy`, Caddy, serving it all over HTTPS on port 443, and redirecting
  HTTP on port 80 to it (`docker/dev/Caddyfile`).

The server and Vite run as your own user, so files they write are yours,
and the server starts Agents' sandboxes with your Docker (it is given the
socket, and the group that owns it).

Open https://ai-office.localhost (browsers send every `*.localhost` name to
this machine). Its certificate is from Caddy's own local CA, which the first
run makes in `~/.ai-office/dev-caddy` (`AI_OFFICE_DEV_CADDY_DIR`) and keeps.
Trust its root once, `caddy/pki/authorities/local/root.crt` there (copy it
to the machine your browser runs on, if that is another one):

- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain root.crt`
- **Windows:** `certutil -addstore -f ROOT root.crt` (as administrator)
- **Linux:** `sudo cp root.crt /usr/local/share/ca-certificates/ai-office-dev.crt && sudo update-ca-certificates`;
  Firefox keeps its own store (Settings → Certificates → Import)
- **Node tools** (Claude Code with `ANTHROPIC_BASE_URL=https://ai-office.localhost`):
  `NODE_EXTRA_CA_CERTS=<path to root.crt>`

If something else on this machine has port 443, 80 or 1455 (a reverse
proxy, or a `docker compose` AI Office), set `AI_OFFICE_DEV_HTTPS_PORT`,
`AI_OFFICE_DEV_HTTP_PORT` and `AI_OFFICE_DEV_OAUTH_PORT` in `.env` to free
ports; the address is then https://ai-office.localhost:<that port>. When
your browser reaches the stack through a forwarded port of its own (443 on
your laptop to 3443 on a server, say), set `AI_OFFICE_DEV_PUBLIC_URL` to the
address it opens. The development stack is
otherwise apart from it, with a project, volumes, sandbox network
(`ai-office-dev-sandboxes`) and sandbox directory
(`~/.ai-office/dev-sandboxes`) of its own. On Windows the sandbox directory
is `/home/ai-office/dev-sandboxes`, in Docker Desktop's Linux VM: a Windows
folder shared into the VM is root's there and cannot be given to the
server's user, so `pnpm dev` refuses a `C:\…` `AI_OFFICE_DEV_SANDBOX_DIR`,
and gives the VM's directory to that user first (`sandbox-dir` in
`docker-compose.dev.yml`). Setting the first password from
the browser takes the one-time setup token, as under compose, because the
server sees the proxy's container rather than this machine's loopback:
`docker compose -f docker-compose.dev.yml exec server cat <file>`, with the
file the server logs as it starts. On first run you are
sent to `/setup` to create the Owner password. It is stored, as an Argon2id
hash, in the `owner` table in Postgres, so from then on you sign in with it
at `/login`, across restarts (see [First run](#first-run-the-setup-screen)). If the server prints "its
configuration is invalid", it names each value in `.env` that is missing or
malformed.

### 6. Let Agents work issues (optional)

The app runs without any of the following, but Agents only pick up issues
once all of it is in place:

- The AI Office GitHub App is created and installed, and added in Floor
  Settings' **GitHub** card, or an access token and its read-only partner
  are added there; add as many Apps and tokens as you need (see
  [Setting up the GitHub App and your Floors](../../docs/processes/setting-up-a-floor.md)).
  They are kept in the database, never in `.env`.
- `SANDBOX_GATEWAY_URL` is set in `.env`, to `http://sandbox-relay:3047`,
  as `.env.example` already has it: the Gateway's own port, through the
  relay. It is the only address a sandbox reaches: given any other host
  (older `.env.example`s had `http://host.docker.internal:3047`, which a
  sandbox cannot even look up, so the agent tool retried for minutes and
  failed with `EAI_AGAIN`), AI Office uses the relay's address instead and
  says so as it starts. `pnpm dev` starts the **sandbox relay**
  (`docker-compose.dev.yml`) on the `ai-office-dev-sandboxes` network, which
  has no route out. Each sandbox is started on a network of its own, as
  closed, which AI Office joins the relay to and removes after it, so the
  relay is the one other thing a sandbox reaches. The relay forwards
  port 3047 to the AI Gateway in the `server` container, and relays HTTPS
  to the hosts `SANDBOX_EGRESS_HOSTS` names and to nothing else (see
  [Sandboxes](issue-pipeline.md#sandboxes)). `pnpm dev` sets the server's
  `SANDBOX_GATEWAY_URL`, `SANDBOX_NETWORK`, `SANDBOX_WORK_DIR` and
  `GATEWAY_HOST` itself, whatever `.env` says.
- `SANDBOX_EGRESS_HOSTS` names the hosts Agents need, such as
  `registry.npmjs.org` for a Floor whose setup command runs
  `npm install`, and `api.github.com` for `gh`. `.env.example` lists
  those two. Each host you add is one an injected Agent could send what it
  read to, if it has an account there.
- The sandbox images are built. `pnpm dev` builds any that are not yet
  (`pnpm sandbox:ensure`; the first time takes a few minutes, and again
  only when an image's version changes). `pnpm sandbox:build` rebuilds
  them all, or only those named, such as `pnpm sandbox:build claude`. The
  Manager chat runs Claude Code or Codex in them too, so a Claude or
  ChatGPT subscription can answer it.
- AI Office sets each sandbox's proxy variables itself (`HTTPS_PROXY`,
  `HTTP_PROXY` and `NO_PROXY`, and their lower-case forms): the relay's
  proxy for everything, and the relay and the Gateway reached directly.
  The Docker CLI otherwise sets them in every container from its own proxy
  configuration (Docker Desktop's proxy settings, or a company's
  `~/.docker/config.json`), and a `NO_PROXY` that does not name the relay
  sends Claude Code's model calls to the relay's proxy, which refuses them:
  "Failed to authenticate. API Error: 403 AI Office's sandboxes reach only
  the hosts SANDBOX_EGRESS_HOSTS names". Claude Code's telemetry and update
  checks are switched off in sandboxes
  (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), as the relay would refuse
  them. The relay logs every connection it refuses, with why, as a JSON
  line: `docker compose -f docker-compose.dev.yml logs sandbox-relay`.
- An AI Account is added under AI Settings → AI Accounts.

### Using the AI Gateway from your own tools

AI Office has one address, `http://localhost:3045` in development and
under compose: it serves the web app, its `/api`, and the AI Gateway at
`/v1`. Make a Gateway Key for each tool under **API Key Management** (or
AI Settings → Gateway Keys), then:

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://localhost:3045 ANTHROPIC_AUTH_TOKEN=aio_gk_… claude
# Codex and other OpenAI clients: the base URL is the address with /v1
OPENAI_BASE_URL=http://localhost:3045/v1 OPENAI_API_KEY=aio_gk_… …
```

Every Gateway request needs a Gateway Key; being signed in to the web app
does not authorise one. See [Gateway Keys](ai-gateway.md#gateway-keys).

## Running AI Office with docker compose

`docker compose up` runs the whole AI Office in Docker: the app (server,
AI Gateway and web app, built by the root `Dockerfile`), Postgres 18 with
an `ai_office` database in the named volume `postgres-data`, and, from
inside the app, the sandboxes Agents and the Manager chat work in.

```bash
cp .env.example .env   # for anything but development, set new POSTGRES_PASSWORD, SESSION_SECRET, ENCRYPTION_KEY
AGENT_UID=1000 AGENT_GID=1000 pnpm sandbox:build   # the sandbox images, for the app's `node` user
docker compose up --build --wait
curl localhost:3045/health   # {"status":"ok","database":"up"}
```

- The app applies the database schema each time it starts (see
  [The database schema](#the-database-schema)), and waits for a healthy
  database first. Both services have health checks; the app's is
  `GET /health`.
- **One entry point.** The app is published on `127.0.0.1:3045` (set
  `AI_OFFICE_BIND_ADDRESS` and `AI_OFFICE_PORT` to change that), and that
  one address serves the web app, its `/api` and the AI Gateway's `/v1`:
  your own tools use `ANTHROPIC_BASE_URL=http://localhost:3045`, or
  `http://localhost:3045/v1` for OpenAI clients, with a Gateway Key (see
  [above](#using-the-ai-gateway-from-your-own-tools)). The Gateway's own
  port, 3047, is not published: it is the sandboxes' way in, through the
  sandbox relay, as `http://sandbox-relay:3047` on their networks.
- **Opening it beyond this machine opens the Gateway too.** Whatever
  `AI_OFFICE_BIND_ADDRESS` lets in reaches the Gateway as well as the web
  app. It stays key-protected, as every Gateway request needs a Gateway
  Key, but don't publish plain HTTP on a network: use the `tls` profile
  (below), which serves it all over HTTPS, and leave the app on
  `127.0.0.1`.
- Data survives `docker compose down` and restarts. `docker compose down
  --volumes` deletes it.
- **The app container has the host's Docker socket**
  (`/var/run/docker.sock`), with `git` and the `docker` CLI, for the
  sandboxes Agents and the Manager chat work in: it starts them on the
  host's Docker. Access to the socket is as good as root on the host. The
  app runs as `node`, so on Linux set `DOCKER_GID` to the socket's group
  (`stat -c %g /var/run/docker.sock`); Docker Desktop needs the default,
  `0`.
- **Compose sets the sandboxes' settings itself**, whatever `.env` says
  (its values are for `pnpm dev`):
  `SANDBOX_GATEWAY_URL=http://sandbox-relay:3047`,
  `SANDBOX_NETWORK=ai-office-sandboxes` and `SANDBOX_WORK_DIR`. Agents
  work issues once the GitHub App is configured and an AI Account added.
- **The app is not on the sandboxes' network.** Compose starts the
  sandbox relay on `ai-office-sandboxes`, and each sandbox the app starts
  is on a network of its own with no route out, which the app joins the
  relay to (see [Sandboxes](issue-pipeline.md#sandboxes)). So from a
  sandbox the app answers only as the Gateway, through the relay, and no
  other sandbox answers at all.

**Agents' sandboxes under compose.** Two things must be in place on the
Docker host, because the app starts sandboxes on the host's Docker:

- **The sandbox images**, built on the host before `docker compose up`,
  for the app's `node` user (UID and GID 1000): `AGENT_UID=1000
  AGENT_GID=1000 pnpm sandbox:build`. Sandcastle refuses to start a
  sandbox whose image was built for another UID than the app's, and
  `pnpm sandbox:ensure` would skip images already built for yours, so use
  `sandbox:build` with those variables (needed again only when an image's
  version changes; see [Sandbox images](issue-pipeline.md#sandbox-images)).
  On Linux, if your own UID is 1000 (`id -u`), the images `pnpm dev` built
  are already right. Docker Desktop maps file ownership, so there the UID
  only has to match Sandcastle's check.
- **The work directory**, `AI_OFFICE_SANDBOX_DIR`
  (`~/.ai-office/sandboxes` by default, in the home directory of whoever
  runs compose), where clones and the Manager chat's per-Floor tool homes
  are made. The host's Docker bind-mounts them into sandboxes by the path
  the app gives it, so compose mounts the directory into the app **at the
  same path** as on the host and sets `SANDBOX_WORK_DIR` to it. A one-shot
  `sandbox-dir` service makes it if it is missing and gives it to UID 1000
  before the app starts. It runs as root, so it takes only a directory
  Docker has just made for the mount (root's, and empty) or one already
  UID 1000's, changes ownership with `chown -h`, and leaves it `0700`,
  private to the app's user, as every Floor's clone is beneath it
  (pen-testing I2-5). Docker follows a
  symbolic link at the path to mount what it points at, so another user's
  directory, or root's with something in it, is refused, and compose
  stops, saying so (pen-testing I2-4). So never put it under a directory
  others may write to, such as `/tmp`, where another local user could
  make the path, or a link there, first.
  - **Linux:** any other absolute path. If you also run `pnpm dev` as a
    user whose UID isn't 1000, keep the two apart: `pnpm dev`'s is in the
    system's temporary directory by default, and takes only its own
    user's.
  - **macOS (Docker Desktop):** a path Docker Desktop shares (Settings →
    Resources → File sharing; `/Users` is shared by default), so the
    default works.
  - **Windows (Docker Desktop):** a Linux-style path; it lives in Docker
    Desktop's Linux VM, and both compose's mount and the sandboxes'
    resolve it there. The default is one when `HOME` is set (as in WSL);
    where it is not (PowerShell), set `AI_OFFICE_SANDBOX_DIR` yourself.
    Never a `C:\…` path: the app inside the container could not name it
    the way the host does.

**Over HTTPS (the `tls` profile).** `docker compose --profile tls up`
adds Caddy in front of the app. Caddy serves `AI_OFFICE_DOMAIN` on ports
80 and 443 with a certificate it obtains and renews itself, and proxies
everything to the app's one port, the AI Gateway's `/v1` included, so
your tools use `https://<domain>` (and `https://<domain>/v1`). It flushes
responses as they arrive, so the Gateway's streams stream. The Gateway's
own port is never proxied. It keeps its certificates in the
`caddy-data` volume. Set `PUBLIC_URL` to the `https://` address,
`TRUST_PROXY` to `1` and `PROXY_SECRET` (`openssl rand -hex 32`) with it:
Caddy sends `PROXY_SECRET` in the `X-AI-Office-Proxy` header with every
request, and the app takes it off before anything else reads it, the
Gateway's `/v1` requests included. Caddy also adds the security headers to
any answer without them (see [Signing in](#signing-in)). The Caddyfile is
[`docker/caddy/Caddyfile`](../../docker/caddy/Caddyfile).
[Deploying to EC2](../processes/deploying-to-ec2.md) walks through a
whole deployment: the instance, restricting access, TOTP, backups and
upgrades.

`pnpm test` checks the compose file against the Compose Specification, and
runs `docker compose config`, with and without `--profile tls`, when Docker
Compose is installed. With
`AI_OFFICE_COMPOSE_E2E=1` it also builds the image and brings a throwaway
copy of the stack up and down, checking health, that `/v1` answers on the
app's port (a `401` without a key), that the app has `git` and the Docker
CLI, and that data survives a restart.

## Running the server

The server reads its start-up configuration from the environment (and, for
`dev`, from a `.env` file at the root; see [`.env.example`](../../.env.example)).
It refuses to start, naming each problem, when a required value is missing or
malformed.

```bash
cp .env.example .env   # works as is with the development Postgres (pnpm db:up)
pnpm db:schema
pnpm --filter server dev
curl localhost:3046/health   # {"status":"ok","database":"up"}
```

### The database schema

AI Office is not in production yet, so it has no database migrations. The
whole schema is one plain SQL file, `packages/db/schema.sql`, generated from
`packages/db/src/schema.ts` and `packages/db/src/schema-extras.sql` (the
events log's trigger and the rows a new database starts with) by
`pnpm --filter @ai-office/db db:generate`. Don't edit it by hand.

`pnpm db:schema` (and the app's container, each time it starts) applies it:

- to an empty database, it runs the whole of `schema.sql` in one
  transaction and records its sha256 in `schema_meta` (`schema_hash`);
- to a database that already has this schema, it does nothing;
- to a database made from a different version of the schema, it refuses,
  and says to recreate the database. For the development Postgres that is
  `pnpm db:reset`, which deletes its data.

`GET /health` is 200 when the database answers and 503 when it does not. The
server also serves the built web app from `apps/web/dist`, with every other
page path falling back to its `index.html`.

### First run: the setup screen

AI Office has no default password, and none can be set through the
environment. Until the Owner sets one, every page redirects to `/setup` and
every API route answers `403 {"error":"setup_required"}` (`/health` still
works). The password must be at least 12 characters, use at least 6
different characters, and mix three of lower case, upper case, digits and
symbols unless it is 20 characters or more. It is stored only as an Argon2id
hash, in the one-row `owner` table. Once it is set, `/setup` is a 404 for
good.

Whoever sets the password is the Owner, so setup takes something only the
host has:

- **From this machine** (a request from loopback, as with `pnpm dev`, or
  `pnpm start` on your own computer) it needs nothing more.
- **From anywhere else**, including a browser on the host reaching the app
  through Docker's published port, it needs the **one-time setup token**.
  While no password exists, AI Office writes a new one at each start to a
  file of its own, readable by its user alone, and logs the file's path
  (never the token). Under docker compose:
  `docker compose logs app` shows the path, and
  `docker compose exec app cat <path>` shows the token. The setup screen
  asks for it when the server wants it. The file is deleted once the
  password is set.
- **Only for a name AI Office is served at**: `PUBLIC_URL`'s, `localhost`
  or an IP address. A request for any other name is refused with `421
  {"error":"wrong_host"}`, so a page whose own name an attacker has
  rebound to the app (DNS rebinding) cannot set it.

Outside compose the server listens on `127.0.0.1` unless `HOST` says
otherwise; compose sets `0.0.0.0` inside the app's container, and
publishes it on the host's `127.0.0.1` unless `AI_OFFICE_BIND_ADDRESS`
says otherwise.

### Signing in

Every page, API route and stream needs a signed-in session, except
`/login`, `/setup` (until it is used), `/health`, the built web app's
files, and `POST /api/github/webhooks`, where GitHub delivers the App's
webhooks: each delivery must be signed with the webhook secret instead
([GitHub webhooks](issue-pipeline.md#issue-intake-and-the-pipeline)).
Without one, pages redirect to `/login` and API routes answer `401`.

- **Every answer carries security headers**, pages, the API, built files,
  live streams and refusals alike (`apps/server/src/security-headers.ts`):
  a `Content-Security-Policy` that lets the web app load only its own
  scripts, styles, images and connections (plus `data:` and `blob:`
  images, and WebAssembly for the model decoder), never other sites'
  images, and lets no site frame it (`frame-ancestors 'none'`);
  `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`;
  `Referrer-Policy: same-origin`; and, when `PUBLIC_URL` is https (or the
  proxy says the request was), `Strict-Transport-Security:
  max-age=31536000`. A page's policy allows its own inline scripts by
  their SHA-256 hashes, worked out from `index.html` as it is served; a
  route may send a stricter policy of its own, as the Manager chat's
  attachments do. The two answers the app's own hooks never see set them
  too: the AI Gateway's `/v1` on the app's port, and the page ChatGPT's
  sign-in lands on at `localhost:1455` (with `Referrer-Policy:
  no-referrer`, as its address holds the sign-in's code).
- `POST /api/login` with `{"password":"…"}`, any of the Owner's
  passwords (the first, set at setup, or one added since, see
  [the Owner's passwords](floors-and-agents.md#the-owners-passwords)),
  starts a session: a random token in an `HttpOnly`, `SameSite=Strict`
  cookie (`Secure` when `PUBLIC_URL` is https). Only the token's SHA-256
  is stored, in `sessions`. Sessions end 7 days after sign-in, however
  much they are used, or once they go 24 hours unused
  (`sessions.last_seen_at`, noted at most once a minute; a page left open
  uses its session all the time). The login page and the cookie policy say
  so.
- `POST /api/login/api-key` with `{"key":"…"}` starts one too, with an
  API key that has UI access, and asks for no second factor (see
  [API Key Management](ai-gateway.md#api-key-management)).
- `GET /api/session` returns the session's `csrfToken` and `expiresAt`.
  Every state-changing request on a signed-in route must send the token in
  `x-csrf-token`, and a state-changing request from another site
  (`Origin` or `Sec-Fetch-Site`) is refused on every route.
- `POST /api/logout` ends this session; `POST /api/logout/everywhere` ends
  every session ("sign out everywhere"). Ending sessions removes no
  password and no API key, so it answers with what still signs in
  (`{"sessionsEnded", "stillSignIn": {"passwords", "apiKeys"}}`, by name),
  and the login page shows it, so the Owner can remove what they do not
  recognise.
- A change that adds a way to sign in needs a **fresh proof of the
  Owner**, not just a session: adding an Owner password, making an API key
  with UI access (or giving a key UI access, or enabling such a key
  again), and turning TOTP on each take `currentPassword` (one of the
  Owner's passwords) and, when TOTP is on, `code`. A session begun with an
  API key cannot give one (`403 proof_required`). So a stolen session
  cannot leave itself a way back in that outlives sign-out-everywhere.
  Each proof is a guess at the Owner's password, so it counts against the
  same per-client limit as sign-ins (a wrong one is `422 wrong_password`
  or `wrong_code`, then `429`), and is recorded as a sign-in attempt is:
  in `sign_in_events`, and a wrong one as `sign_in.failed` in the
  Activity Feed (a right one is no sign-in, so it is not announced).
- **Any Owner password can be replaced**, the first's included, so a
  leaked one can be retired: `PUT /api/owner-passwords/:id` (`first` for
  the first) with `password` takes a fresh proof of that password itself
  (`currentPassword`, and `code` when TOTP is on), and ends every session
  it began. See
  [The Owner's passwords](floors-and-agents.md#the-owners-passwords).
- Sign-ins are rate-limited per client address. Five failures in a row
  lock the client out for a minute, with `429` and `Retry-After`. Each
  failure after a lockout doubles it, up to an hour. A successful sign-in,
  or a day without attempts, starts the count afresh. Every checked attempt
  (failed or successful) is recorded in `sign_in_events` with its time,
  address and user agent, and a restart keeps the count: as the server
  starts, the limiter replays the last day's attempts from
  `sign_in_events`, so a client locked out before it is locked out after.
- Behind a reverse proxy, set `TRUST_PROXY` (a hop count, or the proxy's
  addresses and CIDR ranges) so the client's address comes from
  `X-Forwarded-For`; otherwise every client shares the proxy's limit. Set
  `PROXY_SECRET` with it, and have the proxy send it in the
  `X-AI-Office-Proxy` header (the Caddyfile does): `X-Forwarded-For`,
  `-Host` and `-Proto` are believed only from a request that carries it.
  Anything else that reaches the app's port, such as another container on
  the same Docker network, cannot choose the address it is limited by,
  whatever `TRUST_PROXY` says. The server refuses to start with one of the
  two and not the other. Leave both unset when nothing is in front of AI
  Office.
- **TOTP (optional).** In Admin, the Owner can turn on a second factor:
  confirm with the current password (`POST /api/totp/setup` with
  `{"currentPassword"}`), scan the QR code (or type the secret) into an
  authenticator app, confirm
  with a code, and save the ten single-use recovery codes, which are shown
  only then. Signing in then takes the password (`POST /api/login`
  answers `{"secondFactor":"totp"}`), then a code or a recovery code
  (`POST /api/login/totp`) within five minutes. Wrong codes count against
  the rate limit like wrong passwords. Turning TOTP off needs a current
  code; a wrong one counts against the same limit and is recorded as a
  failed sign-in attempt (`sign_in.failed` at the second factor). The
  secret is stored encrypted with `ENCRYPTION_KEY`, and only
  hashes of the recovery codes are kept. Admin recommends TOTP whenever
  the page is not served from `localhost`.
- **Every change to how the Owner signs in is in the Activity Feed**, as
  `config.changed` in the `security` scope, naming the change and never a
  password, secret or code: `ownerPasswords.firstSet` (setup),
  `ownerPasswords.added`, `ownerPasswords.replaced`,
  `ownerPasswords.removed`, `totp.enabled` and
  `totp.disabled`. API keys that sign in are there too, as
  `gatewayKeys.*` in the `gateway` scope.
- Each route declares its access (`config.access` in Fastify); one that
  declares nothing needs a session. A test fails when a route is added
  without a declaration, or exempts itself without being on its list
  (`apps/server/src/auth/route-access.test.ts`).

## Storage

General Settings' **Storage** card shows how much of the database each history takes
(rows, size on disk with its indexes, and its oldest row) and the whole
database's size (`GET /api/office/storage`). Each history can be deleted
back to a number of days, once the Owner confirms (`POST
/api/office/storage/prune` with `category` and `olderThanDays`):

| History | What goes | Always kept | Suggested | Retention rule |
| --- | --- | --- | --- | --- |
| Activity | Events in the Activity Feed and live views (`events`) | 30 days | 365 days | Activity Feed and Notices |
| Request and response bodies | The Gateway's kept bodies | none | 7 days | Request and response bodies |
| Gateway requests | The request history, with its bodies | 32 days | 90 days | Requests and usage |
| Usage history | AI Accounts' usage readings | none | 90 days | Requests and usage |
| Sign-in history | Each sign-in, and each failed one | 1 day | 365 days | Activity Feed and Notices |
| Connection deliveries | Each Connection's log of what it sent (`connection_deliveries`); one still waiting to go stays | 1 day | 90 days | Connection deliveries |

The kinds, what each always keeps and what is suggested are
[retention](#retention)'s (`historyKindRetention` and
`defaultRetentionSettings` in `@ai-office/shared`), so deleting by hand and
the retention jobs agree: the suggestion is PRD §7's default for the rule
that deletes that kind, and a rule never keeps fewer days than any kind it
deletes. What is always kept is what AI Office still reads: work under way
reads its own events back (an issue's address, its pull request, the Token
Caps it reached) however long ago it started, and hourly Analytics read up
to 31 days of requests themselves.

Both delete events, requests and Connection deliveries through the same
functions in `@ai-office/db`, so a clean-up by hand behaves as retention
does:

- **Token Caps and Analytics keep counting.** Deleting requests
  (`deleteGatewayRequestsBefore`) adds what they used to its UTC day's
  totals for its AI Account, Model, Floor, Agent, issue or Owner tool, in
  `gateway_usage_days`, in the same statement. Token accounting and
  Analytics by the day add those days to the requests still kept, so the
  day's and the month's use (and every cap, Notice and pause that reads
  it) and every daily chart, breakdown and insight are unchanged.
  Analytics by the hour count only the requests still kept.
- **The event log stays append-only otherwise.** Deleting events
  (`deleteEventsBefore`) names its cutoff in
  `ai_office.events_retention_cutoff`, set for its transaction alone. The
  log's one trigger function, `events_refuse_change()`
  (`packages/db/src/schema-extras.sql`), lets through a delete of events
  older than that cutoff and refuses updates, truncation and every other
  delete.
- **The outbound queue stays.** Deleting Connection deliveries
  (`deleteConnectionDeliveriesBefore`) takes only finished ones
  (delivered, failed, or summarised in a Digest). A pending one, still
  being retried or held for quiet hours, is the Communications Agent's
  queue ([Communications and Connections](notices-and-skills.md#communications-and-connections)) rather than its log, and stays
  however old.

Postgres reuses the space deleted rows leave at once, and autovacuum hands
it back over time.

## Retention

AI Office deletes what it records once it is past its retention period
(PRD §7), set in General Settings' **Retention** card, beside Storage (FR-65). Each
rule runs when the server starts, every hour after that, and at once when
the Owner changes a period:

| Rule | Deletes | Default | At least |
| --- | --- | --- | --- |
| Request and response bodies | `gateway_request_bodies`; the requests stay | 7 days | 0 days |
| Requests and usage | `gateway_requests` (with their bodies) and AI Accounts' usage-window readings (`ai_account_usage`) | 90 days | 32 days |
| Activity Feed and Notices | `events`, Notices dismissed or acted on before then, and `sign_in_events` | 365 days | 30 days |
| Connection deliveries | Connections' finished deliveries (`connection_deliveries`); those still waiting to go stay | 90 days | 1 day |

- **Manager chat attachments never sent** (`manager_chat_attachments`
  with no message) are deleted a day after they were uploaded, on the same
  runs, a period of its own that is not set here (PRD FR-24). A sent one
  is kept with its message and goes with it.
- **Token Caps and Analytics keep counting**, and the event log stays
  append-only otherwise, as for a clean-up by hand (see
  [Storage](#storage)).
- **Open Notices stay**, however old, until the Owner dismisses one or
  acts on it; a closed one is deleted once it has been closed for the
  period.
- **Bounds.** Each period is whole days, up to 3,650, and at least the
  most that any kind it deletes always keeps (the table above). Bodies go
  with their request, so their period is no longer than requests'. The
  database's check on `office_settings` holds the same bounds.
- **Not storing bodies at all** is the **Keep request and response bodies**
  switch in AI Settings' **Request history** card (see
  [Request history](ai-gateway.md#request-history-and-live-streams)).
- **API.** `GET` and `PUT /api/office/retention` with
  `{"requestBodiesDays","requestMetadataDays","activityDays","connectionDeliveriesDays"}`. Each change
  is a `config.changed` event (`retention.requestBodiesDays`, …). The
  periods live in `office_settings`. What each run deleted is logged.

## Configuration export and import

General Settings' **Configuration** card exports everything the Owner has configured
as one JSON file, and imports such a file (PRD FR-65), so an Office can be
moved, copied or rebuilt.

- **What is in it:** the office's settings (Git identity, intake,
  sandboxes, body storage, load balancing, retries, usage throttling, the
  prompt-cache TTL, Token Caps and retention), each AI Provider's default
  Model, the Owner's Model prices, the office-wide memory, the Skill
  library with each Skill's files, the Role library (every Role, built in,
  brought by a Floor Template or the Owner's own, with its Stage,
  instructions, Skills, desk dressing and suggested AI Provider and
  Model), the Owner's own [Floor Templates](floors-and-agents.md#your-own-floor-templates)
  with each one's files (the built-in ones ship with AI Office), and every Floor, archived ones too: its repository, the Floor
  Template it started from and its 3D theme, its settings, Merge Policy
  and Fresh Start threshold, its Agents (Avatars, Models, effort, instructions, Token Caps and Fresh
  Start thresholds), its issues' Token Caps, its Skill settings per Role,
  and each Role's accepted memory. The settings shown
  in AI Settings are in it as well as General Settings'.
- **Never a credential.** AI Accounts, Gateway Keys, the password, TOTP and
  anything sealed with `ENCRYPTION_KEY` are not in it, and the whole file
  passes the central redactor, so a secret typed into a free-text field
  leaves as `[REDACTED]`. Nor is anything AI Office recorded rather than
  was told: requests, events, Notices, Batches, chats, Grilling
  Sessions. After an import,
  add the AI Accounts again; each imported Agent gets a new Gateway Key of
  its own.
- **Previewed first.** Choosing a file checks it, then lists what importing
  it would add and change, area by area (and which fields), and anything
  that stops it: a repository that is another Floor here, an Agent whose
  Role differs here, an Agent or Role memory in a Role neither the Role
  library here nor the file has, a required reviewer whose Role is not in
  the review Stage, a Role whose Stage would change while Agents fill it,
  a name taken, an archived Floor brought back, memory that looks like a
  credential. With a problem, nothing is imported.
  **Import these changes** then applies exactly what was listed.
- **Adds and changes, never removes.** What is here and not in the file
  stays. Things are matched by Floor id and repository, Agent id, Role id,
  Skill name and Floor Template id. Roles are added or changed before the
  Floors whose Agents fill them, so an import onto a new Office keeps the Owner's own
  Roles. A Floor that is here already keeps its template and theme.
  Importing the same file twice changes nothing the second time.
- **Role instructions reach models** (ADR 0003), so the preview marks each
  Role whose instructions it adds or changes: read them in the file before
  importing it.
- **Imported Skills wait for review** (FR-76), as uploaded ones do: they
  arrive disabled, and one whose files differ from the Skill of its name
  here replaces it and waits too.
- **Imported Floor Templates wait for review** (FR-101) in the same way:
  each arrives disabled, and one whose files differ from the template of
  its id here replaces it and waits too. One whose files are not a valid
  template, whose id is a built-in template's, or whose name another
  template here has stops the import. A file exported before Floor
  Templates could be exported reads as having none.
- **Every change is an event**, as when it is made in the admin
  (`config.changed`, `role.created`, `role.changed`,
  `floor_template.added`, `floor.created`, `agent.created`, `skill.added`,
  …),
  then `config.changed` with `configuration.imported`.
- **API.** `GET /api/configuration/export` answers the file
  (`configurationSchema` in `@ai-office/shared`) as a download; `POST
  /api/configuration/import/preview` with the file answers `{"changes",
  "problems"}`; `POST /api/configuration/import` applies it and answers the
  same, or `409 configuration_conflicts` with the problems. A file that is
  not an export of this version is `400`.
