# Issue #233: [fix] S2-3 — A sandbox reaches the app's web app, API and sign-in routes (3045) and the OAuth callback (1455), not only the AI Gateway — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `32a6d2e`,
`fix(security): S2-3 the app is off the sandboxes' network, which reaches it only as the AI Gateway, through the sandbox relay`,
on top of `652959e` (S2-1's fix, #229) and `6f94dfa` (S2-2's, #231). Its
blocker, the S2 probe (#193), is in the tree:
`docs/pen-testing/assessments/S2.md`,
`docker/sandbox-isolation.pen-test.test.ts` and
`apps/server/src/ai-accounts/oauth-callback.pen-test.test.ts`.

This is the remediation of finding **S2-3** (`severity:high`, H3 and H14
reach). Its outside-compose half was fixed with A1-2 (#213): `HOST`
defaults to `127.0.0.1`.

## What was fixed

Under compose the app joined `ai-office-sandboxes` and listened on every
interface for 3045 (the web app, the API, `/api/login`, `/api/setup`, the
webhook route), 1455 (ChatGPT's sign-in callback, while one waits) and
3047 (the Gateway), so a sandbox reached all of them as `app:…`, while the
compose file said it reached "the AI Gateway as app:3047 and nothing else
of the stack".

- **The app is on the default network only** (`docker-compose.yml`). The
  sandbox relay (S2-1) is the one container on the sandboxes' network, and
  its Gateway port is piped to `app:3047` and nowhere else, so from a
  sandbox the app answers only as the AI Gateway. The app still listens on
  every interface inside its own container, which Caddy and the ports
  published to the host's loopback need; only the default network's
  containers (Caddy, Postgres, the relay) reach those.
- **The relay's HTTPS proxy** relays only to port 443, so even were the
  Owner to list `app` in `SANDBOX_EGRESS_HOSTS`, 3045, 1455, 3047 and 3048
  stay out of reach (tested).
- **What the documents say is true:** the compose file's comment on the
  sandboxes' network now says the relay is the only other container on it
  and that sandboxes reach the Gateway through it and nothing else of the
  stack. The comments and documents that gave "a sandbox" as an example
  of something reaching the app's port directly (`.env.example`,
  `apps/server/src/config.ts`, `apps/server/src/auth/proxy.ts`,
  `docs/guide/running.md`, the EC2 process) now say "another container on
  its network". The EC2 process says neither Caddy nor the app is on the
  sandboxes' network.

### Sibling paths

- **The pen-test stack** (`docker/pen-test/compose.yml`): its app is on the
  default network only too.
- **Outside compose:** `docker-compose.dev.yml` has no app; its relay
  reaches the host at the Gateway's port alone, and the server's own
  listeners default to loopback (A1-2), as does the sign-in callback.
- **The sign-in callback (H14):** its controls still hold (cancel, fail
  and race), and its pin is now a regression test that also reads where
  compose puts the app.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "on the
      sandboxes' network the app answers only as the AI Gateway" is an
      `it`. Its body is rewritten; see Decisions, 1.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.**
      - "regression (S2-3): under compose the app no longer joins
        ai-office-sandboxes: it still listens on every interface of its
        container, for Caddy and the published ports, but only the default
        network reaches them, and the compose file says what is true".
      - The outside-compose pin was already "regression (A1-2): …"; its
        comment now says the compose half is fixed too.
      - `oauth-callback.pen-test.test.ts`: "regression (S2-3): bound as
        compose binds it, it still answers a peer on a non-loopback address
        while a sign-in waits, but under compose no sandbox is such a peer
        any more: the app is on the default network only". It ran here
        (this machine has a non-loopback address), and was not skipped.
- [x] **Sibling paths with the same flaw are fixed and tested.** "sibling
      (S2-3): the pen-test stack's app is not on its sandboxes' network
      either, and outside compose the relay reaches the host only at the
      Gateway's port"; in `relay.test.ts`, "forwards every connection to the
      AI Gateway, whatever the sandbox asks for" (a `Host: app:3045` and
      `/api/login` still reach the stand-in Gateway) and "never reaches the
      app's web app, API or sign-in callback, even were
      SANDBOX_EGRESS_HOSTS to name the app (S2-3)"; `deployment.test.ts`
      and `pen-test/compose.test.ts` expect the app on `["default"]`.
- [x] **The assessment's findings table marks `S2-3` fixed.**
      `docs/pen-testing/assessments/S2.md`: **fixed** (issue #233) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below:
      lint and typecheck pass; `pnpm test` has only the two failures that
      were there before this run, unrelated.

## Real output of the checks

Run once on the finished tree, at `32a6d2e`, after all three fixes of this
run (#229, #231, #233); the other two notes point here.

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: two failures, both pre-existing and unrelated

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  2 failed | 423 passed (425)
      Tests  2 failed | 4895 passed | 9 expected fail | 603 skipped (5509)
test exit 1
```

Both expect the first release heading of `CHANGELOG.md` to carry a date
(`expected '1.0.0' to match /^1.0.0 \(/`). They failed the same way on the
tree before this run (`cc1717c`: `2 failed | 422 passed (424)`, the same
two, which issue-227.md records too), and nothing this run changed touches
`CHANGELOG.md`, the footer or the changelog. The new test file is
`docker/sandbox-relay/relay.test.ts`. The 603 skipped are the
Postgres-backed tests (no Docker here). The expected fails were 12 before
this run and are 9 now: S2-1's, S2-2's and S2-3's `it.fails` are `it`s.
S2-5's is one of the 9.

### The probe tests, verbose

```
✓ sandbox-isolation.pen-test.test.ts > S2-1: egress from a sandbox (H2) > a sandbox can reach nothing beyond the stack: its network has no route out
✓ sandbox-isolation.pen-test.test.ts > S2-1: egress from a sandbox (H2) > regression (S2-1): ai-office-sandboxes is no longer an ordinary bridge network with a route out, and sandboxes' egress goes through the sandbox relay's allow-list
✓ sandbox-isolation.pen-test.test.ts > S2-1: egress from a sandbox (H2) > regression (S2-1): outside compose, sandboxes no longer join Docker's default bridge: they join ai-office-sandboxes, which docker-compose.dev.yml makes internal, with the sandbox relay
✓ sandbox-isolation.pen-test.test.ts > S2-1: egress from a sandbox (H2) > sibling (S2-1): every compose file that starts sandboxes makes their network internal, and puts the sandbox relay on it, from the Node image, read-only and with no capabilities
✓ sandbox-isolation.pen-test.test.ts > S2-1: egress from a sandbox (H2) > sibling (S2-1): sandboxes reach the AI Gateway through the sandbox relay, under compose and outside it, in every document that says where
✓ sandbox-isolation.pen-test.test.ts > S2-2: the instance metadata service on the documented EC2 set-up (H2) > the documented EC2 set-up keeps sandboxes from the instance metadata service (a hop limit of 1, or a block)
✓ sandbox-isolation.pen-test.test.ts > S2-2: the instance metadata service on the documented EC2 set-up (H2) > regression (S2-2): it still picks Ubuntu 24.04, IMDSv2 only and an IAM role on the instance, but no longer leaves the hop limit at the AMI's default: it sets 1
✓ sandbox-isolation.pen-test.test.ts > S2-2: the instance metadata service on the documented EC2 set-up (H2) > sibling (S2-2): an instance launched before, or another way, is given the same hop limit, and the document says how to check it
✓ sandbox-isolation.pen-test.test.ts > S2-2: the instance metadata service on the documented EC2 set-up (H2) > sibling (S2-2): whatever hop limit an instance has, a sandbox's network has no route to 169.254.169.254, and the sandbox relay refuses it, by address or by a name that resolves to it
✓ sandbox-isolation.pen-test.test.ts > S2-2: the instance metadata service on the documented EC2 set-up (H2) > holds: IMDSv1 is off in the documented set-up, so a metadata request without a token is refused
✓ sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > on the sandboxes' network the app answers only as the AI Gateway
✓ sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > regression (S2-3): under compose the app no longer joins ai-office-sandboxes: it still listens on every interface of its container, for Caddy and the published ports, but only the default network reaches them, and the compose file says what is true
✓ sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > sibling (S2-3): the pen-test stack's app is not on its sandboxes' network either, and outside compose the relay reaches the host only at the Gateway's port
✓ sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > regression (A1-2): outside compose the server no longer listens on every interface by default, so a sandbox on the default bridge does not reach it at the bridge's gateway address
✓ sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > holds: Postgres and Caddy are not on the sandboxes' network
✓ sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > holds: Postgres publishes no port under compose, and the development Postgres only on the host's loopback
✓ sandbox-isolation.pen-test.test.ts > S2-5: one sandbox reaching another > a sandbox cannot reach another sandbox, of its own Floor or another's   [it.fails, S2-5, still open]
✓ sandbox-isolation.pen-test.test.ts > S2-5: one sandbox reaching another > pins today: every sandbox, of every Floor, joins the one ai-office-sandboxes network, with inter-container traffic on
✓ oauth-callback.pen-test.test.ts > S2 (H14): the sign-in's callback listener, from a sandbox > regression (S2-3): bound as compose binds it, it still answers a peer on a non-loopback address while a sign-in waits, but under compose no sandbox is such a peer any more: the app is on the default network only
✓ oauth-callback.pen-test.test.ts > S2 (H14): the sign-in's callback listener, from a sandbox > cannot cancel it: a callback with ?error= changes nothing, and the Owner's still finishes
✓ oauth-callback.pen-test.test.ts > S2 (H14): the sign-in's callback listener, from a sandbox > cannot fail it: callbacks with no state, a wrong state, or a code of its own finish nothing, and the Owner's still finishes
✓ oauth-callback.pen-test.test.ts > S2 (H14): the sign-in's callback listener, from a sandbox > cannot race it: once the Owner's callback has finished it, a later one adds nothing
✓ oauth-callback.pen-test.test.ts > S2 (H14): the sign-in's callback listener, from a sandbox > binds the sign-in to a state only the Owner's browser is shown: 256 bits, different each time
```

### The sandbox relay, verbose

```
✓ relay.test.ts > the Gateway relay > forwards every connection to the AI Gateway, whatever the sandbox asks for
✓ relay.test.ts > the egress proxy > relays CONNECT to port 443 of a host SANDBOX_EGRESS_HOSTS names
✓ relay.test.ts > the egress proxy > relays to every name under a *.domain entry, but not the domain itself
✓ relay.test.ts > the egress proxy > refuses a host SANDBOX_EGRESS_HOSTS does not name, such as one the red team controls, and connects to nothing
✓ relay.test.ts > the egress proxy > refuses everything when SANDBOX_EGRESS_HOSTS is empty
✓ relay.test.ts > the egress proxy > refuses any port but 443 on an allowed host, so nothing else it serves is reached
✓ relay.test.ts > the egress proxy > never reaches the app's web app, API or sign-in callback, even were SANDBOX_EGRESS_HOSTS to name the app (S2-3)
✓ relay.test.ts > the egress proxy > refuses an IP address, the instance metadata service's above all
✓ relay.test.ts > the egress proxy > refuses an allowed name that resolves to the instance metadata service, loopback or link-local, even alongside a public address
✓ relay.test.ts > the egress proxy > refuses a name that does not resolve, and what is not host:port
✓ relay.test.ts > the egress proxy > refuses plain HTTP: it is not a forward proxy for anything but CONNECT
✓ relay.test.ts > SANDBOX_EGRESS_HOSTS > is host names and *.domain entries, separated by commas or spaces; empty is none
✓ relay.test.ts > SANDBOX_EGRESS_HOSTS > refuses an IP address, a port, a URL or a bare wildcard
✓ relay.test.ts > SANDBOX_EGRESS_HOSTS > matches names exactly, or under a *.domain entry
✓ relay.test.ts > the addresses a sandbox never reaches > are the metadata services, link-local, loopback, unspecified and multicast
```

## Decisions

1. **The `it.fails`'s body is rewritten; its name, the property, is not.**
   The probe's body asserted the app on `ai-office-sandboxes` with its
   web app and callback bound to something other than every interface: one
   way the property could be made true. It cannot be made true that way
   under compose: the app's container has an address on each network that
   Docker assigns, its health check and the ports published to the host
   reach it at `127.0.0.1` and through Docker's forwarding, and Caddy at
   `app:3045`, so no one bind address serves those and not the sandboxes.
   The fix takes the app off the network instead (ADR 0005), and the body
   now asserts the property itself, for all three compose files: the
   sandbox relay is the only container on the sandboxes' network, it
   forwards only to the Gateway's port, and the app is not there. That
   covers every listener of the app, not just 3045 and 1455. It fails
   against the compose file as it was: with the app put back on
   `sandboxes`, it fails on `expected [ 'app', 'sandbox-relay' ] to deeply
   equal [ 'sandbox-relay' ]`, as does the regression test (checked, then
   undone).
2. **`OAUTH_CALLBACK_HOST` and `HOST` stay `0.0.0.0` under compose.** In
   the container they must, for the published ports and Caddy; the reach
   that mattered was the network, not the bind.

## Noticed, out of scope

- **S2-5 is still open:** sandboxes reach each other on their one network
  (and reach the relay, by design).
- **A1-1's limiter** no longer has a sandbox as its likeliest direct
  caller, but its fix (`PROXY_SECRET`) stands as it was.
- **The PRD's register (H3, H17)** still quotes the old compose comment;
  it is the round's opening register, so it was left as written.

## What could not be verified here

There is no Docker here. On the pen-test stack, as the issue says, from a
sandbox: `http://app:3045/health` and, while the Owner's test sign-in
waits, `http://app:1455/auth/callback` should no longer answer (`app` does
not resolve on the sandboxes' network), while
`http://sandbox-relay:3047` answers as the Gateway. Outside compose,
`http://172.17.0.1:<PORT>/health` should find no route from the internal
network, and the server is on loopback by default in any case (A1-2).
