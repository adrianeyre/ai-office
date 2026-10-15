# Pen-testing: rules of engagement

The rules every party to the first adversarial round works to: the red
team's Agents, any human tester the Owner commissions, and the Owner. The
brief is the [pen-testing PRD](../product-requirements-document/pen-testing.md)
(Engagement shape, "Rules of engagement"); the target is
[the pen-test stack](stack.md); what happens to a finding is the
[triage runbook](triage-runbook.md). This page restates none of their
decisions but the ones a rule has to name. Where it and the PRD disagree,
the PRD wins and this page is corrected.

**Nothing touches the pen-test stack until the Owner has signed these rules
off and the window is open** ([Sign-off](#sign-off), E3,
[#189](https://github.com/adrianeyre/temp3/issues/189)).

## In short

1. Probe the pen-test stack, inside the window, at its pinned commit.
   Nothing else, and never the Owner's real Office.
2. Prove, don't exploit. Stop at the least that shows a property fails.
3. No denial of service, no volumetric testing, nothing on the
   [out-of-scope](#out-of-scope) list.
4. A critical goes to the Owner out of band the moment it is found, then
   through the [runbook](triage-runbook.md) like any finding.
5. Anything that looks like a real credential: stop, don't use it, report
   it out of band, never paste it anywhere.
6. Whatever the red team makes outside what teardown removes, it lists and
   removes before the window closes.
7. "Stop" from the Owner stops every probe at once.

## The window

The window is the stretch of time in which the red team may send anything
to the pen-test stack. It has:

- **an opening and a closing time**, in UTC, set by the Owner;
- **one pinned commit**, the full SHA of this repository the stack is built
  from. Every probe runs against it, every assessment names it, and every
  finding states it as the commit it was found at (PRD, Sequence 4 and
  Findings workflow). [Stand-up](stack.md#standing-it-up) builds the
  checked-out commit, so the Owner checks out the pinned commit first;
- **the stack's host and address**: the Owner's own machine or an instance
  of its own, and the one address the red team reaches it at
  ([Opening it to the red team's host](stack.md#opening-it-to-the-red-teams-host));
- **the out-of-band channel** for a critical ([below](#a-critical-the-out-of-band-channel-and-stop)).

**How it is set and recorded.** The Owner fills in [The record](#the-record)
at the foot of this page, commits it, and signs it off as
[Sign-off](#sign-off) says. The window opens at the time recorded, and not
before the sign-off. A window that is not in the record has not been set.

**Outside the window**, nothing is sent to the stack except by the Owner
standing it up, seeding it and tearing it down. Work that needs no stack
goes on at any time: reading the source, and writing probe tests that run
under `pnpm test`. That is how H1 is worked ahead of the window
(PRD, Sequence 2). If a probe needs the stack before the window, the Owner
opens a window for that probe alone, recorded and signed off the same way.

**Changing it.** Only the Owner extends, shortens, pauses or closes the
window, by a dated line under [Changes](#changes) and a comment on #189.
The pinned commit does not change during a window: the probes of one round
run against one commit. A retest against the stack at a fix's commit is a
window of its own, recorded the same way.

**Closing it.** At the closing time every probe stops sending to the stack.
The Owner saves the stub upstream's log,
[revokes the credentials package](credentials-package.md#revoking-it)
(E4) and asks for the copy handed over to be deleted, and
[tears the stack down](#what-the-red-team-leaves-behind-and-what-teardown-removes).

## Targets

### In bounds

Only the pen-test stack, as [stack.md](stack.md#what-is-in-it) describes
it, at the address recorded for the window:

- its app (the web app and API, the sign-in and setup routes, the webhook
  route, the sign-in callback listener inside the stack);
- its AI Gateway, `app:3047`, which sandboxes reach as `sandbox-relay:3047`
  on `ai-office-pen-test-sandboxes`;
- its sandbox relay, the one way out of `ai-office-pen-test-sandboxes`;
- its sandboxes, its target Floor's Agents and the seeded Floors;
- its database and stub upstream, as far as something inside the stack
  reaches them;
- the throwaway target repository, only through what the stack's Agents
  and GitHub App do to it;
- the host the stack runs on, only as far as proving that a sandbox or the
  app can reach it ([Prove, don't exploit](#prove-dont-exploit)).

Destructive testing is allowed against these and nothing else: deleting or
corrupting the stack's data, changing its settings, killing its containers.

### Never

- **The Owner's real Office.** Not its app, its AI Gateway, its sandboxes,
  its database, its Floors' repositories or its GitHub App, even to confirm
  a finding that is live there today, as H1 is. The red-team Floor runs in
  the real Office and its sandboxes can reach the real app and Gateway (H3):
  they use their own Gateway Key for their own model calls and probe
  neither.
- **A shared host**, or anything else on the network the stack's host is on.
- **GitHub as a service**: its API, its rate limits, its other
  repositories and accounts. The stack's GitHub App and the throwaway
  repository are probed only through what AI Office does with them.
- **The AI Providers as services.** The stack holds no real AI Account; the
  red team's own model calls are ordinary use through the real Office's
  AI Gateway.
- **Third-party services as services**: Slack, email, ntfy, Pushover,
  Notion, Confluence, Google, and Sandcastle's upstream code.
- **The instance metadata service's credentials.** Proving a sandbox
  reaches `169.254.169.254` (H2) is a request for a path that holds no
  secret, such as `/latest/meta-data/instance-id`, never
  `/latest/meta-data/iam/security-credentials/`. Give the stack's instance
  no IAM role for the window.

### Prove, don't exploit

A probe stops at the least that shows a property fails: a canary fetched,
a marker file written in the stack's sandbox work directory, a command's
output showing it ran as root. It never chains a finding into the next
one, keeps access it gained, or uses it beyond the proof. That applies
with the most force to whatever reaches the host: the host holds the
Docker socket and, on the Owner's own machine, the real Office's secrets.
Prove the reach, then stop.

**Denial of service and volumetric testing are never in bounds**, even
against the stack. The absence of a rate limit is a finding; exercising it
beyond the few requests that show it is not.

## Attacker positions and how each is wired

Every probe issue names the positions it uses (PRD, Attacker positions).
The probing Agents never run inside the stack under test.

| # | Position | What the attacker has | Wired from | Sends to |
| --- | --- | --- | --- | --- |
| 1 | Network, unauthenticated | Reach to the app, behind Caddy or bound beyond loopback | The red-team Floor | The stack's address, nothing else |
| 2 | Hostile content | Text an Agent will read | The target Floor, inside the stack | The throwaway repository and the stack's database |
| 3 | Code in a sandbox (assume breach) | Arbitrary code in one of the stack's sandboxes | The sandbox harness, inside the stack | Whatever that sandbox reaches, within [Targets](#targets) |
| 4 | Stolen credential | A session cookie, a UI-capable API key or a Gateway Key | The red-team Floor | The stack's address, with the credentials package's credentials only |
| 5 | Spoofed GitHub | Sending or replaying deliveries to the webhook route | The red-team Floor | The stack's webhook route |

**The red-team Floor (positions 1, 4 and 5).** A Floor in the Owner's own
Office, pointed at this repository for read-only source. Its Agents reach
the stack over the network, at the recorded address alone; the stack
admits only the red team's host ([stack.md](stack.md#opening-it-to-the-red-teams-host)).

- For position 4 they use only the credentials in the
  [credentials package](credentials-package.md) (E4,
  [#190](https://github.com/adrianeyre/temp3/issues/190)): one Owner
  password, one UI-capable API key and one Gateway Key for the stack.
  A session cookie, API key or Gateway Key they mint or capture there is
  theirs to use there, and nowhere else.
- For position 5 they craft deliveries, or capture and replay them, to the
  stack's webhook route. Never to GitHub, never to the real Office's route.
- They have no write access to this repository. Their assessments and probe
  tests reach it the way every Agent's work does: a pull request the
  Office's GitHub App opens. The red-team Floor's Merge Policy is **send to
  me**, so the Owner merges each one.

**The target Floor (position 2).** `pen-test-target`, inside the stack, on
the throwaway repository, seeded with the hostile-content corpus
([The seed](stack.md#the-seed), E2). Its own Agents are the victims.

- Hostile content goes only into the throwaway repository and the stack's
  database. Never into an issue, comment, file or memory of a repository a
  real Floor works, this one included.
- A new payload is added to the corpus (`docker/pen-test/corpus.ts`) with a
  canary that phones home to the stub upstream and nowhere else, as every
  corpus item does.
- The seed opens the corpus's issues as the GitHub App, which intake does
  not take on its own (FR-8). The Owner labels the ones a probe needs.

**The sandbox harness (position 3).** A script run inside one of the
stack's own sandboxes, on the same network, mounts and environment an Agent
gets. E1–E5 do not build it: the first probe that needs it commits it, and
it must:

- start sandboxes only on `ai-office-pen-test-sandboxes`, with the stack's
  sandbox work directory and the environment the stack's app gives an
  Agent; never the real Office's network, work directory or image tag,
  and never a mount of the host's root;
- run nothing the probe has not committed, so the assessment can name what
  ran.

## Out of scope

As in the PRD, [Explicitly out of scope](../product-requirements-document/pen-testing.md#explicitly-out-of-scope):

- **Denial of service and volumetric testing.** The absence of a rate
  limit is in scope as a finding; exercising it is not.
- **The AI Providers, GitHub and Sandcastle's upstream code** as services or
  products. How AI Office uses them (the flags it passes, the mounts it
  makes, the tokens it mints) is in scope.
- **Third-party notification services** (Slack, email, ntfy, Pushover,
  Notion, Confluence, Google) as services. What AI Office sends them, and
  how it holds their credentials, is in scope.
- **The 3D scene and asset pipeline**, except where text an attacker
  controls is rendered.
- **Social engineering, phishing and physical access.** Not commissioned.
  That includes the Owner: no probe tries to get the Owner to do anything.
- **A malicious Owner.** AI Office makes no attempt to protect the Owner
  from themselves.
- **Migration safety and prior data.** There is no production data that is
  not the Owner's own.

## A critical: the out-of-band channel, and "stop"

A critical is what the PRD's severity table says: the Owner's session, an
AI Account, the GitHub App's write access, or the host can be taken or used
without the Owner's authority.

### Reporting it

The moment a probe finds one, it reports it to the Owner out of band, then
files it within a day as the [runbook](triage-runbook.md#from-assessment-to-finding)
says. Its clock still starts at triage.

**Out of band** means outside GitHub and outside the pen-test stack: not an
issue, a comment or a pull request, and nothing the stack shows. The
channel is recorded for the window. For the AI red team it is:

1. The red-team Agent stops its probe's work without committing. AI Office
   then marks it blocked and raises an action Notice, "Agent blocked:
   _Agent_ on #_probe issue_: …", on the red-team Floor in the Owner's own
   Office.
2. Its last words in its live view are the report:
   `CRITICAL <probe ID>: <attacker position>; <what can be taken, in one line>; <whether anything beyond the stack was touched>`.
   Never a credential and never a working payload.
3. The Owner has a phone-push Connection (ntfy or Pushover) sending action
   Notices, set up before the window, so the Notice reaches them away from
   the desk. Only its title leaves the Office (FR-95).

A human tester uses the channel the Owner names in the record, also outside
GitHub and the stack.

### What "stop" means

**The probe that found a critical stops that path** at once: no further
request along it, no chaining, no use of what it gained. It deletes nothing,
so the evidence stays (the stub's log, what it planted, the containers it
started); it lists what it planted in its report, and the Owner decides what
is removed before teardown.

**Every probe stops at once, without waiting for the Owner,** when a
finding reaches beyond the stack: the host, the Owner's real Office, a real
credential, or GitHub beyond the throwaway repository. Otherwise the other
probes go on until the Owner says otherwise.

**When the Owner says "stop"**, for any reason and at any time:

- no position sends anything more to the stack;
- the red-team Agents end their tasks, and the Owner pauses the red-team
  Floor;
- the Owner stops the stack without removing anything, sandboxes first:

  ```bash
  docker ps --quiet --filter network=ai-office-pen-test-sandboxes | xargs -r docker stop
  docker compose --project-name ai-office-pen-test stop
  ```

- nothing is torn down or deleted until the Owner says so, so the evidence
  survives;
- the window is paused, not closed. Only the Owner resumes it, by a dated
  line under [Changes](#changes).

## Anything that looks like a real credential

The stack holds **canary credentials**, `pen-test-canary-<provider>-<random>`
and the corpus's `pen-test-canary-corpus-<id>`. They are worthless outside
the stack; finding one where it should not be is a leak to report as an
ordinary finding, written `<redacted>` (see [stack.md](stack.md#the-stub-upstream)).

**Anything else that looks like a credential is treated as real**: a GitHub
token (`ghs_`, `ghp_`, `github_pat_`) or private key, an AI Account credential
(`sk-ant-`, `sk-`, `xai-`), a cloud credential (`AKIA`, the metadata
service's role credentials), the stack's `ENCRYPTION_KEY`,
`SESSION_SECRET` or database password (which the grey box withholds), or
any of the Owner's own. When a probe meets one:

1. **Stop** that path, as for a critical.
2. **Don't use it**, not even to check it works.
3. **Report it out of band**: what kind it is, where it was found and how,
   never its value or any part of it beyond a published prefix.
4. **Never paste it** into an issue, an assessment, a probe test, a commit,
   a chat, a Notice, the Activity Feed or an Agent's own output. A probe
   checks for a credential by matching it, and prints `<redacted>`.

The Owner revokes or rotates it before the window resumes. The finding is
filed as the runbook says, with `<redacted>` where the value would be.

## What the red team leaves behind, and what teardown removes

### What stays after the round

| What | Where | Who keeps it |
| --- | --- | --- |
| Assessments, one per probe | [`assessments/`](assessments/), through the red-team Floor's pull requests | The repository, for good |
| Probe tests, `*.pen-test.test.ts` and `*.pen-test.integration.test.ts` | Beside the code they probe | The repository; never deleted ([runbook](triage-runbook.md#retest)) |
| Finding issues | This repository's issues | Until remediated or accepted |
| The stub upstream's log | Saved by the Owner before teardown, outside the repository | The Owner, until the round's retests are done |

### What the red team removes before the window closes

Anything it made that teardown does not remove: a container, volume or
network not on the stack's networks, a file on the host outside the
stack's sandbox work directory, a process left running. Each assessment
lists what its probe made outside the stack and that it was removed, or
names it for the Owner to remove.

### What teardown removes

[`docker/pen-test/teardown`](stack.md#tearing-it-down) (E1,
[#187](https://github.com/adrianeyre/temp3/issues/187)) removes:

1. every sandbox container on `ai-office-pen-test-sandboxes`;
2. the stack's containers, with `docker compose down --volumes --remove-orphans`;
3. its networks, `ai-office-pen-test_default` and `ai-office-pen-test-sandboxes`;
4. its database volume, `ai-office-pen-test-postgres-data`, and with it
   every Floor, Agent, AI Account, canary credential and the credentials
   package's password, API key and Gateway Key;
5. its sandbox work directory, and with it the throwaway repository's
   clones, anything planted in them, and the fixture ID listing;
6. its credentials directory, and with it the host's copy of the
   [credentials package](credentials-package.md) if it was not revoked;
7. its generated secrets in `docker/pen-test/.env`.

It keeps the image `ai-office:pen-test` and the Owner's settings in
`docker/pen-test/.env`.

### What the Owner removes after teardown

- the firewall rules that opened the stack (`sudo iptables -D DOCKER-USER …`);
- the pen-test GitHub App: uninstalled from the throwaway repository and its
  private key deleted, or the App deleted;
- the throwaway repository, deleted or archived;
- the red-team Floor, archived (FR-9) or kept for the next round;
- anything an assessment named for the Owner to remove.

Then the checks in [stack.md](stack.md#tearing-it-down) list nothing.

## Sign-off

The window does not open until the Owner signs these rules off. Sign-off is:

1. [The record](#the-record) below filled in and committed;
2. a comment by the Owner on #189, **from the Owner's own GitHub account**,
   naming the commit of this page they sign, the window's opening and
   closing times and its pinned commit.

A commit alone is not a sign-off: an Agent's commit is authored as the
Owner ([ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md)),
and so is the GitHub App's. A comment by the App is not one either.

## The record

Filled in by the Owner before the window opens.

| | |
| --- | --- |
| **Opens (UTC)** | _Not set._ |
| **Closes (UTC)** | _Not set._ |
| **Pinned commit** | _Not set._ (the full SHA) |
| **The stack's host** | _Not set._ (the Owner's machine, or an instance of its own) |
| **Address the red team reaches** | _Not set._ |
| **Red team** | _Not set._ (the red-team Floor, and any human tester) |
| **Out-of-band channel** | _Not set._ (the phone-push Connection; a human tester's channel) |
| **Credentials package delivered** | _Not set._ (E4, #190: when, to whom and how, and the package's `mintedAt`; never a value from it) |
| **Signed off** | _Not yet._ (the date, and a link to the Owner's comment on #189) |

### Changes

One dated line per change to the window: extended, paused, resumed,
stopped or closed, and why.

_None yet._
