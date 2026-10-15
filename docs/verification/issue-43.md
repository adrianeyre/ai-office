# Issue #43: xAI/Grok AI Account (OAuth import and API key) — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`ee3e2ea`).

## What was built

### The account kinds (`packages/shared/src/ai-accounts.ts`)

Each AI Account kind now says what API it speaks and where its paths start
(`apiFormat`, `apiPath`), and how a subscription signs in (`signIn`). Two
kinds are added, both mapped to the **Grok** AI Provider:

- **xAI API key**: OpenAI formats at `https://api.x.ai` + `/v1`; it serves
  anyone.
- **Grok subscription**: the same API with an OAuth token. It signs in with
  the device flow, and serves only **opencode**, the agent tool AI Office
  runs for Grok (PRD FR-16). Before adding one, the Owner accepts xAI's own
  terms warning.

`POST /api/ai-accounts` takes `"aiProvider":"Claude"` or `"Grok"`.

### Routing by Model

`aiProviderOfModel` maps a Model to its AI Provider: `claude-*`, `grok-*`,
`gemini-*`/`gemma-*`, and `gpt-*`/`o1…`/`codex-*`. A provider prefix such
as `x-ai/` is ignored. The Gateway passes the requested Model to
`select`, and a known AI Provider's Model is served only by its accounts,
so a Claude Model never reaches xAI and the reverse. A Model of no known
AI Provider may go to any account, as before.

### The Gateway (`packages/gateway/src/gateway.ts`)

- An account's upstream URL is its base URL, then its `apiPath` in place of
  `/v1`. Anthropic and xAI keep `/v1`; Gemini's will differ (#44).
- OpenAI-format accounts get the key or token as `Authorization: Bearer`.
  #41 had built that path; it now has real account kinds behind it.
- `agentToolOf` also recognises **opencode**: a Chat Completions or
  Responses request with an `opencode/…` user agent.

### xAI's OAuth (`packages/gateway/src/accounts/oauth.ts`)

- `xaiOAuth` is the Grok CLI's public client, as third-party clients report
  it:
  - issuer `auth.x.ai`, with its device code and token endpoints;
  - client `b1a00492-…`;
  - scopes `openid profile email offline_access grok-cli:access api:access`;
  - form-encoded token requests.
- The device flow (RFC 8628):
  - `startDeviceLogin` gives the user code and the verification URL;
  - `pollDeviceLogin` asks once for the tokens. `authorization_pending`
    and `slow_down` are a new `OAuthError` reason, `pending`.
- `AiAccounts` holds one OAuth provider per AI Provider: Anthropic's for
  Claude, xAI's for Grok. Each login, refresh and re-authentication uses
  its account's provider.
  - A device login's `completeLogin(loginId, undefined)` answers `409
    oauth_login_pending` until the Owner approves it.
  - A denied or expired one is refused, and its login is gone.
- **Importing a Grok CLI login.** `tokensInLoginFile` takes the first
  object, at any depth, with an access and a refresh token, in either
  spelling. Its expiry is read in this order:
  - the file's own field (ISO, or seconds or milliseconds since the epoch);
  - the access token's JWT `exp`;
  - otherwise now, so it is refreshed at once.

  `importLogin` adds the account like a completed sign-in (sealed,
  `config.changed` `aiAccounts.imported`, token health told). Nothing else
  in the file is kept.

### API and web

- `POST /api/ai-accounts/oauth` with `"aiProvider":"Grok"` answers the
  login with a `userCode`. `POST /api/ai-accounts/oauth/:loginId` takes
  `{}` for a device login (`code` is optional now).
- `POST /api/ai-accounts/import` with `{"name","aiProvider":"Grok",
  "acceptedTerms":true,"login"}` imports a login. One without tokens is
  `400 login_not_importable`, never echoing it.
- **Admin's AI Accounts card:**
  - **xAI API key** in the account types, with `https://api.x.ai` as the
    endpoint placeholder.
  - **Grok subscription** shows xAI's terms warning, then **Sign in to
    xAI**: the code to approve, a link to xAI's page, and **Finish signing
    in**, with no code to paste.
  - Or **Import an existing Grok CLI login**: a field for
    `~/.grok/auth.json`, cleared from the page once imported.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 1072 passed, 190 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1247 passed, 15
      skipped.
- [x] **Recorded-fixture contract tests.**

  **API key** (`packages/gateway/src/providers/xai.test.ts`). Four xAI
  fixtures in `fixtures/xai/` are replayed through a real Gateway serving
  from a real xAI API-key account, in 7-byte chunks:
  - a Chat Completion, with cached prompt tokens;
  - a streamed Chat Completion, with its usage chunk;
  - a Responses answer;
  - a `429` with xAI's `x-ratelimit-*` headers and its string `error`
    body.

  For each, the account receives the very path (`/v1/chat/completions`,
  `/v1/responses`) and body. It gets the xAI key as a bearer token, and
  never `x-api-key` or the Gateway Key. The caller gets the answer byte for
  byte, and the record has the expected tokens. A coverage test pairs every
  fixture with its expectation.

  Also through the Gateway:
  - Claude Code's Messages for `grok-4` are translated to Chat Completions
    for xAI, and back.
  - With a Claude account first in priority and an xAI one second, `grok-4`
    goes only to xAI and `claude-sonnet-5-5` only to Claude. A Gemini Model
    is a 503.
  - A rate-limited xAI account falls back to the second xAI account. It is
    held back for the 45 s its exhausted requests limit gives.

  **Subscription** (`src/accounts/grok-subscriptions.test.ts`, in memory
  and in Postgres 18). The fake OAuth server is shaped like xAI's: a device
  endpoint, form-only token requests, and rotating refresh tokens.
  - **Device sign-in.** The code and URL are given. Finishing before
    approval is `oauth_login_pending`, and after approval the account is
    added, its tokens sealed for its row and never returned. The token
    request used the device grant and xAI's client, and a login is used
    once. A denied login is refused.
  - **Serving.** It serves only opencode, for Grok Models, as a bearer
    token to `https://api.x.ai/v1`. It does not serve Claude Code, Codex,
    no tool, or a Claude Model, nor anyone once its token has expired.
  - **Refresh.** It is refreshed ahead of expiry at xAI's token endpoint
    (refresh grant, form-encoded).
  - **Import.** A nested Grok CLI login file is imported, its tokens sealed
    and its expiry taken. It is then refreshed with its own refresh token,
    which is used up.
  - **Refused imports.** Login files without tokens are refused, and so is
    a name in use.
  - **Login files.** Either spelling, any depth, epoch milliseconds or
    seconds, the JWT `exp`, and "expiring now" when nothing says.
  - **Through the Gateway.** opencode's Chat Completion reaches the
    subscription unchanged with its token. Claude Code's Messages for
    `grok-4` are a 503.

  **Server** (`apps/server/src/ai-accounts/grok.test.ts`):
  - an xAI key added;
  - the device sign-in, `409 oauth_login_pending`, then `201`;
  - an import, then a login without tokens (`400 login_not_importable`)
    and malformed bodies refused.

  No answer or log line holds a key or token.

  **Web** (`apps/web/src/ai-accounts-card.test.tsx`):
  - adding an xAI key;
  - the device sign-in, which posts `{}` to finish;
  - importing a login, cleared from the page.

  **Mutation checks** (each reverted):

  | Mutation | Tests failed |
  | --- | --- |
  | The Model does not decide the AI Provider | 2 |
  | opencode not recognised | 1 |

### Verified on the host

- [ ] **A real xAI key serves a request through the Gateway.** Not done
      here: there is no xAI account in the sandbox, and no network to
      `api.x.ai`.

### Not verifiable in this sandbox

- **Recorded provider responses.** The xAI fixtures were written by hand
  from xAI's OpenAI-compatible API, as #45 is open: the formats, the
  `x-ratelimit-*` headers, and a 429 whose `error` is a string.
- **xAI's OAuth.** The client id, endpoints and scopes are those
  third-party clients report for the Grok CLI. xAI does not document them.
  Several things need a real Grok subscription on the host:
  - whether the device flow, refresh and `api.x.ai` accept the token for
    this client;
  - whether xAI gates it by subscription tier (some report a 403 for
    non-Heavy plans);
  - whether such tokens must go to a CLI-only host rather than
    `api.x.ai`.
- **The Grok CLI's `~/.grok/auth.json` layout** is not documented. The
  import searches for the tokens rather than assuming field paths. A real
  file should be checked on the host.
- **opencode's user agent** (`opencode/…`) is assumed, since opencode
  sandboxes do not exist yet. A real opencode run through the Gateway is
  for the host, with its sandbox image.
- The Playwright suite (`pnpm e2e`) was not run.

## Notes, and disagreements with the canon

- **A Grok subscription serves only opencode.** FR-35 says subscription
  OAuth accounts are used only through the AI Provider's own agent tool.
  xAI's own tool is the Grok CLI, which does not run in AI Office's
  sandboxes. FR-16 makes opencode Grok's agent tool in AI Office, so the
  subscription serves opencode's requests, unchanged, and nothing else.
  The Owner is warned before adding one. If the Owner reads xAI's terms
  otherwise, this is one field (`servesOnly`) to change.
- **Device login rather than pasting a code.** The Grok CLI's browser
  login redirects to a local callback, which a server cannot receive. The
  device flow, which the CLI also offers (`--device-auth`), needs nothing
  pasted.
- **Routing by Model** was needed as soon as a second AI Provider's
  accounts existed. Otherwise a Claude request could be balanced onto
  xAI. It uses name prefixes until the live model catalogue (FR-41)
  arrives.
- **Importing takes over the CLI's login.** xAI rotates refresh tokens, so
  after AI Office's first refresh the CLI must sign in again. The field's
  hint says so.

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
 Test Files  104 passed (104)
      Tests  1072 passed | 190 skipped (1262)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  104 passed (104)
      Tests  1247 passed | 15 skipped (1262)
   Duration  45.53s (tests 87%, import 10%, environment 1%, transform 1%)
```

Sources for xAI's OAuth details: the Grok CLI's
[authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md),
[holon-run/holon#2153](https://github.com/holon-run/holon/issues/2153) and
[tonylee2022/dsh-xai-oauth](https://github.com/tonylee2022/dsh-xai-oauth).
