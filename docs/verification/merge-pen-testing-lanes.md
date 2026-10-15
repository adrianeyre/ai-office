# Merging the pen-testing lanes — verification

Checks were run in the Sandcastle sandbox (Node 26, pnpm 12, no Docker,
no Postgres, no network beyond the registry and the model). This branch,
`feat/pen-testing`, was at `22b0ff5` and held every probe, the S1, P1,
P2, W1 and I1 fixes, and `origin/main`. `feat/pen-testing-f` was at
`f486bf6` and held the A1 (sign-in and sessions), S2 (sandbox isolation)
and G1 (Gateway Keys, Token Caps, attribution, redaction, redirects, weak
secrets, key rotation) fixes, and its own merge of `origin/main`. The two
had two merge bases (`39fbe0e` and `d4ccb23`). Four commits:

- `d665a5d` `Merge branch 'feat/pen-testing-f' into feat/pen-testing`
- `47087db` `test(pen-test): I1-10's documentation checks read the sandboxes' network as S2-3 left it`
- `ccf3615` `test(pen-test): I1's supply-chain checks read the sandbox relay and the unpublished Gateway port`
- `b222fd4` `test(pen-test): I2-1 holds since the lanes' merge: /v1 answers carry the security headers`

The probe table in `docs/pen-testing/README.md` did not conflict and is
this branch's, unchanged.

## What conflicted, and how each was resolved

Eighteen files conflicted. Each kept both sides.

| File | This branch | Lane f | Resolution |
|---|---|---|---|
| `apps/server/src/config.ts` | `allowedInternalHostSchema`, `maxAllowedInternalHosts` (I1-1); `parseEncryptionKey` | `parseVersionedEncryptionKey`, `EncryptorOptions`, `VersionedKey` (G1-9) | Both imports; `parseEncryptionKey` dropped, as nothing calls it since G1-9. `ALLOWED_INTERNAL_HOSTS` and the versioned keys both kept (they had auto-merged). |
| `docker-compose.yml` | The networks comment I1-10 wrote: a sandbox reaches the app's 3045 and 1455 beside 3047 | The sandbox relay, the app on `default` only, the internal ICC-off network, and the comment for it (S2-1, S2-3, S2-5) | Lane f's comment: since S2-3 it is what is true. The relay's `node:26.10.0-slim` is pinned by the same digest as the app image's (I1-4). |
| `docker-compose.dev.yml` | Header: the image is `docker-compose.yml`'s, pinned by the same digest (I1-4) | Header: the relay and network for `pnpm dev` (S2-1, S2-5) | Both paragraphs. The relay's image pinned by digest. |
| `docker/sandbox-images.test.ts` | Versions `:4` and their hashes (I1-4, I1-5) | Versions `:3` and their hashes (S2-1's `HTTPS_PROXY`) | The Dockerfiles auto-merged to hold both, which is neither `:3` nor `:4`, so the images are **`:5`** with the merged files' hashes. S2-1's `HTTPS_PROXY` test and I1-5's source hashing both kept. |
| `packages/orchestrator/src/sandbox/images.ts` | `:4` | `:3` | `:5`, as above. |
| `packages/orchestrator/src/sandbox/agent-tools.test.ts`, `skills.test.ts` | `:4` | `:3` | `:5`. `agent-tool-client.test.ts` and `docker-run.pen-test.test.ts`, auto-merged with `:4`, also say `:5`. |
| `docker/sandbox-isolation.pen-test.test.ts` | S2-3's pin, rewritten by I1-10 to read the 3045/1455 comment | S2-3's `it` and its regression test | Lane f's: the regression test reads the relay's comment. |
| `packages/gateway/src/gateway.ts` | `toolCallScreenPath` import; `upstreamFetch = options.fetch ?? ownerFetch()` (I1-1) | `aiProviderAgentTools` import; `takeTurn = turns()` (G1) | Both imports; `ownerFetch()` and `turns()` both. |
| `packages/gateway/src/upstream.ts` | Direct requests through `ownerFetch` and proxied ones checked for internal hosts (I1-1, ADR 0007) | `redirect: "manual"` on every request (G1-7) | Both: the request is built with `redirect: "manual"` first, then sent through `direct` (`ownerFetch`, which checks every connection) or `viaProxy` after the internal-host and proxy checks. `ownerFetch` passes `init` on, so G1-7 holds through it. Both comments kept. |
| `packages/orchestrator/src/sandbox/runner.ts` | W1-3: each sandbox's read-only token, revoked as it stops | G1: `release` of the run's held work at the Gateway | Both: the token and `release` set after the same `Promise.all`; on failure, `revokeReadOnly()` then `release?.()`. |
| `docs/guide/issue-pipeline.md` | I1-10's paragraph (3045 and 1455 reachable); the image table at `:4` with pinned versions (I1-5) | "What a sandbox reaches" and "How a sandbox is started" (S2-1 to S2-5); the table at `:3` | Lane f's sections; this branch's table, at `:5`. |
| `docs/guide/events-and-chat.md` | The Manager chat has no shell, repository tools (P2-1, P2-2) | Each turn on a network of its own (S2-5) | This branch's paragraph, followed by lane f's network sentence. |
| `docs/guide/running.md` | `POST /api/login` with any Owner password; `POST /api/login/api-key` (I1-8) | Security headers (A1-6); sessions idle out after 24 hours (A1-8) | Lane f's security-headers bullet, then this branch's two sign-in bullets with lane f's idle timeout added. |
| `docs/processes/deploying-to-ec2.md` | `TRUST_PROXY` for sign-in **and webhook** limits; the `429` troubleshooting row (W1) | `PROXY_SECRET` row and troubleshooting (A1-1) | All rows. The webhook row also names `PROXY_SECRET`: the webhook limiter keys on `request.ip`, which the app-wide `believeOnlyTheProxy` decides. |
| `docs/product-requirements-document/ai-office.md` | FR-1 to FR-3 naming every way in (I1-8) | FR-2: "or after 24 hours unused" (A1-8) | This branch's FR-1 to FR-3, with lane f's idle timeout in FR-2. |
| `packages/db/migrations/meta/_journal.json`, `0000_snapshot.json` | `id` and `when` | `id` and `when` | Only the `id` and `when` conflicted; this branch's kept. See [Schema](#schema). |

### The ADR number

Both lanes wrote an ADR 0005: this branch's
`0005-only-the-owner-accepts-role-memory.md` (P1-4) and lane f's
`0005-sandboxes-reach-only-the-gateway-and-allowed-hosts.md` (S2-1).
Different file names, so Git merged both in silently. This branch's is
the one the brief names and code cites (`role-memory-card.tsx`,
`memory/shared.ts` and others), so lane f's is now
**`0008-sandboxes-reach-only-the-gateway-and-allowed-hosts.md`**. ADR
0006 and the two guides that cited it as ADR 0005 now cite ADR 0008.
The older verification notes are left as they were written.

## Fixes that had to be reconciled

- **Sandbox images: I1-4/I1-5 and S2-1.** The Dockerfiles carry both the
  digest-pinned base, checked `gh` and `npm ci` installs, and the relay's
  `HTTPS_PROXY`. New version `:5`, as above.
- **The relay's image: S2-1 and I1-4.** S2-1's test pinned the relay to
  the bare tag `node:26.10.0-slim`, and I1-4's tests require a digest on
  every image every compose file pulls, with one digest per tag. The
  relay now runs from
  `node:26.10.0-slim@sha256:930557a2…`, the app image's digest, in all
  three compose files. S2-1's check (in the merge commit) asserts the tag
  with a digest.
- **The Gateway's upstream fetch: G1-7 and I1-1.** Above: no redirect
  followed, and no internal host reached.
- **The sandbox network's documentation: S2-3 and I1-10** (`47087db`).
  I1-10 fixed the compose comment and the guide to say a sandbox reached
  the app's 3045 and 1455, the truth before S2-3; S2-3 took the app off
  the network and wrote "sandboxes reach the AI Gateway through it, as
  sandbox-relay:3047, and nothing else of the stack", which its
  regression test reads verbatim. The I1-10 tests asserted the old wording
  and that "nothing else of the stack" appeared nowhere, so the two
  findings' tests contradicted each other. I1-10's property is that the
  documents say what a sandbox reaches. Its tests still refuse the old
  false claim ("as app:3047 and nothing else of the stack"). Where the
  comment now says nothing else is reached, they check the compose file
  itself: the sandbox relay is the only service on the sandboxes'
  network. The guide sibling reads lane f's "What a sandbox reaches"
  section. `I1.md` records this beside I1-10.
- **I2-1, fixed by lane f** (`b222fd4`). Lane f's `175484e` (from its merge
  of `origin/main`) has `gatewayEntry` set the app's security headers on
  `/v1`. I2-1's `it.fails` therefore passed, which Vitest reports as a
  failure. As the findings workflow says, it is now an `it`, and its pin
  a regression test: the app's own hooks still never run for `/v1`, but
  `/v1` answers carry nosniff, Referrer-Policy, X-Frame-Options and the
  CSP. `I2.md` marks I2-1 fixed by `175484e`.
- **Two I1 supply-chain checks** (`ccf3615`). "Binds the app, the OAuth
  callback and the Gateway to the host's loopback only" expected 3047
  published on loopback. Main's one entry point stopped that, so the test
  **already failed on `feat/pen-testing` at `22b0ff5`** (run with that
  commit's `docker-compose.yml`: `× binds the app, the OAuth callback and
  the Gateway to the host's loopback only`). It now checks 3047 is only
  exposed, never published. "The sandbox images install nothing by
  piping a fetched script into a shell" read every `docker/sandbox-*`
  directory as an image and failed on S2-1's `docker/sandbox-relay`
  (`ENOENT … docker/sandbox-relay/Dockerfile`). The relay has no image of
  its own, so it is passed over, and the check now asserts it read the
  three sandbox images.
- **W1's webhook limiter and A1-1's `PROXY_SECRET`.** No code change. The
  webhook route keys on `request.ip`, which the app-wide `rewriteUrl`
  (`believeOnlyTheProxy`) decides, so a forged `X-Forwarded-For` without
  the proxy's secret buys no new bucket there either.

No test was skipped, deleted or loosened to reach green. The five
`it.fails` left are I2-2, I2-3, I2-4 (two) and I2-5, all `open` in
`I2.md`. No finding marked fixed has one.

## Schema

`0000_schema.sql` auto-merged. Lane f's only schema change is
`sessions.last_seen_at` (A1-8). This branch's schema changes were already
in the file. The snapshot conflicted only on `id`, and the journal only on
`when`.

`pnpm --filter @ai-office/db exec drizzle-kit generate`:

```
No config path provided, using default 'drizzle.config.ts'
Reading config file '/home/agent/workspace/packages/db/drizzle.config.ts'
54 tables
agent_cap_pauses 10 columns 0 indexes 2 fks
agents 19 columns 2 indexes 3 fks
…
sessions 6 columns 1 indexes 2 fks
…
work_queue 11 columns 3 indexes 2 fks

No schema changes, nothing to migrate 😴
```

As a second check, `pnpm --filter @ai-office/db db:generate` was run on a
copy of the migrations. It deletes the folder and writes the schema again
from `schema.ts` and `schema-extras.sql`. Its `0000_schema.sql` was
byte-identical to the merged one, and its snapshot was equal except for
the `id`. The merged files were then put back.

The migration tests (`pnpm --filter @ai-office/db exec vitest run`):

```
 Test Files  3 passed (3)
      Tests  9 passed | 6 skipped (15)
```

The six skipped are "migrations against Postgres 18", which need Docker
for Testcontainers:
`Docker is not available (Could not find a working container runtime
strategy), so the Postgres integration tests are skipped. They run in CI
and on the host.` The two offline migration tests pass: the journal lists
every SQL migration in order, and each is dated later than the one
before.

## Checks

`pnpm lint`:

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck`: `tsc` for the root and every package, each `Done`, exit 0.

`pnpm test`:

```
 Test Files  482 passed (482)
      Tests  5674 passed | 5 expected fail | 616 skipped (6295)
   Duration  157.72s (tests 67%, import 20%, transform 5%, environment 5%, setup 3%)
```

Before the follow-up commits, the merged tree gave `Test Files  1 failed |
481 passed`, with I2-1's pin and `it.fails` failing (above). The I1-10 and
supply-chain failures had been caught earlier, running `docker/` and
`test/` alone. The skipped tests need Docker, Postgres or a browser, as
on `feat/pen-testing` before the merge.
