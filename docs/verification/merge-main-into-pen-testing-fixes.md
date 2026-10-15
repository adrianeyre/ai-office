# Merging `origin/main` into the pen-testing fixes — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no browser, no network beyond the registry and the
model). The branch carried the fixes for A1-1 to A1-9 (sign-in and
sessions) and S2-1 to S2-5 (sandbox isolation), on top of `77880b0`.
`origin/main` was at `631e8d8` (`Merge pull request #209 from
adrianeyre/feat/single-entry-point`), 22 commits past the merge base
`dfe8862`. Three commits:

- `5099fe3` `Merge remote-tracking branch 'origin/main' into the pen-testing fixes`
- `175484e` `fix(security): the AI Gateway's /v1 on the app's port takes the proxy's proof off and carries the security headers`
- `58f4314` `test(pen-test): S2-1, S2-3 and S2-5 hold for the sandboxes the app starts under compose, and for .env.example as pnpm dev reads it`

What main brought in: one entry point (the AI Gateway's `/v1` paths on the
app's port, `apps/server/src/gateway-entry.ts`, and through Caddy); Agents
under compose (`git` and the Docker CLI in the app image, the
`sandbox-dir` service, `AI_OFFICE_SANDBOX_DIR`); `.env.example` set for
development; `pnpm sandbox:ensure`; renaming a Floor; the Manager chat's
status line; Agents named with their Role; and a changelog test fix.

## What conflicted, and how each was resolved

Twelve files conflicted: the nine expected, and `apps/server/src/config.ts`,
`docs/guide/issue-pipeline.md` and `site/index.html`. Each kept both sides.

| File | Main's side | The fixes' side | Resolution |
|---|---|---|---|
| `docker-compose.yml` | `sandbox-dir`, the work directory at the same path, the socket comment for Agents under compose, the Gateway's port unpublished; the app on `default` **and `sandboxes`**, `SANDBOX_GATEWAY_URL: http://app:3047` fixed by compose | The app on `default` only (S2-3); `SANDBOX_GATEWAY_URL` the relay's; `PROXY_SECRET`; the relay service; the internal, ICC-off `sandboxes` network | All of main's services, mounts and ports. The app stays on `default` only. Compose still fixes `SANDBOX_GATEWAY_URL` whatever `.env` says (main's idea), but to `http://sandbox-relay:3047`. The header and the Gateway comments say the sandboxes reach port 3047 through the relay, and that each sandbox has a network of its own. |
| `.env.example` | Every value set for development: `HOST=0.0.0.0`, `SANDBOX_GATEWAY_URL=http://host.docker.internal:3047`, `SANDBOX_NETWORK=bridge`, `AI_OFFICE_DOMAIN=localhost`, `GATEWAY_HOST=127.0.0.1`; `TRUST_PROXY`'s comment suggesting `172.16.0.0/12` | `HOST` on loopback (A1-2); `PROXY_SECRET` (A1-1, and no `172.16.0.0/12`); the relay and `ai-office-sandboxes` (S2-1, S2-5); `SANDBOX_EGRESS_HOSTS` | Main's development values, but `HOST=127.0.0.1`, `SANDBOX_GATEWAY_URL=http://sandbox-relay:3047`, `SANDBOX_NETWORK=ai-office-sandboxes` (with "never Docker's default bridge"), and no `172.16.0.0/12`. `PROXY_SECRET` and `SANDBOX_EGRESS_HOSTS` kept, with main's "Left empty" notes. The Linux note now names only `GATEWAY_HOST`, as the relay's address is the same everywhere. Copying it as main intends no longer undoes A1-1, A1-2, S2-1 or S2-5. |
| `docker/caddy/Caddyfile` | `reverse_proxy app:3045 { flush_interval -1 }`; comment for `/v1` | `header_up X-AI-Office-Proxy {env.PROXY_SECRET}`; the five `header ?…` defaults | One `reverse_proxy` with both `header_up` and `flush_interval -1`; the header defaults kept. |
| `apps/server/src/app.ts` | `gateway` option; `serverFactory: gatewayEntry(gateway)` | `proxySecret` and `setupToken` options; `rewriteUrl` running `believeOnlyTheProxy` | All three options, and both `rewriteUrl` and the server factory. (The factory was then extended; see below.) |
| `apps/server/src/server.ts` | Passes `gateway` | Passes `setupToken` | Both. |
| `apps/server/src/config.ts` | Comments for one entry point; `SANDBOX_NETWORK` optional | `SANDBOX_NETWORK` defaults to `ai-office-sandboxes` | The default kept, with main's comments. |
| `apps/web/src/gateway-keys-card.tsx` | `useFloorNames` import | `OwnerProofFields` import (A1-3) | Both imports. |
| `docker/deployment.test.ts` | Its one-entry-point tests (no matcher, `flush_interval -1`, 3047 unpublished) | `reverse_proxy app:3045 {`; the relay and internal network | Main's tests kept. The one that expected `SANDBOX_GATEWAY_URL` to be `http://app:3047` now expects `http://sandbox-relay:3047`, as the fixes' test beside it already required. |
| `docs/guide/running.md` | `.env.example` already working; `sandbox:ensure`; "Using the AI Gateway from your own tools"; Caddy and `/v1` | The relay in `pnpm dev`; `SANDBOX_EGRESS_HOSTS`; `PROXY_SECRET` | Main's text with the relay's address and the egress list. The tls paragraph names `PROXY_SECRET`. A new bullet says the app is not on the sandboxes' network. The two places that said sandboxes reach `http://app:3047` now say `http://sandbox-relay:3047`. |
| `docs/guide/issue-pipeline.md` | A paragraph: sandboxes on `SANDBOX_NETWORK`, `http://app:3047`, `bridge` in `pnpm dev` | "What a sandbox reaches" and "How a sandbox is started" (S2-1 to S2-5) | The fixes' sections, plus main's point that sandboxes use the Gateway's own port and compose sets both values itself, now with the relay. |
| `docs/processes/deploying-to-ec2.md` | `/v1` through Caddy; Agents work under compose; `SANDBOX_GATEWAY_URL` row removed | Security headers; neither Caddy nor the app on the sandboxes' network; `PROXY_SECRET`, `SANDBOX_GATEWAY_URL` and `SANDBOX_EGRESS_HOSTS` rows | Both bullets lists merged. The `SANDBOX_GATEWAY_URL` row stays removed (compose sets it). The `SANDBOX_EGRESS_HOSTS` row is kept, because compose's relay reads it from `.env`. The closing note lists the `.env` values compose ignores by name, and says sandboxes reach the Gateway through the relay. |
| `site/index.html` | The table headed "Sandboxes' Gateway address"; compose sets `http://app:3047`; "leave `SANDBOX_NETWORK` at `bridge`" | The relay, the same address everywhere | The fixes' table, with main's "compose sets `SANDBOX_GATEWAY_URL`, `SANDBOX_NETWORK` and `SANDBOX_WORK_DIR` itself". The note now says never to set `SANDBOX_NETWORK` to `bridge`. |

Auto-merged files that still described main's wiring were corrected in
the merge commit. `docs/guide/ai-gateway.md` said sandboxes reach the
Gateway at `http://app:3047` under compose and
`http://host.docker.internal:3047` in `pnpm dev`; it now says
`http://sandbox-relay:3047`, through the relay, in both.

One test changed with the merge. `docker/pen-test/compose.test.ts`, "holds
none of the root .env.example's values, nor any other secret", treated
every root `.env.example` value of 8 characters or more as a secret. That
worked while the file set only its sample secrets. Since main, it also sets
addresses, names and paths, such as `127.0.0.1` and the relay's
`http://sandbox-relay:3047`, which the pen-test stack rightly shares. It
now checks every value except an explicit list of those keys, so a new key
is still checked by default. It also asserts that `SESSION_SECRET`,
`ENCRYPTION_KEY`, `POSTGRES_PASSWORD` and `DATABASE_URL` are among those
checked. Without the change it failed on
`expected '# The pen-test stack …' not to contain '127.0.0.1'`.

## Fixes extended to main's new paths

### The AI Gateway's `/v1` on the app's port, and through Caddy (A1-1, A1-6)

`gatewayEntry` hands each `/v1` request to the Gateway's own Fastify
instance before the app sees it. So none of the app's `rewriteUrl` and
hooks run for it, and two fixes did not hold:

- **A1-1, the proxy's proof.** Caddy sends `X-AI-Office-Proxy:
  <PROXY_SECRET>` with every request, `/v1` included. The app removes it in
  `rewriteUrl`, so that no route or log sees it. On `/v1` it reached the
  Gateway, which:
  - keeps the caller's headers in its request history
    (`requestHeaders: shownHeaders(…)`, which redacts only `authorization`,
    `x-api-key`, `proxy-authorization` and `cookie`), shown to the Owner and
    stored in Postgres;
  - forwards them to the AI Provider on a passthrough route
    (`forwardedHeaders`, which drops only hop-by-hop headers, credentials
    and AI Office's own attribution headers).

  So with the `tls` profile, `PROXY_SECRET` was written to the request
  history and sent to Anthropic on every `/v1/messages` call. A caller's
  own `X-Forwarded-*` reached both as well. Confirmed by the new test with
  the fix taken out: `expected { host: '127.0.0.1:38541', …(12) } to not
  have property "x-ai-office-proxy"`.
- **A1-6, the security headers.** `/v1` answers (served calls, the
  Gateway's 401s and 404s) carried none of them. Through Caddy the `?`
  defaults filled them in, but not on the app's port.

**The fix:** `gatewayEntry(gateway, before)` now calls `before(request,
response)` for each Gateway request. In it, `buildApp` gives that request
what every other request gets from the app (`apps/server/src/app.ts`):

- `believeOnlyTheProxy`, the same function as `rewriteUrl`'s: the proof is
  always removed, and `X-Forwarded-For`, `-Host` and `-Proto` are kept only
  when it is right;
- the same `securityHeaders`, set on the raw response before the Gateway
  writes it. HSTS is sent when `PUBLIC_URL` is https, or when a proven
  proxy's last `X-Forwarded-Proto` is https and `TRUST_PROXY` is set, as
  Fastify reads it for the app's own routes.

The Gateway's own port (3047, the sandboxes' way in through the relay) is
unchanged. Caddy never proxies to it, so it never receives the proof.

**Tests** (`apps/server/src/gateway-entry.test.ts`, new `describe("the AI
Gateway on the app's port, behind Caddy (A1-1, A1-6)")`, on a real socket
with the real Gateway and a stand-in AI Provider that records the headers
it is sent):

- the proof Caddy sends reaches neither the request history nor the AI
  Provider, and the client address it vouches for is kept;
- with no proof or a wrong one, no `X-Forwarded-*` reaches either, and no
  HSTS is sent on the caller's word;
- a served call, a refusal without a key and a path the Gateway does not
  serve each carry the same four headers as the app's own `401`;
- HSTS only for a proven proxy's https, or for an https `PUBLIC_URL`.

All seven fail with `before` taken out. In
`docker/caddy/caddyfile.pen-test.test.ts`, a new `describe("A1-1, A1-6 ·
the AI Gateway's /v1 through Caddy")` checks two things. `/v1` goes
through the one `reverse_proxy`, whose block sends the proof, with no
matcher or route that could send it another way. And every `header`
directive is a `?` default with no path.

The **sign-in limiter's client address** is not used on `/v1`. The Gateway
has no limiter and no `trustProxy`, so its `request.ip` is always the TCP
peer. What a `/v1` caller could have chosen was the `X-Forwarded-*` the
Gateway records and forwards, which is now dropped unless the proof is
right.

### The sandboxes the app starts under compose (S2-1, S2-3, S2-5)

Main made the app start Agents' sandboxes under compose. To give them a
way to the Gateway, it put the app back on the sandboxes' network and set
`SANDBOX_GATEWAY_URL: http://app:3047`. That is exactly the reach S2-3
removed: every listener of the app (3045, 1455) on the sandboxes' network.
Main's `.env.example`, which `pnpm dev` now reads as it is, set
`SANDBOX_NETWORK=bridge` (Docker's default bridge, with a route out: S2-1,
and every sandbox on one network: S2-5) and `HOST=0.0.0.0` (A1-2, and
S2-3's outside-compose half). The merge kept the relay, the closed
networks and loopback (above).

Nothing in the orchestrator needed to change. The S2-4 flags and S2-5's
network per sandbox are applied by `dockerSandbox` and `dockerToolRunner`
wherever the app runs. Under compose the app finds the relay on
`ai-office-sandboxes` by its compose service label, as outside it, and
creates and removes the sandboxes' networks through the host's Docker.

**Tests** (`docker/sandbox-isolation.pen-test.test.ts`, new
`describe("S2-1, S2-3, S2-5 · the sandboxes the app starts under compose,
and .env.example as pnpm dev reads it")`):

- under compose, the app has the socket and the work directory, compose
  itself sets `SANDBOX_GATEWAY_URL` to the relay and `SANDBOX_NETWORK` to
  `ai-office-sandboxes` (and so does `loadConfig` with compose's
  environment), the app is off the sandboxes' network, and `sandbox-dir` is
  `network_mode: none`;
- both real runners, driven with compose's configuration against a
  stand-in `docker`, put each of four sandboxes on an
  `ai-office-sandbox-<uuid>` network of its own, which only the relay joins;
- `.env.example`, through `loadConfig`, names `ai-office-sandboxes` (the
  dev compose file's network, never `bridge`) and the relay, and keeps the
  server and the callback on `127.0.0.1` and the Gateway off every
  interface.

With main's values put back (`SANDBOX_GATEWAY_URL: http://app:3047` in
compose; `SANDBOX_NETWORK=bridge` and `HOST=0.0.0.0` in `.env.example`),
the first and third fail. `startedTogether` and `after` moved to the
file's top level, unchanged, so the new `describe` can use them.

## Real output of the checks

Run at `58f4314`, the last of the three commits (the tree the full suite
passed on before the commits were split was compared file by file with it:
the same).

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
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

### `pnpm test`: exit 0

```
 Test Files  428 passed (428)
      Tests  4983 passed | 606 skipped (5589)
test exit 0
```

No test fails, so none needed checking against `origin/main`. The two
changelog failures earlier notes on this branch name are fixed by main's
`0cc16e7` (`test(web): the changelog may start with an undated heading, as
the Owner's does`). The 606 skipped are the Postgres-backed tests
(Testcontainers, no Docker here) and the `docker compose config` checks.
None is an expected fail: every finding's `it.fails` on this branch is an
`it`.

### The new and changed tests, verbose

```
✓ |deployment| docker/caddy/caddyfile.pen-test.test.ts > A1-1, A1-6 · the AI Gateway's /v1 through Caddy > is proxied by the one reverse_proxy that sends the proof, with no path matcher to send /v1 another way
✓ |deployment| docker/caddy/caddyfile.pen-test.test.ts > A1-1, A1-6 · the AI Gateway's /v1 through Caddy > gives /v1 the security headers' defaults: no header directive names a path
✓ |deployment| docker/deployment.test.ts > docker-compose.yml > puts sandboxes on a network of their own, with no route out, where the Gateway is sandbox-relay:3047 and neither the app nor Postgres is
✓ |deployment| docker/deployment.test.ts > the tls profile > proves each request came through Caddy with PROXY_SECRET, which the app and Caddy share (A1-1)
✓ |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
✓ |deployment| docker/sandbox-isolation.pen-test.test.ts > S2-1, S2-3, S2-5 · the sandboxes the app starts under compose, and .env.example as pnpm dev reads it > under compose the app starts the sandboxes on the host's Docker, and compose itself names the sandbox relay for them, whatever .env says, with the app off their network
✓ |deployment| docker/sandbox-isolation.pen-test.test.ts > S2-1, S2-3, S2-5 · the sandboxes the app starts under compose, and .env.example as pnpm dev reads it > the sandboxes the app starts with compose's configuration each have a network of their own, which only the relay joins
✓ |deployment| docker/sandbox-isolation.pen-test.test.ts > S2-1, S2-3, S2-5 · the sandboxes the app starts under compose, and .env.example as pnpm dev reads it > .env.example, set for development, names the relay and its closed network, never Docker's default bridge or the Gateway's own address, and keeps the server on loopback
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > takes PROXY_SECRET off a /v1 request Caddy sends, so neither the Gateway's request history nor the AI Provider gets it
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > keeps no X-Forwarded-* from a /v1 caller that sends no proof, as for the app's own routes
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > keeps no X-Forwarded-* from a /v1 caller that sends a wrong one, as for the app's own routes
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > a served call on /v1 carries the security headers the app's own answers do
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > a refusal without a Gateway Key on /v1 carries the security headers the app's own answers do
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > a path the Gateway does not serve on /v1 carries the security headers the app's own answers do
✓ |@ai-office/server| src/gateway-entry.test.ts > the AI Gateway on the app's port, behind Caddy (A1-1, A1-6) > sends HSTS on /v1 only over https: from the proxy that proves itself, or from an https PUBLIC_URL
Test Files  5 passed (5)
Tests  106 passed | 5 skipped (111)
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps both sides working, recorded here for the Owner to
review:

1. **Compose fixes `SANDBOX_GATEWAY_URL` to the relay**, keeping main's
   choice that compose sets it whatever `.env` says, rather than the fixes'
   `${SANDBOX_GATEWAY_URL:-}`. A `.env` copied from `.env.example` can then
   neither leave Agents idle under compose nor point them at the app.
2. **`.env.example` keeps main's "set for development" promise with the
   fixes' values.** `HOST=127.0.0.1` and the relay serve `pnpm dev` on
   Windows, macOS and Linux alike. On Linux only `GATEWAY_HOST` changes, as
   before the merge.
3. **The proof is taken off `/v1` requests even with no `PROXY_SECRET`**,
   as `rewriteUrl` does for the app's own routes. It never reaches the
   Gateway, whatever the configuration.
4. **A proven proxy's `X-Forwarded-For` still reaches the Gateway's
   request history and, on a passthrough route, the AI Provider**, as it
   did on main for every caller. Only the unproven ones are dropped (see
   below).

## Noticed, out of scope

- **No limit on wrong Gateway Keys.** `/v1` is now on the app's port and
  behind Caddy, so whatever `AI_OFFICE_BIND_ADDRESS` or the `tls` profile
  opens, the Gateway's key check is open to as well. It has no limiter
  (keys are long and random). That is the G series' (#195, H19), not a
  regression of a fix here.
- **`/v1` checks no `Host`.** A DNS-rebinding page reaching
  `localhost:3045/v1` still needs a Gateway Key, which it does not have.
  Whether the Gateway's answers carry CORS headers a page could use is
  H19's.
- **The Owner's client address goes to the AI Provider.** Behind Caddy, a
  passthrough `/v1` request forwards the proven `X-Forwarded-For` (and
  `-Proto`, `-Host`) upstream. That is hygiene only; dropping them from
  `forwardedHeaders` would be a Gateway change.
- **The S2 assessment's "Two deployment shapes"** says the app image has
  neither `git` nor the Docker CLI, so Agents work only outside compose.
  Since main, both shapes are live. The assessment is a record of its
  pinned commit and was left as written. Its compose verdicts now apply,
  and the fixes hold for them (above).
- **`sandbox-dir` runs as root**, with `network_mode: none`, and exits once
  it has made and chowned the directory. It holds no capability drop, but
  it is not a container started for an Agent (S2-4's scope).
- **The Docker CLI stage, `docker:29.5.3-cli`, is pinned by tag**, not
  digest, like the other images (H15, I series).

## What could not be verified here

There is no Docker here, so nothing ran in a container:

- **Caddy itself.** That `header_up` and `flush_interval -1` together in
  one `reverse_proxy` block send the proof and stream the Gateway's
  server-sent events is Caddy's documented behaviour, checked as text. On
  the live stack with the `tls` profile, make a `/v1/messages` call with a
  Gateway Key. Then `X-AI-Office-Proxy` must not appear in that request's
  headers in AI Settings → Gateway requests, and `curl -I
  https://<domain>/v1/messages` must show the app's CSP and HSTS.
- **Agents under compose end to end:** the app creating
  `ai-office-sandbox-<uuid>` networks through the host's Docker, joining
  the compose relay to them, and a sandbox then reaching
  `http://sandbox-relay:3047` but not `app:3045`. `AI_OFFICE_COMPOSE_E2E=1
  pnpm test` brings the stack up, and was not run.
- **The Postgres-backed tests** (606 skipped) were not run.
