# Issue #317: [fix] I1-9 — .env.example says the Gateway "has no authentication of its own yet (Gateway Keys come later)" — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker). The fix is commit `af6fac8`,
`fix(security): I1-9 .env.example, and every other start-up comment on the Gateway, says a Gateway Key is required`,
on top of `3dcb32d` (I1-8's fix, #315). Both fixes touch
`test/documentation-drift.pen-test.test.ts`, and they share its helpers.
The blocker, the I1 probe (#197), is in the tree:
`docs/pen-testing/assessments/I1.md` and
`test/documentation-drift.pen-test.test.ts`.

This is the remediation of finding **I1-9** (`severity:low`, H17). The
full output of the checks, run once on the finished tree for all four
fixes, is in [#315's note](issue-315.md#real-output-of-the-checks).

## What was fixed

At the probe's commit (`7b0bdb4`), `.env.example` said the AI Gateway
"has no authentication of its own yet (Gateway Keys come later)". The
code refuses every request without a Gateway Key, and the guide says so.

**The comment itself was already fixed when this run began.** `main`'s
`3b8565c` ("chore(env): .env.example is set for development, so copying
it is enough") rewrote it as "Every request needs a Gateway Key, but it
listens on no more than it must". That commit reached this branch with
`eeed297`, the merge of `origin/main` after the probe. So the finding's
`it.fails` already passed (vitest counts that as a failure), and its pin
already failed. Both are in the five failures
[#307's note](issue-307.md#noticed-out-of-scope) records.

So this fix is to the tests and the assessment. The `.env.example`
wording was checked against the code first: `packages/gateway` answers
`401` without a key in use, and the config says the same.

### Sibling paths

Every other comment an Owner reads on how the Gateway is reached was
read, and each already says a Gateway Key is required:

- `.env.example`, in both places: its own port (`GATEWAY_PORT`), and
  `/v1` on the app's address (`AI_OFFICE_BIND_ADDRESS`);
- `docker-compose.yml`'s header;
- `docker/pen-test/compose.yml` and `docker-compose.dev.yml`, which say
  nothing to the contrary;
- `apps/server/src/config.ts`'s comment on `GATEWAY_PORT`.

They are now tested, so the drift cannot come back unseen.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.**
      ".env.example says a Gateway Key is required, as the code demands
      and the guide says" is an `it`. Its assertion is kept, and it now
      also checks that both places `.env.example` describes the Gateway
      say "Every request needs a Gateway Key" and "every Gateway request
      needs a Gateway Key".
- [x] **The "pins today" test becomes a regression test; it is not
      deleted.** "regression (I1-9): .env.example no longer says the
      Gateway 'has no authentication of its own yet (Gateway Keys come
      later)'" checks that neither phrase appears, read across comment
      lines, and that no "no authentication" appears at all.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "none says the Gateway has no authentication, or that Gateway
        Keys come later" covers `.env.example`, `docker-compose.yml`,
        `docker/pen-test/compose.yml`, `docker-compose.dev.yml` and
        `apps/server/src/config.ts`;
      - "the compose file and the server's configuration say every
        Gateway request needs a Gateway Key".

      Mutation check: with `.env.example` as it was at `7b0bdb4`, the
      regression test, the former `it.fails` and the first sibling fail.
      With today's file, they pass.
- [x] **The assessment's findings table marks `I1-9` fixed.** The row
      reads **fixed** (issue #317), with the commit's subject, and
      credits `3b8565c` for the wording.
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. The two I1-9 tests that failed before this work
      now pass. `pnpm test` still fails on three older tests that this
      work does not touch (see
      [#315's note](issue-315.md#noticed-out-of-scope)).

### The probe tests, verbose (I1-9)

```
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > regression (I1-9): .env.example no longer says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > confirms the code and the guide require a Gateway Key on every request
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-9 (H17): .env.example says the Gateway has no authentication > .env.example says a Gateway Key is required, as the code demands and the guide says
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-9 siblings: every start-up comment on the Gateway says a Gateway Key is required > none says the Gateway has no authentication, or that Gateway Keys come later
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-9 siblings: every start-up comment on the Gateway says a Gateway Key is required > the compose file and the server's configuration say every Gateway request needs a Gateway Key
```

## Decisions

These are for the Owner to review.

1. **No change to `.env.example`.** Its wording since `3b8565c` already
   says what the issue asks for. Rewriting it only to have a change in
   this commit would churn a file the Owner copies. The commit is the
   tests that hold it, plus the assessment.

## Noticed, out of scope

- **PRD §7, "The AI Gateway is reachable only from the compose network,
  the sandboxes and holders of Gateway Keys."** Since the one entry
  point, the Gateway's `/v1` is reachable wherever the app's address is
  opened, still behind a Gateway Key, as ADR 0001's consequences say.
  The sentence is true if "holders of Gateway Keys" is read as "anyone,
  but only with a key". It could say so more plainly. The issue does
  not ask for this change to the canon.
- **The three older failures and the one-off whiteboard timeout:** see
  [#315's note](issue-315.md#noticed-out-of-scope).

## What could not be verified here

Nothing in this fix runs. That the Gateway refuses a request without a
key is covered by `packages/gateway`'s own tests and by G1's probes.
