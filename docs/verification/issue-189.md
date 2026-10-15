# Issue #189: [pen-test] E3 — Rules of engagement — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GitHub token), in the working tree at `5139e63`, this issue's
documentation commit, on top of `3ce48cd`.

**Blockers.** The issue names none. The PRD's
[Sequence](../product-requirements-document/pen-testing.md#sequence) puts
E3 with E5 "before the window opens", after the PRD. The page links the
stack doc and the findings runbook, and describes teardown (#187); all of
these are on this branch: [`stack.md`](../pen-testing/stack.md) and
`docker/pen-test/` (E1, #187, [note](issue-187.md)), the seed in it (E2,
#188, [note](issue-188.md)), and
[`triage-runbook.md`](../pen-testing/triage-runbook.md) with the templates
(E5, #191, [note](issue-191.md)). The credentials package (E4, #190) is not
built yet and is out of this issue's scope; the page refers to it by
number, as `stack.md` does.

## What was built

### `docs/pen-testing/rules-of-engagement.md` (new)

- **In short:** the seven rules an Agent has to hold on to.
- **The window:** an opening and closing time in UTC, **one pinned commit**
  (the full SHA the stack is built from, named in every assessment and
  finding), the stack's host and address, and the out-of-band channel. Set
  by the Owner in **The record** at the foot of the page and signed off;
  a window not in the record has not been set. Outside the window nothing
  is sent to the stack; source reading and `pnpm test` probe tests go on at
  any time (which is how H1 is worked ahead of the window). Only the Owner
  changes the window, by a dated line under **Changes**; the pinned commit
  does not change within a window; a retest against the stack is a window
  of its own. Closing it leads to saving the stub's log and teardown.
- **Targets:** in bounds, the pen-test stack only (its app, AI Gateway,
  sandboxes, Floors, database and stub as reached from inside, the
  throwaway repository through what the stack does, the host only so far as
  proving reach). **Never:** the Owner's real Office (spelling out that the
  red-team Floor's sandboxes can reach the real app and Gateway, H3, and
  probe neither), a shared host, GitHub, the AI Providers and third-party
  services as services, and the metadata service's role credentials.
  **Prove, don't exploit**, with the most force on anything reaching the
  host. No denial of service or volumetric testing.
- **Attacker positions 1–5:** a table of what each has, where it is wired
  from and where it may send, then the three wirings: the **red-team Floor**
  (positions 1, 4, 5; E4's credentials only; deliveries to the stack's
  webhook route only; no write access, its work arriving as App-opened pull
  requests), the **target Floor** (position 2; hostile content only in the
  throwaway repository and the stack's database, new payloads through the
  corpus), and the **sandbox harness** (position 3; only on the stack's
  sandboxes network, work directory and environment).
- **Out of scope:** the PRD's list, item for item, linked.
- **A critical:** reported out of band (outside GitHub and the stack) the
  moment it is found, then filed through the runbook. For the AI red team:
  the Agent stops without committing, which blocks it and raises an action
  Notice on the red-team Floor; its last words in the live view are a
  one-line report in a fixed shape; a phone-push Connection carries the
  Notice to the Owner. **What "stop" means:** the finding probe stops its
  path and deletes nothing; every probe stops at once, unprompted, when a
  finding reaches beyond the stack; the Owner's "stop" halts every
  position, pauses the red-team Floor, stops the stack without removing
  anything (commands given, sandboxes first), and pauses the window until
  the Owner resumes it.
- **Anything that looks like a real credential:** canary credentials are
  told apart (worthless, reported as an ordinary finding as `<redacted>`);
  anything else is treated as real: stop, don't use it, report its kind and
  where it was found out of band, never paste it anywhere (a probe matches,
  and prints `<redacted>`). The Owner revokes or rotates it before the
  window resumes.
- **Left behind and teardown:** what stays (assessments, probe tests,
  finding issues, the stub's log kept by the Owner); what the red team
  removes itself and lists in its assessment; what teardown (#187) removes,
  item by item as `stack.md` and `stack.ts` do it, including what goes with
  the volume and the work directory; what the Owner removes after (firewall
  rules, the pen-test App and its key, the throwaway repository, the
  red-team Floor).
- **Sign-off:** The record filled in and committed, **and** a comment by
  the Owner on #189 from the Owner's own GitHub account naming the signed
  commit of the page, the window and the pinned commit. A commit alone does
  not count, because an Agent's commit is authored as the Owner (ADR 0002).

### Links into it

- [`docs/pen-testing/README.md`](../pen-testing/README.md): a row in the
  Documents table; the sentence about Enablement documents still to land
  now names only the credentials package.
- [`triage-runbook.md`](../pen-testing/triage-runbook.md): "as the rules of
  engagement say" is now a link to the page's critical section.
- [`stack.md`](../pen-testing/stack.md): "Destructive testing is allowed
  here and nowhere else" links the page's Targets.

## Acceptance criteria

- [x] **Every item above is in the document and consistent with the PRD.**
      Checked by reading the page against the issue's list and the PRD's
      Engagement shape, Attacker positions, How the red team is wired,
      Explicitly out of scope, Sequence and Findings workflow:

  | Issue item | Section | PRD it agrees with |
  | --- | --- | --- |
  | The window, how set and recorded, the pinned commit named in it | The window; The record; Changes | Engagement shape ("cover a window"); Sequence 2–4 ("one pinned commit"); Findings workflow ("the commit it was found at") |
  | Targets: the stack only; never the real Office, a shared host, GitHub, the AI Providers or third-party services as services | Targets (In bounds, Never, Prove don't exploit) | Engagement shape ("Target"); Explicitly out of scope |
  | Attacker positions 1–5 and how each is wired | Attacker positions and how each is wired | Attacker positions; How the red team is wired |
  | Out of scope, as in the PRD | Out of scope | Explicitly out of scope (all seven items) |
  | Out-of-band channel for a critical, and what "stop" means | A critical: the out-of-band channel, and "stop" | Engagement shape; severity table's "critical" |
  | Credential handling: stop, don't use, report out of band, don't paste in an issue | Anything that looks like a real credential | Engagement shape; Data ("synthetic", canaries) |
  | What the red team leaves behind and what teardown (#187) removes | What the red team leaves behind, and what teardown removes | Engagement shape ("Teardown destroys the database volume and the sandbox work directory"); Findings workflow (tests never deleted) |
  | Sign-off by the Owner before the window opens | Sign-off; The record | Sequence 3 ("E3 … before the window opens") |

  The out-of-band path's mechanics were checked against the code: a
  work-Stage Agent that finishes without committing throws
  `AgentBlockedError` (`packages/orchestrator/src/coder/coder.ts:261`,
  `:384`), which marks it blocked and raises an action Notice titled
  "Agent blocked: …" (`coder.ts:860`–`866`). The teardown list matches
  `docker/pen-test/stack.ts` (sandboxes by network, then `down --volumes
  --remove-orphans`, networks, volumes, work directory, secrets) and
  `stack.md`. The glossary's _Avoid_ words were searched for in the page
  (none used for a glossary term; "channel" is the issue's own
  "out-of-band channel", not a Connection).
- [x] **The document links the PRD, the stack doc and the findings
      runbook.** It links the PRD (header and Out of scope), `stack.md`
      (the page and six of its sections) and `triage-runbook.md` (the page
      and two of its sections). Every
      relative link and anchor in the new page, the index, the runbook and
      the stack doc was resolved by a throwaway script (GitHub's heading
      slugs) outside the repository: `bad= 0` for each.
- [x] **`pnpm lint` passes (prettier).** Exit 0 (below). Note that the
      root `.prettierignore` ignores `*.md` ("hand-wrapped prose"), so
      Prettier checks no Markdown file, this one included; the page is
      hand-wrapped like its neighbours.

`pnpm typecheck` exits 0. `pnpm test` exits 1 on **the two pre-existing
failures #188's note recorded**, both in `apps/web` on the CHANGELOG's
first heading (below). This issue changes only Markdown under
`docs/pen-testing/`: `git diff 3ce48cd HEAD -- CHANGELOG.md apps/web` is
empty. The `repository` project, which reads `docs/pen-testing/assessments/`
for the cross-reference test, passes: 7 passed.

## Not verifiable in this sandbox

- **The Owner's sign-off.** It is the Owner's to give, on #189 from the
  Owner's own account, after the record is filled in. The record ships with
  every field _Not set._
- **The stop commands against a running stack** (`docker ps … | xargs -r
  docker stop`, `docker compose --project-name ai-office-pen-test stop`):
  no Docker here. They use the same network name and compose project name
  as `stack.ts`.
- **The out-of-band path end to end**: a red-team Agent's action Notice
  reaching a phone through an ntfy or Pushover Connection needs the Owner's
  Office and Connection. The Notice path was read in the code (above).

## Notes: choices the PRD leaves open

Written into the page for the Owner to change at sign-off:

- **Where the window is recorded**: in the page's own record, plus the
  Owner's comment on #189 as the sign-off.
- **One pinned commit per window**, and a retest against the stack is a
  window of its own.
- **The red-team Floor's Merge Policy is send to me**, so the Owner merges
  every assessment and probe test (the PRD gives the testers no write
  access to this repository).
- **When every probe stops unprompted**: a finding reaching beyond the
  stack (the host, the real Office, a real credential, GitHub beyond the
  throwaway repository). Otherwise a critical stops only its own path
  until the Owner says otherwise.
- **The out-of-band channel for the AI red team**: the blocked Agent's
  action Notice and a phone-push Connection. A human tester's channel is
  named in the record.
- **The metadata service**: proof of reach by a path holding no secret, and
  no IAM role on the stack's instance for the window.

## Noticed, out of scope

- **The position-3 harness does not exist yet.** No E issue builds it; the
  page says the first probe that needs it commits it, and lists what it
  must and must not do.
- **No Agent can raise a Notice of its own accord.** The out-of-band path
  rides on "finished without committing anything", so the Notice's title
  carries that fixed reason, not the Agent's words; the Owner reads the
  report in the live view. A deliberate "report to the Owner" for an Agent
  would be cleaner, and is a product decision.
- **The stack on the Owner's own machine shares a host with the real
  Office's secrets.** `stack.md` allows it; H1 makes a sandbox escape
  root on that host. The page asks for the window's host to be recorded and
  for proof-only on the host; whether to require an instance of its own for
  the window is the Owner's call.
- **`pnpm lint` checks no Markdown** (`*.md` is in `.prettierignore`), so
  the acceptance criterion's "prettier" passes for any `.md` file.
- **The two `apps/web` CHANGELOG failures** remain until `CHANGELOG.md`'s
  first heading carries a release date (as #188's note says).

## Output

### `pnpm lint`

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
LINT_EXIT=0
```

### `pnpm typecheck`

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
TYPECHECK_EXIT=0
```

### `pnpm test`

```text
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
AssertionError: expected '1.0.0' to match /^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

- Expected:
/^1.0.0 \(\d{4}-\d{2}-\d{2}\)$/

+ Received:
"1.0.0"

 ❯ src/site-footer.test.tsx:84:25

 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
AssertionError: expected '1.0.0' to match /^1.0.0 \(/

- Expected:
/^1.0.0 \(/

+ Received:
"1.0.0"

 ❯ src/legal/legal.test.tsx:119:7

 Test Files  2 failed | 405 passed (407)
      Tests  2 failed | 4570 passed | 599 skipped (5171)
TEST_EXIT=1
```

The skips are the Postgres and Docker tests, each with its reason, as in
earlier notes. The counts are the same as #188's.

### Pre-existing, not this issue

```text
$ git diff 3ce48cd HEAD -- CHANGELOG.md apps/web | wc -l
0
$ head -1 CHANGELOG.md
## 1.0.0
```

### The cross-reference test

```text
$ pnpm exec vitest run --project repository
      Tests  7 passed (7)
```

### Links

```text
$ python3 -I /tmp/roe/links.py docs/pen-testing/rules-of-engagement.md
checked bad= 0
$ python3 -I /tmp/roe/links.py docs/pen-testing/README.md docs/pen-testing/triage-runbook.md
checked bad= 0
$ python3 -I /tmp/roe/links.py docs/pen-testing/stack.md
checked bad= 0
```
