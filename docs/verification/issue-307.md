# Issue #307: [fix] I1-4 — Base and stack images are pinned by tag, not digest — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0,
npm 11.19.1, git 2.39.5; no Docker and no Postgres). Unlike earlier runs,
this sandbox could reach Docker Hub and GitHub as well as the npm
registry, so every digest below was read from Docker Hub, not written
from memory. The fix is commit `41f2fd7`,
`fix(security): I1-4 every image the stack runs is pinned by digest, so a re-pointed tag serves nothing new`,
on top of `8369e57`. Its blocker, the I1 probe (#197), is in the tree:
`docs/pen-testing/assessments/I1.md` and
`docker/supply-chain.pen-test.test.ts`.

This is the remediation of finding **I1-4** (`severity:low`, H15). This
run also works I1-5 (#309), I1-6 (#311) and I1-7 (#313), each its own
commit and note; the full output of the checks, run once on the finished
tree, is [below](#real-output-of-the-checks).

## What was fixed

`postgres:18-alpine` and `caddy:2-alpine` in compose, and every
Dockerfile's `FROM`, were tags: whatever a tag pointed at on the day of a
pull or build was what ran.

Every image the stack pulls now carries the digest its tag named on
2026-10-11 (the OCI index, so every architecture), beside a tag that says
which release it is. Docker pulls the digest; a re-pointed tag changes
nothing.

| Where | Was | Is |
| --- | --- | --- |
| `docker-compose.yml` `postgres` | `postgres:18-alpine` | `postgres:18.6-alpine@sha256:77f58511…` |
| `docker-compose.yml` `caddy` | `caddy:2-alpine` | `caddy:2.11.7-alpine@sha256:d8542f48…` |
| `docker-compose.yml` `sandbox-dir` | `alpine:3.22` | `alpine:3.22.6@sha256:5291449c…` |
| `Dockerfile` (app) | `docker:${DOCKER_CLI_VERSION}-cli`, `node:${NODE_VERSION}-slim` | each `@sha256:…` (`11e1133c…`, `930557a2…`) |
| `docker/sandbox-*/Dockerfile` | `node:${NODE_VERSION}-bookworm` | `…@sha256:e6cfc351…` |

The specific tags were the ones sharing each floating tag's digest on
Docker Hub that day (`18-alpine` = `18.6-alpine`, `2-alpine` =
`2.11.7-alpine`, `3.22` = `3.22.6`). The `NODE_VERSION` and
`DOCKER_CLI_VERSION` ARGs stay, since the tests and `node --version`
checks read them; the digest is literal in each `FROM`, and a comment
beside it says a new version needs its digest too, and how to read one
(`docker buildx imagetools inspect <image>:<tag>`).

### Sibling paths

- **The development stack** (`docker-compose.dev.yml`, which `pnpm dev`
  starts) and **the pen-test stack** (`docker/pen-test/compose.yml`: its
  Postgres and the stub upstream's `node:26.10.0-slim`) are pinned the
  same way.
- **The images the tests run**: Testcontainers' Postgres
  (`packages/db/src/testing/docker.ts`, now the stack's own digest) and
  Mailpit (`packages/communications/src/mailpit.ts`,
  `v1.27.11@sha256:e22dce5b…`). hadolint's was already pinned.
- **The sandbox images are version 3**: their Dockerfiles changed, and
  `docker/sandbox-images.test.ts` requires a new tag when they do.
- **The EC2 upgrade guide** promised "newer Caddy 2 and Postgres 18
  images" from `docker compose pull`; it now says pulls fetch what the
  version of AI Office pins, and new images arrive with an upgrade.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "every
      image the stack runs is pinned by digest, so a re-pointed tag
      cannot serve new code" is an `it`; its assertion
      (`references.every(byDigest)`) is unchanged. The compose images it
      checks now leave out the one compose builds itself
      (`ai-office:local`, `build: .`), which is never pulled: its content
      is its Dockerfile's, whose base images are in the same list. Its
      comment that ARG-based references "can never carry a digest" was
      wrong and is gone.
- [x] **The "pins today" tests become regression tests; neither is
      deleted.**
      - "regression (I1-4): the compose images are no longer bare tags, so
        a re-pointed tag serves nothing new" (`postgres:18-alpine` and
        `caddy:2-alpine` are gone; the pinned ones are there; none is
        without a digest);
      - "regression (I1-4): every Dockerfile base image carries a digest
        beside its tag or build ARG". This pin had failed before this
        work, since the app's `docker:…-cli` stage was merged from `main`
        after the probe; it now covers that stage too.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "the development and pen-test stacks pin every image they pull by
        digest";
      - "the images the tests run (Postgres, Mailpit, hadolint) are pinned
        by digest";
      - "each tag has one digest everywhere, so no copy is left behind
        when a pin moves" (the ARGs filled in, so the app's
        `node:26.10.0-slim` and the stub upstream's must agree);
      - `docker/sandbox-images.test.ts` and `docker/deployment.test.ts`
        now require the digest in each `FROM`, and
        `docker/pen-test/compose.test.ts` the stub's digest.
      Mutation check: see [below](#mutation-check).
- [x] **The assessment's findings table marks `I1-4` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #307) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on five tests in the `deployment`
      and `repository` projects that failed before this work and fail the
      same after; every other test passes. Before this work there were
      six: the sixth was this finding's own pin, which now passes. See
      [Noticed, out of scope](#noticed-out-of-scope).

### The probe tests, verbose (I1-4)

```
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > regression (I1-4): the compose images are no longer bare tags, so a re-pointed tag serves nothing new
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > regression (I1-4): every Dockerfile base image carries a digest beside its tag or build ARG
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-4 (H15): images are pinned by tag, not digest > every image the stack runs is pinned by digest, so a re-pointed tag cannot serve new code
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-4 siblings: the development and pen-test stacks, and the images the tests run > the development and pen-test stacks pin every image they pull by digest
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-4 siblings: the development and pen-test stacks, and the images the tests run > the images the tests run (Postgres, Mailpit, hadolint) are pinned by digest
✓ |deployment| docker/supply-chain.pen-test.test.ts > I1-4 siblings: the development and pen-test stacks, and the images the tests run > each tag has one digest everywhere, so no copy is left behind when a pin moves
```

### Mutation check

With Caddy put back to `caddy:2-alpine` in `docker-compose.yml`, the stub
upstream to `node:26.10.0-slim` in the pen-test stack, and one sandbox
Dockerfile's Node digest changed by one character, four I1-4 tests fail:
the first regression test, the former `it.fails`, the other stacks'
sibling and "each tag has one digest everywhere". Put back, all pass.

## Decisions

For the Owner to review.

1. **Tag and digest, not digest alone.** `postgres:18.6-alpine@sha256:…`
   rather than `postgres@sha256:…`: Docker uses the digest and ignores
   the tag, but the tag says which release is pinned, and the specific
   tag (18.6, not 18) says it exactly.
2. **The digest is of the multi-architecture index**, not one platform's
   image, so the stack still runs on amd64 and arm64 (an EC2 Graviton
   instance, an Apple-silicon Mac).
3. **The ARGs stay.** `NODE_VERSION` and `DOCKER_CLI_VERSION` are read by
   the tests (minimum versions, `node --version` in the image), so they
   keep naming the release; the digest beside them is literal. Changing
   an ARG without its digest builds the old digest's image, and the
   Docker-only image test (`node --version` equals `NODE_VERSION`) fails.
4. **Moving a pin is by hand.** There is no Renovate or Dependabot in the
   repository; the comments say how to read a tag's digest. Security
   updates to these images now arrive only when someone moves the pin,
   which is the trade-off digests make.
5. **The test images are pinned too** (Postgres, Mailpit). They run in CI,
   not the stack, but they are pulled and run the same way, and the
   integration tests now run against the very Postgres the stack pins.

## Noticed, out of scope

- **Five tests fail before and after this work**, all from changes merged
  from `main` after the probes were written, as
  [#301's note](issue-301.md#noticed-out-of-scope) records: two I1-9
  tests (`.env.example` was rewritten), the published-ports test in
  `supply-chain.pen-test.test.ts` (the Gateway's 3047 is no longer
  published), one in `caddyfile.pen-test.test.ts` (Caddy proxies `/v1`
  now) and one in `pen-test/compose.test.ts`. The ports test sits in this
  probe file but asserts a different property (bullet 1), so it was left
  for the assessment that owns the one entry point.
- **Debian packages** in the images (`git`, `curl`, `jq`,
  `ca-certificates`) still come from Debian's archive at whatever version
  it serves; apt checks them against Debian's keys, which come with the
  digest-pinned base image. Pinning their versions breaks builds as
  Debian drops old versions, as the Dockerfiles' comments say.

## What could not be verified here

- **That Docker pulls the pinned digests:** no Docker here. On a host,
  `docker compose pull` and `docker compose --profile tls up --build`
  should fetch exactly these digests (`docker image ls --digests`), and a
  build of each image should succeed with `FROM <tag>@<digest>`.
- **Testcontainers with a digest reference:** its `ImageName` parses
  `name:tag@sha256:…` (read in `testcontainers` 12.2.0), but no container
  was started here; CI's Postgres and Mailpit tests will.

## Real output of the checks

Run once, on the finished tree with all four fixes (`5e0b3f3`). The test
output is cut to its failures and summary.

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
packages/communications typecheck$ tsc
packages/orchestrator typecheck$ tsc
apps/web typecheck$ tsc
packages/gateway typecheck$ tsc
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
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > pins today: .env.example says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
 FAIL  |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
 FAIL  |deployment| docker/supply-chain.pen-test.test.ts > bullet 1: the deployment's published ports (HOLDS) > binds the app, the OAuth callback and the Gateway to the host's loopback only
 FAIL  |deployment| docker/caddy/caddyfile.pen-test.test.ts > Caddy where it holds > proxies to the app's web port only, never the Gateway
 FAIL  |deployment| docker/pen-test/compose.test.ts > no secret shared with the real stack > holds none of the root .env.example's values, nor any other secret
…
 Test Files  4 failed | 466 passed (470)
      Tests  5 failed | 5179 passed | 86 expected fail | 603 skipped (5873)
   Duration  190.37s (tests 62%, import 23%, transform 7%, environment 5%, setup 3%)
exit 1
```

Before any of these fixes (at `8369e57`), the `deployment` and
`repository` projects alone:

```
 Test Files  4 failed | 14 passed (18)
      Tests  6 failed | 199 passed | 16 expected fail | 13 skipped (234)
```

the same five, and "pins today: every Dockerfile base image is a tag or a
build ARG, never a digest".
