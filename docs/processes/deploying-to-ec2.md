# Deploying AI Office to EC2

How to run AI Office on a single EC2 instance, served over HTTPS by Caddy,
with access restricted to you (PRD §7, Deployment and Security). It
assumes an AWS account, and either a domain name whose DNS you control or
a [Tailscale](https://tailscale.com) tailnet. Creating the instance with
infrastructure as code is a separate task (#117). This guide does it by
hand, in the AWS console.

```text
 you ── HTTPS :443 ──▶ Caddy ──▶ app :3045 ──▶ Postgres :3048
       (security group     │       │  web app, /api, AI Gateway /v1
        or Tailscale)      │       │  AI Gateway :3047 (sandboxes only, never published)
                           │       └──▶ the host's Docker: Agents' sandboxes
                           └─ certificates in the caddy-data volume
```

The stack is the usual `docker-compose.yml` (see
[Running AI Office with docker compose](../guide/running.md#running-ai-office-with-docker-compose)),
plus its `tls` profile. The profile adds a `caddy` service that:

- publishes ports 80 and 443 (and 443/udp, for HTTP/3);
- obtains and renews the certificate for `AI_OFFICE_DOMAIN` itself;
- redirects HTTP to HTTPS;
- proxies everything to the app's one port, the AI Gateway's `/v1`
  included, so your own tools reach the Gateway at `https://<your name>`
  (`https://<your name>/v1` for OpenAI clients) with a Gateway Key;
- adds the security headers (HSTS, a Content-Security-Policy, `X-Frame-Options`,
  `nosniff` and `Referrer-Policy`) to any answer that lacks them, such as
  its own when the app is down. The app sends its own on every answer,
  the Gateway's `/v1` included.

Only Caddy is reachable from outside the instance:

- The app stays on `127.0.0.1:3045`.
- The AI Gateway's own port (3047) and Postgres stay inside the compose
  network; the Gateway is reached through Caddy at `/v1`, where every
  request needs a Gateway Key.
- Neither Caddy nor the app is on the sandboxes' network: sandboxes reach
  the AI Gateway's own port through the sandbox relay, and nothing else of
  the stack.

Agents work issues under compose: the app starts their sandboxes on the
instance's Docker, from the sandbox images built below, with their
clones in `AI_OFFICE_SANDBOX_DIR` (`~/.ai-office/sandboxes` by
default, in the home directory of whoever runs compose; compose makes it
for the app's `node` user, and refuses a directory another user made or
a symbolic link, so never put it under `/tmp`).

---

## 1. Choose an instance

Agents' sandboxes run on the instance's own Docker, one container each, so
size it for how many run at once (the office's sandbox limit in General Settings, 3
by default; PRD FR-22). These are starting points: watch `docker stats`
and resize if the instance runs short of memory.

| Use                                    | Instance type                    | vCPUs | Memory | Disk (gp3) |
| -------------------------------------- | -------------------------------- | ----- | ------ | ---------- |
| Trying it out; a sandbox limit of 1    | `t3.large`                       | 2     | 8 GiB  | 60 GiB     |
| The default sandbox limit of 3         | `m7i.xlarge` (or `t3.xlarge`)    | 4     | 16 GiB | 100 GiB    |
| A sandbox limit of 5 or 6, many Floors | `m7i.2xlarge`                    | 8     | 32 GiB | 150 GiB    |

- **Architecture:** x86_64, which AI Office is developed and tested on.
- **Operating system:** Ubuntu Server 24.04 LTS, which the commands
  below are for.
- **Disk:** the app, Postgres, three sandbox images (a few GB each),
  Docker's build cache and the Agents' clones all live on the root volume.
  Tick **Encrypted**.
- **`t3` instances** are burstable: fine for light use, but a long
  sandbox run spends their CPU credits. Prefer `m7i` for steady work.

## 2. Launch it

In the EC2 console, **Launch instance**:

1. **Name:** `ai-office`.
2. **AMI:** Ubuntu Server 24.04 LTS, 64-bit (x86).
3. **Instance type:** from the table above.
4. **Key pair:** a new or existing one, for SSH. (With Tailscale, you can
   use Tailscale SSH instead and open no SSH port at all.)
5. **Network settings → Edit:** create a security group named
   `ai-office` with the rules of [section 3](#3-restrict-access). Leave
   **Auto-assign public IP** on.
6. **Storage:** the size from the table, `gp3`, encrypted.
7. **Advanced details → Metadata version:** **V2 only (token
   required)**, and **Metadata response hop limit:** **1**. Leave
   **Metadata accessible** on: the host's own AWS CLI uses the instance's
   IAM role for [backups](#9-back-up).

   The hop limit of 1 keeps every container on the instance (the app and
   every Agent's sandbox) from the instance metadata service, and so from
   the instance role's credentials: a container's request takes a second
   hop, and its answer never arrives. Ubuntu 24.04's AMI otherwise defaults
   to a limit of 2, which a container reaches. Agents' sandboxes are kept
   from it twice over: their Docker network has no route out, and the
   sandbox relay refuses `169.254.169.254` and every other link-local
   address (see [Sandboxes](../guide/issue-pipeline.md#sandboxes)).

For an instance launched before, or by anything other than this page,
set the same from your own machine, and check it:

```bash
aws ec2 modify-instance-metadata-options --instance-id <instance-id> \
  --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled
aws ec2 describe-instances --instance-ids <instance-id> \
  --query 'Reservations[].Instances[].MetadataOptions'
# "HttpTokens": "required", "HttpPutResponseHopLimit": 1
```

Then, for a stable address, **Elastic IPs → Allocate**, and **Associate**
it with the instance. With a domain name, create a DNS `A` record for
the name you will use (such as `ai-office.example.com`) pointing at the
Elastic IP. Add no `AAAA` record unless the security group allows IPv6
too.

## 3. Restrict access

AI Office signs in with any of your Owner passwords (and, once you turn
it on, TOTP) or with an API key that has UI access, which asks for no
TOTP; but it should not be reachable by anyone else in the first place.
Choose one way. Whichever you choose, never open ports 3045, 3047 or
3048.

### Option A: a security group limited to your IP

The `ai-office` security group's inbound rules:

| Type  | Port | Source                    | Why                                                                                      |
| ----- | ---- | ------------------------- | ---------------------------------------------------------------------------------------- |
| SSH   | 22   | My IP                     | Administration                                                                           |
| HTTPS | 443  | My IP                     | AI Office itself                                                                         |
| HTTP  | 80   | Anywhere (`0.0.0.0/0`)    | Let's Encrypt's HTTP challenge, to issue and renew the certificate; Caddy only redirects |

- **Port 80 is open to everyone** because Let's Encrypt validates from
  addresses it does not publish. Caddy answers there only the challenge
  and a redirect to HTTPS. Close it, and certificates can be neither
  issued nor renewed.
- **When your IP changes,** edit the rules (**My IP** fills in the new
  one). Add a rule per extra address you use.
- **GitHub webhooks** ([optional](setting-up-a-floor.md#webhooks-optional))
  need GitHub to reach port 443. Add a rule per range GitHub delivers
  webhooks from:

  ```bash
  curl -s https://api.github.com/meta | jq -r '.hooks[]'
  ```

  The ranges change from time to time. Without webhooks, AI Office polls
  GitHub, which needs nothing inbound.

### Option B: Tailscale

Nothing is open to the internet. You reach AI Office over your tailnet
at `https://<machine>.<tailnet>.ts.net`, with a certificate Caddy gets
from Tailscale.

1. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and
   **HTTPS Certificates**. Certificates for `ts.net` names are published
   in public Certificate Transparency logs, as every public certificate
   is: the machine's name will be visible there.
2. The security group has no inbound rules at all (or SSH from your IP
   until Tailscale is up). Tailscale needs only outbound traffic.
3. On the instance, after [section 4](#4-install-docker):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --ssh
   tailscale status --json | jq -r '.Self.DNSName'   # ai-office.<tailnet>.ts.net.
   ```

4. In [section 6](#6-configure-it), set `AI_OFFICE_DOMAIN` to that name
   (without the trailing dot). Then let Caddy reach Tailscale's daemon:
   create `docker-compose.override.yml` beside `docker-compose.yml`
   (git ignores it). Compose reads it automatically.

   ```yaml
   services:
     caddy:
       volumes:
         - /var/run/tailscale:/var/run/tailscale
   ```

GitHub cannot reach a tailnet, so leave GitHub webhooks off. AI Office
polls GitHub instead.

## 4. Install Docker

SSH in (`ssh ubuntu@<elastic-ip>`), then install Docker Engine with its
Compose plugin from Docker's own repository:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu   # then log out and back in
docker compose version
```

Building the sandbox images (`pnpm sandbox:build`, for Agents) also needs
Node 26 and pnpm 12 on the instance, as the README's
[Requirements](../../README.md#requirements) say. The stack itself needs
neither: it builds in Docker.

```bash
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install --global pnpm@12.10.0
```

Ubuntu installs security updates by itself (`unattended-upgrades`).
Docker's packages update with `sudo apt-get upgrade`.

## 5. Get AI Office

```bash
git clone https://github.com/adrianeyre/ai-office.git ~/ai-office
cd ~/ai-office
```

For Agents, build the sandbox images too, for the app's `node` user.
Build only those your Agents' AI Providers need, if you like (`pnpm
sandbox:build claude`); see
[Sandbox images](../guide/issue-pipeline.md#sandbox-images).

```bash
pnpm install --frozen-lockfile
AGENT_UID=1000 AGENT_GID=1000 pnpm sandbox:build
```

## 6. Configure it

```bash
cp .env.example .env
chmod 600 .env
```

Then edit `.env`. Every value in the **Required** section and
`POSTGRES_PASSWORD` must be new: the samples are public. With
`PUBLIC_URL` set to your domain (or `TRUST_PROXY` set), AI Office refuses
to start with any of them, naming each.

| Variable                 | Value                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`         | `openssl rand -hex 32`                                                                       |
| `ENCRYPTION_KEY`         | `openssl rand -base64 32`. Keep a copy somewhere safe: see [Backups](#9-back-up). To replace it later, see [Replacing `ENCRYPTION_KEY`](../guide/running.md#replacing-encryption_key) |
| `POSTGRES_PASSWORD`      | `openssl rand -hex 24`                                                                       |
| `AI_OFFICE_DOMAIN`       | The name you reach AI Office at: `ai-office.example.com`, or your `ts.net` name               |
| `PUBLIC_URL`             | `https://` and that name. It also marks the session cookie `Secure`                           |
| `TRUST_PROXY`            | `1`: the one proxy in front of the app is Caddy, so sign-in and webhook rate limits see each client |
| `PROXY_SECRET`           | `openssl rand -hex 32`. Caddy sends it with every request; the app believes the client address Caddy gives only from a request that carries it, so nothing that reaches the app's port directly (another container on its network) can choose its own |
| `DOCKER_GID`             | `stat -c %g /var/run/docker.sock`                                                            |
| `SANDBOX_EGRESS_HOSTS`   | The hosts sandboxes may reach over HTTPS, and nothing else: `.env.example`'s `registry.npmjs.org,api.github.com`, or fewer. See [Sandboxes](../guide/issue-pipeline.md#sandboxes) |

The GitHub App (or access tokens) is not set here: once AI Office is up,
add it in Floor Settings' **GitHub** card
([Setting up the GitHub App and your Floors](setting-up-a-floor.md)).

Leave `AI_OFFICE_BIND_ADDRESS` at `127.0.0.1`, so the app's own port, and
the AI Gateway on it, stays on `127.0.0.1` and only Caddy reaches it from
outside. `DATABASE_URL`, `PORT`, `HOST`, `SANDBOX_GATEWAY_URL`,
`SANDBOX_NETWORK` and `SANDBOX_WORK_DIR` in `.env` are for running
outside compose; compose sets its own (the sandboxes reach the Gateway
at `http://sandbox-relay:3047`, through the sandbox relay).

## 7. Start it

Start AI Office only once [access is restricted](#3-restrict-access).
Until a password is set, the setup screen asks a browser on another
machine for the one-time setup token AI Office wrote as it started (see
[First run](../guide/running.md#first-run-the-setup-screen)):
`docker compose logs app` shows the file's path, and
`docker compose exec app cat <path>` the token.

```bash
docker compose --profile tls up --build --detach --wait
curl https://ai-office.example.com/health   # {"status":"ok","database":"up"}
docker compose logs caddy                   # "certificate obtained successfully"
```

Then open `https://<your name>/` and set the password on the setup
screen, with the setup token
([First run](../guide/running.md#first-run-the-setup-screen)).

- **Every compose command** that should include Caddy needs `--profile
  tls`: `up`, `down`, `pull`, `logs caddy`. Or put
  `COMPOSE_PROFILES=tls` in `.env` and drop the flag.
- **Restarts:** every service has `restart: unless-stopped`, so the stack
  comes back after a reboot once Docker starts (it is enabled at boot).

## 8. Turn on TOTP

AI Office recommends it whenever it is not served from `localhost`
(PRD FR-3). In **Admin → Two-step sign-in (TOTP)**:

1. Scan the QR code into an authenticator app.
2. Confirm with a code.
3. Store the ten recovery codes somewhere safe. They are shown only
   once.

Signing in with an Owner password then takes the password and a code.
An API key with UI access still signs in without one: keep such keys as
safe as a password, or make none.

## 9. Back up

Two things are worth keeping:

- **The Postgres volume** (`ai-office_postgres-data`): every setting,
  Floor, Agent, Notice, the Activity Feed and the AI Gateway's history.
- **`.env`**, above all `ENCRYPTION_KEY`. AI Account credentials, the
  TOTP secret and the webhook secret are encrypted with it, so a database
  restored without it has them unreadable.

Repositories need no backup: they live on GitHub.

### A nightly dump

`pg_dump` copies the database while it runs, consistently. Save this as
`~/backup-ai-office.sh` and make it executable (`chmod +x`):

```bash
#!/bin/sh
# A compressed dump of AI Office's database, keeping the last 14.
set -eu
cd ~/ai-office
mkdir -p ~/backups
docker compose exec -T postgres \
  pg_dump --username=ai_office --dbname=ai_office --format=custom \
  > ~/backups/ai-office-$(date +%F).dump
find ~/backups -name 'ai-office-*.dump' -mtime +14 -delete
```

Run it every night at 03:00 with `crontab -e`:

```text
0 3 * * * /home/ubuntu/backup-ai-office.sh
```

- **Off the instance.** A backup on the instance dies with the instance.
  Copy the dumps to an S3 bucket too: give the instance an IAM role that
  can write to it (and nothing else), install the AWS CLI on the
  instance itself, never in a container (the hop limit of 1 from
  [Launch it](#2-launch-it) keeps containers from the role), and add
  `aws s3 cp ~/backups/ai-office-$(date +%F).dump s3://<bucket>/` to the
  script. Turn on the bucket's versioning and a lifecycle rule to expire
  old copies.
- **EBS snapshots.** As well, have **Data Lifecycle Manager** snapshot the
  instance's volume daily (EC2 → Lifecycle Manager → Create lifecycle
  policy, targeting the `Name: ai-office` tag). A snapshot restores the
  whole machine; a dump restores the database alone.

### Restoring a dump

Into an empty database, before the app starts, from the same version of
AI Office: the app checks the database's schema is the one it was built
with (`schema_hash` in `schema_meta`), and refuses to start if not.

```bash
cd ~/ai-office
docker compose --profile tls down
docker volume rm ai-office_postgres-data
docker compose up --detach --wait postgres
docker compose exec -T postgres \
  pg_restore --username=ai_office --dbname=ai_office --exit-on-error \
  < ~/backups/ai-office-2026-10-10.dump
docker compose --profile tls up --detach --wait
```

The `.env` must hold the same `ENCRYPTION_KEY` the dump was made with, or
have it in `RETIRED_ENCRYPTION_KEYS` beside a newer one (see
[Replacing `ENCRYPTION_KEY`](../guide/running.md#replacing-encryption_key)).

### A copy of the volume itself

To copy the volume's files rather than dump the database, stop the stack
first, so Postgres is not writing:

```bash
cd ~/ai-office
docker compose --profile tls stop
docker run --rm -v ai-office_postgres-data:/data:ro -v ~/backups:/backup alpine \
  tar czf /backup/postgres-data-$(date +%F).tar.gz -C /data .
docker compose --profile tls start
```

## 10. Upgrade

1. **Back up first.** AI Office is not in production yet and has no
   database migrations, so going back to an older version means restoring
   the dump taken before the upgrade.

   ```bash
   ~/backup-ai-office.sh
   ```

2. **Update and rebuild.** The app checks the database schema as it
   starts, before it listens. If this version's schema differs from the
   database's, it exits and `docker compose logs app` says so: the
   database has to be recreated (`docker volume rm ai-office_postgres-data`,
   which deletes its data) for the new schema to be applied.

   ```bash
   cd ~/ai-office
   git pull
   docker compose --profile tls pull caddy postgres   # the Caddy and Postgres images this version pins
   docker compose --profile tls up --build --detach --wait
   ```

3. **Rebuild the sandbox images**, if you built them, when their
   Dockerfiles or the agent tools' versions changed (`git log --
   docker/sandbox-*`). The tools' versions are pinned in AI Office, so
   they move with an upgrade, never on a rebuild alone:

   ```bash
   pnpm install --frozen-lockfile
   AGENT_UID=1000 AGENT_GID=1000 pnpm sandbox:build
   ```

4. **Tidy up** old images and build cache: `docker image prune -f` and
   `docker builder prune -f`.

Every image is pinned by digest (`docker-compose.yml` and the
Dockerfiles), so `pull` and `--build` fetch exactly what this version of
AI Office names, never whatever a tag points at today: newer Caddy,
Postgres and Node images arrive with an upgrade of AI Office that moves
the pins. Postgres moves only within Postgres 18. A new major version of
Postgres needs a dump and restore, and is a release of AI Office of its
own.

## Troubleshooting

| Symptom                                                         | Cause                                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser warns about the certificate; `logs caddy` shows ACME errors | Port 80 is not open to everyone, the DNS record does not point at the Elastic IP yet, or `AI_OFFICE_DOMAIN` is wrong. Caddy keeps retrying |
| `ts.net` certificate errors in `logs caddy`                     | HTTPS Certificates are off for the tailnet, or `docker-compose.override.yml` does not mount `/var/run/tailscale`                              |
| `502` from Caddy                                                | The app is not healthy: `docker compose ps` and `docker compose logs app`                                                                    |
| Everyone shares one sign-in rate limit                          | `TRUST_PROXY` is not `1`, or `PROXY_SECRET` is not set, so the app sees every client as Caddy                                                |
| GitHub's **Recent Deliveries** show `429` after forged ones      | `TRUST_PROXY` is not `1`, or `PROXY_SECRET` is not set, so the webhook route counts every sender's failed deliveries as Caddy's, GitHub's among them |
| The app will not start: `TRUST_PROXY and PROXY_SECRET must be set together` | Set both in `.env`, or neither; then `docker compose --profile tls up --detach` again, so Caddy gets `PROXY_SECRET` too |
| The session cookie is not marked `Secure`                       | `PUBLIC_URL` is not the `https://` address you use                                                                                            |
| Out of disk                                                     | Old images and build cache: `docker system df`, then the tidy-up in [Upgrade](#10-upgrade); or grow the volume and the filesystem              |

## See also

- [Running AI Office](../guide/running.md): docker compose, the setup
  screen, signing in and TOTP
- [Setting up the GitHub App and your Floors](setting-up-a-floor.md): the GitHub App, and
  optional webhooks
- [PRD §7](../product-requirements-document/ai-office.md#7-non-functional-requirements):
  deployment and security
