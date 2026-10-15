# Issue #237: [fix] S2-5 — Every Floor's sandboxes share one bridge network with inter-container traffic on — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `31f3e93`,
`fix(security): S2-5 each sandbox has a network of its own, which the sandbox relay joins, so no sandbox reaches another`,
on top of `49c3fe9` (S2-4's fix, #235), whose `docker.ts` it extends. Its
blocker, the S2 probe (#193), is in the tree:
`docs/pen-testing/assessments/S2.md` and
`docker/sandbox-isolation.pen-test.test.ts`. ADR 0005 and the sandbox
relay (S2-1, #229), which this builds on, are in the tree too.

This is the remediation of finding **S2-5** (`severity:medium`, new).

## What was fixed

Every sandbox, of every Floor, joined the one `ai-office-sandboxes`
network, and inter-container traffic was on. So a listener started in one
sandbox, such as a Floor's dev server or test database, was reachable
from any other. Turning inter-container traffic off on that network would
also have cut the sandboxes off from the sandbox relay, and so from the
AI Gateway.

- **Each container AI Office starts for an Agent has a network of its
  own** ([ADR 0006](../architectural-decision-record/0006-each-sandbox-has-a-network-of-its-own.md),
  new). That covers a task's sandbox, a Grilling Session's fact-finding, a
  Manager chat session and a subscription's model call.
  `sandboxNetwork` (`packages/orchestrator/src/sandbox/docker.ts`):
  - creates `ai-office-sandbox-<uuid>`, `--internal`, labelled
    `ai-office.sandbox-network=<SANDBOX_NETWORK>`;
  - joins the sandbox relay to it with `--alias sandbox-relay`;
  - removes it after the container, the relay disconnected first.
  Only the sandbox and the relay are ever on it. The images'
  `HTTPS_PROXY` and `SANDBOX_GATEWAY_URL` (`http://sandbox-relay:3047`)
  are unchanged.
- **`SANDBOX_NETWORK` names the network the relay is on** (default
  `ai-office-sandboxes`, unchanged). AI Office finds the relay there by its
  compose service label (`com.docker.compose.service=sandbox-relay`). No
  sandbox joins that network any more.
- **Inter-container traffic is off on it**
  (`com.docker.network.bridge.enable_icc: "false"`) in
  `docker-compose.yml`, `docker-compose.dev.yml` and
  `docker/pen-test/compose.yml`. Only the relay is on it, so a container
  started there by other means, such as an older AI Office, reaches
  nothing.
- **Failing closed:** a sandbox is not started while the relay is not
  running, and says so. If the relay cannot join the new network, the
  network is removed and nothing starts.
- **No leaks:**
  - before its first sandbox, an AI Office process removes the labelled
    networks one before it left;
  - a tool run is named (`ai-office-tool-<uuid>`) and force-removed before
    its network, so an aborted Manager chat turn does not hold its network;
  - on exit, running sandboxes and their networks are removed.

### Sibling paths

- **Both `docker run`s**, `dockerSandbox` (through `dockerProvider`) and
  `dockerToolRunner`, take the same `sandboxNetwork`. The fact-finding
  sandbox (`apps/server/src/server.ts`) is `dockerSandbox` too.
- **The pen-test stack's teardown** found sandboxes by
  `--filter network=ai-office-pen-test-sandboxes`, where they no longer
  are. It now also lists the networks labelled for it, removes the
  sandboxes on any of them, and removes those networks after `down` has
  taken the relay off them (`docker/pen-test/stack.ts`,
  `docs/pen-testing/stack.md`).
- **The documents that said sandboxes join `SANDBOX_NETWORK`** now say
  each has its own: `.env.example`, `apps/server/src/config.ts`, the three
  compose files' comments, and the guide's `issue-pipeline.md`,
  `running.md`, `ai-gateway.md` and `events-and-chat.md`.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "a sandbox
      cannot reach another sandbox, of its own Floor or another's" is an
      `it`. Its assertion is kept (`sandboxesSeeEachOther()` is false, now
      because inter-container traffic is off on `ai-office-sandboxes`). It
      also drives the real `dockerSandbox` and `dockerToolRunner`, as
      compose's configuration has them, against a stand-in `docker`: two
      sandboxes of one Floor and one of another, all open at once, and a
      Manager chat session. Each is on one network, no two share one, none
      is on `ai-office-sandboxes`, and each network was made `--internal`
      with only the relay joined to it besides, as `sandbox-relay`.
      See Decisions, 3.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (S2-5):
      sandboxes no longer all join the one ai-office-sandboxes network with
      inter-container traffic on: only the sandbox relay is on it, with
      inter-container traffic off, in every compose file, and each sandbox
      has a network of its own".
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `docker-run.pen-test.test.ts`, "S2-5: a network of its own", for
        both `docker run`s:
        - "joins a network made for it alone, internal, which the sandbox
          relay joins as sandbox-relay and nothing else does";
        - "never shares it with another sandbox, of its own Floor or
          another's";
        - "removes its network once it has ended, after the container and
          its volumes";
        - "is never started when the sandbox relay is not running, and
          makes no network".
      - "S2-5: networks an AI Office before left behind" ("are removed
        before the first sandbox makes its own").
      - `docker.test.ts`: "removes the network it made when the sandbox
        relay cannot join it, and starts nothing".
      - `stack.test.ts`: "sibling (S2-5): removes the sandboxes on networks
        of their own, and those networks once down has taken the relay off
        them".
      With `sandboxNetwork` returning the shared network and the compose
      files as they were, 14 tests of the two probe files failed: the `it`,
      the regression test, S2-1's regression test, the four tests above
      for each run, the "what holds" network test for each run, and the
      leftover networks test. Restored, all pass.
- [x] **The assessment's findings table marks `S2-5` fixed.**
      `docs/pen-testing/assessments/S2.md`: **fixed** (issue #237) with the
      commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on ten tests in `@ai-office/web`,
      which this run did not touch: the two pre-existing changelog failures
      and eight timeouts under load. The real output is in
      [issue-235.md](issue-235.md#real-output-of-the-checks), run once on
      the finished tree for both fixes.

### The probe tests, verbose (S2-5)

```
✓ stack.test.ts > teardown > sibling (S2-5): removes the sandboxes on networks of their own, and those networks once down has taken the relay off them
✓ src/sandbox/docker.test.ts > AI Office's Docker sandbox provider > removes the network it made when the sandbox relay cannot join it, and starts nothing
✓ sandbox-isolation.pen-test.test.ts > S2-1: egress from a sandbox (H2) > regression (S2-1): outside compose, sandboxes no longer join Docker's default bridge: they join internal networks beside ai-office-sandboxes, which docker-compose.dev.yml makes internal, with the sandbox relay
✓ sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > on the sandboxes' network the app answers only as the AI Gateway
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > what holds > joins a sandboxes' network of its own, not the host's
✓ sandbox-isolation.pen-test.test.ts > S2-5: one sandbox reaching another > a sandbox cannot reach another sandbox, of its own Floor or another's
✓ sandbox-isolation.pen-test.test.ts > S2-5: one sandbox reaching another > regression (S2-5): sandboxes no longer all join the one ai-office-sandboxes network with inter-container traffic on: only the sandbox relay is on it, with inter-container traffic off, in every compose file, and each sandbox has a network of its own
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-5: a network of its own > joins a network made for it alone, internal, which the sandbox relay joins as sandbox-relay and nothing else does
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-5: a network of its own > never shares it with another sandbox, of its own Floor or another's
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-5: a network of its own > removes its network once it has ended, after the container and its volumes
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a task's sandbox (dockerSandbox) > S2-5: a network of its own > is never started when the sandbox relay is not running, and makes no network
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > what holds > joins a sandboxes' network of its own, not the host's
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-5: a network of its own > joins a network made for it alone, internal, which the sandbox relay joins as sandbox-relay and nothing else does
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-5: a network of its own > never shares it with another sandbox, of its own Floor or another's
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-5: a network of its own > removes its network once it has ended, after the container and its volumes
✓ src/sandbox/docker-run.pen-test.test.ts > S2: the docker run of a Manager chat session (dockerToolRunner) > S2-5: a network of its own > is never started when the sandbox relay is not running, and makes no network
✓ src/sandbox/docker-run.pen-test.test.ts > S2-5: networks an AI Office before left behind > are removed before the first sandbox makes its own, so Docker's address pools do not run out
```

## Decisions

Recorded as ADR 0006; the choices within it, for the Owner to review:

1. **A network per sandbox, which AI Office joins the relay to.** The
   alternatives:
   - inter-container traffic off with the Gateway reached another way
     (the relay on the host's network, or published at the bridge's
     address) depends on how each Docker version routes an internal
     network to the host;
   - a relay per sandbox would start two containers for every model call
     through a subscription;
   - a network per Floor would leave one Floor's sandboxes reaching each
     other, which the finding names.
   ADR 0006 records them.
2. **The relay is found on `SANDBOX_NETWORK` by its compose service label**,
   not by a fixed container name. Compose names containers after the
   project, which differs between the dev file, the stack and the pen-test
   stack, and a fixed `container_name` would stop two stacks sharing a
   host. `SANDBOX_NETWORK` keeps its name and default, but now names the
   relay's network rather than the sandboxes'.
3. **The `it.fails`'s assertion is kept, and the test asserts more.** Its
   predicate (inter-container traffic on, and the configured network the
   compose one) is false because traffic is now off on
   `ai-office-sandboxes`. Alone, that would show only that the shared
   network is closed. So the same `it` also drives both runners and checks
   that no two sandboxes share a network. The S2-1 regression test that
   matched the dev compose network exactly now expects the
   `enable_icc` option too, and its title says sandboxes join internal
   networks beside `ai-office-sandboxes`. The "what holds" test "joins the
   sandboxes' network, not the host's" is now "joins a sandboxes' network
   of its own, not the host's": one `--network`, an
   `ai-office-sandbox-<uuid>`, never `host`.
4. **Leftover networks are removed once per process, before its first
   sandbox**, not on a timer. The removal disconnects the relay and
   removes each labelled network. One whose orphaned sandbox still runs is
   left (Docker refuses), but the relay is off it.
5. **A sandbox fails to start without the relay.** Before, it started and
   then could not reach the Gateway, so the Agent failed later and less
   clearly.

## Noticed, out of scope

- **ADR 0005 still says sandboxes share one network** ("The one other
  container on it is the sandbox relay", and its last consequence). ADR
  0006 refines it; ADR 0005 was not changed, as no issue asked for it.
  The PRD's register (H2) still quotes the old compose file; it is the
  round's opening register.
- **Docker's address pools.** Each running sandbox, chat turn and
  subscription model call now holds a network. Docker's default pools
  give about 30 bridge networks in all. That is enough for the default
  sandbox limit of 3 plus chat turns, but an Owner who raises the limits
  far may need `default-address-pools` in Docker's `daemon.json`.
- **The relay is on every running sandbox's network.** It forwards only to
  the Gateway, and proxies only to the names `SANDBOX_EGRESS_HOSTS` lists.
  Its own DNS resolves other containers' names on networks it shares, and
  `isForbiddenAddress` does not refuse private addresses. An allowed name
  that resolved to a sandbox's address would be relayed. Sandboxes' names
  are random and single-label, which a `*.domain` entry cannot match, but
  refusing private ranges in the relay would close it.
- **Latency.** Each chat turn and subscription model call now costs a
  `network create`, `connect`, `disconnect` and `rm`.
- Running AI Office both under compose and outside it on one machine is
  still unsupported (ADR 0005). Each would remove the other's leftover
  networks at its start.

## What could not be verified here

There is no Docker here; every `docker` call was checked as a stand-in
recorded it. Not tried:

- **The issue's statement itself:** a listener started in one sandbox
  (`python3 -m http.server 8000`, say) should no longer be reachable from
  another, by address or by name. Each should still reach
  `http://sandbox-relay:3047` and the relay's proxy.
- That `docker network connect --alias sandbox-relay` gives the relay that
  name on each new network on every Docker version this runs on, and that
  `enable_icc: "false"` is accepted on an internal network.
- That `docker ps --filter label=com.docker.compose.service=sandbox-relay`
  finds the relay under compose v2, outside it (`docker-compose.dev.yml`)
  and in the pen-test stack.
- The sweep after a real crash, and how long each network's create and
  removal takes.
