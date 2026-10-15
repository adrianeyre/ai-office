# Issue #275: [fix] G1-4 — An Agent's Gateway Key outlives its Agent's work — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `47eb66f`,
`fix(security): G1-4 a paused Agent's Gateway Key, an archived Floor's and a paused Communications Agent's call no model`,
on top of G1-3's `5ca0ed8` (#273). Its blocker, the G1 probe (#195), is in
the tree: `docs/pen-testing/assessments/G1.md` and
`apps/server/src/gateway-keys/agent-keys.pen-test.test.ts`.

This is the remediation of finding **G1-4** (`severity:medium`, new). The
real output of the checks, run once on the finished tree for all four
fixes of this run, is in
[issue-269.md](issue-269.md#real-output-of-the-checks).

## What was fixed

Only rotating an Agent's key, or removing the Agent, ended the key. A key
a sandbox held, or one taken from it (P2-1, S2-1), kept calling models
after the Owner paused the Agent (FR-11) and after the Owner archived its
Floor, "which stops all work" (FR-9).

Now the Gateway's keys go through `keysAtWork`
(`apps/server/src/gateway-keys/agent-keys.ts`), which the server wires in
front of `createGatewayKeys`:

- **An Agent's key is in use only while its Agent is enabled and its
  Floor is not archived.** Both are read from the stores at every call,
  so a pause or an archive stops the key from the next call: the Gateway
  answers `401` ("That Gateway Key is not in use"), and nothing reaches
  an AI Provider. That covers every Agent: Floor Agents, Contractors and
  the Manager, whose key its chat sessions hold.
- **Resuming the Agent lets the same key work again.** Pausing does not
  rotate it.
- **The Communications Agent's key is in use only while it is not
  paused** (FR-90).
- **Owner tools' keys are unaffected**: they have their own enabled flag
  and revocation.

The guide says so: `docs/guide/ai-gateway.md` (Gateway Keys: Agents, the
Communications Agent) and `docs/guide/floors-and-agents.md` (archiving a
Floor; an Agent's "Enabled or paused").

### Sibling paths

- **The Manager's key**, held by its chat sessions and by its one-shot
  calls: an archived Floor's Manager's key calls no model (tested).
- **The Communications Agent's key**, paused: calls no model (tested).
- **Every place the Gateway answers** — its own port and `/v1` on the
  app's (`gatewayEntry`) — is the one Gateway instance built with these
  keys.
- **Rotation and removal** still revoke at once (the existing pinned
  test, "is revoked at once by rotation and by removing its Agent",
  passes).

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-4: a
      paused Agent's Gateway Key calls no model" and "G1-4: an archived
      Floor's Gateway Keys call no model" are `it`s, their assertions
      unchanged. The probe's `office()` now builds the Gateway with
      `keysAtWork` as `server.ts` does.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-4): a key
      taken from a sandbox no longer calls models after its Agent is
      paused, nor after its Floor is archived": 200 before, 401 paused,
      200 resumed, 401 archived.
- [x] **Sibling paths with the same flaw are fixed and tested.** In
      `agent-keys.pen-test.test.ts`:
      - "an archived Floor's Manager's key, which its chat sessions hold,
        calls no model either; another Floor's keys still do";
      - "the paused Communications Agent's key calls no model";
      - "an Owner tool's key is not an Agent's: pausing Agents and
        archiving Floors leave it be".

      With `keysAtWork` passing every caller through by hand:

      ```
      × regression (G1-4): a key taken from a sandbox no longer calls models after its Agent is paused, nor after its Floor is archived
      × G1-4: a paused Agent's Gateway Key calls no model
      × G1-4: an archived Floor's Gateway Keys call no model
      × G1-4: an archived Floor's Manager's key, which its chat sessions hold, calls no model either; another Floor's keys still do
      × G1-4: the paused Communications Agent's key calls no model
            Tests  5 failed | 1 passed | 4 skipped (10)
      ```

      Restored, all pass.
- [x] **The assessment's findings table marks `G1-4` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #275) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` exits 1 on eleven failures, none in a
      file this run changed: ten pre-existing failures of other probes'
      stale pins (G1-8, I2-1, I1-4, I1-9, I1-10), and one timeout under
      load that passes alone. The real output is in
      [issue-269.md](issue-269.md#real-output-of-the-checks).

## Decisions

1. **Checked as each call arrives, from the stores**, not by following
   events. A pause written straight to the store (as the probe does, and
   as anything but the Agent editor might) is honoured at once. It costs
   two store reads per call of an Agent's, the same two that the Token
   Cap check already makes.
2. **A `401`, "That Gateway Key is not in use"**, rather than a new
   refusal: while its Agent is paused or its Floor archived, the key is
   not in use. Agent tools stop on it, as on a revoked key.
3. **A paused Agent's running work stops at its next model call.** Before,
   pausing an Agent only kept new work from it, and a task it was running
   carried on. The finding requires that a paused Agent's key call no
   model, so that task's next call is refused and its run fails as a
   failed run does. The coder flow's "Paused" handling (push what was
   committed, let the issue go quietly) is for Token Cap pauses only; an
   Owner's pause mid-task may end in an "Agent blocked" Notice instead.
4. **A leaving Agent keeps its key until it is removed** (FR-10: it
   finishes its task first). Removal revokes it, as before.
5. **No key per sandbox run.** Ending each sandbox's key with its run
   would make a key taken from a finished task useless at once, but ADR
   0001 gives each Agent one key "created with the Agent"; that would be a
   new decision (see Noticed).

## Noticed, out of scope

- **A key taken from a sandbox still works while its Agent is enabled**,
  after the sandbox has gone, until the Owner rotates it. Pause, archive,
  rotation and removal now all end it. A key per run, or rotation at the
  end of every run, would close the rest; either changes ADR 0001's
  "Each Agent gets its own Gateway key, created with the Agent".
- **The coder flow** could treat a refusal after an Owner's pause as it
  treats a Token Cap pause (keep the work, no failure Notice).

## What could not be verified here

- From a real sandbox, `curl` to the Gateway with the Agent's key after
  the Owner pauses the Agent in the Floor admin and after archiving the
  Floor, on the pen-test stack.
- What a real Claude Code, Codex or opencode run shows when its key is
  refused mid-task.
- The Postgres stores' tests, skipped here without Docker; `keysAtWork`
  reads them through the same `floors.get` and `agents.list` the rest of
  AI Office uses.
