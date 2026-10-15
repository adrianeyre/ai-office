# Issue #195: [pen-test] G1 — AI Gateway and credentials — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no live model, no EC2, no network beyond the registry and the
model). The probe was assessed at commit `bc210f8` (the branch head; the
worktree was clean). `pnpm lint`, `pnpm typecheck` and `pnpm test` were run
with the probe's tests and assessment present.

This issue is a **probe**, not a fix: it answers H11 and H16 (and H19, the
Gateway on the host's loopback, added after #204), produces an assessment
and committed probe tests, and changes no production code.

## What was produced

- **Assessment** `docs/pen-testing/assessments/G1.md`. It has a verdict on
  every "What to probe" bullet (Gateway Keys; attribution headers; Token
  Caps; AI Account credentials at rest, in transit, in request history and
  in error messages; redaction; weak and plaintext secrets and rotation)
  and on each added after #204 (the Gateway on the host's loopback; usage
  windows and charts; the Manager chat's Gateway path), and the commit it
  was assessed at. Its Findings table (G1-1…G1-9) gives each finding's
  one-line statement, attacker position, hypothesis, claimed severity
  against the PRD's definitions, probe tests, and what the fix must make
  true. The index (`docs/pen-testing/README.md`) lists G1.
- **Seven probe test files**, beside the code they probe:
  - `packages/gateway/src/gateway.pen-test.test.ts`: the real Gateway over
    HTTP in front of a fake AI Provider: attribution as the caller's word
    (G1-1's half), session pinning and forced accounts per key, what goes
    upstream, the User-Agent deciding a subscription (G1-5), upstream error
    text (G1-6) and redirects (G1-7), and every route on 3047 without a key
    (H19).
  - `apps/server/src/token-caps/enforcement.pen-test.test.ts`: the real
    Gateway, request history, tally, `createTokenCaps` and
    `createCapEnforcement` wired as `server.ts` wires them, on real Floors:
    slipping, borrowing and using up issue caps (G1-1), calls made at once
    (G1-2), Owner tools and the Terminal (G1-3), the Manager's key.
  - `apps/server/src/gateway-keys/agent-keys.pen-test.test.ts`: real
    `createGatewayKeys` and `keepAgentKeys` behind the real Gateway: scope,
    UI access, sealing, rotation and removal, and a key after its Agent is
    paused and its Floor archived (G1-4).
  - `apps/server/src/config.pen-test.test.ts`: the real `.env.example`
    through the real `loadConfig` (G1-8), rotation (G1-9), the sealed format.
  - `apps/server/src/redaction.pen-test.test.ts`: one redactor as the server
    wires it, across the logger, the event bus, Notices, request history and
    a webhook Connection.
  - `apps/server/src/analytics/routes.pen-test.test.ts`: the real app's
    analytics, AI Accounts and request-history answers.
  - `packages/orchestrator/src/manager/chat-gateway.pen-test.test.ts`: the
    real `dockerSessionTool`'s key and attribution for Claude Code and Codex.

### The findings

| ID | Statement | Severity |
|---|---|---|
| G1-1 | A Gateway Key holder bills its calls to any issue on its Floor, or none: it slips its issue's Token Cap, escapes its own through another issue's, and pauses another Agent (H11) | high |
| G1-2 | Token Caps are checked before a call and counted after it, so calls made at once all pass a cap | medium |
| G1-3 | Owner tools and the Terminal have no Token Cap (FR-33) | medium |
| G1-4 | An Agent's Gateway Key keeps calling models after its Agent is paused and its Floor archived | medium |
| G1-5 | A subscription serves whoever sends its agent tool's User-Agent (FR-35) | medium |
| G1-6 | The AI Provider's error text reaches the Gateway Key holder unredacted, credential and all | medium |
| G1-7 | The Gateway follows an upstream redirect to another origin with the account's `x-api-key` and the prompt | low |
| G1-8 | An Office served beyond localhost starts with `.env.example`'s public secrets (H16) | low |
| G1-9 | ENCRYPTION_KEY cannot be rotated (H16) | low |

What holds, each kept holding by a plain `it`: a key names one Agent and
its Floor and only calls models; session pinning and forced accounts are
confined to the caller's key; AI Office's headers and the caller's
credentials never go upstream, and the query string cannot move a request
off its account's host; credentials are sealed with AES-256-GCM bound to
key version, field and row; rotation and removal revoke a key; redaction
holds for logs, the Activity Feed, Notices, request history and
Connections; the analytics carry no credential; the Manager's chat turns
carry only the Manager's key; on the host's loopback only `/health`
answers without a key, and no origin is granted CORS.

## Acceptance criteria

- [x] **Every bullet in "What to probe" has a verdict in the assessment.**
      `G1.md` has a section per bullet, and one per item added after #204,
      each with a verdict (FINDING / HOLDS / CONFIRMED) for every item it
      names.
- [x] **Every finding has an `it.fails` + pinning `it` pair, and the
      findings table names it.** Twelve `it.fails` cover G1-1 (three),
      G1-2, G1-3, G1-4 (two), G1-5, G1-6, G1-7, G1-8 and G1-9, each beside a
      passing pin, and the table names the file and test. Each `it.fails`
      was flipped to `it` once by hand to see it fail on its own assertion
      — twelve `AssertionError`s (for example `expected [ 200, 200, 200,
      200, 200 ] to include 403`, `expected 4250 to be less than or equal
      to 1425`, `expected '{"type":"error",…' not to contain
      'sk-ant-api03-…'`, `expected 200 not to be 200`, `expected [Function]
      to throw an error`) — then put back.
- [x] **Nothing in production code changes.** The diff from `bc210f8` is
      only test files and documents:

  ```
  A  apps/server/src/analytics/routes.pen-test.test.ts
  A  apps/server/src/config.pen-test.test.ts
  A  apps/server/src/gateway-keys/agent-keys.pen-test.test.ts
  A  apps/server/src/redaction.pen-test.test.ts
  A  apps/server/src/token-caps/enforcement.pen-test.test.ts
  M  apps/server/src/manager-chat/routes.pen-test.test.ts
  M  docs/pen-testing/README.md
  A  docs/pen-testing/assessments/G1.md
  A  docs/verification/issue-195.md
  A  packages/gateway/src/gateway.pen-test.test.ts
  A  packages/orchestrator/src/manager/chat-gateway.pen-test.test.ts
  M  packages/orchestrator/src/manager/requests.pen-test.test.ts
  M  packages/orchestrator/src/models/agent-tool-session.pen-test.test.ts
  ```

  The three modified probe files are P2's (#205). `pnpm lint` failed on
  them at `bc210f8` (an unnecessary type assertion, a catch callback not
  typed `unknown`, and two lines Prettier wraps differently). They were
  fixed in their own commits, changing no assertion; their tests still
  give 10 passed and 4 expected fail as before.
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** `pnpm lint`
      and `pnpm typecheck` pass. `pnpm test` passes every test this probe
      added; it carries three failures that are all pre-existing at
      `bc210f8` and outside this probe's diff (below). No test was skipped,
      deleted or weakened to reach this state.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

### `pnpm typecheck`: exit 0

```
packages/orchestrator typecheck: Done
apps/server typecheck: Done
apps/web typecheck: Done
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: the probe's tests pass; three pre-existing failures

```
 Test Files  3 failed | 443 passed (446)
      Tests  3 failed | 4844 passed | 67 expected fail | 600 skipped (5514)
   Duration  168.44s
```

The **67 expected fail** include this probe's 12; the rest are A1's, S2's,
P2's and P1's. They pass by failing, as the findings workflow intends. The
skips are the Postgres and Docker tests, skipped with their reason in this
sandbox. **None of the three failures is in a file this probe added**:

```
 FAIL  |repository| test/pen-testing.test.ts > the pen-test cross-reference > finds every probe test holding an it.fails referenced by an assessment
AssertionError: expected [ …(8) ] to deeply equal []
+   "packages/orchestrator/src/context/fresh-start.pen-test.test.ts",
+   "packages/orchestrator/src/decision-model/decision-model.pen-test.test.ts",
+   "packages/orchestrator/src/intake/intake.pen-test.test.ts",
+   "packages/orchestrator/src/memory/role-review.pen-test.test.ts",
+   "packages/orchestrator/src/merge/merge.pen-test.test.ts",
+   "packages/orchestrator/src/review/prompt.pen-test.test.ts",
+   "packages/orchestrator/src/sandbox/runner.pen-test.test.ts",
+   "packages/orchestrator/src/skills/skills.pen-test.test.ts",

 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/
```

- The cross-reference failure names the eight P1 (#194) probe files, merged
  at `a3c8bcf` without their assessment: at `bc210f8` there is no
  `assessments/P1.md` and no assessment mentions those paths. Every G1
  probe file is referenced by `G1.md`. Writing P1's assessment is #194's
  work, not this probe's.
- The two changelog failures are the ones #192, #193 and #205 recorded: the
  root `CHANGELOG.md` starts `## 1.0.0` with no release date.

The seven G1 probe files run green on their own:

```
# vitest run of the seven probe files
 Test Files  7 passed (7)
      Tests  36 passed | 12 expected fail (48)
```

## What could not be exercised here

- **A live sandbox sending its own headers.** A call with the headers and
  User-Agent a sandbox can set stood for one. On the pen-test stack,
  position 3's harness would `curl` `app:3047` from a coder's sandbox with
  its own key, naming another issue, no issue and `claude-cli/…`, then read
  the request history and the Floor admin's caps.
- **Real AI Providers.** Whether a real upstream echoes a key in an error
  (G1-6) or redirects (G1-7) was not observed; the stack's stub upstream
  would be set to do both.
- **The published port, a real browser and another local user.** Docker's
  `127.0.0.1:3047`, a DNS-rebinding page and a second user on an EC2 host
  need the stack on a host; what any of them can reach is the Gateway's
  own answers, pinned here.
- **Postgres.** The probes use the in-memory stores the server's own tests
  pair with Postgres; the code above them is the same.
