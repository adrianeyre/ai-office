# Issue #303: [fix] I1-2 — The generic webhook Connection accepts any http or internal/loopback/link-local host, so it is a blind SSRF — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0,
git 2.39.5; no Docker, no Postgres, no DNS and no network beyond the
registry and the model). The fix is commit `e5a0122`,
`fix(security): I1-2 a Connection is never sent to an internal address the Owner did not allow in the environment, a webhook above all`,
on top of `aa429d9` (I1-1's fix, #301), whose host policy, guard and
`ALLOWED_INTERNAL_HOSTS` it uses. Its blocker, the I1 probe (#197), is in
the tree: `docs/pen-testing/assessments/I1.md` and
`packages/communications/src/transports/webhook.pen-test.test.ts`.

This is the remediation of finding **I1-2** (`severity:low`, H13).

## What was fixed

The generic webhook Connection POSTed AI Office's message to any http or
https address, internal ones included, and told the Owner the answer's
status, or that nothing listened: a blind SSRF with a status and
reachability oracle.

- **The same host policy as I1-1**
  ([ADR 0007](../architectural-decision-record/0007-owner-given-addresses-never-reach-internal-hosts.md)):
  a webhook's address may not name a loopback, link-local, private or
  other internal host, nor be plain `http://`, unless
  `ALLOWED_INTERNAL_HOSTS` names the host. The schema
  (`webhookCredentialsSchema`) refuses it, naming the variable.
- **The send checks again** (`fetchOwnerUrl`,
  `packages/communications/src/transports/transport.ts`): the host, what
  it resolves to, and each connection as it is made, through I1-1's
  `ownerFetch`. A webhook stored before, or a name that resolves inward,
  is never connected to. The delivery fails with "The webhook is on an
  internal address (…), which AI Office reaches only if
  ALLOWED_INTERNAL_HOSTS names it.": the same words whether anything
  listens there or not, so it is no longer an oracle. Redirects were
  already not followed (`redirect: "manual"`).

### Sibling paths

Every other address a Connection is sent to that the Owner types in had
the same flaw, and has the same fix, in its schema and its send:

- **Slack's incoming webhook address** (the bot's `chat.postMessage` goes
  to Slack's own API, which AI Office fixes, and is unchanged);
- **an ntfy server**;
- **a Confluence site**;
- **an SMTP server's host**: refused by its form in the schema; at send,
  checked by what it resolves to, and nodemailer connects to the address
  that was checked (`servername` keeps TLS checking the server's name).

Notion, Google and Pushover go to hosts AI Office fixes, and are
unchanged. The guide's Connections section (`notices-and-skills.md`) and
"Internal addresses" (`ai-gateway.md`) say so.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "a webhook
      Connection cannot be aimed at a loopback, link-local or private
      address" is an `it`, its assertion unchanged. The file sets
      `ALLOWED_INTERNAL_HOSTS` empty before each test, as AI Office
      starts (the package's tests otherwise allow loopback for their
      fakes; see [#301's Decisions](issue-301.md#decisions), 6).
- [x] **The "pins today" tests become regression tests; none is
      deleted.**
      - "regression (I1-2): the webhook URL schema no longer accepts
        loopback, the metadata service, private addresses, bare names or
        plain http";
      - "regression (I1-2): the webhook no longer POSTs to a loopback
        service, nor reflects its status: the delivery says the host is
        internal" (the service receives nothing; no `502` in the error);
      - "regression (I1-2): whether the internal host answers is no
        longer an oracle — an open port and a closed one fail alike, and
        neither is connected to".
- [x] **Sibling paths with the same flaw are fixed and tested.** In the
      same file:
      - "a webhook on a host the Owner allowed is delivered, over http
        too";
      - "a webhook stored before, or a name that resolves to an internal
        address, is refused when it is sent" (`localhost`, which the
        schema refuses, sent anyway);
      - "the schemas refuse an internal Slack webhook, ntfy server,
        Confluence site and SMTP server";
      - "each transport refuses to send to an internal host, never
        connecting" (Slack, ntfy, Confluence and email, against one live
        loopback service that receives nothing).
      Mutation check: see [below](#mutation-check).
- [x] **The assessment's findings table marks `I1-2` fixed.**
      `docs/pen-testing/assessments/I1.md`: **fixed** (issue #303) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck pass. `pnpm test` fails on six `deployment` and
      `repository` tests that fail the same before these fixes; every
      other test passes. The real output is in
      [issue-301.md](issue-301.md#real-output-of-the-checks), run once
      on the finished tree for all three fixes.

### The probe tests, verbose (I1-2)

```
✓ src/transports/webhook.pen-test.test.ts > I1-2 (H13): a webhook Connection may be aimed at an internal address > regression (I1-2): the webhook URL schema no longer accepts loopback, the metadata service, private addresses, bare names or plain http
✓ src/transports/webhook.pen-test.test.ts > I1-2 (H13): a webhook Connection may be aimed at an internal address > regression (I1-2): the webhook no longer POSTs to a loopback service, nor reflects its status: the delivery says the host is internal
✓ src/transports/webhook.pen-test.test.ts > I1-2 (H13): a webhook Connection may be aimed at an internal address > regression (I1-2): whether the internal host answers is no longer an oracle — an open port and a closed one fail alike, and neither is connected to
✓ src/transports/webhook.pen-test.test.ts > I1-2 (H13): a webhook Connection may be aimed at an internal address > a webhook Connection cannot be aimed at a loopback, link-local or private address
✓ src/transports/webhook.pen-test.test.ts > I1-2 (H13): a webhook Connection may be aimed at an internal address > a webhook on a host the Owner allowed is delivered, over http too
✓ src/transports/webhook.pen-test.test.ts > I1-2 (H13): a webhook Connection may be aimed at an internal address > a webhook stored before, or a name that resolves to an internal address, is refused when it is sent
✓ src/transports/webhook.pen-test.test.ts > I1-2 siblings: every other address a Connection is sent to > the schemas refuse an internal Slack webhook, ntfy server, Confluence site and SMTP server
✓ src/transports/webhook.pen-test.test.ts > I1-2 siblings: every other address a Connection is sent to > each transport refuses to send to an internal host, never connecting
Tests  8 passed (8)
```

### Mutation check

With the send's fetch put back to Node's `fetch` (no guard) and the
webhook schema's refinement removed, 6 of the 8 tests in
`webhook.pen-test.test.ts` fail: the former `it.fails`, all three
regression tests, "a webhook stored before …" and "each transport
refuses to send to an internal host …". The two that pass are "a webhook
on a host the Owner allowed is delivered" and the sibling schemas, whose
refinements were left in. Put back, all 8 pass.

## Decisions

The policy's decisions are [#301's](issue-301.md#decisions). Those
particular to Connections:

1. **A refused delivery is a failed delivery.** It is retried like any
   other for up to 24 hours (FR-94), so after five in a row the
   Connection is marked failing and the Owner gets a Notice saying why.
   Refusing it outright, without retries, would need a new kind of
   delivery error; a later `ALLOWED_INTERNAL_HOSTS` and restart lets the
   retries succeed.
2. **The message names the host, not the URL.** A webhook's path is a
   secret (FR-91); the host was already shown as the Connection's hint.
3. **SMTP is pinned to the address checked**, so a name that answers
   differently the second time cannot send it inward; `servername` keeps
   TLS checking the name the Owner gave.

## Noticed, out of scope

- The six `deployment` and `repository` failures that predate these
  fixes, the Linux `host.docker.internal` gap and the worktree pruning
  during this run are in [#301's note](issue-301.md#noticed-out-of-scope).
- The Owner's own Mailpit under `pnpm dev` (`localhost:1025`) now needs
  `ALLOWED_INTERNAL_HOSTS=localhost`, as their own Ollama does.

## What could not be verified here

- **The issue's statement against the stack's services:** on the
  pen-test stack, a webhook at `http://app:3047/` or
  `http://postgres:3048/` should be refused by the form and the API, and
  one written straight into the database should fail its delivery with
  the internal-address reason while the service sees nothing.
- **Real DNS** for a public name pointed inward (exercised with a
  stand-in resolver, in I1-1's guard tests).
- **SMTP pinning against a real TLS server** (STARTTLS and TLS), and
  the Mailpit contract tests, which need Docker.
- **The Connections page in a browser.**
