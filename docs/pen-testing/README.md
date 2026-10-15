# Pen-testing

The documents for the first adversarial round against AI Office, and the
assessments it produces. The brief is the
[pen-testing PRD](../product-requirements-document/pen-testing.md): its
scope, attacker positions, opening register (H1–H21), gates and findings
workflow. The canon for how AI Office is meant to behave remains
[`ai-office.md`](../product-requirements-document/ai-office.md).

## Documents

| Document | What it is |
| --- | --- |
| [PRD: Pen-testing AI Office](../product-requirements-document/pen-testing.md) | The brief: why, the gates, the engagement, the opening register, the scope partition and the findings workflow |
| [The pen-test stack](stack.md) | The target: its own compose stack, stub upstream and AI Accounts; standing it up, opening it to the red team's host, and tearing it down with its volume and sandbox work directory |
| [The credentials package](credentials-package.md) | E4: what the red team gets (one Owner password, one UI-capable API key, one Gateway Key, the fixture IDs, the pinned commit) and never gets; minting it, `0600`, with `docker/pen-test/credentials mint`; delivering it out of band; revoking each credential at the end of the window; destroyed at teardown |
| [Rules of engagement](rules-of-engagement.md) | E3: the window and its pinned commit, the targets, how each attacker position is wired, the out-of-band channel for a critical and what "stop" means, credential handling, what is left behind, and the Owner's sign-off before the window opens |
| [Triage runbook](triage-runbook.md) | The labels; filing a finding; triage within one day; severities and their targets; re-rating; `wontfix`; the retest and the register |
| [Finding issue template](../../.github/ISSUE_TEMPLATE/pen-test-finding.md) | `[finding] <ID> — <one-line statement>`, one per finding, labelled `prd:pen-testing` |
| [Remediation issue template](../../.github/ISSUE_TEMPLATE/pen-test-remediation.md) | One fix per finding: the `it.fails` becomes an `it`, the pin a regression test |
| [Assessments](#assessments) | One per probe issue, under [`assessments/`](assessments/) |

The seed fixtures and the hostile-content corpus (E2) are documented in
[The pen-test stack](stack.md#the-seed), which the stand-up runs.

## Labels

`prd:pen-testing` goes on every probe, finding and remediation issue. Each
finding and its remediation carry exactly one of `severity:critical`,
`severity:high`, `severity:medium` or `severity:low`, and an accepted
finding `wontfix`. What each means, and its target, is in
[the runbook](triage-runbook.md#labels).

## Assessments

Each probe issue writes one assessment in [`assessments/`](assessments/):
a verdict on every bullet of the probe, including what could not be
exercised and why, against one pinned commit. It names and links the probe
tests it committed, and lists its findings by ID (`<probe ID>-<n>`) with
their claimed severities.

| Probe | Assessment | Pinned commit | Findings by severity | Retest (2026-10-11) |
| --- | --- | --- | --- | --- |
| S1 | [Host-side git in Agent-written worktrees](assessments/S1.md) (H1) | `fa56e24` | critical: S1-1, S1-2 | Both fixed (`dd458e7`, `fbd4c71`) |
| A1 | [Sign-in and sessions](assessments/A1.md) (H3–H7) | `18e9c71` | high: A1-1–A1-3; medium: A1-4–A1-6, A1-9; low: A1-7, A1-8 | All nine fixed |
| S2 | [Sandbox and host isolation](assessments/S2.md) (H2, H3, H14) | `b19d98f` | high: S2-1–S2-3; medium: S2-4, S2-5 | All five fixed |
| P1 | [Prompt injection and Agent integrity](assessments/P1.md) (H8–H10) | `a3c8bcf` | high: P1-1; medium: P1-2–P1-11 | All eleven fixed |
| P2 | [The Manager chat's agent session](assessments/P2.md) (H18) | `3c081be` | high: P2-1, P2-3, P2-4; medium: P2-2 | All four fixed (P2-3 by the Owner's option 4, ADR 0009) |
| G1 | [AI Gateway and credentials](assessments/G1.md) (H11, H16, H19) | `bc210f8` | high: G1-1; medium: G1-2–G1-6; low: G1-7–G1-9 | All nine fixed |
| W1 | [GitHub App and webhooks](assessments/W1.md) (H12) | `c4860a2` | medium: W1-3, W1-6; low: W1-1, W1-2, W1-4, W1-5 | All six fixed |
| I1 | [Infrastructure and delivery](assessments/I1.md) (H13, H15, H17, H20) | `7b0bdb4` | medium: I1-1; low: I1-2–I1-11 | All eleven fixed |
| I2 | [The Gateway on the app's own port, and the sandbox directory](assessments/I2.md) (H21) | `23d9f9d` | low: I2-1–I2-5 | All five fixed |

Sixty-two findings: 2 critical, 11 high, 25 medium and 24 low. On this
branch all 62 are fixed: the last, P2-3 (high), by the Owner's choice in
#199 (option 4, [ADR 0009](../architectural-decision-record/0009-a-chat-batch-is-fenced-and-merged-by-the-owner.md)). Each assessment's findings
table names every fix commit. Its probe tests hold no `it.fails`: each
finding's `it.fails` is a plain `it` that passes, and each test that
pinned the old behaviour is a regression test. The retest, with the real
output of `pnpm lint`, `pnpm typecheck` and `pnpm test`, is
[`pen-testing-retest.md`](../verification/pen-testing-retest.md). The
register in the PRD has one retest line under each hypothesis.

"Fixed" here means fixed in the code and its tests, in this sandbox.
Nothing in this round ran against the live pen-test stack, a live model,
Docker, Caddy or EC2. Each assessment's "Could not be exercised here"
says what the live window must still try.

## The gates

The PRD's two gates, as this branch stands:

- **Exposure** (every `severity:critical` finding remediated): **met on
  this branch.** S1-1 and S1-2, the round's only criticals, are fixed by
  `dd458e7` and `fbd4c71`. The gate is still the Owner's to pass (#199).
  Before passing it, the Owner re-rates any finding rated against a
  loopback-only deployment, as the
  [runbook](triage-runbook.md#re-rating-when-a-premise-changes) says, and the live window (#198) may yet
  find a critical this round did not.
- **Public release** (every finding above `severity:low` remediated, or
  waived in writing by the Owner): **met on this branch.** P2-3, the last
  open, is fixed by the Owner's option 4 (`f4c6b8e6`), and the Owner
  decided in #199 that no human external round is required before public
  release (success criterion 6). The live window (#198) may yet find
  more.

## For the Owner

Only the Owner can do what follows. Nothing on this branch does it for
them.

### #198 (O1): stand up the stack and run the live window

- Stand up the pen-test stack and seed it ([stack.md](stack.md)), mint and
  deliver the credentials package out of band
  ([credentials-package.md](credentials-package.md)), sign off the
  [rules of engagement](rules-of-engagement.md), and open the window
  against one pinned commit with these fixes in.
- In the window, try what no probe here could: each assessment's "Could
  not be exercised here". That is a live model (P2-3's check against the
  hostile-content corpus above all), Docker (S1's hook reaching the
  socket, S2's networks and the sandbox relay, I2's work directory as a
  second host user), Caddy and the EC2 set-up.
- Tear the stack down with its database volume and sandbox work
  directory, and revoke every credential in the package (success
  criterion 3).

### #199 (O2): the gate decisions

- **Exposure:** re-rate any finding rated against a loopback-only
  deployment ([runbook](triage-runbook.md#re-rating-when-a-premise-changes)),
  then sign the gate off. On this branch every critical is fixed.
- **Public release:** decided in #199 (2026-10-12): P2-3 by option 4,
  and no human external round is required before release (success
  criterion 6). The round was an AI red team, recorded as reviewed by a
  different brief, not independently tested.

### Findings left open

None. P2-3 (high), the last, was the Owner's decision: of its options
([issue-243.md](../verification/issue-243.md#decisions-for-the-owner)) the
Owner chose a deterministic fence (option 4), and both its rules are in
(`f4c6b8e6`, [ADR 0009](../architectural-decision-record/0009-a-chat-batch-is-fenced-and-merged-by-the-owner.md)).

### Decisions the fixes took, for review

Each fix recorded, in its verification note's "Decisions", the choices
neither the PRD nor an ADR made: the most conservative that kept the
product working. Each is the Owner's to review. **Left open** marks a
gap the fix names, or a question it puts to the Owner.

- **S1-1** ([#201](../verification/issue-201.md#decisions)): a filter,
  diff or merge driver a repository defines is overridden to empty, not
  refused; a command in a repository naming a remote's `uploadpack`,
  `receivepack` or `vcs` is refused; only the `file` and `https`
  transports are allowed; a Fresh Start stops the sandbox before it saves.
- **S1-2** ([#203](../verification/issue-203.md#decisions)): Sandcastle's
  git is guarded by AI Office's `git` first on the app's `PATH`, not by
  patching Sandcastle; it runs with `runGit`'s minimal environment; it
  fails loudly without `node`, at tens of milliseconds a call;
  fact-finding works on a throwaway branch in a Sandcastle worktree;
  `core.alternateRefsCommand` is set to `true`.
- **A1-1** ([#211](../verification/issue-211.md#decisions)): the proxy
  proves itself with `PROXY_SECRET`, not an address; `TRUST_PROXY`
  without it refuses to start, so an upgraded `.env` needs one; the proof
  is always stripped.
- **A1-2** ([#213](../verification/issue-213.md#decisions)): the setup
  token goes in a file, never the log; loopback needs none; setup answers
  only `PUBLIC_URL`'s name, `localhost` or an address, else `421`; `HOST`
  defaults to `127.0.0.1`; the token is written when the database cannot
  say whether a password exists.
- **A1-3** ([#215](../verification/issue-215.md#decisions)): any Owner
  password is fresh proof, a recovery code counts as the second factor,
  and an API-key session can never give it; re-enabling a UI key needs
  it, narrowing or revoking does not; sign-out-everywhere lists the
  credentials by name and removes none itself.
- **A1-4** ([#217](../verification/issue-217.md#decisions)): `409
  password_in_use` stays, reached only after a proof; proofs and sign-ins
  share one limiter; a right proof is recorded but not announced.
- **A1-5** ([#219](../verification/issue-219.md#decisions)): credential
  changes are `config.changed` events in the `security` scope, naming
  keys, never values; a refused code to turn TOTP off is a failed
  sign-in.
- **A1-6** ([#221](../verification/issue-221.md#decisions)): other sites'
  images are blocked, so they show broken in Markdown; scripts by hash
  and `'wasm-unsafe-eval'`, styles `'unsafe-inline'`; `Referrer-Policy:
  same-origin`; HSTS for a year without `includeSubDomains` or `preload`;
  the app sets the headers and Caddy fills gaps. **Left open:** HSTS
  preloading.
- **A1-7** ([#225](../verification/issue-225.md#decisions)): lockouts are
  rebuilt from the last day of `sign_in_events`; AI Office still starts
  without the database, where nobody can sign in.
- **A1-8** ([#227](../verification/issue-227.md#decisions)): 24 hours
  idle, any authenticated request (a stream's heartbeat too) is use,
  noted at most once a minute; FR-2 says so. **Left open:** a thief who
  keeps a stream open keeps the session until the 7-day limit or
  sign-out-everywhere.
- **A1-9** ([#223](../verification/issue-223.md#decisions)): a password
  is changed with proof of that password; the change ends every session
  it began; the first password is replaced, never removed.
- **S2-1** ([#229](../verification/issue-229.md#decisions), ADR 0008):
  egress through the sandbox relay; `SANDBOX_EGRESS_HOSTS` empty by
  default, `.env.example` listing `registry.npmjs.org` and
  `api.github.com`; `CONNECT` to 443 of a listed name only; the Manager
  chat's web fetch reaches only those hosts. **Left open:** an injected
  Agent can still send what it read to an allowed host where it holds an
  account; plain HTTP or `git` over SSH needs a new decision.
- **S2-2** ([#231](../verification/issue-231.md#decisions)): a metadata
  hop limit of 1 rather than the service off, so host backups keep their
  role; the relay refuses link-local, loopback and reserved addresses, not
  private ones.
- **S2-3** ([#233](../verification/issue-233.md#decisions)): the fix is
  the network, not the bind address; `HOST` and `OAUTH_CALLBACK_HOST`
  stay `0.0.0.0` under compose.
- **S2-4** ([#235](../verification/issue-235.md#decisions)): AI Office
  starts sandbox containers itself, not through Sandcastle's Docker
  provider; home and `/tmp` are anonymous volumes; 4 GB and 4096
  processes, fixed in code.
- **S2-5** ([#237](../verification/issue-237.md#decisions), ADR 0006): a
  network per sandbox, which the relay joins; the relay found by its
  compose service; leftover networks removed before a process's first
  sandbox; no sandbox starts without the relay.
- **P1-1** ([#247](../verification/issue-247.md#decisions)): commits after
  approval go back to review (a new `ready-to-merge → needs-review` move),
  to the Owner only when no round is left; QA and docs do not run again.
- **P1-2** ([#249](../verification/issue-249.md#decisions)): a fixed,
  wide list of what CI runs sends a pull request to the Owner on every
  Floor; the Notice names the rule, not the path.
- **P1-3** ([#251](../verification/issue-251.md#decisions)): `.agents/`,
  `.claude/`, `.codex/` and `.opencode/` count wherever they are; such
  pull requests go to the Owner rather than being refused.
- **P1-4** ([#253](../verification/issue-253.md#decisions), ADR 0005):
  only the Owner accepts Role memory, on the Manager's recommendation,
  which raises no Notice; an existing database needs `pnpm db:reset`.
  **Left open:** FR-55 in `ai-office.md` still says "accepted by the
  Manager or the Owner".
- **P1-5** ([#255](../verification/issue-255.md#decisions)): every Stage
  works the version the Owner approved, and re-labelling approves an edit;
  an edit in the same second as the label waits for a new label.
- **P1-6** ([#257](../verification/issue-257.md#decisions)): the changed
  paths go inside the diff's quote, not escaped further.
- **P1-7** ([#259](../verification/issue-259.md#decisions)): the Fresh
  Start summary is quoted, before the Owner's instructions.
- **P1-8** ([#261](../verification/issue-261.md#decisions)): tool calls
  are screened by AI Office's rules, and by Jev when on; the screen's
  route widens an Agent's Gateway Key by one route; the hook fails
  closed. **Left open:** Codex's and opencode's calls are judged as they
  stream, after they run; whether FR-46 names the screen route; whether
  ChatGPT, Grok and Gemini Agents wait for a pre-call hook.
- **P1-9** ([#263](../verification/issue-263.md#decisions)): the
  repository's agent-tool files stay in the working copy as content, not
  configuration; approvals and the tool's own sandbox stay off, the P1-8
  screen and the sandbox being the controls.
- **P1-10** ([#265](../verification/issue-265.md#decisions)): a
  repository Skill overrides the office one only once the Owner has
  reviewed exactly its files, shown raw, per folder. **Left open:** FR-72
  does not say "once reviewed".
- **P1-11** ([#267](../verification/issue-267.md#decisions)): the diff is
  shown in full or the pull request goes to the Owner, a binary file
  included. **Left open:** binary files CI checks need a decision of
  their own.
- **P2-1** ([#239](../verification/issue-239.md#decisions)): history
  through AI Office's `git_log`, `git_show` and `git_diff` tools, no
  shell; Codex reads through `read_file`, `list_files` and `search`; the
  Gateway Key stays in the tool's environment. **Left open:** taking the
  key out of the container needs a per-turn credential.
- **P2-2** ([#241](../verification/issue-241.md#decisions)): paths
  beginning with `-` are refused, even after `--`.
- **P2-3** ([#243](../verification/issue-243.md#decisions)): no check, no
  Batch; the Manager's own Model checks, costing one call per decision;
  the Owner's words are this message and up to four before it; no "go
  anyway" button. **Left open:** above.
- **P2-4** ([#245](../verification/issue-245.md#decisions)): a one-off
  Role carries AI Office's instructions and the Manager's text goes as
  untrusted task text; a research Contractor's instructions are dropped;
  a kept Contractor's Role joins the library with AI Office's
  instructions, for the Owner to write.
- **G1-1** ([#269](../verification/issue-269.md#decisions)): the runner
  holds a registry of work, and AI Office's own calls carry a one-time
  token; Owner tools still name their issue; the Communications Agent
  bills none. A Gateway Key per task would be a new decision under ADR
  0001.
- **G1-2** ([#271](../verification/issue-271.md#decisions)): a capped
  caller's calls run one at a time, a second waiting. **Left open:** two
  Agents on one issue may each pass its cap by one call.
- **G1-3** ([#273](../verification/issue-273.md#decisions)): each Owner
  tool is held to the office's caps, counted by its name, refused and
  never paused. **Left open:** a cap per Owner-tool key, and Notices at
  80% and 100%.
- **G1-4** ([#275](../verification/issue-275.md#decisions)): the Gateway
  reads the stores on each call; a paused Agent's or archived Floor's key
  gets `401`. **Left open:** a key taken from a sandbox works while its
  Agent is enabled, until rotated; a key per run would change ADR 0001.
- **G1-5** ([#277](../verification/issue-277.md#decisions)): a
  subscription serves by the Agent's AI Provider, and Owner tools at their
  word. **Left open:** a sandbox can still use its own provider's
  subscription with raw calls; binding Owner-tool keys to their tools is
  a new decision.
- **G1-6** ([#279](../verification/issue-279.md#decisions)): the serving
  account's credential is redacted from the error text, which is kept.
  **Left open:** a credential echoed encoded, or split across streamed
  chunks, would pass.
- **G1-7** ([#281](../verification/issue-281.md#decisions)): no redirect
  is followed, even to the same origin; a redirect is a failure.
- **G1-8** ([#283](../verification/issue-283.md#decisions)): "served
  beyond this machine" is `HOST` or `PUBLISHED_ADDRESS` beyond loopback, a
  non-local `PUBLIC_URL` or `TRUST_PROXY`; an existing database's
  password also needs `ALTER USER`.
- **G1-9** ([#285](../verification/issue-285.md#decisions)): keys are
  written `<version>:<key>`, a new one as `2:<key>`; retired keys in
  `RETIRED_ENCRYPTION_KEYS`; the re-seal runs at start; no ADR.
- **W1-1** ([#289](../verification/issue-289.md#decisions)): deliveries
  are known by their body, the last 10,000 in memory; a replay is a `202`.
  **Left open:** keeping them in Postgres; intake over one Floor rather
  than every Floor.
- **W1-2** ([#291](../verification/issue-291.md#decisions)): Workflows is
  asked for only when the installation has it; the listing token is
  metadata only.
- **W1-3** ([#293](../verification/issue-293.md#decisions)): each token is
  revoked as its sandbox ends, a failed revoke swallowed.
- **W1-4** ([#295](../verification/issue-295.md#decisions)): twenty
  failures in ten minutes per address, in memory. **Left open:** other
  numbers.
- **W1-5** ([#297](../verification/issue-297.md#decisions)): every `*-by:`
  trailer is dropped. **Left open:** checking the author date.
- **W1-6** ([#299](../verification/issue-299.md#decisions)): the approved
  head is kept on the Notice; a moved branch asks the Owner again.
  **Left open:** sending it back to review instead.
- **I1-1** ([#301](../verification/issue-301.md#decisions), ADR 0007):
  `ALLOWED_INTERNAL_HOSTS` in the environment, not Admin; plain `http://`
  held to it except the outbound proxy; hosts judged by form and by what
  they resolve to.
- **I1-2** ([#303](../verification/issue-303.md#decisions)): a refused
  delivery is a failed one; the error names the host, never the URL.
- **I1-3** ([#305](../verification/issue-305.md#decisions)): Git follows
  no redirect and is pinned to the first address checked.
- **I1-4** ([#307](../verification/issue-307.md#decisions)): images are
  pinned by tag and digest, by hand: a security update arrives only when
  someone moves a pin.
- **I1-5** ([#309](../verification/issue-309.md#decisions)): Claude Code
  from npm by the lockfile, `gh` from a checked tarball, named install
  scripts only, self-updates off; the version variables are ignored.
- **I1-6** ([#311](../verification/issue-311.md#decisions)):
  semantic-release decides the version in a job that cannot write;
  release comments and labels are dropped. **Left open:** a compromised
  dependency there could still choose the release notes or a higher
  version.
- **I1-7** ([#313](../verification/issue-313.md#decisions)): the build job
  keeps `pages: read`.
- **I1-8** ([#315](../verification/issue-315.md#decisions)): FR-1 and FR-2
  changed, the decisions log annotated; FR-2 says an API key asks no
  second factor. **Left open:** whether the documents read clearly to an
  Owner hardening a deployment.
- **I1-9** ([#317](../verification/issue-317.md#decisions)): `.env.example`
  already said it; tests now hold it.
- **I1-10** ([#319](../verification/issue-319.md#decisions)): the compose
  comment cites findings by ID, and each fix updates it.
- **I1-11** ([#321](../verification/issue-321.md#decisions)): only strict
  semantic versions of at most 64 characters; a refusal cached a minute,
  never logged.
- **I2-1** ([#323](../verification/issue-323.md#decisions)): the Gateway's
  own port gets no security headers; the sign-in callback keeps
  `Referrer-Policy: no-referrer`.
- **I2-2** ([#325](../verification/issue-325.md#decisions)): the body
  limit stays 32 MiB for a key in use; an unread body is discarded.
  **Left open:** a caller that keeps sending holds a socket until Node's
  timeouts.
- **I2-3** ([#327](../verification/issue-327.md#decisions)): the sign-in
  limits, with a limiter of their own; only a key found not in use
  counts; the Gateway's own port is not limited; two new event types.
  **Left open:** a restart forgets a running lockout.
- **I2-4** ([#329](../verification/issue-329.md#decisions)): the default
  is `~/.ai-office/sandboxes`; the server refuses a work directory that is
  a link or another user's. **Left open:** an existing `.env` under
  `/tmp` should be emptied or moved; a link under a world-writable
  directory to a suitable directory would still be taken.
- **I2-5** ([#331](../verification/issue-331.md#decisions)): the work
  directory is `0700`, an existing one made private in place.

## The cross-reference test

Every probe test file that holds an `it.fails` (a property that should hold
but doesn't) must be referenced by some assessment, so no failing property
sits in the tree unexplained. `pnpm test` checks it
(`test/pen-testing.test.ts`, the `repository` Vitest project):

- it finds every `*.pen-test.test.ts` and `*.pen-test.integration.test.ts`
  in the repository, outside `node_modules`, build output and dot
  directories;
- for each that holds an `it.fails` (or `test.fails`), it looks for the
  file's path from the repository root in the text of the Markdown files
  under [`assessments/`](assessments/). A relative link such as
  `../../../packages/orchestrator/src/sandbox/x.pen-test.test.ts` contains
  that path, so it counts;
- it fails, naming each file no assessment references.

When a remediation turns a file's last `it.fails` into an `it`, the file
needs no reference any more, but the assessment keeps its link.
