# Issue #279: [fix] G1-6 — The AI Provider's error text reaches the Gateway Key holder unredacted — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `df8eec2`,
`fix(security): G1-6 no answer the Gateway sends a caller carries the credential of the AI Account that served it`,
on top of G1-5's `f184e6a` (#277). Its blocker, the G1 probe (#195), is in
the tree: `docs/pen-testing/assessments/G1.md` and
`packages/gateway/src/gateway.pen-test.test.ts`.

This is the remediation of finding **G1-6** (`severity:medium`, new). The
real output of the checks, run once on the finished tree for all three
fixes of this run, is in
[issue-277.md](issue-277.md#real-output-of-the-checks).

## What was fixed

The AI Provider's error was sent to the caller as it came: passed through
whole, or its `message` translated (`upstreamError`). An AI Provider, a
compatible endpoint or a proxy in front of one that named the credential
it was given handed the AI Account's credential to whoever held a Gateway
Key, a sandbox included: the one place ADR 0001 says it never reaches.

Now everything that comes back from the AI Provider has the serving
account's credential replaced with `[REDACTED]` on its way to the caller
(`packages/gateway/src/scrub.ts`, wired in `gateway.ts`):

- **Which credential:** the one the request was sent with, in each form it
  took (`credentialsSent`): the account's key or token, each header that
  presented it, and a bearer token alone.
- **Where:** every path of the answer:
  - the response headers passed back, the `x-request-id` and
    `retry-after` of a translated answer, and the request id recorded;
  - a passed-through body, whole or streamed: the stream is scrubbed even
    when a chunk ends in the middle of the credential (`scrubbing`), and
    only bytes that could start it are held back, so events are not
    delayed;
  - a translated answer, error or success, whole or streamed;
  - the answer's body kept in the request history (`clientBody`).
- **What is kept:** the AI Provider's error is still sent on, so an
  Agent's tool still sees why its call failed: "This key is not allowed
  this model: [REDACTED]".

The guide says so: `docs/guide/ai-gateway.md` (The AI Gateway).

### Sibling paths

- **Not only errors.** The same flaw was in every answer the AI Provider
  writes: a success body (a model can be made to repeat what it was
  sent), a streamed one, and its headers. All are scrubbed and tested.
- **Bearer tokens.** An OpenAI-format account (and a subscription) is
  sent its credential as `Bearer …`; translated answers from one are
  tested.
- **AI Office's other upstream calls** (usage, keep-alive, auto-refresh,
  model lists, token refreshes) send nothing they read back to a Gateway
  Key holder: the usage refresh already never keeps an error body, and
  OAuth and Google errors keep only the provider's error code.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-6: no
      answer to a Gateway Key holder carries its AI Account's credential"
      is an `it`, its assertions unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-6): the
      caller no longer gets the AI Account's credential back, passed
      through or translated": still a `401` both ways, the credential
      absent, and the error's text there with `[REDACTED]` in its place.
- [x] **Sibling paths with the same flaw are fixed and tested.** In
      `gateway.pen-test.test.ts`:
      - "G1-6: nor its headers, a streamed answer (the credential split
        across chunks), nor the body kept in request history";
      - "G1-6: nor a translated answer, whole or streamed, from an account
        that takes a bearer token".

      And `scrub.test.ts`: the credential's forms; a stream split
      anywhere, a byte at a time and through multi-byte characters; only
      a possible start held back, and let go when it is not one; nothing
      changed with no credential.

      With `credentialsSent` returning nothing (the fix switched off):

      ```
      × regression (G1-6): the caller no longer gets the AI Account's credential back, passed through or translated 124ms
      × G1-6: no answer to a Gateway Key holder carries its AI Account's credential 23ms
      × G1-6: nor its headers, a streamed answer (the credential split across chunks), nor the body kept in request history 36ms
      × G1-6: nor a translated answer, whole or streamed, from an account that takes a bearer token 19ms
            Tests  4 failed | 18 skipped (22)
      ```

      Restored, all pass.
- [x] **The assessment's findings table marks `G1-6` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #279) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See
      [issue-277.md](issue-277.md#real-output-of-the-checks).

## Decisions

1. **The serving account's own credential, not the central redactor.**
   Running every answer through the redactor's patterns would also mangle
   what a model rightly writes (an example `sk-…` key in code it is
   asked to write) and cost latency on every streamed chunk. The
   credential the call was sent with is the one the finding is about, and
   it can be matched exactly.
2. **Values shorter than the redactor's minimum (4) are left out**, as
   the redactor leaves them out: a two-letter "key" would match noise in
   every answer.
3. **The AI Provider's error text is kept**, with the credential redacted
   in it, rather than replaced with a generic message: the Gateway's
   callers, and the Owner reading the request history, still learn why a
   call failed.
4. **Only the credential as sent is matched**, not other encodings of it
   (JSON-escaped, URL-encoded, base64). AI Account keys and tokens are of
   characters none of those change, except base64; see Noticed.
5. **Fixtures (recorder mode, a development tool) keep what crossed the
   wire**, redacted by the central redactor as before.

## Noticed, out of scope

- **An upstream that echoes the credential encoded** (base64, or split
  across two streamed deltas so it is never contiguous in the answer)
  would still get it past. No known AI Provider does; the probe's own
  upstream echoes it plainly.
- **The request history's stored upstream body** (`upstreamBody`, kept for
  fixtures only) is unchanged; the request history keeps the answer as
  the caller got it.

## What could not be verified here

- Which real AI Providers echo a key in an error: there is no network to
  them here. On the pen-test stack, the stub upstream set to echo would
  show it through a sandbox's `curl`.
- The NFR's "< 10 ms median overhead" on a real host. The gateway's own
  benchmark test passes with the scrub in place.
