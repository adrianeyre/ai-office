# Issue #301: [fix] I1-1 — A custom AI endpoint is fetched with no block on its host — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0,
git 2.39.5; no Docker, no Postgres, no DNS and no network beyond the
registry and the model). The fix is commit `aa429d9`,
`fix(security): I1-1 the Gateway never reaches an internal address the Owner did not allow in the environment, an AI Account's endpoint above all`,
on top of `d4ccb23`. Its blocker, the I1 probe (#197), is in the tree:
`docs/pen-testing/assessments/I1.md` and the probe tests it names. I1-2
(#303, `e5a0122`) and I1-3 (#305, `c1e46aa`) apply the same host policy
to Connections and imports; this note holds the Decisions all three
share.

This is the remediation of finding **I1-1** (`severity:medium`, H13).

## What was fixed

An AI Account's custom endpoint (FR-35) is the Gateway's `baseUrl`, which
it fetches on every model call and whose answer it hands to the Gateway
Key holder. Nothing checked its host, so a stolen session could add an
account at `http://169.254.169.254/…` and a sandbox could read the answer.

- **One host policy for every address the Owner gives**
  ([ADR 0007](../architectural-decision-record/0007-owner-given-addresses-never-reach-internal-hosts.md),
  new), in `packages/shared/src/internal-hosts.ts`. Refused:
  - a loopback, link-local, private or other non-public address, IPv4
    (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
    192.168/16, 198.18/15, 224/4 and up) or IPv6 (`::`, `::1`, fc00::/7,
    fe80::/10, ff00::/8, and an internal IPv4 address carried in a
    mapped, compatible, NAT64 or 6to4 one);
  - `localhost`, a one-label name (the stack's `app`, `postgres`), and a
    private suffix (`.internal`, `.local`, `.localdomain`, `.lan`,
    `.home`, `.home.arpa`, `.intranet`, `.corp`, `.private`);
  - plain `http://`, except to the outbound proxy;

  unless `ALLOWED_INTERNAL_HOSTS`, in the environment, names the host
  (a name with its subdomains, a `.domain`, or an IP address).
- **Where it is checked:**
  - **The schemas.** `endpointUrl` (every account type that takes one),
    an Ollama account with no URL (its default is `localhost:11434`), a
    Vertex AI key's `token_uri`, and the outbound proxy's URL.
  - **The web app's forms**, which learn the hosts from `GET
    /api/session` (`allowedInternalHosts`), so they refuse what the
    server would.
  - **Each connection the Gateway makes.** `ownerFetch`
    (`packages/shared/src/internal-hosts-guard.ts`) checks the host, then
    every address its name resolves to, then each connection as it is
    made through an undici dispatcher whose lookup refuses an internal
    address. So a public name pointed at `169.254.169.254`, a name that
    answers differently the second time, and a redirect inward are all
    refused, and nothing connects. It is `buildGateway`'s default fetch
    and the direct path of `createUpstreamFetch`, which every Gateway
    path shares in production.
- **The server** reads `ALLOWED_INTERNAL_HOSTS` (`apps/server/src/config.ts`)
  and sets it at start (`startOffice`). `.env.example`,
  `docker-compose.yml` and the guide (`ai-gateway.md`, "Internal
  addresses", the Ollama and proxy entries) say how to set it.

### Sibling paths

- **Every Gateway path, not only model calls.** Model lists, published
  prices, subscriptions' sign-ins, token refreshes and usage,
  keep-alives and auto-refreshes all go through `createUpstreamFetch`,
  whose direct path is now `ownerFetch`.
- **The outbound proxy.** Its URL may not be an internal host the Owner
  did not allow (plain `http://` stays fine: it carries `https://`
  inside). Through it, the host asked for is checked by its form, and
  the proxy's own host by what it resolves to.
- **A Vertex AI key's `token_uri`**, which the Gateway POSTs a signed
  assertion to.
- **The pen-test stack** allows its stub upstream
  (`docker/pen-test/compose.yml`), and nothing else, so its AI Accounts
  still work and the I1 targets stay refused.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** Both:
      - `endpoint-ssrf.pen-test.test.ts`: "the Gateway refuses an AI
        Account whose endpoint is a loopback, link-local or private
        address" is an `it`, its assertions unchanged (the body never
        reaches the caller; the internal service received nothing). The
        file sets `ALLOWED_INTERNAL_HOSTS` empty before each test, as the
        Gateway starts; see Decisions, 6.
      - `ai-accounts.pen-test.test.ts`: "a custom AI endpoint cannot be
        set to a loopback, link-local or private address" is an `it`.
- [x] **The "pins today" tests become regression tests; none is
      deleted.**
      - "regression (I1-1): the Gateway no longer fetches a loopback
        endpoint, nor returns its body to the Gateway Key holder";
      - "regression (I1-1): the endpoint URL no longer accepts loopback,
        the metadata service, private addresses or bare internal names"
        (each problem names `ALLOWED_INTERNAL_HOSTS`);
      - "regression (I1-1): the endpoint URL no longer accepts plain http
        to a host the Owner did not allow" (an https public endpoint is
        still accepted).
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `endpoint-ssrf.pen-test.test.ts`: "the Gateway fetches an internal
        endpoint the Owner allowed"; "an endpoint whose public-looking
        name resolves to an internal address is refused as it connects"
        (with a resolver standing in for a hostile DNS answer, and the
        same name reaching the service once allowed); "the upstream fetch
        the server gives every Gateway path … refuses an internal host,
        directly or through the proxy".
      - `ai-accounts.pen-test.test.ts`: an allowed host is accepted over
        http, and only that host; Ollama's default; the outbound proxy;
        a Vertex `token_uri`.
      - `internal-hosts.test.ts` (the address and name rules, IPv4 and
        IPv6, the allowance) and `internal-hosts-guard.test.ts` (no
        connection to an internal address; an allowed one reached; a
        rebinding name refused at connect; a redirect from an allowed
        host to an internal one refused).
      Mutation check: with `buildGateway`'s and `createUpstreamFetch`'s
      default fetch put back to `fetch`, and the endpoint schema's
      refinement removed, 7 of the 12 tests in the two probe files fail:
      both former `it.fails`, all three regression tests, "a host the
      Owner allowed … only that host" and "the upstream fetch the server
      gives every Gateway path …". The 5 that pass test what was not
      removed (the proxy's, Ollama's and `token_uri`'s schemas, an
      allowed endpoint, and the resolver test, which passes `ownerFetch`
      itself). Put back, all pass.
- [x] **The assessment's findings table marks `I1-1` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #301) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on six tests, in the
      `deployment` and `repository` projects, which fail the same at
      `d4ccb23`, before any of these fixes (see Noticed, out of scope);
      every other test passes. See [the output](#real-output-of-the-checks).

### The probe tests, verbose (I1-1)

```
✓ src/internal-hosts.test.ts > internal addresses > are loopback, link-local, private and the other ranges no public host has, in IPv4
✓ src/internal-hosts.test.ts > internal addresses > are unspecified, loopback, unique-local, link-local and multicast in IPv6, and an internal IPv4 address carried in one
✓ src/internal-hosts.test.ts > internal addresses > are told from names, and a name is never one
✓ src/internal-hosts.test.ts > internal hosts > are internal addresses, localhost, single labels such as the stack's own services, and private suffixes
✓ src/internal-hosts.test.ts > the hosts the Owner allows > are names, which cover their subdomains, domains and addresses
✓ src/internal-hosts.test.ts > the hosts the Owner allows > are the server's once set, and none until then
✓ src/internal-hosts.test.ts > the hosts the Owner allows > are checked as the environment gives them
✓ src/internal-hosts.test.ts > an address the Owner gives > is https:// to a public host, or anything to a host they allowed
✓ src/internal-hosts-guard.test.ts > checking a host before it is reached > refuses an internal host by its form, and one whose name resolves to an internal address
✓ src/internal-hosts-guard.test.ts > checking a host before it is reached > lets through a host the Owner allowed, whatever it resolves to, and a name that does not resolve, whose fetch fails on its own
✓ src/internal-hosts-guard.test.ts > ownerFetch > never connects to an internal address the Owner did not allow
✓ src/internal-hosts-guard.test.ts > ownerFetch > reaches one they allowed
✓ src/internal-hosts-guard.test.ts > ownerFetch > checks what a name resolves to as the connection is made, so a name that answers differently the second time is still refused
✓ src/internal-hosts-guard.test.ts > ownerFetch > refuses a redirect from a host they allowed to one they did not
✓ src/ai-accounts.pen-test.test.ts > I1-1 (H13): a custom AI endpoint's URL may name an internal host > regression (I1-1): the endpoint URL no longer accepts loopback, the metadata service, private addresses or bare internal names
✓ src/ai-accounts.pen-test.test.ts > I1-1 (H13): a custom AI endpoint's URL may name an internal host > regression (I1-1): the endpoint URL no longer accepts plain http to a host the Owner did not allow
✓ src/ai-accounts.pen-test.test.ts > I1-1 (H13): a custom AI endpoint's URL may name an internal host > a custom AI endpoint cannot be set to a loopback, link-local or private address
✓ src/ai-accounts.pen-test.test.ts > I1-1 (H13): a custom AI endpoint's URL may name an internal host > a host the Owner allowed in the environment is accepted, over http too, and only that host
✓ src/ai-accounts.pen-test.test.ts > I1-1 siblings: other addresses the Gateway fetches > an Ollama account with no URL, whose default is localhost, is refused until the Owner allows localhost
✓ src/ai-accounts.pen-test.test.ts > I1-1 siblings: other addresses the Gateway fetches > the outbound proxy cannot be an internal host unless the Owner allowed it
✓ src/ai-accounts.pen-test.test.ts > I1-1 siblings: other addresses the Gateway fetches > a Vertex AI service account's token_uri cannot be an internal host
✓ src/endpoint-ssrf.pen-test.test.ts > I1-1 (H13): a custom AI endpoint on an internal address > regression (I1-1): the Gateway no longer fetches a loopback endpoint, nor returns its body to the Gateway Key holder
✓ src/endpoint-ssrf.pen-test.test.ts > I1-1 (H13): a custom AI endpoint on an internal address > the Gateway refuses an AI Account whose endpoint is a loopback, link-local or private address
✓ src/endpoint-ssrf.pen-test.test.ts > I1-1 (H13): a custom AI endpoint on an internal address > the Gateway fetches an internal endpoint the Owner allowed, such as their own Ollama
✓ src/endpoint-ssrf.pen-test.test.ts > I1-1 siblings: every other way the Gateway reaches upstream > an endpoint whose public-looking name resolves to an internal address is refused as it connects
✓ src/endpoint-ssrf.pen-test.test.ts > I1-1 siblings: every other way the Gateway reaches upstream > the upstream fetch the server gives every Gateway path (model lists, prices, sign-ins, keep-alives) refuses an internal host, directly or through the proxy
Tests  26 passed (26)
```

## Real output of the checks

Run once, on the finished tree with all three fixes (`c1e46aa`). The
test output is cut to its failures and summary; the probe files'
verbose output is above and in #303's and #305's notes.

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

```
$ pnpm typecheck
$ tsc && pnpm --recursive typecheck
packages/db typecheck$ tsc
packages/shared typecheck$ tsc
packages/github typecheck$ tsc
packages/db typecheck: Done
packages/shared typecheck: Done
packages/events typecheck$ tsc
packages/github typecheck: Done
packages/events typecheck: Done
apps/web typecheck$ tsc
packages/communications typecheck$ tsc
packages/gateway typecheck$ tsc
packages/orchestrator typecheck$ tsc
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

```
$ pnpm test
$ vitest run
…
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > pins today: every Dockerfile base image is a tag or a build ARG, never a digest
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
…
 Test Files  4 failed | 464 passed (468)
      Tests  6 failed | 5031 passed | 90 expected fail | 603 skipped (5730)
   Duration  208.69s (tests 72%, import 17%, transform 5%, environment 4%, setup 2%)
exit 1
```

## Decisions

For the Owner to review; ADR 0007 records the first four.

1. **The allow-list is in the environment, not in Admin.** FR-67 keeps
   configuration in Postgres, but the attacker I1-1 names holds a stolen
   session, which could add a host to an Admin list as easily as the
   account. `ALLOWED_INTERNAL_HOSTS` is read at start, so changing it
   needs a restart. A per-account "on my network" switch was rejected
   for the same reason.
2. **Plain `http://` is held to the same list** (except the outbound
   proxy). The pin "accepts plain http" had to become a regression test,
   and a public endpoint over http sends the AI Account's key in the
   clear. Local servers that speak http (Ollama, LM Studio, vLLM) are on
   the Owner's network and need allowing anyway.
3. **Names are judged by their form and by what they resolve to.** One
   label, `localhost` and the private suffixes listed above are refused
   without asking DNS (so `app` and `postgres` are refused even where
   they do not resolve). `.corp`, `.home` and `.private` are not
   delegated TLDs, so refusing them costs no public host. `.test` and
   `.example` names are not refused by form; what they resolve to is
   checked.
4. **Through the outbound proxy, the host asked for is checked by its
   form only.** The proxy resolves names in its own network, which AI
   Office cannot see, and a corporate network often resolves outside
   names only at its proxy. The proxy itself is checked fully.
5. **Ollama with no URL is refused until `localhost` is allowed.** Its
   default is `http://localhost:11434`: under compose that is the app
   container itself, and outside it the AI Office host. The form says
   which variable to set.
6. **Tests.** The Gateway's, the server's and the Connections' tests stand
   up fakes on loopback, so each of those packages has a Vitest setup
   file (`src/test-setup.ts`) that allows `127.0.0.1` and `localhost`, as
   an Owner would allow their own servers. The probe files set the list
   empty before each test, as AI Office starts, and put it back after.
   Tests that need more (a `.lan` Ollama, a `.corp` proxy) allow it in
   that test. The web app's tests send the hosts in their fake session,
   which exercises the whole path. The e2e server and the Postgres
   `main.test.ts` set `ALLOWED_INTERNAL_HOSTS` in the environment they
   start AI Office with.
7. **Stored records are not migrated.** An account, proxy, Connection or
   Skill stored before with a host now refused is refused where it is
   used: the Gateway answers as for an account it cannot reach.
8. **ADR 0007, not 0005.** ADR numbers 0005 and 0006 are already taken
   on branches being worked in parallel (`0005-sandboxes-reach-only-the-gateway-and-allowed-hosts`,
   `0005-only-the-owner-accepts-role-memory`,
   `0006-each-sandbox-has-a-network-of-its-own`), so this one is 0007 to
   avoid a third clash at merge. On this branch alone the numbers skip.
9. **`undici` is a dependency of `@ai-office/shared`** (the version the
   Gateway already uses), for the guarded dispatcher. Its Node-only part
   is a separate entry point, `@ai-office/shared/internal-hosts-guard`,
   so the web app never bundles it.

## Noticed, out of scope

- **G1-7 is still open.** The Gateway follows an AI Provider's redirect
  to another origin with the account's key. The guard now stops a
  redirect inward, but a redirect to another public origin still
  carries the key; G1-7's own fix owns that.
- **`host.docker.internal` on Linux.** The guide and `.env.example`
  name `http://host.docker.internal:11434` for the Owner's Ollama under
  compose, but `docker-compose.yml` sets no
  `extra_hosts: ["host.docker.internal:host-gateway"]`, so on Linux the
  name does not resolve in the app container. That predates this fix.
- **`docs/processes/deploying-to-ec2.md`'s environment table** does not
  list `ALLOWED_INTERNAL_HOSTS`. It is optional and empty is the safe
  default; the EC2 guide may want a line for an Owner with their own
  model server.
- **The sandbox relay** on the parallel S2 branch has its own
  `isForbiddenAddress`, and that branch's verification notes it does not
  refuse private addresses. `isInternalAddress` here could serve it at
  merge.
- **Six tests in the `deployment` and `repository` projects fail at
  `d4ccb23`**, before any of these fixes, and fail the same after (see
  the test output): two I1-9 tests in
  `test/documentation-drift.pen-test.test.ts`, two in
  `docker/supply-chain.pen-test.test.ts` (an I1-4 pin and the published
  ports), one in `docker/caddy/caddyfile.pen-test.test.ts`, and one in
  `docker/pen-test/compose.test.ts`. They come from changes merged into
  this branch since the probes were written (the compose and Caddy
  files, `.env.example`), not from this work.
- **The worktree's Git metadata was pruned twice during this run** (at
  18:58 and 19:01 UTC) when the host's Sandcastle created new runs and
  pruned worktrees it could not see. The branch and its commits were
  untouched. The metadata was recreated (`HEAD`, `commondir`, `gitdir`,
  then `git reset` to rebuild the index from `HEAD`, keeping the working
  tree) and locked against further pruning; the lock is removed as this
  run ends. Orchestrator tests that ran while Git was broken failed and
  were run again.

## What could not be verified here

There is no Docker, no Postgres, no DNS and no second host here. Not
tried:

- **The issue's statement end to end:** on the pen-test stack, add an
  endpoint AI Account at
  `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
  (the form and the API should refuse it), write one straight into the
  database, and make a model call with a Gateway Key: the Gateway should
  answer with its own error, and the metadata service should see nothing.
- **Real DNS.** The resolution checks were exercised with a resolver
  standing in for DNS; the system resolver was reached only to fail. A
  public name pointed at a private address (such as a `nip.io` name)
  should be refused on a host with DNS.
- **The Postgres tests** (`main.test.ts`, the AI Account and proxy routes
  against Postgres) are skipped without Docker; `main.test.ts` was edited
  to set `ALLOWED_INTERNAL_HOSTS` but not run.
- **The e2e tests**, which now start AI Office with
  `ALLOWED_INTERNAL_HOSTS=127.0.0.1`.
- **The web forms in a browser** with a host allowed and one not.
- **The pen-test stack** with `ALLOWED_INTERNAL_HOSTS: stub-upstream`:
  its AI Accounts should still serve through the Gateway.
