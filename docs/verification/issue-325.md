# Issue #325: [fix] I2-2 — An unauthenticated /v1 request's body is read in full (up to the Gateway's 32 MiB limit) before the Gateway Key is checked — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0;
no Docker and no Postgres). The fix is commit `747cf60`,
`fix(security): I2-2 a Gateway request without a key in use is refused before its body is read`,
on top of `25917ac` (#323's). Its blocker, the I2 probe (#287), is in the
tree: `docs/pen-testing/assessments/I2.md` and
`apps/server/src/gateway-entry.pen-test.test.ts`.

This is the remediation of finding **I2-2** (`severity:low`). The full
output of the checks, run once on the finished tree for all five fixes,
is in [#323's note](issue-323.md#real-output-of-the-checks).

## What was fixed

Every Gateway route checked the Gateway Key in its handler. Fastify runs
a handler only after the content-type parser has read the body, and the
Gateway's parser buffers it, up to its 32 MiB `bodyLimit` (Anthropic's
maximum). So a caller with no key, or a wrong one, had the Gateway take
in the whole body before it answered `401`.

`packages/gateway/src/gateway.ts` now checks the key in an `onRequest`
hook (`requireKey`). Fastify runs that hook as the request arrives,
before it reads the body.

- **It refuses with the same answers as before.** A missing key and a
  key not in use get `401`, a Gateway Key store that cannot be read gets
  `503`, and the same log line, without the key, goes to the log. Each
  route answers in its own callers' format: Anthropic's or OpenAI's for
  the endpoints, Anthropic's for the tool-call screen.
- **The handler takes the caller the hook found.** That caller is kept
  per request in a `WeakMap`. A route reached without one throws: it
  cannot happen, and it fails closed.
- **It is the Gateway's own Fastify**, so it holds on the app's port
  (`/v1`, through `gatewayEntry`) and on the Gateway's own port (the
  sandboxes', through the sandbox relay) alike.

### Sibling paths

- **Every route that takes a key.** The finding probed `/v1/messages`.
  The hook is on every endpoint: `/v1/messages`,
  `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/responses`,
  `/v1/responses/compact` and `/v1/systemone`. It is also on the
  tool-call screen, `/v1/ai-office/tool-calls`, which checked its key in
  its handler in the same way.
- **A path no route serves.** A `POST` to `/v1/nowhere` read the whole
  body before its `404`, too. This was confirmed against Fastify 5.12.5
  before the fix: a held-back body got no answer within the timeout. A
  root `onRequest` hook now answers `request.is404` before the body,
  with the same "The AI Gateway has no such route." as before.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "I2-2: an
      unauthenticated /v1 request is refused before its body is read" is
      an `it`. Its assertion is unchanged: `answeredBeforeBody(port)` is
      `true`.
- [x] **The "pins today" tests become regression tests; neither is
      deleted.**
      - "regression (I2-2): the app refuses a 2 MiB body with 413, and
        /v1 refuses the same body without a Gateway Key, 401, without
        reading it first". The app's `413` and `/v1`'s `401` are as
        before. The `401` carries `nosniff`, and now comes before the
        body.
      - "regression (I2-2): /v1 no longer waits for the whole of an
        unauthenticated body: a key not in use is refused before it too".
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - "holds since I2-2: each /v1 endpoint, and a /v1 path no route
        serves, answers an unauthenticated request before its body";
      - "holds since I2-2: on the Gateway's own port too, a keyless
        request is refused before its body", for `/v1/messages` and
        `/v1/nowhere`;
      - "holds: with a Gateway Key in use, /v1 still reads the whole body
        and serves it";
      - in `packages/gateway/src/tool-call-screen.test.ts`: "refuses a
        request with no key in use before reading its body".

      Mutation check: with `gateway.ts` stashed and the tests kept, five
      tests in the probe file fail, and so does the tool-call screen's
      test, each waiting the full second for an answer. With the fix,
      all pass.
- [x] **The assessment's findings table marks `I2-2` fixed.** The row
      reads **fixed** (issue #325), with the commit's subject.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See
      [#323's note](issue-323.md#real-output-of-the-checks).

### The tests, verbose

```
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-2: the body limit on /v1 > regression (I2-2): the app refuses a 2 MiB body with 413, and /v1 refuses the same body without a Gateway Key, 401, without reading it first
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-2: the body limit on /v1 > regression (I2-2): /v1 no longer waits for the whole of an unauthenticated body: a key not in use is refused before it too
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-2: the body limit on /v1 > I2-2: an unauthenticated /v1 request is refused before its body is read
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-2: the body limit on /v1 > holds since I2-2: each /v1 endpoint, and a /v1 path no route serves, answers an unauthenticated request before its body
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-2: the body limit on /v1 > holds since I2-2: on the Gateway's own port too, a keyless request is refused before its body
✓ |@ai-office/server| src/gateway-entry.pen-test.test.ts > I2 (H21): the AI Gateway on the app's own port > I2-2: the body limit on /v1 > holds: with a Gateway Key in use, /v1 still reads the whole body and serves it
✓ |@ai-office/gateway| src/tool-call-screen.test.ts > the tool-call screen's route > refuses a request with no key in use before reading its body
```

## Decisions

These are for the Owner to review.

1. **The body limit stays 32 MiB for a caller with a key in use.** The
   finding is about keyless callers. A key holder may still send what
   Anthropic accepts, so Agents with long contexts keep working.
2. **The unread body is not kept, but the connection is not cut.** Once
   the Gateway has answered, Node discards the rest of the body as it
   arrives, so it keeps the connection for the caller's next request.
   Nothing is buffered. A caller that keeps sending still holds a socket
   until Node's own request timeouts end it, as any slow client does.
   Cutting the connection would break well-behaved clients' keep-alive
   for no memory saved.
3. **The tool-call screen's refusal is now logged** like an endpoint's
   ("A request without a Gateway Key in use was refused.", with the
   route and whether a key was presented, never the key). It used to
   refuse silently.

## Noticed, out of scope

- Nothing new. #327 builds its limiter on the hook added here: the limit
  is checked before the key, in the same place, so the two fixes agree.

## What could not be verified here

There is no Docker, Caddy or second host here. Every case was sent over a
real socket with `node:http`, holding the body back after its first
1 KiB, to the app's port and to the Gateway on a port of its own. Behind
Caddy (`flush_interval -1` and unbuffered request bodies), the early
answer should reach the client the same way. Confirming that on the
pen-test stack's `tls` profile with a held-back body is for the host.
