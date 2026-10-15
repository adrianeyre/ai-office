# Issue #213: [fix] A1-2 — Setup makes whoever reaches it first the Owner, with nothing binding it to the host or a one-time token — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no browser, no network beyond the registry and the
model). The fix is commit `8b6bf5f`,
`fix(security): A1-2 setup takes something from the host, for a name AI Office is served at`,
on top of `dd17f91` (A1-1's fix, #211, which it builds on: a caller
cannot claim loopback with `X-Forwarded-For`). Its blocker, the A1 probe
(#192), is in the tree: `docs/pen-testing/assessments/A1.md` and
`apps/server/src/auth/setup.pen-test.test.ts`.

This is the remediation of finding **A1-2** (`severity:high`, H4) only.

## What was fixed

Until a password existed, `POST /api/setup` made whoever called it the
Owner: from any address, for any `Host`, so a DNS-rebinding page in the
Owner's own browser could too (its `Origin` and `Host` agree, so it
passed the cross-site check). Now setting the first password takes
something only the host has, and only for a name AI Office is served at:

- **From this machine's loopback** (`request.ip` in `127.0.0.0/8`, `::1`,
  or IPv4-mapped loopback), nothing more is needed: `pnpm dev` (Vite keeps
  the browser's `Host` and proxies from loopback) and `pnpm start` on the
  Owner's own computer work as before, and so do the end-to-end tests.
- **From anywhere else** (including a browser on the host reaching the app
  through Docker's published port, whose peer is the bridge's gateway), the
  body must carry the **one-time setup token**
  (`apps/server/src/auth/setup-token.ts`). While no password exists, the
  server makes a new one at each start (24 random bytes, base64url) and
  writes it with mode `0600` and `wx` to `token` in a new directory made by
  `mkdtemp` (`ai-office-setup-XXXXXX` under the temporary directory, mode
  `0700`), so its path can be neither guessed nor planted. The server logs
  the **path**, never the token; the setup screen's `403
  setup_token_required` says where it is (`docker compose exec app cat
  <path>`). It is compared in constant time. The directory is removed once
  the password is set, and when the server closes.
- **Only for a name AI Office is served at**: the request's `Host` must be
  `PUBLIC_URL`'s name, `localhost` or an IP address. Anything else is `421
  {"error":"wrong_host"}`, before the token or the loopback check. A
  rebinding page's request is for the page's own name, so it is refused
  even from loopback and even with the token.
- **The setup screen** (`apps/web/src/setup-page.tsx`) asks for the token
  only when the server answers `setup_token_required`, showing the
  server's message about where it is, and sends it with the password.
  It shows the server's word for `wrong_host` too.

### Sibling path: listening on every interface

Outside compose, `HOST` defaulted to `0.0.0.0`, so `pnpm start` exposed
setup to the whole network (the probe's third pin). It now defaults to
`127.0.0.1`, as `GATEWAY_HOST` and `OAUTH_CALLBACK_HOST` already did.
Compose sets `HOST: 0.0.0.0` inside the app's container and publishes it
on the host's `127.0.0.1` unless `AI_OFFICE_BIND_ADDRESS` says otherwise,
so compose deployments are unchanged. The end-to-end harness and
`main.test.ts` already set `HOST=127.0.0.1`.

### S2-3's pin

S2's probe (#193) pinned the same default from the sandboxes' side:
"outside compose the server listens on every interface by default, so a
sandbox on the default bridge reaches it". With `HOST` on loopback that no
longer holds, so commit `6fdba40` (`test(pen-test): S2-3's outside-compose
pin is a regression test since A1-2`) turns that pin into a regression
test, keeps it, and notes it in `docs/pen-testing/assessments/S2.md`.
S2-3 itself stays open: under compose the app still listens on every
interface of a container that joins the sandboxes' network.

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** Both
      `it.fails` in `setup.pen-test.test.ts` ("setup is bound to this
      machine or to a one-time token, not open to any address" and "a
      request for a name AI Office is not served at cannot set the password
      (DNS rebinding)") are now `it`, with their bodies unchanged, and pass.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** All three pins are now
      regression tests: a caller from another address without the token is
      `403 setup_token_required`, no password exists and nobody signs in;
      a rebinding page's setup is `421 wrong_host` from loopback and with
      the right token alike; and outside compose `HOST` now defaults to
      `127.0.0.1` (with the Gateway and the OAuth callback still on
      loopback).
- [x] **Sibling paths with the same flaw are fixed and tested.** New
      `describe("A1-2 · what from the host lets a setup through")`: the
      token from another machine sets the password, and is in no log line;
      a wrong token is refused with the file's path and never the token;
      four loopback forms need no token; four private-network addresses
      do; `X-Forwarded-For: 127.0.0.1` from a remote peer does not count as
      loopback (A1-1); `Host` checks for `PUBLIC_URL`'s name, `localhost`,
      IPv4 and IPv6 addresses, and two look-alike names; and
      `writeSetupToken` writes a `0600` file in a `0700` directory of its
      own, a new token each start, removed once spent. The setup page's
      tests cover asking for the token, sending it trimmed, a wrong token,
      and `wrong_host`. `config.test.ts` checks the new `HOST` default.
- [x] **The assessment's findings table marks `A1-2` fixed.**
      `docs/pen-testing/assessments/A1.md`: **fixed** (issue #213) with the
      commit's subject (hash filled at merge).
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** See below.

One "where it holds" test changed: "lets only one of many concurrent
setups set the password" sends its six setups from `198.51.100.8`, which
now needs the token, so each carries it. It still asserts one `204` and
five `404`s.

## Real output of the checks

### `pnpm lint`: exit 0

```
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit 0
```

### `pnpm typecheck`: exit 0

```
packages/gateway typecheck: Done
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit 0
```

### `pnpm test`: two failures, both pre-existing and unrelated

Run at `6fdba40`, after all four fixes:

```
 FAIL  |@ai-office/web| src/site-footer.test.tsx > the footer > opens the changelog from the version, rendered from its Markdown
 FAIL  |@ai-office/web| src/legal/legal.test.tsx > the changelog > is the root CHANGELOG.md, starting at the current version
 Test Files  2 failed | 422 passed (424)
      Tests  2 failed | 4827 passed | 22 expected fail | 600 skipped (5451)
test exit 1
```

Both expect the first release heading of `CHANGELOG.md` to carry a date
(`expected '1.0.0' to match /^1.0.0 \(/`). They failed the same way in a
run before any of these changes, and neither `CHANGELOG.md` nor either
test is touched by them (`git diff 3c081be --stat -- CHANGELOG.md
apps/web/src/site-footer.tsx apps/web/src/site-footer.test.tsx
apps/web/src/legal` is empty). The 600 skipped are the Postgres-backed
tests (no Docker here). The 22 expected fails are the open findings'
`it.fails` (A1-5 to A1-9, S2's and the others'); none of A1-1 to A1-4's
remain.

### The probe tests, verbose

```
✓ setup.pen-test.test.ts > A1-2: who may set the first password > setup is bound to this machine or to a one-time token, not open to any address
✓ setup.pen-test.test.ts > A1-2: who may set the first password > regression (A1-2): a caller from another address, with nothing but the password it chooses, no longer becomes the Owner
✓ setup.pen-test.test.ts > A1-2: who may set the first password > a request for a name AI Office is not served at cannot set the password (DNS rebinding)
✓ setup.pen-test.test.ts > A1-2: who may set the first password > regression (A1-2): Origin matching Host no longer lets a rebinding page set up, from loopback and with the token alike
✓ setup.pen-test.test.ts > A1-2: where setup is reachable before the Owner > regression (A1-2): outside compose (pnpm dev, pnpm start) the server no longer listens on every interface unless HOST says so
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > the one-time setup token lets the Owner set up from another machine
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > refuses a wrong token, and says where the right one is, never what it is
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs no token from this machine's loopback (127.0.0.1)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs no token from this machine's loopback (127.1.2.3)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs no token from this machine's loopback (::1)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs no token from this machine's loopback (::ffff:127.0.0.1)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs the token from anywhere else, a private network too (10.0.0.1)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs the token from anywhere else, a private network too (172.18.0.1)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs the token from anywhere else, a private network too (192.168.1.20)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > needs the token from anywhere else, a private network too (::ffff:10.0.0.1)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > a caller cannot claim loopback with X-Forwarded-For (A1-1)
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > serves setup for PUBLIC_URL's own name
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > serves setup for localhost
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > serves setup for an address
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > serves setup for an IPv6 address
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > serves setup for another name
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > serves setup for a name that only ends like it
✓ setup.pen-test.test.ts > A1-2 · what from the host lets a setup through > writes the token to a file only this user can read, in a directory of its own, which goes once it is spent
```

## Decisions

Neither the PRD nor an ADR decides these. Each is the most conservative
option that keeps the product working, recorded here for the Owner to
review:

1. **The token is in a file, not the log.** The finding suggests "a
   one-time token AI Office prints"; this repository's rule is that no
   credential goes in a log. The log says where the file is; reading it
   needs the host (or `docker compose exec`, which needs the host's
   Docker).
2. **Loopback needs no token.** The finding allows either; asking for the
   token on the Owner's own machine would add a step to `pnpm dev` and
   every local run for nothing a local process could not read anyway.
   A rebinding page reaching loopback is stopped by the `Host` check.
3. **"A name AI Office is served at"** is `PUBLIC_URL`'s, `localhost`, or
   any IP address (a rebinding page cannot use an address as its name).
   The port is not compared: Docker and proxies change it. An Owner who
   reaches AI Office by another name (a Tailscale name, say) before setting
   `PUBLIC_URL` to it gets `421` with a message saying so. The check
   applies to setup only; every other route needs a session, whose
   `SameSite=Strict` cookie a rebinding page does not have.
4. **`HOST` defaults to `127.0.0.1`.** Anyone running `pnpm start` for
   other machines now sets `HOST=0.0.0.0`, as `.env.example` says. The
   image itself does not set `HOST`; compose does.
5. **When the database cannot say whether a password exists** at start,
   the token is written anyway: once a password exists, setup is a `404`
   whatever the token is.

## Noticed, out of scope

- **`pnpm dev` with `vite --host`** would let another machine reach Vite,
  which proxies `/api` from loopback, so setup would need no token from
  it. Vite listens on `localhost` by default; nothing in the repository
  passes `--host`.
- **A1-9** (the first password can never be replaced) is still open; once
  set, setup stays a `404` for good.

## What could not be verified here

- **Compose end to end.** That a browser on the host reaches the app from
  the bridge's gateway (so the token is asked for), that `docker compose
  logs app` shows the path and `docker compose exec app cat <path>` the
  token, need Docker. On the live stack: `docker compose up`, open
  `http://localhost:3045/setup`, set a password without the token
  (refused, with the path), then with it.
- **DNS rebinding in a browser** needs a browser and a DNS server. The
  server's side (the request a rebinding page sends is refused) is
  tested; on the live stack, a rebinding service against a fresh stack
  must get `421`.
- **The end-to-end first-run test** (`e2e/tests/sign-in.spec.ts`) runs
  over `127.0.0.1`, so it needs no token; it was not run here (no
  Postgres).
