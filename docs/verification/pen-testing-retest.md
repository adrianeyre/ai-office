# Pen-testing round one: the retest

The retest is step 7 of the
[pen-testing PRD](../product-requirements-document/pen-testing.md)'s
Sequence. It was run on 2026-10-11 on the merged branch: every probe, the
enablement work (E1 to E5), and the remediations from the three lanes
merged together. The checks were run in the Sandcastle sandbox: Node
26.10.0, pnpm 12.10.0, git 2.39.5, no Docker, no Postgres, no browser, no
live model, no GitHub token, and no network beyond the registry and the
model. The code was retested at `6752f2e`. The commits after it change
documents only, and the checks below were run on the finished tree.

## What the retest did

- **Made the merged branch whole.** `pnpm lint`, `pnpm typecheck` and
  `pnpm test` already passed on the merged branch (`df3e993`): 483 test
  files, 5,704 tests passed, 616 skipped, none expected to fail. The code
  that more than one lane's fixes touch was read for agreement:
  - **The security headers.** One `securityHeaders` is used for the app's
    answers (A1-6), for `/v1` through `gatewayEntry`'s `before` (A1-6 on
    the Gateway, `175484e`; I2-1) and for the sign-in callback on 1455
    (I2-1's sibling, `25917ac`). Caddy only fills gaps.
  - **The limiter.** Sign-ins and the Owner's fresh proofs share one
    limiter (A1-3, A1-4), replayed from `sign_in_events` at start (A1-7).
    Gateway Keys at `/v1` have their own, with the same limits (I2-3).
    Every client address comes from `believeOnlyTheProxy` (A1-1), the
    webhook limiter's too (W1-4).
  - **`/v1`.** The proxy's proof is taken off (A1-1) and the headers set
    (A1-6) before the Gateway answers. A request without a key in use is
    refused before its body is read (I2-2) and counted (I2-3). A paused
    Agent's or archived Floor's key is refused (G1-4).
  - **The compose file.** The app is on `default` only (S2-3). The relay
    is the only container on the sandboxes' network (S2-1, S2-5) and is
    pinned by the app image's digest (I1-4). The work directory is out of
    `/tmp`, refused when it is a link, and private (I2-4, I2-5).
    `PUBLISHED_ADDRESS` lets the server refuse the sample secrets beyond
    loopback (G1-8). Its comments say what a sandbox reaches (I1-10).
  - **The Merge Policy.** Only a head every required reviewer approved is
    merged (P1-1), and only when shown in full (P1-11). A change to what
    CI runs or later Agents read goes to the Owner (P1-2, P1-3). The
    Owner's Approve and merge merges only the head the Notice named
    (W1-6).
  - **Gateway Keys.** Calls bill the issue AI Office gave the work (G1-1)
    and run one at a time once capped (G1-2). Owner tools are held to the
    caps (G1-3). Adding a UI-capable key needs a fresh proof (A1-3).

  Every finding's probe tests pass, and nothing a later fix undid was
  found.
- **Turned the one leftover "pins today" test.** I2's probe pinned that a
  copied `.env` yields the public sample secrets, re-confirming G1-8. G1-8
  is fixed (`238fb5d`), so the pin is now a regression test (`6752f2e`).
  It also drives the real `loadConfig` as compose hands it
  `AI_OFFICE_BIND_ADDRESS`: on the host's loopback the samples run, and
  published beyond it the server refuses all three.
- **Retested every finding.** Each of the 62 has its fix commit in its
  assessment's Status column (`4beb6f1`). 61 are fixed, and P2-3 is
  `open: the Owner's decision (#199)`. The 55 probe test files hold no
  `it.fails`. Each finding's `it.fails` is a plain `it` that passes, and
  each test that pinned the old behaviour is a regression test. Run alone
  with the verbose reporter: `Test Files  55 passed (55)`, `Tests  678
  passed (678)`, none skipped. Every one of the 55 is named by an
  assessment. The cross-reference test (`test/pen-testing.test.ts`)
  passes.
- **Updated the register** (`3c39b58`, `b375a56`). The PRD's Status is
  the round's. Each of H1 to H21 has one retest line. The findings that
  confirmed no hypothesis are a table after H21, and "Confirm, don't
  re-test" notes the two lines that no longer held as written.
- **Updated the probe table** in
  [`docs/pen-testing/README.md`](../pen-testing/README.md) (`4a146ac`):
  one row per probe, the gates this branch meets, and "For the Owner".

## The findings

| Probe | critical | high | medium | low | Fixed | Open |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | 2 | | | | 2 | |
| A1 | | 3 | 4 | 2 | 9 | |
| S2 | | 3 | 2 | | 5 | |
| P1 | | 1 | 10 | | 11 | |
| P2 | | 3 | 1 | | 3 | P2-3 (high) |
| G1 | | 1 | 5 | 3 | 9 | |
| W1 | | | 2 | 4 | 6 | |
| I1 | | | 1 | 10 | 11 | |
| I2 | | | | 5 | 5 | |
| **All** | **2** | **11** | **25** | **24** | **61** | **1** |

## The success criteria

### 1. Every scope issue filed, labelled and anchored before the window opens

**Met on this branch, as far as the repository records it.** Every probe
and enablement issue has its verification note, and every probe its
assessment against a pinned commit:

- E1 to E5: #187 to #191;
- the probes: S1 #186, A1 #192, S2 #193, P1 #194, G1 #195, W1 #196,
  I1 #197, P2 #205 and I2 #287;
- the Owner's: O1 #198 and O2 #199.

Each assessment's header names its trust boundary, attacker positions,
hypotheses and governing FRs, glossary terms and ADRs. The window has
not opened. The labels are on GitHub, which this sandbox cannot read
(no `GH_TOKEN`); the Owner confirms them there.

### 2. H1 has a dated answer before the window opens

**Met.** S1 confirmed H1 on 2026-10-11
([S1.md](../pen-testing/assessments/S1.md)). Both findings were fixed the
same day: S1-1 by `dd458e7`, so that host-side git runs nothing an Agent's
repository names, and S1-2 by `fbd4c71`, so that Sandcastle's host-side
git does neither. The S1 probe tests pass as plain `it`s (34 tests in
three files). The detonation through the Docker socket is for the live
window.

### 3. The pen-test stack stood up, seeded, reachable only by the red team, and torn down with its volumes

**The Owner's to do (#198).** The stack, its seed and its teardown are
built and tested offline: E1 (#187) and E2 (#188), documented in
[stack.md](../pen-testing/stack.md). It has never been stood up, as this
sandbox has no Docker. The tests that bring it up are among those
skipped.

### 4. Every reported finding filed as a labelled issue within one day of its assessment

**Met on this branch for the remediations; the Owner confirms the finding
issues.** All nine assessments and all 62 fix commits are dated
2026-10-11. Each finding has its remediation issue: #201, #203, and the
odd numbers from #211 to #285 and from #289 to #331, one per finding,
each with its verification note. The `[finding]` issues and their labels
are on GitHub, which this sandbox cannot read.

### 5. The exposure gate: every critical remediated before AI Office is served beyond localhost

**Met on this branch.** The round's only criticals, S1-1 and S1-2, are
fixed (above). Passing the gate is the Owner's (#199). The Owner first
re-rates any finding rated against a loopback-only deployment
([the runbook](../pen-testing/triage-runbook.md#re-rating-when-a-premise-changes)),
and the live window may still find a critical this round did not.

### 6. The public-release gate

**Not met: the Owner's to do (#199).**

- **Every finding above low remediated or waived in writing:** all but
  one. P2-3 (high) is open. Its fix (`f6f0794`) binds a chat Batch's Plan
  to the Owner's own words with a separate model call, so a Plan the
  check refuses files nothing. But the check is a model's judgement, not
  a deterministic rule.
  [issue-243.md](issue-243.md#decisions-for-the-owner) puts four options
  to the Owner. Until the Owner waives P2-3 in writing, or chooses an
  option and its fix lands, this part is not met.
- **Whether a human external round is required:** not yet decided. The
  round was an AI red team, recorded as reviewed by a different brief,
  not independently tested.

### 7. The documents describe the surface the code has (H17)

**Met on this branch.** FR-1 and FR-2 name every way the Owner signs in
(I1-8, `3dcb32d`). `.env.example` and every start-up comment say a
Gateway Key is required (I1-9, `af6fac8`). The compose file's comments
say a sandbox reaches the Gateway through the sandbox relay and nothing
else of the stack (I1-10, `1413188`, reconciled with S2-3 in `47087db`).
`test/documentation-drift.pen-test.test.ts` holds each to the code, and
all 14 of its tests pass. Two things stay with the Owner:

- whether the documents read clearly to an Owner hardening a deployment
  (I1-8's note);
- FR-55 in `ai-office.md`, which still says Role memory is "accepted by
  the Manager or the Owner", where ADR 0005 (P1-4) has only the Owner
  accept it.

Both are listed in [For the Owner](../pen-testing/README.md#for-the-owner).

## Real output of the checks

Run on the finished tree. Each exited 0. From `pnpm test`, the lines
between its start and its summary are left out where marked `…`: they
are what tests print (semantic-release's log, deprecation warnings).

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck`: exit 0

```
$ tsc && pnpm --recursive typecheck
packages/db typecheck$ tsc
packages/github typecheck$ tsc
packages/shared typecheck$ tsc
packages/db typecheck: Done
packages/shared typecheck: Done
packages/events typecheck$ tsc
packages/github typecheck: Done
packages/events typecheck: Done
apps/web typecheck$ tsc
packages/gateway typecheck$ tsc
packages/communications typecheck$ tsc
packages/orchestrator typecheck$ tsc
packages/communications typecheck: Done
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

### `pnpm test`: exit 0

```
$ vitest run

 RUN  v5.0.3 /home/agent/workspace

…

 Test Files  483 passed (483)
      Tests  5704 passed | 616 skipped (6320)
   Start at  22:15:21
   Duration  160.15s (tests 67%, import 20%, transform 6%, environment 5%, setup 3%)
```

The 616 skipped tests each say why, from the verbose reporter:

| Skipped | Reason |
| --- | --- |
| 587 | Docker is not available, so the Postgres integration tests are skipped (they run in CI and on the host) |
| 15 | `GITHUB_APP_ID` is not set, so the GitHub contract suite does not run against the real App |
| 3 | Docker is not available, so the email contract tests against Mailpit are skipped |
| 3 | hadolint is not installed, and Docker is not available |
| 3 | `AI_OFFICE_SANDBOX_IMAGE_E2E` is not 1 (building the sandbox images) |
| 3 | Docker Compose is not available |
| 1 | Neither caddy nor a running Docker daemon is available |
| 1 | `AI_OFFICE_COMPOSE_E2E` is not 1 (bringing the stack up) |

None of them is a probe test. No test was skipped, deleted or weakened to
reach this state.

## What could not be verified here

Everything that needs the live pen-test stack, as each assessment's
"Could not be exercised here" says:

- a live model's judgement (P2-3's check above all, P1's injections);
- Docker (S1's hook reaching the socket, S2's networks and the relay,
  S2-4's run flags, I2's work directory as a second host user);
- Caddy, the EC2 set-up and its metadata hop limit;
- GitHub's own behaviour (W1's redelivery, the App's tokens).

That is the window, #198.

## Host-only failures

On the host, with Docker, `pnpm test` gave 10 failures in 7 files that
this sandbox skips (`Tests  10 failed | 6291 passed | 19 skipped`). CI
runs with Docker and would fail the same way. Each one is below with its
cause and its fix, one commit per cause. No security fix was undone, and
no test was skipped, deleted or weakened. **They are to be verified on
the host, with Docker, after this run**: this sandbox has no Docker, so
the failing tests themselves still skip here.

Where the logic could run without Docker, a test now runs it here. The
Postgres tests changed below (the re-seal, the session, TOTP, the
credentials CLI and all 20 work queue cases) were also run, outside the
committed tests, against PGlite 0.5.8 (PostgreSQL 18.3) through
`@electric-sql/pglite-socket`, with one connection at a time. Each
passes there. The re-seal test and the credentials CLI test also fail
there as they did on the host before their fixes. Neither tool is a
dependency of the repository.

| # | Failure | Stale test, or wrong code | Cause | Fix |
| --- | --- | --- | --- | --- |
| 1 | `docker/deployment.test.ts`: `--profile tls` config resolved `sandbox-relay` too | Stale test | S2-1 put the sandbox relay in the stack with no profile: it is the sandboxes' only way to the Gateway and the internet. The Docker test still listed the services from before it. | `6e87311`: the Docker test and a new static check read one list, `sandbox-relay` included. |
| 2–4 | `docker/sandbox-images.test.ts`: hadolint SC3011 on the claude, codex and opencode images | Wrong code | gh's checksum was checked with a here-string, `sha256sum --check --strict <<<"…"`. hadolint's ShellCheck read it as POSIX sh, though each file sets `SHELL` to bash. | `370d95e`: the checksum line is written with `printf` beside the download and checked from that file, before anything is unpacked (I1-5 holds). This builds the same under sh or bash. The images are now **`:6`**, with their new hashes, so rebuild them with `pnpm sandbox:build`. A static check refuses a here-string in any `RUN`. |
| 5 | `docker/pen-test/compose.test.ts`: `PEN_TEST_TARGET_REPOSITORY is missing a value` | Stale test | The seed service (E2) requires the Owner's target repository, and stand-up checks it, so compose is right to refuse without it. The test's stand-ins predated it. | `11ff0dd`: the stand-ins are one list, the target repository among them. A static check holds that list to every `${…:?}` variable the compose file requires. |
| 6 | `docker/pen-test/credentials.test.ts`: `credentials-cli.ts mint` refused its own package | The test's database | testcontainers' default database password is `test`. The CLI is given only `DATABASE_URL`, so `forbiddenValues` held `test`, and the package's `"Pen-test red team"` holds that word. The check was right to refuse it. Stand-up gives the stack a random password, so it never matched there. | `efc9d6d`: the check is unchanged. The Postgres test harness gives each container a random password, as stand-up and the e2e setup already do. A unit test pins the cause: `test` is refused, and a random password is not. Under PGlite, the CLI fails with the host's exact message when the password is `test`, and mints with a random one. |
| 7 | `apps/server/src/reseal.test.ts`: `owner_totp_enabled` refused the row | Wrong test | `owner_totp_enabled` comes from TOTP's own schema (`f9f3d63`), not from a fix. It holds a TOTP secret only with `totp_enabled_at`. G1-9's test inserted the secret alone, so nothing was re-sealed. | `5d50fc0`: the row turns TOTP on with both, as the app does. The three inserts after it, which the host never reached, meet their tables' constraints. |
| 8 | `apps/server/src/auth/store.test.ts`: the found session had `lastSeenAt: null` | Stale test | A1-8 added `sessions.last_seen_at` for the 24-hour idle timeout. A session not used since it began reads `null`, and the timeout counts from `createdAt`. | `961a521`: the expected session has `lastSeenAt: null`. |
| 9 | `apps/server/src/auth/store.test.ts`: `/api/totp/setup` gave no secret | Stale test | Since A1-3, setup needs a fresh proof: the Owner's current password (and a code, when TOTP is on). The route does require it: an empty body gets `403 proof_required`, and nothing is set up. The proof is also recorded in `sign_in_events` (A1-4). | `4735689`: the test checks that refusal, sets up with the password, and expects the proof's row among the sign-in events. The flow is now one function, run against Postgres and in memory, so it runs here too. |
| 10 | `packages/orchestrator/src/work/queue.test.ts`: review round #4 started while its Floor's required reviewer was paused (`[1, 3, 2, 4, 5]`) | Wrong code | No round-one fix changed this order: P1, G1-2 and W1 touched neither the queue nor its store. The new order is wrong. The queue read the paused Agents before each claim. A search that began before the reviewer reached a Token Cap could find a review round queued after it, and start it. In Postgres, the round's insert can land on another connection mid-claim. With one connection, the same case passes. | `8e43733`: once a claim returns, the queue reads the paused Agents again. If any is newly paused, the work goes back to the queue and the search looks again. A new memory test pauses the reviewer and queues the round during a search. It failed with `[4]` before the fix and passes now. |

What the host is to confirm, after this run: `pnpm test` with Docker
gives no failures, hadolint finds nothing in the three images, and the
two `docker compose config` checks pass.

The checks here, run on the finished tree, each exited 0:

- `pnpm lint`: `All matched files use Prettier code style!`
- `pnpm typecheck`: every package `Done`.
- `pnpm test`:

  ```
   Test Files  483 passed (483)
        Tests  5712 passed | 616 skipped (6328)
  ```

  That is eight tests more than above, the eight new ones that run
  without Docker. The same 616 skip, for the reasons in the table above.
