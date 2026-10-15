# Issue #115: EC2 guide and Caddy TLS compose profile — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker daemon and no Docker CLI) on this branch, after the issue's last
commit.

## What was built

- **The `tls` profile** (`docker-compose.yml`). A `caddy` service,
  `caddy:2-alpine`, that runs only with `--profile tls`; without the
  profile the stack is unchanged.
  - It publishes `80`, `443` and `443/udp` (HTTP/3).
  - It serves `AI_OFFICE_DOMAIN` (default `localhost`, which gets a
    certificate from Caddy's local CA) with automatic certificates.
  - It proxies to `app:3045` only: the AI Gateway (3047) is never
    proxied (ADR 0001), and the app stays on `127.0.0.1`.
  - It starts once the app is healthy.
  - It keeps its certificates and ACME account in the named volumes
    `caddy-data` and `caddy-config`.
  - It is on the default network only, never the sandboxes'.
- **The Caddyfile** (`docker/caddy/Caddyfile`), mounted read-only:
  - one site, `{$AI_OFFICE_DOMAIN}`, with `reverse_proxy app:3045`;
  - access logs to stdout.

  There is no `encode`, which could hold back the server-sent event
  streams. There is no HSTS header, which on `localhost` would force
  HTTPS onto every local port.
- **`.env.example`** documents `AI_OFFICE_DOMAIN`, with `PUBLIC_URL`
  and `TRUST_PROXY=1` to set beside it. `.gitignore` ignores
  `docker-compose.override.yml`, which the Tailscale option uses to give
  Caddy Tailscale's socket.
- **`docs/processes/deploying-to-ec2.md`** covers:
  - instance sizing;
  - launching (encrypted gp3, IMDSv2, an Elastic IP);
  - access, either by a security group limited to your IP (with port 80
    open for certificate issuance and GitHub's webhook ranges for
    optional webhooks) or by Tailscale with nothing open;
  - installing Docker from Docker's repository;
  - configuring `.env`, and starting the stack;
  - TOTP;
  - backups: a nightly `pg_dump` with S3 and EBS snapshots, restoring
    it, and a copy of the Postgres volume;
  - upgrades, and troubleshooting.

  It says plainly that Agents do not yet work issues under compose (as
  the pipeline guide already notes). The running guide and the README's
  documentation table link to it.

## Acceptance criteria

### Verified in the sandbox

- [x] **`docker compose --profile tls config` validates.** The sandbox
      has no Docker CLI. So the official Docker Compose v5.6.0 binary was
      downloaded from its GitHub release, checked against the release's
      `checksums.txt` (SHA-256 matched), and run on the repository with
      throwaway secrets.
  - `docker-compose --profile tls config --quiet` exits 0.
  - `config --services` lists `postgres`, `app` and `caddy` with the
    profile, and only `postgres` and `app` without it.
  - The deployment tests' Docker-gated checks then ran with that binary
    on the `PATH` and passed:
    - "docker compose config validates the file";
    - the new "docker compose --profile tls config validates the file,
      with Caddy", which also checks that `AI_OFFICE_DOMAIN` reaches the
      `caddy` service.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass** (not named
      by the issue, but run as for every issue). All three exit 0.
- [x] **Static checks of the profile** (`docker/deployment.test.ts`,
      "the tls profile"). These run everywhere, Docker or not:
  - Caddy runs only with the profile, and the other services have none;
  - it publishes 80, 443 and 443/udp, and the app stays on
    `127.0.0.1`;
  - the Caddyfile serves `{$AI_OFFICE_DOMAIN}` and proxies only to
    `app:3045`, never to 3047, with automatic TLS (no `tls` directive,
    no `auto_https off`);
  - Caddy starts once the app is healthy, with the Caddyfile read-only;
  - the certificate volumes are named and declared;
  - Caddy is not on the sandboxes' network.

  The existing schema check (the Compose Specification, with Ajv) covers
  the new service too.
- [x] **The Caddyfile parses.** The official Caddy v2.11.7 binary was
      downloaded and checked against its release's SHA-512 checksums.
      `caddy adapt` turns the Caddyfile into a config, both for
      `ai-office.example.com` and for `localhost`: a server on `:443`
      matching the host, with a reverse proxy to `app:3045`. `caddy fmt`
      leaves the file unchanged. The new optional test "Caddy reads the
      Caddyfile, for a domain and for localhost" runs the same check with
      a `caddy` on the `PATH` (or the image, through a Docker daemon),
      and passed with that binary.

Without those binaries, as `pnpm test` runs in the sandbox, the three
Docker checks are skipped with their reason, never faked:

```text
Docker Compose is not available (spawn docker ENOENT; spawn docker-compose ENOENT), so "docker compose --profile tls config validates the file, with Caddy" is skipped.
Neither caddy nor a running Docker daemon is available (spawn docker ENOENT), so "Caddy reads the Caddyfile, for a domain and for localhost" is skipped.
```

In CI, which has Docker, "docker compose --profile tls config validates
the file, with Caddy" fails rather than skips if Compose is missing, as
the existing config check does. The Caddyfile check is optional because
it may pull Caddy's image.

### Verified on the host

- [ ] **Following the guide on a fresh instance gives a working HTTPS
      site.** This needs an EC2 instance, a DNS name or a tailnet, and
      Let's Encrypt (or Tailscale) issuing a real certificate, so it was
      not run here. These parts of the guide in particular are unverified
      until then:
  - **Issuing certificates:** Caddy obtaining the Let's Encrypt
    certificate over port 80 while 443 is limited to one IP.
  - **Tailscale:** Caddy obtaining a `ts.net` certificate through
    Tailscale's socket, mounted by `docker-compose.override.yml`.
  - **The commands:** installing Docker and NodeSource's Node 26 on
    Ubuntu 24.04.
  - **Backups:** the `pg_dump` and `pg_restore` round trip, and the
    volume copy.
  - **Live streams:** the SSE streams through Caddy.

## Notes and decisions

- **Port 80 is open to everyone in option A.** Let's Encrypt validates
  from addresses it does not publish, so restricting 80 would stop
  issuance and renewal. Caddy answers there only the ACME challenge and a
  redirect to HTTPS. Port 443, the app itself, stays limited to your IP,
  which is how this reconciles with "access should be restricted by
  security group" (PRD §7).
- **Agents under compose.** The pipeline guide already notes that the
  app's image lacks `git` and the `docker` CLI, so Agents do not work
  issues under compose yet. That is outside this issue. The guide says so
  rather than implying otherwise, and prepares the instance (sizing,
  sandbox images, `SANDBOX_GATEWAY_URL`) for when they do.
- **`TRUST_PROXY=1`.** Caddy does not trust a client's own
  `X-Forwarded-For` by default and sets it to the client's address. So
  one trusted hop gives the sign-in rate limit each client's real
  address.
- **Provisioning** (Terraform or similar) is #117 and not covered.

## Output

`docker compose --profile tls config` (the standalone Compose v5.6.0
binary, which is the same program as the `docker compose` plugin):

```text
$ docker-compose version
Docker Compose version v5.6.0
$ docker-compose --profile tls config --quiet
docker compose --profile tls config --quiet: exit 0
$ docker-compose config --services
postgres
app
$ docker-compose --profile tls config --services
postgres
app
caddy
```

`docker/deployment.test.ts` with Compose and Caddy on the `PATH`:

```text
 ✓ docker/deployment.test.ts > the tls profile > adds Caddy, and only with --profile tls
 ✓ docker/deployment.test.ts > the tls profile > publishes HTTP and HTTPS (HTTP/3 too), leaving the app on 127.0.0.1
 ✓ docker/deployment.test.ts > the tls profile > serves AI_OFFICE_DOMAIN, proxying to the app and never to the AI Gateway
 ✓ docker/deployment.test.ts > the tls profile > starts once the app is healthy, reading the Caddyfile read-only
 ✓ docker/deployment.test.ts > the tls profile > keeps certificates in named volumes, so a restart does not ask for new ones
 ✓ docker/deployment.test.ts > the tls profile > keeps Caddy off the sandboxes' network
 ✓ docker/deployment.test.ts > with Docker > docker compose config validates the file
 ✓ docker/deployment.test.ts > with Docker > docker compose --profile tls config validates the file, with Caddy
 ✓ docker/deployment.test.ts > with Docker > Caddy reads the Caddyfile, for a domain and for localhost
      Tests  25 passed | 1 skipped (26)
```

(The one skipped is the opt-in `docker compose up` end-to-end test,
which needs `AI_OFFICE_COMPOSE_E2E=1` and a Docker daemon.)

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck` (tail):

```text
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test` (tail, in the sandbox as it is, without the downloaded
binaries):

```text
 Test Files  252 passed (252)
      Tests  2891 passed | 402 skipped (3293)
   Start at  09:21:33
   Duration  54.85s (tests 41%, import 34%, environment 12%, transform 10%, setup 2%)
exit 0
```
