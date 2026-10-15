# Issue #42: ChatGPT/Codex AI Account (OAuth) — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`a1c31eb`).

## What was built

### The account kind (`packages/shared/src/ai-accounts.ts`)

A **ChatGPT subscription** is an AI Account kind for the **ChatGPT** AI
Provider:

- OpenAI's formats at `https://chatgpt.com`, under `/backend-api/codex` in
  place of `/v1` (ChatGPT's own Codex backend, which Codex uses when signed
  in with ChatGPT);
- it signs in with PKCE (`signIn: "pkce"`);
- it serves only **Codex** (`servesOnly`), and only the Responses endpoints
  (`serves: ["responses", "responses_compact"]`).

`subscriptionProviders` gains ChatGPT, with its own terms warning (FR-35,
PRD §11): OpenAI's terms allow a ChatGPT subscription for coding only
through Codex. A pasted sign-in may be up to 8 KiB, so a whole callback
address fits.

### OpenAI's OAuth (`packages/gateway/src/accounts/oauth.ts`)

- `openaiOAuth` is Codex's public client:
  - `auth.openai.com`'s authorize and token endpoints;
  - client `app_EMoamEEZ73f0CkXaXp7hrann`;
  - scopes `openid profile email offline_access`;
  - Codex's callback, `http://localhost:1455/auth/callback`;
  - Codex's extra authorize parameters (`id_token_add_organizations`,
    `codex_cli_simplified_flow`, `originator=codex_cli_rs`);
  - form-encoded token requests, with no `state` in the code's exchange,
    as Codex sends none.
- Providers now carry their own `authorizeParams` (Claude's `code=true`
  moved there) and `exchangeState`.
- **Pasting the address.** Nothing serves Codex's local callback, so the
  browser shows an address that does not load. `pastedCode` takes that
  address (its `code` and `state`) as well as Claude's `code#state`. The
  state is checked against the login before anything is sent.
- **Expiry.** When a token answer has no `expires_in`, the access token's
  JWT `exp` is used. An answer with neither is refused.
- **Its ChatGPT account.** `chatgptAccountIdOf` reads
  `chatgpt_account_id` from the access token's `https://api.openai.com/auth`
  claim. `requestHeaders` sends it as `chatgpt-account-id` with every
  request the account serves.

`AiAccounts` holds OpenAI's provider for ChatGPT. Login, refresh, token
health and re-authentication are the existing subscription machinery,
unchanged. So the "Re-authentication needed: <name>" Notice (#37) applies
as it is.

### The Gateway (`packages/gateway/src/gateway.ts`, `limits/detect.ts`)

- `agentToolOf` recognises **Codex**: a Responses request (or compaction)
  whose user agent is one of Codex's originators: `codex_cli_rs/…`, or
  `codex_exec/…` (`codex exec`, as sandboxes will run it).
- `GatewayAccount.headers` are added to every request an account serves
  (the ChatGPT account).
- **Routed natively.** Codex's Responses requests match the account's
  format, so they pass through unchanged, streamed, to
  `/backend-api/codex/responses` (and `/responses/compact`), with usage
  read from `response.completed`. Codex's own headers (`originator`,
  `session_id`, `openai-beta`) go with them. A translated request can never
  reach the account, since it serves only Codex and only Responses.
- ChatGPT's `429 usage_limit_reached` holds the account back until
  `resets_in_seconds` (or else `resets_at`).

### API and web

- `POST /api/ai-accounts/oauth` with `"aiProvider":"ChatGPT"` starts the
  login. `POST /api/ai-accounts/oauth/:loginId` takes the pasted address as
  `code`, and re-authentication works the same way. No route changed.
- **Admin's AI Accounts card:**
  - **ChatGPT subscription (Plus, Pro or Business), for Codex** in the
    account types;
  - OpenAI's terms warning;
  - **Sign in to OpenAI**: the link to OpenAI's page, a step saying the
    browser will end on a `localhost:1455` page that does not load, and a
    field, **Address the sign-in ended on**, for that address.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 1101 passed, 195 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1281 passed, 15
      skipped.
- [x] **Fake OAuth tests.**

  The fake OAuth server (`src/accounts/fake-oauth.ts`) gains an OpenAI
  shape:
  - It uses `openaiOAuth`'s own settings, pointed at itself, so the real
    authorize parameters, callback and exchange are what is tested.
  - Its sign-in redirects (302) to the callback with the code and state.
  - It takes forms only, and refuses an exchange that sends a `state` or
    an authorize request without `codex_cli_simplified_flow`.
  - It rotates refresh tokens.
  - Its access tokens are JWTs with `exp` and a ChatGPT account, and its
    answers carry no `expires_in`.

  **Gateway** (`src/accounts/chatgpt-subscriptions.test.ts`, each case in
  memory and in Postgres 18):
  - **Sign-in.**
    - The authorize URL is checked.
    - The pasted callback address adds the account. Its expiry comes from
      the token's `exp`.
    - The exchange is a form with the verifier and no state.
    - The tokens are sealed for the row and told to the redactor. They are
      in no answer, list or event.
    - `config.changed` and the health event are told.
    - A login is used once.
  - **Refused sign-ins.** Another login's address, or one that ended with
    `error=`, is refused before anything reaches OpenAI.
  - **Serving.** It serves Codex's Responses and compactions, as a bearer
    token to `https://chatgpt.com/backend-api/codex`, with
    `chatgpt-account-id`. It serves nothing else:
    - not Claude Code, opencode or no tool;
    - not Chat Completions or Messages;
    - not a Grok Model;
    - nothing once its token has expired.
  - **Refresh.** Ahead of expiry, at OpenAI's token endpoint (refresh
    grant, form). The old refresh token is used up and the new one kept,
    with the new token's expiry.
  - **Re-authentication.** A refused refresh marks it as needing a new
    sign-in, tells the health event and stops refreshing it. Signing in
    again clears it (`aiAccounts.reauthenticated`).
  - Unit checks: Codex's exact authorize URL, pasted addresses, and the
    ChatGPT account read from a token. A value with a newline is refused,
    so it cannot be put in a header.

  **Server** (`apps/server/src/ai-accounts/providers.test.ts`). Through the
  API:
  - no terms accepted, a `400`;
  - the sign-in started (`no-store`);
  - the address pasted, `201`;
  - re-authentication, `200`.

  Neither the answers nor the log carry the token or the code.

  **Web** (`apps/web/src/ai-accounts-card.test.tsx`): choosing the ChatGPT
  subscription shows OpenAI's terms and no import. **Sign in to OpenAI**
  links to OpenAI's page and mentions `localhost:1455`. The pasted address
  is posted as `code`, and the row says "Serves only Codex". The address is
  not left on the page.
- [x] **Recorded-fixture contract tests**
      (`packages/gateway/src/providers/chatgpt.test.ts`).

  Four Codex backend fixtures in `fixtures/chatgpt/` are replayed in 7-byte
  chunks through a real Gateway, against a real ChatGPT subscription
  signed in through the fake OAuth server:
  - a streamed answer with reasoning and cached prompt tokens;
  - a streamed `shell` tool call;
  - a compaction;
  - a `429 usage_limit_reached`.

  For each:
  - the backend receives the very path (`/backend-api/codex/responses`,
    `…/responses/compact`) and body, and Codex's `originator` and user
    agent;
  - it gets the token as a bearer token with `chatgpt-account-id`, and
    never `x-api-key` or the Gateway Key;
  - the caller gets the answer byte for byte;
  - the record has the expected endpoint and tokens;
  - recorder mode saves the path as sent, without the token.

  A coverage test pairs every fixture with its expectation. Also:
  - `503` for Responses from opencode, curl or no user agent;
  - `503` for Codex's Chat Completions;
  - `503` for Claude Code's Messages for `gpt-5-codex`;
  - `503` for Codex asking for a Claude Model;
  - none of those reaches the backend, and Codex's own request does.
  - A subscription at its usage limit falls back to a second one, and is
    held back for the 4800 s its `resets_in_seconds` gives.
  - `detect.test.ts`: `resets_in_seconds`, and `resets_at` when it is
    alone.

  **Mutation checks** (each reverted):

  | Mutation | Tests failed |
  | --- | --- |
  | Codex not recognised as an agent tool | 6 |
  | The account's headers (`chatgpt-account-id`) not sent | 4 |
  | `state` sent in OpenAI's code exchange | 10 |
  | `codex_cli_simplified_flow` not asked for | 6 |
  | A ChatGPT subscription serving every endpoint | 1 |

### Verified on the host

- [ ] **A real ChatGPT login serves a Responses request through the
      Gateway.** Not done here: there is no ChatGPT account in the sandbox,
      and no browser to sign in with.

### Not verifiable in this sandbox

- **Recorded provider responses.** The fixtures were written by hand, as
  #45 is open. They follow the Responses API's documented stream events
  and what Codex is reported to send to and receive from ChatGPT's Codex
  backend: the `x-codex-*` headers, and `usage_limit_reached` with
  `resets_in_seconds`. The compaction's answer shape is the least certain.
- **OpenAI's OAuth for Codex.** OpenAI does not document it for other
  tools. These are what Codex uses:
  - the client id;
  - the endpoints;
  - the scopes and authorize parameters;
  - the form-encoded exchange without `state`.

  These need a real ChatGPT subscription on the host:
  - whether OpenAI accepts the login from an AI Office instance;
  - whether the Codex backend needs more headers than Codex sends through
    the Gateway (it sends `originator`, `session_id` and `openai-beta`;
    `chatgpt-account-id` is added);
  - whether OpenAI's token answers carry `expires_in` (both cases are
    handled);
  - whether the access token carries `chatgpt_account_id` (if not, the
    header is left out).
- **Codex through the Gateway.** Codex pointed at the Gateway with a
  Gateway Key is an API-key-mode Codex. Its exact request body, such as
  whether it sends `store: false` and the fields the Codex backend
  accepts, needs a real run. Its sandbox image is #48.
- The Playwright suite (`pnpm e2e`) was not run (no Docker).
- The Postgres 18 run used an embedded Postgres 18.3, as for earlier
  issues: `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp`. A
  scratch, uncommitted change pointed `postgresTest` at it, giving each
  test file its own template database.

## Notes, and disagreements with the canon

- **Pasting the address rather than a code.** Codex's sign-in redirects to
  a local server on port 1455, which a server-side AI Office cannot
  receive. Codex's own device sign-in is not RFC 8628 (it uses
  `deviceauth` endpoints of its own), and less is known about it. So the
  Owner pastes the address the browser lands on, as other third-party
  Codex clients do.
- **Responses only.** FR-34 asks for translation so any agent tool can
  reach any AI Account. FR-35 says a subscription is used only through the
  AI Provider's own agent tool. FR-35 wins, as it did for Claude and Grok,
  so a ChatGPT subscription serves Codex's Responses unchanged and nothing
  else. ChatGPT through an API key is not in this issue.
- **Usage windows.** The Codex backend reports its five-hour and weekly
  windows in `x-codex-primary-*` and `x-codex-secondary-*` headers. These
  are not read yet. The issue asks for token health, refresh,
  re-authentication, the terms warning and native routing. Usage windows
  for ChatGPT are a follow-up.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker:

```text
 Test Files  107 passed (107)
      Tests  1101 passed | 195 skipped (1296)
   Duration  19.67s (tests 41%, import 37%, transform 13%, environment 8%, setup 1%)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  107 passed (107)
      Tests  1281 passed | 15 skipped (1296)
   Duration  50.14s (tests 87%, import 9%, environment 2%, transform 1%)
```

Sources for Codex's sign-in and backend: the
[Codex repository](https://github.com/openai/codex) (`codex-rs/login`,
`codex-rs/core`), and third-party clients that sign in as Codex.
