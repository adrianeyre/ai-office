# Issue #51: Token Cap enforcement — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`898d0e1`).

## What was built

### Enforcement (`packages/orchestrator/src/caps/enforcement.ts`)

`createCapEnforcement` is asked by the AI Gateway before each of an
Agent's calls (`check`), and told after each one is recorded (`observe`).
Both use the caps in force for the Agent's work (#50's `capUse`, with the
issue the call names):

- **80%** of a cap: a `cap.warning` event and an action Notice ("Token Cap
  warning: Ada has used 85% of its own daily Token Cap (850 of 1,000
  tokens)"), once per Agent, cap, level and period. An open warning for
  the same cap is not raised again, so a restart does not repeat it.
- **100%**: the Agent is paused. That means a row in `agent_cap_pauses`
  (new table, migration `0025_cap_pauses`), a `cap.reached` event, an
  `agent.status_changed` to `capped`, and an action Notice ("Token Cap
  reached: Ada is paused at its own daily Token Cap (1,050 of 1,000
  tokens)"). The Notice's actions are `raise_cap` ("Raise cap") and
  `resume_tomorrow` ("Resume tomorrow"). For a monthly cap the second is
  `resume_next_month` ("Resume next month").
- **While paused**, `check` refuses every call of the Agent, naming the
  cap it reached.
- **Raise cap** resumes the Agent, then raises the cap reached for its
  work: an issue's cap for the issue (`setIssueCaps`), otherwise the
  Agent's own cap for that period, so the Floor's and the office's stay
  as they are for other Agents. The new cap is
  `max(2 × cap, used + cap)`. It publishes `config.changed`, never the
  values. If raising fails, the Agent is paused again and the Notice
  stays (`502 action_failed`).
- **Resume tomorrow / next month** sets the pause's resume time to the end
  of the cap's period. A sweep every minute, and each call of the Agent,
  resume it once that time has passed.
- **A cap raised anywhere else** (any `config.changed` naming
  `tokenCaps`) rechecks every pause. An Agent no longer at its cap is
  resumed and its Notice closed as acted on (`raise_cap`).
- Pausing, resuming and warning happen one at a time, so an Agent is never
  paused or warned twice for one cap. Pauses are read back when the
  server starts.

### The usage tally (`packages/orchestrator/src/caps/tally.ts`)

The Gateway checks before every call, which is too often to add up a
month of `gateway_requests` each time. `createUsageTally` reads the
current day and month from the request history once, then adds each
request as it is recorded (from `requestHistory.subscribe`). Other periods
still come from the history.

### The Gateway (`packages/gateway/src/gateway.ts`)

A new option, `capCheck`, is asked after the Gateway Key is checked and
before anything else, for Agents' calls only. A refusal is a `403` in the
caller's format (Anthropic `permission_error`, or OpenAI's error) with
`x-ai-office-refusal: token_cap` and the message, and nothing is sent to
the AI Provider. It is recorded like any refused request. If the caps
cannot be read, the call is a `503`, never served unchecked.

### Pausing at a safe point (coder flow, work queue)

- Agent tools do not retry a `403`, so a paused Agent stops at its next
  call. The coder flow treats the end of a run whose Agent is paused as
  the safe point:
  - it pushes what the Agent committed (if the run returned), opening no
    pull request;
  - it lets the issue go at `needs-code`;
  - it sets the status to `capped` and finishes the progress comment as
    "Paused";
  - it returns `requeued`.

  There is no "Agent blocked" Notice: the cap's Notice says why.
- The work queue puts `requeued` work back in the queue (`requeue`). It
  starts no work for paused Agents (`claimNext(…, paused)`) and assigns
  new work to an unpaused Agent in the Role when there is one. Resuming
  wakes the queue.

### The server

`apps/server/src/server.ts` wires all of this up: the tally, the
enforcement over the database stores and Notices, `capCheck` on the
Gateway, `observe` on each recorded request, `capPaused` in the coder
flow, `pausedAgents` in the work queue, and `start`/`stop` with the
server.

## Acceptance criteria

### Verified in the sandbox

- [x] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. Output below.
- [x] Scenario test: an Agent crosses 80% (warning) then 100% (refused,
      paused, Notice); raising the cap resumes it.
      `apps/server/src/token-caps/enforcement.test.ts` runs PRD §5
      scenario 5 as the server wires it. It uses the real Gateway
      (`buildGateway`) in front of a local stand-in AI Provider, the real
      request history, tally, enforcement, Notices and work queue, and an
      Agent's Gateway Key. The coder's daily cap is 1,000 tokens and each
      call uses 425:
  1. 425: served, no Notice.
  2. 850: served; one warning Notice and one `cap.warning`.
  3. 1,275: served (it was under the cap when made). The Agent is now
     paused: `cap.reached`, status `capped`, and the action Notice with
     **Raise cap** and **Resume tomorrow**.
  4. The next call is refused: `403`, `permission_error`,
     `x-ai-office-refusal: token_cap`, and the AI Provider never sees it.
     Work queued for the Agent does not start.
  5. **Raise cap** on the Notice: the Agent's daily cap becomes 2,275, it
     resumes (status `idle`), the Notice closes, its queued work starts,
     and its next call is served.

  Unit tests cover the rest:
  - `caps/enforcement.test.ts`: warn once; pause with a Notice; refuse
    while paused whatever the issue; raise an office-level cap as the
    Agent's own; raise an issue's cap; resume tomorrow and next month;
    resume when a cap is raised in Admin (and stay paused while another
    period is still over); pauses and resume times outlast a restart.
  - `caps/tally.test.ts`: the tally's reads, rollover and races.
  - `gateway/src/caps.test.ts`: the refusal in both formats, nothing
    forwarded, Owner tools not checked, a `503` when caps cannot be read.
  - `work/queue.test.ts`: a paused Agent's work waits, new work goes to
    another coder, requeued work starts again on resume.
  - `coder/coder.test.ts`: a paused run pushes its commits with no pull
    request, lets the issue go and is requeued; its resumed run carries
    on from the pushed branch and is delivered. A run whose tool fails at
    the refusal is paused, not blocked.

## Not verifiable in this sandbox

- **Postgres** (Docker): `agent_cap_pauses`, migration `0025`, and the
  queue's `claimNext` exclusion and `requeue` in SQL. Every enforcement
  and work-queue case also runs against Postgres 18 in CI and on the
  host. Here they are skipped with the reason, as listed below.
- **Real agent tools.** That Claude Code, Codex and opencode stop at a
  `403` without retrying is what they are documented to do. It is not
  checked against the real tools here (no Docker, no AI Accounts).
- **Real AI Accounts and recorded provider responses** (#45, open).

## Notes

- **The safe point and unpushed work.** When the agent tool exits with an
  error at the refusal, Sandcastle reports the run as failed. The
  sandbox runner then deletes the clone, as for any failed run, so
  commits not yet pushed are lost. The resumed work starts again from the
  issue's branch as last pushed. When the tool exits cleanly, its
  commits are pushed before the work waits.
- **"Resume tomorrow" for a monthly cap.** The issue names "raise cap"
  and "resume tomorrow". Resuming tomorrow would only meet a monthly cap
  again at once, so a monthly cap's Notice offers "Resume next month"
  (`resume_next_month`) instead.
- **Warning Notices are action Notices**, as FR-49 lists "Token Cap
  warning (80%)" among them. They have no one-click action.
- **Owner tools' caps** (the last line of FR-33) are not part of this
  issue: Owner tools are never checked.
- **Gateway overhead.** The check reads the caps (the office's, the
  Floor's, the Agent's, the issue's) from the database on each call. The
  use comes from memory. The `< 10 ms` overhead target (PRD §7) is not
  measured here.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck`:

```text
exit 0
```

`pnpm test`:

```text
 Test Files  120 passed (120)
      Tests  1235 passed | 232 skipped (1467)
exit 0
```

The skipped tests need Docker (Postgres through Testcontainers, the
compose stack, hadolint's image, the image builds) and say so.

The tests for this issue (verbose, trimmed):

```text
✓ src/token-caps/enforcement.test.ts > PRD §5 scenario 5: an Agent reaches its Token Cap > warns at 80%, refuses and pauses at 100% with a Notice, and resumes when the cap is raised
✓ src/caps/enforcement.test.ts > Token Cap enforcement, kept in memory > warns once at 80% of a cap in force, then refuses and pauses the Agent at 100%, with a Notice
✓ src/caps/enforcement.test.ts > Token Cap enforcement, kept in memory > raising the cap from the Notice gives the Agent its own, higher cap and resumes it
✓ src/caps/enforcement.test.ts > Token Cap enforcement, kept in memory > raises an issue's own cap when that is the cap reached
✓ src/caps/enforcement.test.ts > Token Cap enforcement, kept in memory > resumes the Agent tomorrow, or next month for a monthly cap
✓ src/caps/enforcement.test.ts > Token Cap enforcement, kept in memory > resumes an Agent whose cap is raised anywhere, and closes its Notice
✓ src/caps/enforcement.test.ts > Token Cap enforcement, kept in memory > keeps a pause, and its resume time, across a restart
✓ src/caps/enforcement.test.ts > a raised cap > doubles the cap, or leaves a cap's worth of room above what is used
↓ src/caps/enforcement.test.ts > Token Cap enforcement, kept in Postgres 18 > (each of the six cases) [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
✓ src/caps/tally.test.ts > the usage tally > (5 tests)
✓ src/caps.test.ts > Token Caps at the Gateway > asks for each of an Agent's calls, with its Floor and issue, and serves it under its cap
✓ src/caps.test.ts > Token Caps at the Gateway > refuses a capped Agent's call with a cap error in Anthropic's format, sending nothing on
✓ src/caps.test.ts > Token Caps at the Gateway > refuses it in OpenAI's format to an OpenAI client such as Codex or opencode
✓ src/caps.test.ts > Token Caps at the Gateway > never asks for an Owner tool's calls
✓ src/caps.test.ts > Token Caps at the Gateway > refuses with a 503 when Token Caps cannot be read, rather than serving without them
✓ src/work/queue.test.ts > the work queue, in memory > holds back a paused Agent's work, gives new work to another, and starts requeued work once the Agent resumes
↓ src/work/queue.test.ts > the work queue, in Postgres 18 > (each case) [Docker is not available …]
✓ src/coder/coder.test.ts > the coder flow > pauses at a Token Cap: pushes what the Agent committed, lets the issue go and queues the work again
✓ src/coder/coder.test.ts > the coder flow > pauses, rather than blocks, when the agent tool stops at the Gateway's refusal
 Test Files  9 passed (9)
      Tests  47 passed | 23 skipped (70)
```
