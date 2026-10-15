# Issue #229: [fix] S2-1 — Sandboxes have open egress — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `652959e`,
`fix(security): S2-1 sandboxes reach only the AI Gateway and the hosts the Owner allows, through the sandbox relay`.
Its blocker, the S2 probe (#193), is in the tree:
`docs/pen-testing/assessments/S2.md` and
`docker/sandbox-isolation.pen-test.test.ts`.

This is the remediation of finding **S2-1** (`severity:high`, H2). Its
fix is also what S2-2 (#231) and S2-3 (#233) build on, so the three agree:
one network with no route out, one relay on it, and the app off it.

## What was fixed

A sandbox's network had a route anywhere, so an injected Agent could send
its clone, its read-only `GH_TOKEN` and its Gateway Key to any host, such
as one the red team controls.

- **The sandboxes' network is `internal`** (no route out) in
  `docker-compose.yml`.
- **The sandbox relay** (`docker/sandbox-relay/relay.ts`, new) is the one
  other container on it. It is a Node script with no dependencies, run from
  `node:26.10.0-slim` as the pen-test stub upstream is, as `node`,
  read-only, with every capability dropped and `no-new-privileges`. It is
  on the default network too, so it is the sandboxes' only way out:
  - port **3047** is piped, byte for byte, to the AI Gateway
    (`RELAY_GATEWAY`: `app:3047`), whatever the sandbox sends;
  - port **3128** is an HTTPS proxy that relays `CONNECT` to **port 443**
    of a host **`SANDBOX_EGRESS_HOSTS`** names (a name, or `*.domain`),
    and answers anything else 403: another host, another port, an IP
    address, plain HTTP, a name that does not resolve. Each connection,
    relayed or refused, is a JSON line in its log.
- **The sandbox images** set `HTTPS_PROXY`/`https_proxy` to
  `http://sandbox-relay:3128` and `NO_PROXY`/`no_proxy` to
  `sandbox-relay`, so `npm`, `pnpm`, `pip`, `git` and `gh` use the relay.
  Each image has a new version (`:3`), with its Dockerfile's hash
  recorded, so no server runs sandboxes from a stale `:2` build.
- **`SANDBOX_GATEWAY_URL` is `http://sandbox-relay:3047`** under compose
  and outside it, in `.env.example`, the compose files, the guide
  (`running.md`, `issue-pipeline.md`), the EC2 process and the website.
- **ADR 0005** (`docs/architectural-decision-record/0005-sandboxes-reach-only-the-gateway-and-allowed-hosts.md`)
  records the decision. It narrows ADR 0004's "the Manager's chat reads …
  the web" to the allowed hosts; ADR 0004 itself is unchanged.

### Sibling paths

- **Outside compose, where Agents work today.** Sandboxes joined Docker's
  default bridge, which has a route out, unless `SANDBOX_NETWORK` named
  another. `SANDBOX_NETWORK` now defaults to `ai-office-sandboxes`
  (`apps/server/src/config.ts`), and `docker-compose.dev.yml`, which
  `pnpm dev` already starts (`pnpm db:up`), creates it `internal` with the
  same relay, which reaches the Gateway on the host
  (`host.docker.internal:${GATEWAY_PORT:-3047}`, `host-gateway`).
- **The pen-test stack** (`docker/pen-test/compose.yml`): the same network
  and relay, with `PEN_TEST_SANDBOX_EGRESS_HOSTS` (none by default).
  Stand-up starts the relay with the app; teardown counts it as the
  stack's container, not as a sandbox, though it is on the sandboxes'
  network.
- **Every container AI Office starts for an Agent.** Sandcastle's task and
  fact-finding sandboxes (`dockerSandbox`) and `dockerToolRunner`'s Manager
  chat sessions and subscription model calls are both given
  `config.sandboxes.network` (`apps/server/src/server.ts`), and both use
  the sandbox images, so both are closed.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "a sandbox
      can reach nothing beyond the stack: its network has no route out" is
      an `it`, its body unchanged (`sandboxes.internal` is `true`).
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** Both pins:
      - "regression (S2-1): ai-office-sandboxes is no longer an ordinary
        bridge network with a route out, and sandboxes' egress goes through
        the sandbox relay's allow-list";
      - "regression (S2-1): outside compose, sandboxes no longer join
        Docker's default bridge: they join ai-office-sandboxes, which
        docker-compose.dev.yml makes internal, with the sandbox relay".
- [x] **Sibling paths with the same flaw are fixed and tested.**
      "sibling (S2-1): every compose file that starts sandboxes makes their
      network internal, and puts the sandbox relay on it…" (all three
      compose files); "sibling (S2-1): sandboxes reach the AI Gateway
      through the sandbox relay… in every document that says where";
      `docker/sandbox-relay/relay.test.ts` (the relay, driven on loopback:
      it relays only to an allowed host's port 443 and refuses a host the
      red team controls, connecting to nothing); `sandbox-images.test.ts`
      ("reaches the internet only through the sandbox relay's HTTPS
      proxy…"); `config.test.ts` (the default network);
      `pen-test/stack.test.ts` (stand-up starts the relay; teardown counts
      it as the stack's); `deployment.test.ts` and `pen-test/compose.test.ts`
      (the network is internal, the relay forwards to `app:3047`).
- [x] **The assessment's findings table marks `S2-1` fixed.**
      `docs/pen-testing/assessments/S2.md`: **fixed** (issue #229) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass; `pnpm test` has only the two failures that were there
      before this run, unrelated. The real output is in
      [issue-233.md](issue-233.md#real-output-of-the-checks), run once on
      the finished tree for all three fixes.

Tests changed besides the probe's: `pen-test/compose.test.ts` and
`deployment.test.ts` expected `SANDBOX_GATEWAY_URL=http://app:3047` and
said nothing of the network being internal; they now expect the relay and
`internal: true`. `skills.test.ts` and `agent-tools.test.ts` name the
images' new `:3` tags. `credentials.test.ts` expects the credentials
package's `stack.gatewayUrl` to be `http://sandbox-relay:3047`, where a
sandbox now reaches the Gateway.

## Decisions

Recorded as ADR 0005; the choices within it, for the Owner to review:

1. **A relay container, not host firewall rules or a proxy image.** It is
   the one way to the Gateway and out under compose, in the pen-test stack
   and outside compose alike, and it is tested here. Firewall rules would
   mean AI Office writing the host's `iptables` from a container; Squid or
   tinyproxy would be a second image to pin and a configuration language
   to review.
2. **`SANDBOX_EGRESS_HOSTS` defaults to nothing in code and in compose;
   `.env.example` lists `registry.npmjs.org,api.github.com`.** Most of the
   built-in Floor Templates' setup commands run `npm install`, and the
   sandbox images say the Agent reads its issue with `gh`, so with nothing
   allowed those would stop working. An Owner who copies `.env.example`
   gets those two, visibly, and can empty the line. Each listed host is
   one an injected Agent could still send what it read to if it holds an
   account there (an attacker's npm token or GitHub token); `.env.example`,
   the guide and the ADR say so. `github.com` is not listed: cloning a
   dependency from GitHub needs the Owner to add it.
3. **Only `CONNECT` to port 443 of a listed name.** No plain HTTP, no other
   port, no IP address. A Floor that needs a private registry over HTTP or
   `git` over SSH needs a new decision.
4. **The proxy is named in the images, not in the sandbox's environment.**
   The environment allow-list stays exactly what the S2 probe confirmed
   (its "holds" test is unchanged), and a repository still cannot point a
   sandbox at a proxy of its own. A sandbox started from an old `:2` image
   on the new network has no proxy at all, so it fails closed: it reaches
   the Gateway and nothing else.
5. **`SANDBOX_NETWORK` defaults to `ai-office-sandboxes`, outside compose
   too**, never Docker's default bridge. The dev compose file uses the
   same name as `docker-compose.yml`, so the Owner runs AI Office one way
   or the other on a machine, not both (each has its own relay on the one
   network); the comments and the ADR say so.
6. **The Manager's chat sessions are on the same network**, so their web
   fetches reach only the allowed hosts (web search runs at the AI
   Provider, through the Gateway, and is unaffected). This narrows what
   ADR 0004 describes; ADR 0005 says so, and the guide's Manager chat
   section does too.

## Noticed, out of scope

- **S2-5 is still open:** sandboxes still share the one network, with
  inter-container traffic on, and so does the relay. Its `it.fails` and pin
  are unchanged and still pass as they did.
- **An Owner who names a `SANDBOX_NETWORK` with a route out gets one.**
  Nothing checks at run time that the network is internal (that would take
  a `docker network inspect` before each sandbox); `.env.example` says to
  name only one as closed.
- **DNS from an internal network.** Whether Docker's embedded DNS answers
  (and so forwards) queries for outside names from an internal network,
  which would leave DNS as a slow way out, depends on the Docker version
  and was not checked here.
- **`NODE_USE_ENV_PROXY` is not set** in the images, so a Node program
  using the built-in `fetch` ignores `HTTPS_PROXY` and reaches nothing.
  npm and pnpm use their own proxy settings and are unaffected.
- **`pnpm db:up` now starts the relay too**, as its README row says; the
  script keeps its name.
- `packages/orchestrator/src/sandbox/docker-run.pen-test.test.ts` still
  passes `ai-office/sandbox-claude:2` as an input value to the stand-in
  `docker`; it asserts nothing about the tag, and that probe file is S2-4's,
  so it was left alone.

## What could not be verified here

There is no Docker here. The compose files were checked against the
Compose Specification's schema and read by the tests; the relay was run on
loopback, with its DNS and outbound connections stood in for. Not tried:

- **The issue's statement itself:** from a real sandbox on the pen-test
  stack, an HTTPS request to a host the red team controls should now be
  refused by the relay (403, and a `refused` line in
  `docker compose … logs sandbox-relay`), and a direct connection to it
  should find no route.
- That an `internal` network leaves a container no route to the host's
  other addresses on every Docker version (older Engines left the
  bridge's gateway address on the host); the server's listeners outside
  compose are on loopback by default (A1-2), which does not depend on it.
- `host.docker.internal:host-gateway` reaching the Gateway on Linux with
  `GATEWAY_HOST=172.17.0.1`, and on Docker Desktop with the default.
- `npm install`, `pip install`, `git` and `gh` through the relay from the
  real images.
