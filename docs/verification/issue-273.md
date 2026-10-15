# Issue #273: [fix] G1-3 — Owner tools and the Terminal have no Token Cap, though FR-33 says Owner tools can have caps — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `5ca0ed8`,
`fix(security): G1-3 each Owner tool, the Terminal too, is held to the office's Token Caps against its own use`,
on top of G1-2's `8fbb345` (#271), whose one-at-a-time turn it uses. Its
blocker, the G1 probe (#195), is in the tree:
`docs/pen-testing/assessments/G1.md` and
`apps/server/src/token-caps/enforcement.pen-test.test.ts`.

This is the remediation of finding **G1-3** (`severity:medium`, new). The
real output of the checks, run once on the finished tree for all four
fixes of this run, is in
[issue-269.md](issue-269.md#real-output-of-the-checks).

## What was fixed

The Gateway asked Token Caps only for an Agent's calls
(`caller.kind === "agent"`). An Owner tool's key and the Terminal's spent
past every cap the Office had, so a stolen Owner-tool key (position 4)
spent the Owner's AI Accounts without limit, though FR-33 says "Owner
tools (FR-46) can have caps too".

Now:

- **The Gateway asks before each Owner tool's call** (`ownerToolCapCheck`,
  `packages/gateway/src/gateway.ts`), with the Owner tool's name, and
  refuses it at a cap with the cap error Agents get: `403`,
  `permission_error` (or OpenAI's format), `x-ai-office-refusal:
  token_cap`, and nothing sent to the AI Provider. A cap that cannot be
  read is a `503`, as for an Agent.
- **Each Owner tool is held to the office's daily and monthly caps**,
  against its own tokens (`ownerToolCapUse`, `ownerToolCapRefusal`,
  `packages/orchestrator/src/caps/token-caps.ts`), as each Agent is by
  default. The Terminal is an Owner tool ("Terminal") and is counted on
  its own. One Owner tool's use never counts against another's, nor
  against an Agent's.
- **Its calls go one at a time** (G1-2), so it too stops within one call
  of its cap.
- The server wires it (`apps/server/src/server.ts`), and the guide says so:
  `docs/guide/floors-and-agents.md` ("Owner tools' caps", replacing "Owner
  tools have no caps yet") and `docs/guide/ai-gateway.md` (Owner tools).

### Sibling paths

- **The Terminal**, whose key `createGatewayKeys` tells the Gateway is an
  Owner tool: capped on its own (tested).
- **Owner tools' calls made at once**: through G1-2's turn (tested).
- **The Communications Agent** already had office caps
  (`communicationsCapRefusal`); unchanged.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-3: an
      Owner tool is refused once its tokens reach a Token Cap" is an `it`,
      its assertion unchanged. The probe's `office()` wires
      `ownerToolCapCheck` as `server.ts` does.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-3): an
      Owner tool's key, and the Terminal's, no longer spend past every cap
      the Office has: each is refused at the office's daily cap": each
      gets three 200s then three 403s, 2,550 tokens in all where before
      it was 5,100.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `enforcement.pen-test.test.ts`: "the refusal is a cap error naming
        the Owner tool and the office's cap, and goes nowhere"; "an Owner
        tool's use counts against no Agent's cap, and no Agent's against
        an Owner tool's"; "G1-3 with G1-2: an Owner tool's calls made at
        once pass the cap by no more than one call's".
      - `packages/gateway/src/caps.test.ts`: "asks for an Owner tool's
        calls, the Terminal's too, against the office's caps by its name,
        refusing it at one"; "refuses an Owner tool's call with a 503 when
        Token Caps cannot be read"; and G1-2's "an Owner tool's next call
        reaches the AI Provider only once the one before has been
        recorded". The test that said the Gateway "never asks for an Owner
        tool's calls" now says it "never asks an Agent's caps for an Owner
        tool's calls", which still holds.
      - `packages/orchestrator/src/caps/token-caps.test.ts`: "counts each
        Owner tool's own tokens, the Terminal's too, against the office's
        caps, refusing it at one" (in memory; its Postgres twin is skipped
        here).

      With the Gateway not asking for Owner tools by hand:

      ```
      × regression (G1-3): an Owner tool's key, and the Terminal's, no longer spend past every cap the Office has: each is refused at the office's daily cap
      × G1-3: an Owner tool is refused once its tokens reach a Token Cap
      × G1-3: the refusal is a cap error naming the Owner tool and the office's cap, and goes nowhere
      × G1-3 with G1-2: an Owner tool's calls made at once pass the cap by no more than one call's
      AssertionError: expected [ 200, 200, 200, 200, 200, 200 ] to deeply equal [ 200, 200, 200, 403, 403, 403 ]
      AssertionError: expected [ 200, 200, 200, 200, 200, 200 ] to include 403
      AssertionError: expected { status: 200, body: { …(7) } } to deeply equal { status: 403, body: { …(2) } }
      AssertionError: expected 10 to be 1 // Object.is equality
            Tests  4 failed | 1 passed | 15 skipped (20)
      ```

      Restored, all pass.
- [x] **The assessment's findings table marks `G1-3` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #273) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` exits 1 on eleven failures, none in a
      file this run changed: ten pre-existing failures of other probes'
      stale pins (G1-8, I2-1, I1-4, I1-9, I1-10), and one timeout under
      load that passes alone. The real output is in
      [issue-269.md](issue-269.md#real-output-of-the-checks).

## Decisions

1. **The office's caps, per Owner tool, against its own use.** FR-33 says
   Owner tools "can have caps", not which. The most conservative choice
   that needs no new setting: the office's caps, which are already every
   Agent's default, each Owner tool held to them on its own as each Agent
   is. A cap set per Owner-tool key would need a column, an API and a
   field in API Key Management; that is a feature for the Owner to ask
   for.
2. **Counted by the Owner tool's name**, as the request history records
   it (`ownerTool`), so the usage tally needs nothing new. Two keys with
   one name share a count, and renaming a key starts its count again.
3. **Refused, never paused, and no Notice.** An Owner tool is not an
   Agent: there is no work to pause and nothing for "Resume tomorrow" to
   act on. The Owner sees the refusal in their own tool, which names the
   cap and how to raise it. A Notice at 80% and 100% for Owner tools is
   left for the Owner to ask for.
4. **This changes what the Owner's own tools may spend.** With the default
   caps (5,000,000 tokens a day, 100,000,000 a month) the Owner's local
   Claude Code is refused past them. Raising the office's cap raises it
   for Owner tools and for every Agent's default.

## Noticed, out of scope

- **AI Settings' Token Caps card** shows each Owner tool's use, but not
  against the cap now in force for it. The API (`officeUsage`) could add
  it; it is a display change.
- **A stolen Owner-tool key** is still a credential worth up to the
  office's daily cap a day until the Owner revokes it.

## What could not be verified here

- The Owner's own Claude Code or Codex against the running app at
  `http://localhost:3045` reaching the cap and showing the refusal.
- The Terminal page reaching the cap in the browser.
- The Postgres stores' tests, skipped here without Docker.
