# Issue #221: [fix] A1-6 — Neither the app nor Caddy sends CSP, X-Frame-Options, nosniff, Referrer-Policy or HSTS — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no browser, no network beyond the registry and the
model). The fix is commit `a3b5009`,
`fix(security): A1-6 every answer carries the security headers, from the app and through Caddy`,
on top of `addc27e` (A1-5's fix). Its blocker, the A1 probe (#192), is in
the tree: `docs/pen-testing/assessments/A1.md` and the probe tests it
names, `apps/server/src/app.pen-test.test.ts` and
`docker/caddy/caddyfile.pen-test.test.ts`.

This is the remediation of finding **A1-6** (`severity:medium`, H6).

## What was fixed

- **`apps/server/src/security-headers.ts`** says what every answer
  carries:
  - `Content-Security-Policy`: `default-src 'self'`; `script-src 'self'
    'wasm-unsafe-eval'` (the model loader's mesh decoder is WebAssembly);
    `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:` (the
    TOTP QR code and the logo are `data:`, a model's textures `blob:`);
    `font-src 'self' data:`; `connect-src 'self' data: blob:`; `media-src
    'self' data: blob:`; `worker-src 'self' blob:`; `object-src 'none'`;
    `base-uri 'none'`; `form-action 'self'`; **`frame-ancestors
    'none'`**.
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: same-origin`.
  - `Strict-Transport-Security: max-age=31536000` when `PUBLIC_URL` is
    https, or the request came over https (believed from
    `X-Forwarded-Proto` only from the proxy that proves itself, A1-1).
- **`apps/server/src/app.ts`** sets them in the first `onRequest` hook, on
  the raw response, so every answer has them however it is sent: a route's
  reply, a refusal from the access hook (401, 403), the not-found handler,
  a body-parser error, the static files and the **live streams**, which
  hijack the reply and write their own head (Node merges headers set
  before `writeHead`). A route's own header of the same name wins, so the
  Manager chat's attachment downloads keep their stricter
  `default-src 'none'; img-src 'self'; sandbox`.
- **Pages** (`index.html`, served by the not-found handler) get a policy
  that also allows their own inline scripts by SHA-256 hash, worked out
  from the HTML as served (`inlineScriptHashes`): `index.html` has one
  that sets dark mode before the first paint. No `'unsafe-inline'` for
  scripts anywhere.
- **`docker/caddy/Caddyfile`** adds all five with `header ?<Field>
  "<value>"`: `?` sets a header only where the answer has none, so the
  app's own (a page's hashes, an attachment's sandbox) are kept, and
  Caddy's own answers, such as a 502 while the app is down, get them
  (`default-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'` for those).

### Sibling paths

Every way an answer leaves the app: refusals, unknown files, a malformed
body, a cross-site refusal, the live streams (hijacked) and pages are each
tested. The Caddyfile's defaults are tested to be `?` defaults, so they
never replace the app's policies.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "pages and
      API answers carry CSP (frame-ancestors), X-Frame-Options, nosniff,
      Referrer-Policy and HSTS" (`app.pen-test.test.ts`) and "Caddy adds
      HSTS, CSP, X-Frame-Options, nosniff and Referrer-Policy"
      (`caddyfile.pen-test.test.ts`) are `it`s, unchanged, and pass.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (A1-6): no
      longer is none of them sent, on a page, the API or a built file"
      asserts the old `present: []` is gone and each header's value
      (`frame-ancestors 'none'`, `DENY`, `nosniff`, `same-origin`,
      `max-age=31536000`). "regression (A1-6): the Caddyfile no longer has
      no header directive" asserts the old "no header directive at all" is
      gone.
- [x] **Sibling paths with the same flaw are fixed and tested.** New
      `describe("A1-6 · the sibling paths: every answer, however it is
      sent")`: refusals (a page and the API signed out, a wrong password,
      an unknown file, a cross-site request, a malformed body); a live
      stream over a real socket; HSTS only over https (not for an http
      `PUBLIC_URL`, nor with none); a page's policy allows exactly its own
      inline script's hash, and an API answer none. New
      `describe("A1-6 · the sibling paths through Caddy")`: each header is
      a `?` default; Caddy's own answers' policy and `DENY`; HSTS without
      `includeSubDomains` or `preload`.
- [x] **The assessment's findings table marks `A1-6` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #221) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below:
      lint and typecheck pass; `pnpm test` has only the two failures that
      were there before this run, unrelated.

## Real output of the checks

The checks were run once on the finished tree, at `3eb8303` (all five
fixes of this run); see
[issue-227.md](issue-227.md#real-output-of-the-checks) for the output of
all three, shared by the five notes.

### The probe tests, verbose

```
✓ app.pen-test.test.ts > A1-6: security headers on the app's answers > pages and API answers carry CSP (frame-ancestors), X-Frame-Options, nosniff, Referrer-Policy and HSTS
✓ app.pen-test.test.ts > A1-6: security headers on the app's answers > regression (A1-6): no longer is none of them sent, on a page, the API or a built file
✓ app.pen-test.test.ts > A1-6 · the sibling paths: every answer, however it is sent > refusals carry them: no session, a wrong password, an unknown path, a cross-site request
✓ app.pen-test.test.ts > A1-6 · the sibling paths: every answer, however it is sent > a live stream, which writes its own head, carries them
✓ app.pen-test.test.ts > A1-6 · the sibling paths: every answer, however it is sent > HSTS only over https: not for a plain-http PUBLIC_URL, nor with none
✓ app.pen-test.test.ts > A1-6 · the sibling paths: every answer, however it is sent > a page allows its own inline scripts by their hashes, and no other inline script
✓ docker/caddy/caddyfile.pen-test.test.ts > A1-6: security headers through Caddy > Caddy adds HSTS, CSP, X-Frame-Options, nosniff and Referrer-Policy
✓ docker/caddy/caddyfile.pen-test.test.ts > A1-6: security headers through Caddy > regression (A1-6): the Caddyfile no longer has no header directive
✓ docker/caddy/caddyfile.pen-test.test.ts > A1-6 · the sibling paths through Caddy > each only fills a header the app did not send, so the app's own policies are kept
✓ docker/caddy/caddyfile.pen-test.test.ts > A1-6 · the sibling paths through Caddy > Caddy's own answers (the app down) may be framed by no site and run nothing
✓ docker/caddy/caddyfile.pen-test.test.ts > A1-6 · the sibling paths through Caddy > HSTS without includeSubDomains or preload: other names under the Owner's domain are theirs
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **No other site's images** (`img-src 'self' data: blob:`). Text from
   outside that the web app renders as Markdown (a Skill's instructions,
   which may be imported) can no longer make the browser fetch an image
   from an address it chose, which could carry data out in its URL. Such
   an image now shows as a broken image.
2. **`'wasm-unsafe-eval'`** is allowed for scripts, because the model
   loader's Meshopt decoder (`three/addons`) compiles WebAssembly; it
   allows WebAssembly only, not `eval`. **`'unsafe-inline'` for styles**
   is allowed, because libraries set styles inline; styles run no code.
   Inline **scripts** are allowed only by hash.
3. **`Referrer-Policy: same-origin`**: AI Office's own requests keep
   their referrer, and no address inside AI Office (a Floor, an issue)
   reaches GitHub or any other site through a link. `no-referrer` would
   also do; `same-origin` changes nothing for AI Office's own requests.
4. **HSTS for a year, without `includeSubDomains` or `preload`**: other
   names under the Owner's domain may not be https, and preloading is a
   decision for the Owner. It is sent only when `PUBLIC_URL` is https or
   the request came over https, so a plain-http `localhost` is never
   pinned to https.
5. **The app is the source of the headers; Caddy fills gaps** (`?`), so a
   change to the policy is made in one place, and the attachment
   downloads' stricter policy survives the proxy.

## Noticed, out of scope

- **The OAuth callback listener** (port 1455, H14) is a separate HTTP
  server; its page sends `Referrer-Policy: no-referrer` and `no-store` but
  no CSP or `X-Frame-Options`. It is #193's surface (S2), not this app's.
- **The AI Gateway** (port 3047) answers API clients, not browsers, and is
  unchanged.
- **`Cross-Origin-Opener-Policy`** and `Permissions-Policy` would harden
  further; the finding does not ask for them.

## What could not be verified here

- **The web app under the policy in a browser.** There is no browser here,
  so `pnpm e2e` and `pnpm scenes` (Playwright, Chromium) were not run. The
  policy was written from what the web app loads (`index.html`'s inline
  script, Meshopt's WebAssembly, `data:` and `blob:` images, same-origin
  fetches and event streams, no frames, no other origin). On a machine
  with a browser: `pnpm e2e` and `pnpm scenes`, and the console of a
  signed-in Floor shows no CSP violation. Zod's JIT probes `new Function`
  and falls back when CSP refuses it; that may log one report.
- **Caddy itself** needs Docker. The Caddyfile was checked as text; that
  `?` sets a header only where the upstream answer has none (and defers
  until the response is written) is from Caddy's documentation. On the
  live stack: `curl -I https://<domain>/login` shows the app's policy
  (with the inline script's hash) and the other four headers.
