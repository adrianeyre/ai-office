# Issue #271: [fix] G1-2 — Token Caps are checked before a call and counted after it, so calls made at once all pass a cap — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `8fbb345`,
`fix(security): G1-2 a capped caller's calls go through the Gateway one at a time, each once the one before is counted`,
on top of G1-1's `cf7a30b` (#269), whose Gateway handler it extends. Its
blocker, the G1 probe (#195), is in the tree:
`docs/pen-testing/assessments/G1.md` and
`apps/server/src/token-caps/enforcement.pen-test.test.ts`.

This is the remediation of finding **G1-2** (`severity:medium`, new). The
real output of the checks, run once on the finished tree for all four
fixes of this run, is in
[issue-269.md](issue-269.md#real-output-of-the-checks).

## What was fixed

The Gateway asked Token Caps before a call (`capCheck`) and told them
after the call was recorded (`observe`), with nothing for calls in
flight. Ten calls made at once against a 1,000-token cap were all served:
4,250 tokens, four times the cap, the Agent paused only afterwards.

Now a capped caller's calls go through the Gateway one at a time
(`turns`, `packages/gateway/src/gateway.ts`):

- **Each call waits for its turn** before its cap is checked: until the
  caller's call before it has been recorded, and so counted (the request
  history tells its subscribers, and the usage tally adds the call,
  before `record` resolves). However many calls an Agent sends at once,
  its use stops within one call of its cap.
- **A turn ends** once the call is recorded: served, refused at a cap,
  refused for a bad request, failed or broken off. If an answer ends
  without being recorded at all (an error thrown inside the handler), the
  turn ends when the connection closes.
- **A caller that leaves while it waits** sends nothing anywhere, and the
  calls after it go on.
- **Who is capped:** an Agent (by its id) while Token Caps are enforced,
  and the Communications Agent while its office caps are; after G1-3
  (#273), each Owner tool too. Different callers never wait for each
  other.

The guide says so: `docs/guide/floors-and-agents.md`, Enforcement, "One
call at a time".

### Sibling paths

- **The issue's cap** has the same check-before, count-after shape. A
  sandbox's calls all count against its issue (G1-1), and they go one at
  a time, so the issue's cap is passed by at most one call too.
- **The Communications Agent's office caps** (`communicationsCapCheck`)
  were checked the same way; its calls go one at a time too.
- **Owner tools' caps** (G1-3, #273) go through the same turn.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-2: an
      Agent's tokens never pass its cap by more than one call's" is an
      `it`, its assertion (at most 1,000 + 425 tokens) unchanged. See
      Decisions, 3, for the probe's stand-in AI Provider.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-2): ten
      calls at once are no longer all served: they reach the AI Provider
      one at a time, and those past the cap are refused": three 200s and
      seven 403s, at most one call held by the AI Provider at once, 1,275
      tokens, and the coder paused.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `enforcement.pen-test.test.ts`: "an issue's cap, too, is passed by
        no more than one call's"; "one Agent's calls in flight never hold
        up another Agent's" (the coder's and QA's are held together).
      - `packages/gateway/src/caps.test.ts`, "G1-2: a capped caller's
        calls, one at a time": for an Agent, the Communications Agent and
        (with G1-3) an Owner tool, "next call reaches the AI Provider only
        once the one before has been recorded" (the second is not even
        asked about its cap until the first is recorded); "ends a refused
        call's turn, so the next is asked"; "sends nothing for a call
        whose caller leaves while it waits, and the calls after it go
        on".

      With the turn taken out by hand, the three tests that measure a cap
      fail on their own assertions:

      ```
      × regression (G1-2): ten calls at once are no longer all served: they reach the AI Provider one at a time, and those past the cap are refused
      × G1-2: an Agent's tokens never pass its cap by more than one call's
      × G1-2: an issue's cap, too, is passed by no more than one call's
      AssertionError: expected [ 200, 200, 200, 200, 200, 200, …(4) ] to have a length of 3 but got 10
      AssertionError: expected 4250 to be less than or equal to 1425
      AssertionError: expected 4250 to be less than or equal to 1425
            Tests  3 failed | 1 passed | 13 skipped (17)
      ```

      Restored, all pass.
- [x] **The assessment's findings table marks `G1-2` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #271) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` exits 1 on eleven failures, none in a
      file this run changed: ten pre-existing failures of other probes'
      stale pins (G1-8, I2-1, I1-4, I1-9, I1-10), and one timeout under
      load that passes alone. The real output is in
      [issue-269.md](issue-269.md#real-output-of-the-checks).

## Decisions

1. **One call at a time, always, rather than a reservation per call.** A
   call's tokens are known only once it is answered. To let calls run
   together and still stop within one call of the cap, the Gateway would
   need a true upper bound on each call before it is sent, and there is
   none it can trust:
   - the body's length plus `max_tokens` bounds text, but not an image or
     a PDF the AI Provider fetches by URL, and OpenAI's Chat Completions
     and Responses do not require an output limit;
   - the largest call seen so far is the caller's to choose: many small
     calls, then many large ones at once, would pass the cap again;
   - a Model's context window is a true bound, but with the default caps
     (5,000,000 a day) and windows of up to about 1,000,000 tokens it
     would allow at most a few calls together early in the day and one at
     a time after, which is this fix with more to go wrong.
   The cost: one Agent's parallel calls (Claude Code's sub-agents, its
   side calls) wait for each other; different Agents' never do.
2. **Wait, never refuse, for a turn.** An Agent far from its cap that sends
   two calls at once is not refused; its second call is checked once the
   first is counted, and refused then only if the cap has been reached.
3. **The probe's stand-in AI Provider answers when calls stop arriving.**
   It held every call until ten had arrived. A Gateway that lets one
   through at a time would then never be answered, so the test could not
   pass whatever the fix. It now also answers once no call has arrived for
   a quarter of a second, so every call the Gateway lets through at once
   is still in flight together. Without the fix, all ten still arrive at
   once and are held together (the regression test then fails with ten
   200s and 4,250 tokens, above). The `it.fails`'s assertion is unchanged.
4. **Per caller, not per issue.** Two Agents working one issue at once (a
   review round that sends an issue back to a coder still at work) may
   each pass the issue's cap by one call.

## Noticed, out of scope

- **Prompt-cache keep-alive pings** are checked against the Agent's caps
  (`keep-alive.ts`) but are sent outside the Gateway's handler, so they do
  not take the Agent's turn. They are AI Office's own, made one per
  session per interval with a cached prompt, and a sandbox cannot make
  more of them.
- **Latency.** A call that waits for its turn adds the earlier call's
  time to its own. The Gateway's own overhead target (under 10 ms) is
  unchanged for a caller with one call at a time.

## What could not be verified here

- A real agent tool's parallel calls (Claude Code's sub-agents) through
  the Gateway, and how long they wait for each other.
- A burst from inside a real sandbox on the pen-test stack.
