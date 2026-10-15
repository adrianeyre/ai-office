# PRD: Pen-testing AI Office

| | |
|---|---|
| **Product** | AI Office |
| **Status** | Round one retested (2026-10-11); all 62 findings fixed (2026-10-12), P2-3 by the Owner's choice in #199; the gates are decided (#199), and the live window is the Owner's (#198) |
| **Label** | `prd:pen-testing` |
| **Date** | 2026-10-11 |
| **Parent PRD** | [`ai-office.md`](./ai-office.md) |
| **Glossary** | [`GLOSSARY.md`](../../GLOSSARY.md) |
| **Decisions** | [`docs/architectural-decision-record/`](../architectural-decision-record/) |

This file is the brief for the first adversarial round against AI Office. The canon for how AI Office is meant to behave remains [`ai-office.md`](./ai-office.md). Nothing here restates a requirement. A tester who needs one reads it there, and a finding cites the FR it contradicts.

---

## Current state of play

AI Office runs several **Agents** on the **Owner's** private repositories. Each Agent works in a Docker sandbox started through the host's Docker socket and calls models through the built-in **AI Gateway**, which holds the Owner's pooled **AI Accounts**. A GitHub App pushes the results as the Owner, and a Floor's Merge Policy may merge them unattended. The whole application sits behind the Owner's sign-in, and the Owner runs it on their own machine or on one EC2 instance.

**Nothing in this tree has ever been probed by anyone who did not write it.** Every review to date has been by the code's authors, or by Agents working to the same brief they were given. A rule that has only ever been tested by the people who wrote it has been reviewed, not tested.

Three structural facts set the tone of the engagement:

1. **AI Office runs untrusted text through Agents that have tools.** Issue text, repository files, review comments, memory, Skills and Floor Templates all reach a model that can execute code. Prompt injection is not a corner of the attack surface. It is the main entrance.
2. **The app container holds the host's Docker socket.** Whatever runs inside the app container runs, in effect, as root on the host. Any path from a sandbox into the app process is a path to the host and to every secret on it.
3. **What an Agent writes is pushed as the Owner and can be merged without the Owner.** ADR 0002 and the Merge Policy make an Agent's commit indistinguishable from the Owner's once it lands.

All three are deliberate, documented product decisions. They are also exactly the shape of the thing that ships wider than intended because nobody wrote down which controls had to hold first. **Writing those controls down is the first job of this round.**

---

## Problem statement

**Before AI Office is reachable from anywhere other than the Owner's own machine, and before the repository is made public for anyone else to run, an adversarial party must probe it against an AI Office-shaped scope document and file findings.** The Owner can then sign the release off against evidence rather than against the care of the people and Agents who built it.

Three consequences of not running this now:

1. **The credentials are the product's whole value.** AI Office holds every AI Account the Owner has, a GitHub App that can write to every installed repository, and the Docker socket. One leak is all of them.
2. **The surface is small and the code is young.** This is the cheapest this engagement will ever be. Every route, sandbox wiring and Gateway path fits in one reading. After public release it doesn't, and other people's Offices carry whatever ships.
3. **Going public is a one-way door.** Once the repository is public, every unfixed finding is published to anyone who reads the code, and every installed copy carries it until its Owner upgrades.

---

## Gates

The round answers two release gates. Neither is passed by this document. Both are passed by the success criteria below.

| Gate | What must be true |
|---|---|
| **Exposure**: AI Office served beyond `localhost`, or beyond a security group or Tailscale restricted to the Owner | Every `severity:critical` finding is remediated. |
| **Public release**: the repository made public | Every finding above `severity:low` is remediated, or waived in writing by the Owner. |

---

## Engagement shape

- **Who: an AI red team.** Agents on a dedicated red-team Floor, working to the `security-audit` Skill, probe the Office and file findings. This is honest grey-box testing, but it isn't independent: the probing Agents share the models and much of the brief of the Agents that built the code. The PRD records it as **reviewed by a different brief, not independently tested**. A human external round is a candidate pre-condition for the public-release gate, and the Owner decides that before the gate.
- **Type: grey-box.** Testers get read-only source, one Owner password for the pen-test stack, one UI-capable API key, one Gateway Key, seeded Floors and fixture IDs. They do **not** get the stack's `ENCRYPTION_KEY`, `SESSION_SECRET`, the database password, the GitHub App private key, CI credentials, or write access to this repository. White-box testing wastes their time on what we can read ourselves. Black-box testing wastes it discovering topology we would have told them.
- **Target: a dedicated pen-test stack.** It is its own `docker compose` stack with its own Postgres, `ENCRYPTION_KEY`, `SESSION_SECRET`, GitHub App and installation, and throwaway target repository. It is reachable only by the red team. It is never the Owner's real Office, and never a shared host. Teardown destroys the database volume and the sandbox work directory, not just the containers.
- **Data: synthetic.** There are no real AI Account credentials. The stack's AI Accounts point at a stub upstream that answers like a provider and logs what it receives, so a leaked credential is detectable and worthless. The target repository and its issues are generated by a seed script that ships with the stack stand-up.
- **Rules of engagement** are codified before the window opens. They cover a window; no destructive testing against anything but the pen-test stack; an out-of-band channel to the Owner for a critical; and handling rules for anything that looks like a real credential.

### Attacker positions

Every probe issue names the positions it uses.

| # | Position | What the attacker has |
|---|---|---|
| 1 | **Network, unauthenticated** | Reach to Caddy, or to the app port when it is bound beyond loopback. Nothing else. |
| 2 | **Hostile content** | Control of text an Agent will read: issue bodies, repository files (`CLAUDE.md`, `.claude/settings.json`, scripts, `package.json`), review comments, an imported Skill or Floor Template, a memory proposal. |
| 3 | **Code in a sandbox (assume breach)** | Arbitrary code running inside one of the target stack's sandboxes, as if position 2 had already succeeded. |
| 4 | **Stolen credential** | One of: a session cookie, a UI-capable API key, a Gateway Key. |
| 5 | **Spoofed GitHub** | The ability to send, or replay, deliveries to the webhook route. |

**A malicious Owner is out of scope.** The Owner is the human of last resort, and AI Office makes no attempt to protect the Owner from themselves.

### How the red team is wired

The Agents that probe never run inside the stack under test, because then attacker and target are the same thing.

- **Positions 1, 4 and 5:** a red-team Floor in the Owner's own Office, pointed at this repository for read-only source, probes the pen-test stack over the network.
- **Position 2:** inside the pen-test stack, a target Floor on the throwaway repository is seeded with hostile issues and hostile repository files. Its own Agents are the victims.
- **Position 3:** a harness runs a chosen script inside one of the pen-test stack's own sandboxes, on the same network, mounts and environment an Agent gets.

### Explicitly out of scope

- **Denial of service and volumetric testing.** It is not a pen-test activity. The *absence* of a rate limit is in scope as a finding; exercising it is not.
- **The AI Providers, GitHub, and Sandcastle's upstream code as services or products.** How AI Office *uses* them is emphatically in scope: the flags it passes, the mounts it makes and the tokens it mints.
- **Third-party notification services** (Slack, email, ntfy, Pushover, Notion, Confluence, Google) as services. What AI Office sends them, and how it holds their credentials, is in scope.
- **The 3D scene and asset pipeline**, except where text an attacker controls is rendered.
- **Social engineering, phishing and physical access.** Not commissioned.
- **A malicious Owner.** See above.
- **Migration safety and prior data.** There is no production data that is not the Owner's own.

---

## The tester's opening register

What follows is the reconnaissance a tester would do on day one, done in advance so the engagement starts from hypotheses rather than a directory listing. **Each entry is a hypothesis, not a confirmed finding.** It says what the code reads like from outside and names the file that has to be disproved. Where a behaviour is deliberate and documented, that is said plainly. A documented decision is still a finding when nothing records which control makes it safe.

Severities are the tester's **opening** estimate, for triage ordering only.

### H1 — An Agent can plant code that AI Office runs on the host side · **critical**

Sandcastle bind-mounts the host clone's `.git` into the sandbox read-write. On a Fresh Start, `saveUncommitted` (`packages/orchestrator/src/sandbox/runner.ts:382`) runs `git status`, `git add --all` and `git commit --no-verify` in that worktree **in the app container**. `runGit` (`packages/orchestrator/src/git/command.ts:22`) neutralises system and global config only, not the repository's own `.git/config`.

So an Agent that writes `core.fsmonitor`, `core.hooksPath` or a `post-commit` hook into the repository's config gets that command run by the app process. `--no-verify` skips `pre-commit` and `commit-msg`, not `post-commit`, and nothing skips `core.fsmonitor`. The app container holds the Docker socket (`docker-compose.yml`), so this is root on the host, the GitHub App private key and every AI Account.

`publish.ts` disables hooks, but in a separate bare repository. Sandcastle's own host-side git calls are unchecked. **Probe: from position 3, plant `core.fsmonitor` in the worktree's config, trigger a Fresh Start, and see whether the app container runs it.**

This is filed and worked **ahead of the window** (see [Sequence](#sequence)). The Owner's real Office runs Agents on real repositories today.

**Retest (2026-10-11):** confirmed by S1. S1-1 and S1-2 (critical) fixed by `dd458e7` and `fbd4c71` on 2026-10-11.

### H2 — Sandboxes have open egress and no metadata block · **high**

The `ai-office-sandboxes` network (`docker-compose.yml:137`) is not `internal: true`. No egress filter or instance-metadata block exists anywhere in the tree. An injected Agent can send the repository, its `GH_TOKEN` and its Gateway Key anywhere.

On EC2, `docs/processes/deploying-to-ec2.md` recommends an IAM role for backups and IMDSv2 "required", but doesn't set the hop limit. With a hop limit of 2 or more, a container can read the instance role's credentials. **Probe: from position 3, reach an arbitrary host and `169.254.169.254`.**

**Retest (2026-10-11):** confirmed by S2. S2-1 and S2-2 (high) fixed by `652959e` and `6f94dfa` on 2026-10-11 (ADR 0008).

### H3 — Sandboxes can reach the app itself, and spoof the client address · **high**

The compose file's comment says sandboxes reach "the AI Gateway as app:3047 and nothing else of the stack". But the app joins the sandboxes network and listens on `0.0.0.0` for 3045 (the web app and API) and 1455 (the OAuth callback) as well. So a sandbox can reach the login routes directly.

With `TRUST_PROXY=1`, which the deployment docs prescribe, `trustHops` (`apps/server/src/app.ts:382`) trusts any first hop. A direct caller can therefore set `X-Forwarded-For` to anything and get a fresh login-limiter bucket on every attempt. The CIDR suggested in `.env.example` (`172.16.0.0/12`) also covers the sandbox subnet. **Probe: from position 3, brute-force `/api/login` with a rotating `X-Forwarded-For`.**

**Retest (2026-10-11):** confirmed by A1 and S2. A1-1 (high, the client address) fixed by `dd17f91`, and on `/v1` by `175484e`; S2-3 (high, the reach) fixed by `32a6d2e`; all on 2026-10-11.

### H4 — Whoever reaches the setup screen first becomes the Owner · **high**

Until a password exists, `POST /api/setup` (`apps/server/src/auth/routes.ts:131`) is open to anyone. The EC2 process document says so. The window between `docker compose up` and the Owner's first visit is the whole of the authorisation check. **Probe: from position 1, is there any deployment path in which the app is reachable before setup?** Does anything bind setup to the host, or to a one-time token printed in the logs?

**Retest (2026-10-11):** confirmed by A1. A1-2 (high) fixed by `8b6bf5f` on 2026-10-11.

### H5 — A session can mint a permanent way back in · **medium**

`POST /api/owner-passwords` (`apps/server/src/auth/password-routes.ts:75`) adds an Owner password without re-authentication and without TOTP. So a stolen session, or a UI-capable API-key session (which never asks for TOTP, `auth/routes.ts:209`), becomes a persistent credential that outlives the session.

The same route answers `409 password_in_use` when the candidate matches an existing Owner password, and it isn't rate-limited. That makes it an oracle for guessing the Owner's password. **Probe: from position 4, add a password, then sign everything out and sign back in with it; time a dictionary against the 409.**

**Retest (2026-10-11):** confirmed and widened by A1. A1-3 (high) and A1-4 (medium) fixed by `b482e7f` and `68b5dac` on 2026-10-11.

### H6 — No security headers · **medium**

Neither the server nor `docker/caddy/Caddyfile` sets a CSP, HSTS, `X-Frame-Options` / `frame-ancestors`, `X-Content-Type-Options` or `Referrer-Policy`. The OAuth callback page is the only exception. `SameSite=Strict` session cookies blunt clickjacking and CSRF but don't replace these headers.

**Retest (2026-10-11):** confirmed by A1 and I2. A1-6 (medium) fixed by `a3b5009`, on `/v1` by `175484e` (I2-1, low) and on the sign-in callback by `25917ac`, on 2026-10-11.

### H7 — Sign-in state forgets on restart; sessions never idle out · **medium**

The login limiter and the sign-in challenge state are in memory (`apps/server/src/auth/login-limiter.ts:17`). A restart, which an attacker in position 3 may be able to cause, resets every lockout. Sessions last a fixed seven days with no idle timeout (`apps/server/src/auth/sessions.ts`).

**Retest (2026-10-11):** confirmed by A1. A1-7 and A1-8 (low) fixed by `0d9e194` and `3eb8303` on 2026-10-11.

### H8 — Agent code runs in the target repository's CI and can merge itself · **medium**

Same-repository pushes run the target repository's CI with that repository's secrets. The Merge Policy can merge without the Owner (`packages/orchestrator/src/merge/merge.ts:37`). The GitHub App's Workflows permission is off by default (`docs/processes/setting-up-a-floor.md`), so an Agent cannot edit `.github/workflows/`. But nothing stops it changing `package.json` scripts, test files or any other file CI executes. **Probe: from position 2, can a hostile issue produce a pull request that exfiltrates a CI secret and is merged by policy?**

**Retest (2026-10-11):** confirmed by P1, narrower than the register. P1-1 (high), P1-2 and P1-11 (medium) fixed by `e64ecc6`, `b8d085b` and `cf8547c` on 2026-10-11.

### H9 — Memory can be poisoned across tasks · **medium**

Agents propose repository and Role memory at Handoff (`packages/orchestrator/src/memory/`). Later prompts quote it (`coder/prompt.ts:22`), and issue text is fenced as untrusted, but memory is not. One hostile issue can therefore steer every later Agent on the Floor. **Probe: from position 2, plant an instruction in memory and observe a later, unrelated issue.**

**Retest (2026-10-11):** confirmed by P1. P1-4 and P1-3 (medium) fixed by `e3ea51a` (ADR 0005) and `31c1963` on 2026-10-11.

### H10 — Prompt injection through the repository, reviews, Skills and Templates · **medium**

Intake accepts only issues the Owner opened or labelled (`packages/orchestrator/src/intake/intake.ts:27`), and issue text is quoted as untrusted (`coder/prompt.ts:14`). Several paths are unguarded:
- Repository content: `CLAUDE.md`, `.claude/settings.json`, scripts.
- Reviewer comments and Handoff notes.
- Skills, and Floor Templates imported from Git, whose `setupCommand` runs (`packages/shared/src/floor-templates.ts:150`).

Agent tools run with their own permission prompts switched off, as Sandcastle invokes them. The Decision Model's tool-call screen is optional and is itself a model. **Probe: from position 2, each path, against each Stage's Role.**

**Retest (2026-10-11):** confirmed by P1. P1-3 and P1-6 to P1-11 (medium) fixed by `31c1963`, `99efa45`, `b7431c6`, `ad794ac`, `f6c66da`, `6d881c9` and `cf8547c` on 2026-10-11.

### H11 — Gateway attribution headers are the caller's word · **low**

`x-ai-office-issue`, `x-ai-office-pull-request` and `x-ai-office-session` are set by the caller and trusted (`packages/gateway/src/gateway.ts:555`). An Agent can bill its usage to another issue, slip a Token Cap set per issue, or pin an AI Account session. **Probe: from position 3 with the Agent's Gateway Key, which caps can be evaded?**

**Retest (2026-10-11):** confirmed by G1, and worse than its opening low. G1-1 (high) fixed by `cf7a30b` on 2026-10-11.

### H12 — Webhook deliveries can be replayed · **low**

HMAC-SHA256 verification over the raw body is correct and compares in constant time (`packages/github/src/webhooks.ts:28`). It covers no delivery ID, and the receiver deduplicates nothing (`packages/orchestrator/src/webhooks/webhooks.ts`). **Probe: from position 5, find the state in which a replayed delivery is not a no-op.**

**Retest (2026-10-11):** confirmed by W1, and no worse than the register said. W1-1 (low) fixed by `8eeea47` on 2026-10-11.

### H13 — Owner-triggered fetches can reach internal addresses · **low**

Skill and Floor Template import accept any https host (`packages/orchestrator/src/skills/git.ts:182`). The webhook Connection posts to any URL (`packages/communications/src/transports/webhook.ts:106`). Custom AI endpoints and the outbound proxy allow plain http (`packages/shared/src/connections.ts`).

Only the Owner can set these, so the attacker needs position 4 or a hostile Template. **Probe: can any of them reach Postgres, the metadata service or `app:3047` and return what it read?**

**Retest (2026-10-11):** confirmed by I1. I1-1 (medium), I1-2 and I1-3 (low) fixed by `aa429d9`, `e5a0122` and `c1e46aa` on 2026-10-11 (ADR 0007).

### H14 — The OAuth callback listener is reachable from sandboxes · **low**

While a ChatGPT sign-in waits, a listener on 1455 accepts callbacks on `0.0.0.0` (`apps/server/src/ai-accounts/oauth-callback.ts:100`). PKCE should defeat a code swap. **Probe: from position 3, can a sandbox cancel, fail or race the Owner's sign-in?**

**Retest (2026-10-11):** not confirmed for the listener: S2 found a sandbox cannot cancel, fail or race the Owner's sign-in. Its reach was part of S2-3 (high), fixed by `32a6d2e` on 2026-10-11.

### H15 — Images aren't pinned by digest; the Claude sandbox installs by `curl | bash` · **low**

`node:26.10.0-slim`, `postgres:18-alpine` and `caddy:2-alpine` are pinned by tag, not digest. `docker/sandbox-claude/Dockerfile` installs `CLAUDE_CODE_VERSION=stable` through `curl | bash`. A re-pointed tag or a compromised installer runs inside every sandbox.

**Retest (2026-10-11):** confirmed by I1. I1-4 and I1-5 (low) fixed by `41f2fd7` and `f973b4f` on 2026-10-11.

### H16 — Weak secrets boot with a warning; key secrets sit in plaintext · **low**

If the development secrets from `.env.example` are left in place, the server only warns (`apps/server/src/config.ts:291`). It should refuse to start. `GITHUB_APP_PRIVATE_KEY`, `SESSION_SECRET` and `ENCRYPTION_KEY` are plaintext in `.env` and in the app container's environment. So anything that reads the app's environment, such as H1, gets write access to every installed repository and the key to everything sealed. Encryption keys are versioned, but rotation isn't built.

**Retest (2026-10-11):** confirmed by G1. G1-8 and G1-9 (low) fixed by `238fb5d` and `7882474` on 2026-10-11.

### H17 — The documents understate the ways in · **low**

`ai-office.md` FR-1 and FR-2 describe a single password. The code supports further Owner passwords and API-key sign-in. `.env.example` says the Gateway "has no authentication of its own yet", but the code requires Gateway Keys. The compose file says sandboxes reach nothing but the Gateway (H3). A tester, or an Owner hardening a deployment, who reads the documents gets the wrong surface.

**Retest (2026-10-11):** confirmed by I1. I1-8, I1-9 and I1-10 (low) fixed by `3dcb32d`, `af6fac8` and `1413188` on 2026-10-11.

### H18 — An injected Manager can start work without the Owner · **high**

Since ADR 0004, the Manager's chat is a continuing agent session (Claude Code or Codex) with read-only tools over a read-only clone, plus web search and web fetch. From a chat request it files issues, writes one-off Contractor Roles, adds Contractors and starts a Batch **without Plan approval** (`packages/orchestrator/src/manager/requests.ts`). Every one of those reads text an attacker can control: repository files, fetched pages, attachments.

So the chat is a new route from position 2 to work that runs and, by Merge Policy, lands. "Read-only" is enforced by tool flags (`packages/orchestrator/src/models/agent-tool-session.ts`), and `Bash` is allowed for `git log`, `git show` and `git diff`, whose options can write files and run programs. Attachments are uploaded and served back (`apps/server/src/manager-chat/routes.ts`), and `@` mentions read repository paths (`manager/repository-files.ts`). **Probe: from position 2, steer the Manager into filing and starting work; from the allowed tools, write or run anything.**

**Retest (2026-10-11):** confirmed by P2. P2-1 (high), P2-2 (medium) and P2-4 (high) fixed by `b2e269a`, `a0dcede`, and `1fd2edd` with `705f392`, on 2026-10-11. P2-3 (high) is narrowed by `f6f0794`, its check a model's judgement, and fixed by `f4c6b8e6` (2026-10-12), the Owner's choice in #199: a deterministic fence on what a chat Batch may touch, and its merges the Owner's (ADR 0009).

### H19 — The Gateway is published on the host's loopback · **low**

`docker-compose.yml` now publishes the Gateway on `127.0.0.1:3047` for the Owner's own tools. Every request still needs a Gateway Key. But every local process and user on the host can now reach it, and so can a browser page through DNS rebinding unless the `Host` header and CORS are checked. **Probe: which routes answer without a key, and what a rebinding page can do.**

**Retest (2026-10-11):** not confirmed (G1): on the host's loopback nothing but `/health` answered without a Gateway Key. Since the one entry point the Gateway's port is no longer published, and `/v1` on the app's port is H21's.

### H20 — CI now holds write tokens · **low**

`.github/workflows/release.yml` runs semantic-release with `contents`, `issues` and `pull-requests: write` after `pnpm install`, so dependency code runs in a job that holds a write token. `.github/workflows/pages.yml` holds `pages` and `id-token: write`. The CI line under "Confirm, don't re-test" no longer holds for every workflow. The version check (`apps/server/src/version/routes.ts`) asks GitHub and shows the answer in the web app. **Probe: what a compromised dependency or a spoofed version answer can reach.**

**Retest (2026-10-11):** confirmed by I1 for the write tokens. I1-6 and I1-7 (low) fixed by `cf7d473` and `5e0b3f3` on 2026-10-11. The version check's answer was I1-11 (low, new), fixed by `8558a06` on 2026-10-11.

### H21 — The Gateway shares the app's front door · **medium**

Since main's "one entry point" change, the AI Gateway's `/v1` paths are served on the app's own port and through Caddy (`apps/server/src/gateway-entry.ts`), and go "never through the app's hooks". Whatever exposes the app now exposes the Gateway, and app-wide controls such as security headers, the limiter and redaction may not reach `/v1`. Path handling at the split point decides which side answers.

Separately, under compose a root `sandbox-dir` container runs `mkdir -p` and `chown` on a host directory, `/tmp/ai-office-sandboxes` by default. **Probe: confuse the split, and pre-create or symlink the sandbox directory as another local user.**

**Retest (2026-10-11):** confirmed by I2 on both halves; the split itself holds. I2-1 (low) fixed by `175484e`, its sibling by `25917ac`, and I2-2 to I2-5 (low) by `747cf60`, `c1d7635`, `8fef8bd` and `e3bb3ec`, on 2026-10-11.

### Findings beyond the register

Findings that confirmed no hypothesis above (the [triage runbook](../pen-testing/triage-runbook.md#retest)).

| Finding | Remediation | Severity | What it was | Fixed by, on 2026-10-11 |
|---|---|---|---|---|
| A1-5 | #219 | medium | Changes to how the Owner signs in never reached the Activity Feed | `addc27e` |
| A1-9 | #223 | medium | The first Owner password could be neither changed nor removed | `6122d84` |
| S2-4 | #235 | medium | Sandboxes started with Docker's defaults only | `49c3fe9` |
| S2-5 | #237 | medium | Every Floor's sandboxes shared one network, inter-container traffic on | `31f3e93` (ADR 0006) |
| P1-5 | #255 | medium | The Owner's label approved an issue's text its author could still edit | `db79155` |
| G1-2 | #271 | medium | Calls made at once all passed a Token Cap | `8fbb345` |
| G1-3 | #273 | medium | Owner tools and the Terminal had no Token Cap | `5ca0ed8` |
| G1-4 | #275 | medium | An Agent's Gateway Key outlived its Agent's work | `47eb66f` |
| G1-5 | #277 | medium | A subscription served whoever sent its agent tool's User-Agent | `f184e6a` |
| G1-6 | #279 | medium | The AI Provider's error text reached the Gateway Key holder unredacted | `df8eec2` |
| G1-7 | #281 | low | The Gateway followed an AI Provider's redirect to another origin | `f751f71` |
| W1-2 | #291 | low | The App's own installation tokens asked for no narrower permissions | `f650316` |
| W1-3 | #293 | medium | One read-only token served every sandbox of a Floor, never revoked | `0b37fbf` |
| W1-4 | #295 | low | Nothing limited the deliveries one caller sent to the webhook route | `32a44e5` |
| W1-5 | #297 | low | An Agent's commit trailers reached commits authored as the Owner | `4f04ed5` |
| W1-6 | #299 | medium | Approve and merge merged whatever the branch held when clicked | `a579b6a` |
| I1-11 | #321 | low | The version check accepted and showed any answer | `8558a06` |

### Confirm, don't re-test

The following read as sound. The round confirms each still holds at the pinned commit and moves on.
- **CI:** actions are pinned by commit SHA; `persist-credentials: false`; no `pull_request_target` or `workflow_run`. `ci.yml` is `permissions: contents: read`. The release and Pages workflows are not (H20).
- **Webhooks:** the HMAC comparison is constant-time.
- **Encryption at rest:** AES-256-GCM, with additional authenticated data binding each value to its field.
- **Clone tokens:** passed through the environment, never written to `.git/config`.
- **Static serving:** uses `wildcard: false`, and nothing serves files from a path the user supplies.
- **Web rendering:** no `dangerouslySetInnerHTML`. Markdown goes through `react-markdown`, and `index.html` values are escaped.
- **Sandbox environment:** an allow-list. It refuses values that look like AI Account credentials, and the sandbox's `GH_TOKEN` is read-only.

**Retest (2026-10-11):** the probes re-confirmed the webhook, encryption at rest and clone-token lines, and the CI and sandbox-environment lines apart from what follows; static serving and web rendering drew no finding. Two no longer held as written:
- **CI:** the release and Pages workflows gave write tokens to jobs that run dependency code or never deploy (I1-6, I1-7). Fixed by `cf7d473` and `5e0b3f3` on 2026-10-11: no release job that runs dependency code holds a write token, and only the Pages deploy job holds `pages` and `id-token: write`.
- **Sandbox environment:** the read-only `GH_TOKEN` was one token for every sandbox of a Floor, never revoked (W1-3). Fixed by `0b37fbf` on 2026-10-11: each sandbox's token is its own, and is revoked as the sandbox stops.

---

## Scope partition

Child issues under `prd:pen-testing` partition the surface along AI Office's own boundaries. Each names:
- its trust boundary;
- the attacker positions it uses;
- the hypotheses it answers;
- the glossary terms, FRs and ADRs that govern it;
- the code entry points;
- what is out of scope for it, with the sibling issue that owns each excluded item.

- **Enablement (E1–E5):**
  - E1, the pen-test stack and its teardown.
  - E2, the seed fixtures. These are broad enough for an authorisation bug to show: at least two Floors, Agents in every Stage, a Floor whose Merge Policy merges unattended, and a hostile-content corpus for position 2.
  - E3, the rules of engagement.
  - E4, the credentials package and how it is delivered. This is never a command-line flag, an issue or an email.
  - E5, the findings workflow: labels, a finding issue template and the triage runbook.
- **Sign-in and sessions (A):** setup (H4), passwords, API-key sign-in and TOTP (H5), the limiter and the client address (H3, H7), sessions and CSRF, security headers (H6). It also proves the negative: every route that declares no access really is public by intent.
- **Sandbox and host isolation (S):** host-side git in Agent-written worktrees (H1), egress and metadata (H2), reach into the stack (H3, H14), the Docker run flags (capabilities, `no-new-privileges`, memory and PID limits, read-only root), and what is mounted.
- **Prompt injection and Agent integrity (P):** each content path to each Role (H10), memory (H9), CI and the Merge Policy (H8), the Decision Model screen, and the Review Loop as a control. P2 is the Manager's chat session, Contractors and chat Batches (H18).
- **AI Gateway and credentials (G):** Gateway Keys and their scope, the Gateway on the host's loopback (H19), attribution and Token Caps (H11), AI Account credentials at rest and in transit, redaction across logs, events, Notices and Connections, key handling and rotation (H16).
- **GitHub App and webhooks (W):** signature and replay (H12), installation token scope, the boundary between the App's write access and what an Agent can reach.
- **Infrastructure and delivery (I):** the EC2 and Caddy deployment as documented, fetches the Owner triggers (H13), images and the supply chain (H15), the release and Pages workflows and the version check (H20), the one entry point and the sandbox directory (H21), dependency advisories, and the documentation drift in H17.

---

## Sequence

1. **This PRD**, then the `prd:pen-testing` and `severity:*` labels.
2. **H1 ahead of the window.** It is filed as an S-series probe and worked first, because it is live in the Owner's real Office today. A confirmed finding runs on the critical clock from triage.
3. **Enablement.** E1 comes before E2. E2 comes before E4. E3 and E5 must be done before the window opens.
4. **Probes.** The A, S, P, G, W and I series run in parallel against one pinned commit.
5. **Findings** are filed one issue each.
6. **Remediation** is filed separately, one fix per finding. Decisions that a fix depends on are taken first, in an issue or an ADR.
7. **Retest.** Each fix turns its probe's pinned test; the register here is updated with what was fixed, by which commit and when.

---

## Findings workflow

**A probe never remediates.** A probe issue produces two things:
- an assessment, with a verdict on every bullet, including what could not be exercised and why;
- committed probe tests, named `*.pen-test.test.ts` or `*.pen-test.integration.test.ts`.

Each property that should hold but doesn't is an `it.fails` asserting the property, beside a passing test that pins what happens today. The fix is a separate issue. It turns the `it.fails` into an `it` and the pin into a regression test. Neither test is ever deleted.

Every finding is its own GitHub issue, titled `[finding] <ID> — <one-line statement>`. It carries `prd:pen-testing`, one of `severity:critical | severity:high | severity:medium | severity:low`, and links to the probe issue it was found under. Its body states:
- the commit it was found at;
- the attacker position it needs;
- how to reproduce it, as the probe test that shows it;
- which hypothesis it confirms, or that it is new.

Finding IDs are `<probe ID>-<n>`, such as `S1-1`.

Severity is claimed in the assessment and carried over without re-judging. It is re-assessed when a premise changes. For example, a finding rated against a loopback-only deployment is re-rated before the exposure gate.

Remediation targets, in **calendar days** after triage confirms the finding:

| Severity | Target | What it means here |
|---|---|---|
| critical | 2 | The Owner's session, an AI Account, the GitHub App's write access, or the host can be taken or used without the Owner's authority. |
| high | 10 | A control holds in one layer only, or a sandbox, Gateway Key or Token Cap boundary can be crossed. |
| medium | 30 | A control is weaker than the documentation claims, or a boundary is undefended in depth. |
| low | best effort | Hygiene, disclosure, or a documented decision with no recorded control. |

**Accepting a finding is a legitimate outcome; leaving it undecided is not.** A finding that won't be fixed needs a written rationale from the Owner in the issue **before** `wontfix` goes on it.

---

## Success criteria

1. Every scope issue is filed, labelled and anchored before the window opens. The testers work against an AI Office-shaped document, not a copy of a generic checklist.
2. H1 has a dated answer before the window opens: either the Agent-written worktree can no longer reach the app process, or a recorded decision names the control that stops it.
3. The pen-test stack is stood up, seeded and reachable only by the red team, and torn down afterwards with its volumes.
4. Every reported finding is filed as a labelled issue within one day of the assessment that found it.
5. **The exposure gate:** every `severity:critical` finding is remediated before AI Office is served beyond `localhost`, or beyond access restricted to the Owner.
6. **The public-release gate:**
   - Every finding above `severity:low` is remediated, or waived in writing, before the repository is made public.
   - The Owner has decided, in writing, whether a human external round is also required before release.
7. The documents describe the surface the code actually has (H17). FR-1 and FR-2, `.env.example` and the compose file's comments agree with the code.
