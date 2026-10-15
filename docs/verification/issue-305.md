# Issue #305: [fix] I1-3 — Skill and Floor Template import accept any internal https host with no address block — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0,
git 2.39.5; no Docker, no Postgres, no DNS and no network beyond the
registry and the model). The fix is commit `c1e46aa`,
`fix(security): I1-3 a Skill or Floor Template is never cloned from an internal address the Owner did not allow in the environment`,
on top of `e5a0122` (I1-2's fix, #303) and `aa429d9` (I1-1's, #301),
whose host policy, guard and `ALLOWED_INTERNAL_HOSTS` it uses. Its
blocker, the I1 probe (#197), is in the tree:
`docs/pen-testing/assessments/I1.md` and
`packages/orchestrator/src/skills/git.pen-test.test.ts`.

This is the remediation of finding **I1-3** (`severity:low`, H13).

## What was fixed

Skill and Floor Template import cloned from any `https://` host, internal
ones included, and showed the Owner Git's error, which told a live port
from a closed one: an oracle for the stack's network.

- **The same host policy as I1-1**
  ([ADR 0007](../architectural-decision-record/0007-owner-given-addresses-never-reach-internal-hosts.md)):
  the import URL (`skillRepositoryUrlSchema`, which the Floor Template
  import shares) may not name a loopback, link-local, private or other
  internal host unless `ALLOWED_INTERNAL_HOSTS` names it. `https://`
  alone was already required.
- **The clone checks again, before Git runs** (`withShallowClone`'s
  `pinnedTo`, `packages/orchestrator/src/skills/git.ts`): the host by its
  form, then what it resolves to. Refused, the import fails with "The
  repository is on an internal address (…), which AI Office reaches only
  if ALLOWED_INTERNAL_HOSTS names it.", the same for a live port and a
  closed one, and nothing is asked of either.
- **Git is held to the address checked:** `-c
  http.curloptResolve=<host>:<port>:<address>` pins the name to it, so a
  name that answers differently the second time cannot send Git inward,
  and `-c http.followRedirects=false` stops a redirect taking it
  elsewhere.

### Sibling paths

- **Floor Template import** (`gitTemplateRepository`) clones through the
  same `withShallowClone`, so it is fixed with it, and tested on its own.
- **A Skill imported from a hostile Floor Template's repository** (the
  probe's position 2) is the same import, with the same URL schema.
- The guide's Skill library (`notices-and-skills.md`), Floor Templates
  (`floors-and-agents.md`) and "Internal addresses" (`ai-gateway.md`)
  say so.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "Skill and
      Template import cannot be aimed at a loopback, link-local or
      private address" is an `it`, its assertion unchanged.
- [x] **The "pins today" tests become regression tests; neither is
      deleted.**
      - "regression (I1-3): the import URL schema no longer accepts
        loopback, the metadata service, private addresses or bare
        internal names over https" (both schemas; each problem names
        `ALLOWED_INTERNAL_HOSTS`; a public repository is still accepted);
      - "regression (I1-3): a clone no longer reaches the host, so its
        failure is no oracle — a live internal port fails as a closed one
        does" (the same message for both, and the live service is asked
        nothing; it now records what it is asked).
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "a Floor Template's clone refuses an internal host as a Skill's
        does, before Git runs";
      - "a host the Owner allowed is accepted by both schemas and cloned
        from" (Git reaches the allowed loopback service).
      Mutation check: see [below](#mutation-check).
- [x] **The assessment's findings table marks `I1-3` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #305) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on six `deployment` and
      `repository` tests that fail the same before these fixes; every
      other test passes. The real output is in
      [issue-301.md](issue-301.md#real-output-of-the-checks), run once
      on the finished tree for all three fixes.

### The probe tests, verbose (I1-3)

```
✓ src/skills/git.pen-test.test.ts > I1-3 (H13): Skill and Template import may name an internal host > regression (I1-3): the import URL schema no longer accepts loopback, the metadata service, private addresses or bare internal names over https
✓ src/skills/git.pen-test.test.ts > I1-3 (H13): Skill and Template import may name an internal host > regression (I1-3): a clone no longer reaches the host, so its failure is no oracle — a live internal port fails as a closed one does
✓ src/skills/git.pen-test.test.ts > I1-3 (H13): Skill and Template import may name an internal host > Skill and Template import cannot be aimed at a loopback, link-local or private address
✓ src/skills/git.pen-test.test.ts > I1-3 siblings: the Floor Template clone, and a host the Owner allowed > a Floor Template's clone refuses an internal host as a Skill's does, before Git runs
✓ src/skills/git.pen-test.test.ts > I1-3 siblings: the Floor Template clone, and a host the Owner allowed > a host the Owner allowed is accepted by both schemas and cloned from
Tests  5 passed (5)
```

### Mutation check

With the import schema's refinement removed and `pinnedTo` returning
no config at once (no check before Git), 4 of the 5 tests in
`git.pen-test.test.ts` fail: the former `it.fails`, both regression
tests and the Floor Template sibling. The one that passes is "a host
the Owner allowed is … cloned from". Put back, all 5 pass.

## Decisions

The policy's decisions are [#301's](issue-301.md#decisions). Those
particular to imports:

1. **Git follows no redirect.** A repository that has moved (GitHub
   redirects a renamed one) now fails to import; the Owner gives its new
   address. Following redirects would need each hop checked, which Git
   cannot be asked to do.
2. **Git is pinned to the first address the name resolves to.** A host
   whose first address this machine cannot reach (an IPv6 address
   without IPv6, say) fails to import, where Git alone would have tried
   the next.
3. **A local repository** (`file://`, which only the tests' option
   allows) is not checked: it has no host.

## Noticed, out of scope

- The six `deployment` and `repository` failures that predate these
  fixes, and the worktree pruning during this run, are in
  [#301's note](issue-301.md#noticed-out-of-scope).

## What could not be verified here

- **The issue's statement against the stack:** on the pen-test stack,
  importing from `https://app:3047/repo.git` or
  `https://169.254.169.254/repo.git` should be refused by the form and
  the API, and a clone of a public name pointed at an internal address
  should be refused before Git runs.
- **`http.curloptResolve` against a real `https://` Git host** (there is
  no DNS or outside network here): that the pin is honoured and TLS still
  checks the name. Git 2.39.5 here, and Git 2.37 and later, take it.
