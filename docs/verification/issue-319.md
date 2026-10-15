# Issue #319: [fix] I1-10 — The compose file says sandboxes reach "the AI Gateway as app:3047 and nothing else of the stack" — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker). The fix is commit `1413188`,
`fix(security): I1-10 the compose file says a sandbox reaches the app's 3045 and 1455 on its network, not the Gateway alone`,
on top of `af6fac8` (I1-9's fix, #317). Its blocker, the I1 probe
(#197), is in the tree: `docs/pen-testing/assessments/I1.md` and
`test/documentation-drift.pen-test.test.ts`. S2 (#193), whose S2-3
finding this comment describes, is in the tree too:
`docs/pen-testing/assessments/S2.md` and
`docker/sandbox-isolation.pen-test.test.ts`.

This is the remediation of finding **I1-10** (`severity:low`, H17). The
full output of the checks, run once on the finished tree for all four
fixes, is in [#315's note](issue-315.md#real-output-of-the-checks).

## What was fixed

`docker-compose.yml`'s comment on the `sandboxes` network said sandboxes
reach "the AI Gateway as app:3047 and nothing else of the stack". S2-3
showed that the app also answers on that network:

- on 3045: the web app, its `/api`, the sign-in routes and `/v1`;
- on 1455: ChatGPT's sign-in callback, while a sign-in waits.

An Owner reading the comment trusted a boundary that is not there.

The comment now says what a sandbox reaches on that network:

```yaml
  # The network Agents' sandboxes are started on (by the host's Docker).
  # On it a sandbox reaches the AI Gateway as app:3047, and the app's other
  # ports too: app:3045, the web app with its /api and sign-in routes and
  # the Gateway's /v1, and app:1455, ChatGPT's sign-in callback while one
  # waits (pen-test finding S2-3). It also reaches every other sandbox on
  # it (S2-5), and the network beyond, through Docker's bridge (S2-1).
  # Postgres and Caddy are not on it.
```

This fix only stops the document understating the reach. Narrowing the
reach is the work of S2-3, S2-5 and S2-1, which stay open.

### Sibling paths

- **`docs/guide/issue-pipeline.md`, "Sandboxes join the Docker
  network…":** it said sandboxes use the Gateway's own port "never the
  app's address". That describes what a sandbox is configured with, but
  it reads as a boundary. It now says that using the Gateway's port is
  what a sandbox is told, not all it can reach, and names `app:3045` and
  `app:1455`.
- **Read, and found to hold:**
  - the compose header ("The Gateway's own port, 3047, is never
    published: it is the sandboxes' way in");
  - the `GATEWAY_HOST` and `expose` comments ("for the sandboxes
    only", "the sandboxes' way in"), which describe the port's purpose,
    not the limit of the reach;
  - `docker/pen-test/compose.yml`'s network comment ("where the AI
    Gateway is app:3047");
  - `docs/pen-testing/stack.md`;
  - `deploying-to-ec2.md` ("Caddy is not on the sandboxes' network").

  None of these says a sandbox reaches nothing else.

### Where it meets S2-3

S2-3's pin in `docker/sandbox-isolation.pen-test.test.ts` ("pins today:
under compose the app joins ai-office-sandboxes and listens on every
interface for 3045, 1455 and 3047, …") quoted the old comment word for
word, so the two findings' tests had to agree:

- **Changed:** its comment assertion now checks that the old wording is
  gone and that the comment names the Gateway on 3047, `app:3045` and
  `app:1455`. Its name ends "as the compose file now says (I1-10)"
  instead of "while the compose file says sandboxes reach nothing but
  the Gateway".
- **Unchanged:** its assertions on S2-3's behaviour. The app joins the
  network and listens on `0.0.0.0` for 3045, 1455 and 3047.
- **Not touched:** S2-3's own `it.fails` and the S2 assessment.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "the
      compose comment reflects that a sandbox also reaches the app's
      3045 and 1455 (S2-3)" is an `it`. Its assertion is kept, and it
      now also checks that the `networks:` comment names the Gateway as
      `app:3047`, `app:3045` with its `/api` and sign-in routes,
      `app:1455`, and that Postgres and Caddy are not on the network.
- [x] **The "pins today" test becomes a regression test; it is not
      deleted.** "regression (I1-10): the compose file no longer says
      sandboxes reach 'the AI Gateway as app:3047 and nothing else of
      the stack'" checks the old phrase is gone, read with and without
      line breaks.
- [x] **Sibling paths with the same flaw are fixed and tested.** "the
      issue-pipeline guide names the app's 3045 and 1455 beside the
      Gateway's port". S2-3's pin now checks the new comment too (see
      above).

      Mutation check: with the old `docker-compose.yml` and guide put
      back, four tests fail: the regression test, the former `it.fails`,
      the guide sibling and S2-3's pin. With the new files, they pass.
- [x] **The assessment's findings table marks `I1-10` fixed.** The row
      reads **fixed** (issue #319), with the commit's subject.
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails only on three older tests that
      this work does not touch (see
      [#315's note](issue-315.md#noticed-out-of-scope)).

### The probe tests, verbose (I1-10, and S2-3's pin)

```
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > regression (I1-10): the compose file no longer says sandboxes reach 'the AI Gateway as app:3047 and nothing else of the stack'
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-10 (H17): the compose comment claims sandboxes reach only the Gateway > the compose comment reflects that a sandbox also reaches the app's 3045 and 1455 (S2-3)
✓ |repository| test/documentation-drift.pen-test.test.ts > I1-10 siblings: the guide says what a sandbox reaches on its network > the issue-pipeline guide names the app's 3045 and 1455 beside the Gateway's port
✓ |deployment| docker/sandbox-isolation.pen-test.test.ts > S2-3: reach into the stack (H3, H14) > pins today: under compose the app joins ai-office-sandboxes and listens on every interface for 3045, 1455 and 3047, as the compose file now says (I1-10)
```

The rest of `sandbox-isolation.pen-test.test.ts` is unchanged:
`9 passed | 4 expected fail`, S2-1's pin included (the comment names no
`egress`, `iptables` or `169.254.169.254`).

## Decisions

These are for the Owner to review.

1. **The comment also names S2-5 and S2-1.** The issue asks for 3045 and
   1455. Another sandbox on the network, and the network's route out,
   are also things a sandbox reaches on it. A comment that left them
   out would understate the reach in the same way. They are named but
   not tested here, so S2-5's and S2-1's fixes can reword them freely.
2. **The comment cites the findings by ID.** This tells an Owner reading
   it that the reach is known and tracked, not intended. When S2-3,
   S2-5 or S2-1 is fixed, its fix should update the comment, and this
   regression test still refuses "nothing else of the stack".

## Noticed, out of scope

- **Outside compose**, the server listens on `0.0.0.0` by default
  (`HOST` in `.env.example`, "Default 0.0.0.0"). A sandbox on Docker's
  default bridge therefore reaches it at the bridge's gateway address,
  as S2-3's second pin records. `.env.example` makes no claim to the
  contrary, so it is not this drift. It is S2-3's to fix.
- **The three older failures and the one-off whiteboard timeout:** see
  [#315's note](issue-315.md#noticed-out-of-scope).

## What could not be verified here

There is no Docker here, so what a sandbox actually reaches on
`ai-office-sandboxes` was not exercised. The comment follows S2's
assessment, which read the same compose file and the server's listen
addresses. On the pen-test stack, a sandbox reaching `app:3045/health`
and, during a ChatGPT sign-in, `app:1455` would confirm it.
