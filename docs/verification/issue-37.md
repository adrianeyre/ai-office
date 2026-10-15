# Issue #37: Anthropic subscription login, token health and refresh — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`9a59d1d`).

## What was built

### The login (`packages/gateway/src/accounts/oauth.ts`, `accounts.ts`)

- **OAuth authorization code with PKCE (S256).** `startLogin` makes a
  verifier and its challenge and a random `state`, keeps them in memory for
  15 minutes, and answers the authorization URL (`code=true`, Claude Code's
  public `client_id`, its manual redirect URI, the scopes, the challenge).
  The Owner signs in on Claude's page and pastes back what it shows
  (`code#state`). `completeLogin` checks the state, exchanges the code with
  the verifier at the token endpoint, and adds the account (or, for
  `startLogin({ accountId })`, gives the existing one its new tokens). A
  login is used once; a refused code ends it.
- **Endpoints** (`anthropicOAuth`): `https://claude.ai/oauth/authorize`,
  `https://platform.claude.com/v1/oauth/token`, redirect
  `https://platform.claude.com/oauth/code/callback`, client
  `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, beta flag `oauth-2025-04-20`. They
  are what Claude Code uses; Anthropic does not document them (see below).

### Tokens at rest (`packages/db`, migration `0019_oauth_accounts`)

- `ai_accounts` gains `refresh_token` (sealed, context
  `ai_account.refresh_token:<id>`), `token_expires_at` and
  `reauthentication_needed`. The access token is the account's `credential`
  (sealed, `ai_account.credential:<id>`).
- Check constraints: the refresh token is sealed, and an account is `oauth`
  exactly when it has a refresh token and an expiry.
- Both tokens are registered with the redactor when opened.
  `holdsCredential` (from #36) checks the refresh token too.

### Health and refresh

- **Health** (`tokenHealthOf`, shared with the web app): `valid`,
  `expiring` (15 minutes or less left) or `expired`. The API sends
  `tokenHealth`, `tokenExpiresAt` and `reauthenticationNeeded`, computed
  against the app's clock.
- **Refresh ahead of expiry.** `refreshTokens()` refreshes every OAuth
  account whose token expires within 15 minutes. Only one refresh runs per
  account at a time, because a refresh token is used once. The server runs
  it at start and every minute.
- **Live.** Each change of health, or a new expiry, is an
  `ai_account.token_health` event (new event family `ai_account`, shown in
  the Activity Feed under "AI Accounts"). The admin card refetches on each
  one.
- **Failures.**
  - **Refused** (a 4xx such as `invalid_grant`): the account is marked
    `reauthenticationNeeded` and not asked again.
  - **Anything else** (unreachable, 5xx): tried again the next minute; the
    health still moves to `expiring`, then `expired`.
  - Either way the account serves until its access token expires, then is
    skipped.

### The Notice (`packages/orchestrator/src/ai-accounts/reauthentication.ts`)

- `createReauthenticationNotices` follows `ai_account.token_health`. When
  `reauthenticationNeeded` is set it raises one action Notice per account,
  "Re-authentication needed: <name>", with the action
  `reauthenticate_ai_account` ("Re-authenticate"). The action's new `href`
  is `/admin?reauthenticate=<id>`.
- Notice actions gain an optional `href` (a path in AI Office). The Notice
  Board links there instead of acting. The handler only checks the account
  no longer needs signing in, so taking the action early fails and the
  Notice stays. When the account signs in again, the Notice is acted on and
  closed.

### Only the matching agent tool (FR-35, PRD §11)

- Account kinds gain `servesOnly`; a Claude subscription's is `Claude
  Code`. `AccountSource.select` now takes the request's agent tool:
  `agentToolOf` gives `Claude Code` only for a Messages or `count_tokens`
  request from a `claude-cli/<version>` user agent.
- A subscription is skipped for every other request. That includes Codex,
  opencode, anything without that user agent, and any OpenAI-format
  request, which would have to be translated.
- It sends its token as `authorization: Bearer`, never `x-api-key`, and
  adds `oauth-2025-04-20` to the caller's `anthropic-beta` flags.

### API (`apps/server`) and web (`apps/web`)

- `POST /api/ai-accounts/oauth` (`{"name","aiProvider":"Claude",
  "acceptedTerms":true}`) and `POST /api/ai-accounts/:id/reauthenticate`
  answer `{"loginId","authorizeUrl","expiresAt"}` with `no-store`.
- `POST /api/ai-accounts/oauth/:loginId` (`{"code"}`) answers `201` (added)
  or `200` (signed in again).
- Errors: `oauth_login_not_found` 404, `oauth_code_refused` 400,
  `oauth_unavailable` 502, `not_oauth_account` 409.
- The admin card:
  - **Adding.** Choosing "Claude subscription (Pro or Max)" replaces the
    key fields with the warning about Anthropic's terms
    (`subscriptionTermsWarning`) and a checkbox, then **Sign in to Claude**,
    then the two steps: open the page, paste the code.
  - **Each subscription** shows its token health badge, "Serves only Claude
    Code", and **Re-authenticate**.
  - **From a Notice.** `/admin?reauthenticate=<id>` brings that account up.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 955 passed, 166 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1106 passed, 15
      skipped (the Docker image and compose checks).
- [x] **Tests with a fake OAuth server: full PKCE flow, refresh ahead of
      expiry, failed refresh raises the Notice.**

  **The fake OAuth server** (`packages/gateway/src/accounts/fake-oauth.ts`,
  exported as `@ai-office/gateway/testing`):
  - checks the authorization request (client, `S256`, challenge shape,
    redirect, state) and shows `code#state`;
  - at the token endpoint, issues tokens only when the verifier hashes to
    the code's challenge and the redirect and state match, using each code
    once;
  - rotates refresh tokens;
  - can refuse refreshes (`invalid_grant`) or fail (`503`).

  **The tests:**
  - **Full PKCE flow.** In `packages/gateway/src/accounts/subscriptions.test.ts`,
    in memory and in Postgres 18:
    - the authorization URL carries the challenge and `S256`;
    - the token request carries the code, the state, the redirect and a
      43-character verifier, which the fake verified;
    - the account is added with both tokens sealed, nothing `sk-ant-` in
      the store's JSON, answers or events, both tokens registered for
      redaction, and a `token_health: valid` event;
    - a finished login cannot be reused;
    - a wrong verifier is refused by the server;
    - another login's code is refused before anything is sent;
    - a login older than 15 minutes is gone.

    Through the API, in `apps/server/src/ai-accounts/oauth.test.ts` (memory
    and Postgres 18):
    - `acceptedTerms: false` is refused with the terms message;
    - the whole flow answers `201` with `tokenHealth: valid`, which turns
      `expiring` 7.9 hours later;
    - an unknown login is a 404, and a refused code a 400;
    - no answer, event or log line holds a token or the pasted code.
  - **Refresh ahead of expiry.** `refreshes tokens ahead of expiry, once at
    a time`:
    - at 7.5 h (30 minutes left) nothing is refreshed;
    - at 7.8 h it is refreshed exactly once, although two rounds overlap;
    - the new access token is stored and served to Claude Code, the old
      refresh token is used up and the new one kept, and the expiry moves
      to 15.8 h.

    `tells the token is expiring, then expired, …`: with the fake failing
    (`503`), health goes valid → expiring → expired, and the account stops
    serving at expiry and recovers once the fake answers.
  - **Failed refresh raises the Notice.**
    - `apps/server/src/ai-accounts/oauth.test.ts` wires the real AI
      Accounts, Notices and re-authentication Notices behind the real
      routes. After a refused refresh, `GET /api/notices` shows the action
      Notice "Re-authentication needed: Claude Max", with
      `href: /admin?reauthenticate=<id>`, and the account shows
      `reauthenticationNeeded: true`. Acting on it early is refused (502)
      and it stays. Signing in again through
      `/api/ai-accounts/:id/reauthenticate` answers `200` and closes it
      (`notice.acted_on`).
    - `packages/orchestrator/src/ai-accounts/reauthentication.test.ts`:
      one Notice however often the health is told; none for a token that
      is only expiring or expired.
  - **Mutation checks** (each reverted):
    - sending a wrong PKCE verifier: 8 tests failed;
    - refreshing only at expiry: 3 tests failed;
    - never raising the Notice: 3 tests failed.

Also covered:

- **Only Claude Code** (`subscriptions.test.ts`):
  - `select` gives the subscription to `Claude Code` only, never to `null`,
    `Codex` or `opencode`; an API key still serves everyone.
  - Through a running Gateway, a `claude-cli/2.1.3` request reaches the
    AI Provider with `Bearer <access token>`, no `x-api-key`, and
    `anthropic-beta: claude-code-20250219,oauth-2025-04-20`.
  - A `codex_cli_rs` request, and a Chat Completions request from a
    `claude-cli` user agent, get 503 and reach nothing.
- **Web:**
  - `ai-accounts-card.test.tsx` covers the terms warning; refusing to start
    without ticking it; the whole sign-in; the badges; live health from an
    `ai_account.token_health` event; and signing in again, brought up by
    `/admin?reauthenticate=…`.
  - `notice-board.test.tsx`: an action with an `href` is a link that
    navigates there without acting.
- **Events:** the new event parses, has an Activity Feed label and group,
  and has text.

### Verified on the host

- [ ] **A real Claude subscription can be added and serves a coder run.**
      Not verifiable here: it needs a real Claude Pro or Max login in a
      browser, Anthropic's real OAuth endpoints, Docker and the Claude Code
      image, and the GitHub App and `ai-office-sandbox` (#18). To check:
      - In Admin, add a "Claude subscription", sign in, and paste the code.
      - Pause any API-key account.
      - Run a coder Agent on an `ai-office` issue.
      - **Gateway** should show its requests served by the subscription.

### Also not verifiable in this sandbox

- **Anthropic's OAuth details.** The authorize and token URLs, the manual
  redirect URI, the client id, the scopes, the `code#state` page and the
  `oauth-2025-04-20` flag come from what Claude Code does; Anthropic does
  not document them. Recorded OAuth fixtures are #45. If any has changed,
  only `anthropicOAuth` needs changing.
- **Claude Code's user agent.** That Claude Code, run in a sandbox with
  `ANTHROPIC_AUTH_TOKEN`, sends `claude-cli/<version>` as its user agent (the
  check that lets a subscription serve it).
- **Refreshing from a server.** A refresh from a headless server: community
  reports say Anthropic's edge has sometimes blocked those. Such a block
  would show as a refused refresh, then the Notice.
- The Testcontainers path of the Postgres tests (no Docker); they ran
  against an embedded Postgres 18.3 instead, as in #36.
- `pnpm e2e` (Playwright and Chromium) was not run for this issue. The
  admin card's key form and button names that `ai-accounts.spec.ts` uses
  are unchanged, and `e2e` type-checks.

## A fix found afterwards

While working #38, a test of overlapping refresh rounds failed once against
Postgres. The cause was a real race. A round that read the accounts just
before another round's refresh finished could then refresh with the refresh
token that refresh had already used up. Anthropic would refuse it, and the
account would wrongly ask to be signed in again. The fix
(`fix(gateway): refresh with the refresh token as stored, not as read
before`): each refresh now reads the account again inside its per-account
turn, and refreshes only if it is still due.

- **Regression test:** `never refreshes with a refresh token another round
  has already used`. A second AI Accounts instance holds a stale read; it
  makes no refresh request, and the account still needs no new sign-in.
- **The overlapping-rounds test** now checks only what must hold: exactly
  one refresh request, and nothing refused or failed. It no longer checks
  which round reported the refresh.

Lint, typecheck and the whole test suite (twice against Postgres 18) pass
after it; the output is in `issue-38.md`.

## Notes, and disagreements with the canon

- **Is a subscription through the Gateway within Anthropic's terms?** PRD
  §11 accepts the risk: subscriptions are used only through the AI
  Provider's own agent tool, and the Owner is warned. The Gateway sits
  between Claude Code and Anthropic, and only Claude Code's own requests,
  unchanged, are served from a subscription. Whether Anthropic counts that
  as "through Claude Code" is for the Owner to judge; the warning says so
  plainly.
- **"Serves only Claude Code" trusts the user agent.** It is a request
  header, so a caller that holds a Gateway Key could fake it. Only the
  Owner's Agents and tools hold Gateway Keys, so this keeps honest tools
  apart rather than stopping a hostile one.
- **Logins live in memory.** A login started before a restart cannot be
  finished after it; the Owner starts again.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  92 passed (92)
      Tests  955 passed | 166 skipped (1121)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  92 passed (92)
      Tests  1106 passed | 15 skipped (1121)
   Start at  07:37:32
   Duration  39.19s (tests 87%, import 9%, environment 2%, transform 1%)
```
