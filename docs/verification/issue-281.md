# Issue #281: [fix] G1-7 — The Gateway follows an AI Provider's redirect to another origin — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `f751f71`,
`fix(security): G1-7 no redirect is followed with an AI Account's credential, nor passed on to the caller`,
on top of G1-6's `df8eec2` (#279). Its blocker, the G1 probe (#195), is in
the tree: `docs/pen-testing/assessments/G1.md` and
`packages/gateway/src/gateway.pen-test.test.ts`.

This is the remediation of finding **G1-7** (`severity:low`, new). The
real output of the checks, run once on the finished tree for all three
fixes of this run, is in
[issue-277.md](issue-277.md#real-output-of-the-checks).

## What was fixed

Node's `fetch` follows a redirect, and to another origin strips only
`authorization`. An AI Provider endpoint answering `307` to another origin
got that origin the AI Account's `x-api-key` (an Anthropic API key's, or an
Anthropic-compatible endpoint's in `both` mode) and the whole prompt.

Now:

- **The Gateway follows no redirect** (`redirect: "manual"` on its call to
  the AI Provider, `gateway.ts`). A `3xx` answer counts as an AI Provider
  that could not be reached: the account is told it failed (its circuit
  breaker counts it), another account is tried if there is one, and
  otherwise the caller gets a `502`, "The AI Provider answered with a
  redirect, which the AI Gateway does not follow."
- **The `Location` is never passed on.** Passing the `307` through would
  have moved the leak to the caller: its client would follow it with its
  own Gateway Key, which Claude Code sends as `x-api-key`.
- **Every other upstream request follows none.** The one `fetch` every
  request to an AI Provider takes (`createUpstreamFetch`, through the
  outbound proxy or not) follows a redirect only when its caller asks for
  one.

The guide says so: `docs/guide/ai-gateway.md` (The AI Gateway; The
outbound proxy, "No redirects").

### Sibling paths

Each of AI Office's other requests that carries an AI Account's
credential, a token or a prompt had the same flaw:

- the prompt-cache keep-alive (`keep-alive.ts`: the account's key and the
  Agent's prompt);
- the auto-refresh (`auto-refresh.ts`: the account's key);
- the model list (`catalogue.ts`: the account's key);
- a subscription's usage (`accounts.ts`: its access token);
- OAuth token exchange and refresh (`oauth.ts`: a code or refresh token).

In production they all go through `createUpstreamFetch`, which now
follows no redirect; each also asks for none itself (`redirect:
"manual"`), so each holds whatever `fetch` it is given. A `3xx` is not
`ok`, so each fails as it does on an error.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-7: an
      AI Account's credential is sent only to its own endpoint's origin"
      is an `it`, its assertion unchanged.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-7): the
      redirect is no longer followed: the other origin gets neither the AI
      Account's x-api-key nor the prompt": a `502` with no `Location`, and
      nothing reaches the other origin.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `gateway.pen-test.test.ts`: "G1-7: nor an OpenAI-format account's
        bearer token, translated; and another account serves while one
        redirects".
      - `upstream.test.ts`, "redirects (pen-testing G1-7)": "no request
        through it follows a redirect, directly or through the proxy: the
        account's key and the prompt go nowhere else"; "a model list is
        not fetched, with the account's key, from where its endpoint
        redirects"; "follows one only when the caller asks it to".

      With `redirect: "follow"` in place of `"manual"` in `gateway.ts`,
      `upstream.ts` and `catalogue.ts`:

      ```
      × no request through it follows a redirect, directly or through the proxy: the account's key and the prompt go nowhere else 108ms
      × a model list is not fetched, with the account's key, from where its endpoint redirects 16ms
      × regression (G1-7): the redirect is no longer followed: the other origin gets neither the AI Account's x-api-key nor the prompt 96ms
      × G1-7: an AI Account's credential is sent only to its own endpoint's origin 29ms
      × G1-7: nor an OpenAI-format account's bearer token, translated; and another account serves while one redirects 12ms
            Tests  5 failed | 1 passed | 27 skipped (33)
      ```

      (The one that passes is "follows one only when the caller asks it
      to".) Restored, all pass.
- [x] **The assessment's findings table marks `G1-7` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #281) with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See
      [issue-277.md](issue-277.md#real-output-of-the-checks).

## Decisions

1. **No redirect is followed, even to the same origin.** The finding's
   property would allow one to the account's own origin, but no AI
   Provider's API needs one, and following none is the simpler rule to
   hold everywhere. An endpoint the Owner gives with the wrong path or
   scheme now fails with a `502` that names the redirect, instead of
   working through it; the Owner corrects the endpoint.
2. **A redirect counts as a failure, not as the AI Provider's answer.** It
   is retried on another account and counts towards the account's circuit
   breaker, as an endpoint that cannot be reached does. Passing it on
   would leak the caller's Gateway Key instead.
3. **`createUpstreamFetch` follows none by default** for every request,
   published prices and OAuth device codes included, which carry no
   credential: nothing AI Office sends upstream needs one, and a caller
   can still ask for `redirect: "follow"`.

## Noticed, out of scope

- **Plain-http custom endpoints**, where an on-path attacker could answer
  with the redirect (or read the key directly), are #197's (I1).
- **OAuth device-code requests** follow no redirect now, through
  `createUpstreamFetch` only; they carry the public client id, not a
  credential, so they were not given their own `redirect: "manual"`.

## What could not be verified here

- A real AI Provider or compatible endpoint answering with a redirect:
  there is no network to them here. On the pen-test stack, the stub
  upstream set to redirect would show that nothing reaches the other
  origin, and the request history would show the `502`.
- Through a real outbound proxy; here the fake proxy of `upstream.test.ts`
  stands for one, for plain-http requests (a `CONNECT` tunnel's redirect
  comes back the same way, as the AI Provider's answer).
