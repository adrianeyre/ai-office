# Issue #44: Gemini AI Account (OpenAI-compatible) — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch, after the issue's last code commit (`200dbd3`).

## What was built

- **The kind** (`packages/shared/src/ai-accounts.ts`): **Gemini API key
  (Google AI Studio)**, for the Gemini AI Provider:
  - OpenAI formats at `https://generativelanguage.googleapis.com`;
  - `apiPath` `/v1beta/openai` in place of `/v1`;
  - the key as a bearer token;
  - it serves anyone.

  `POST /api/ai-accounts` takes `"aiProvider":"Gemini"`. A Gemini
  subscription cannot be added: there is no such sign-in.
- **The endpoints a kind serves.** A kind can name the Gateway endpoints it
  serves (`serves`, checked by `kindServes`), and the Gateway tells
  `select` each request's endpoint. Gemini's serves Chat Completions, and
  Claude Code's Messages translated to Chat Completions (#41's
  translator). Google's OpenAI-compatible API has no Responses endpoint,
  and nothing translates Responses to Chat Completions, so a Responses
  request is never sent to a Gemini account; with no other account for its
  Model it is a 503. Other kinds name nothing, and serve everything, as
  before.
- **Paths.** The upstream path is the account's base URL, its `apiPath`,
  then the endpoint (`/v1beta/openai/chat/completions`). Recorder mode
  (`GATEWAY_FIXTURES_DIR`) now saves the path as sent to the AI Provider,
  not the Gateway's own `/v1` path.
- **Routing by Model** (#43) sends `gemini-*` and `gemma-*` Models to Gemini
  accounts only.
- **Rate limits** (#39) read Google's error lists:
  - `429 RESOURCE_EXHAUSTED` holds the account back for its `RetryInfo`
    `retryDelay`;
  - `503 UNAVAILABLE` ("The model is overloaded") holds it back as
    overloaded.
- **Admin's AI Accounts card** lists the kind, with Google's endpoint as the
  placeholder.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 (output below). Without Docker: 1083 passed, 190 skipped (the
      Postgres tests, with the reason). Against Postgres 18: 1258 passed, 15
      skipped.
- [x] **Recorded-fixture contract tests.**
      `packages/gateway/src/providers/gemini.test.ts` replays each fixture
      in `fixtures/gemini/` through a real Gateway, serving from a real
      Gemini API-key account, in 7-byte chunks. The fixtures:
      - a Chat Completion;
      - a streamed Chat Completion, with usage on its last chunk, as Google
        sends it;
      - a `429 RESOURCE_EXHAUSTED` with `QuotaFailure` and `RetryInfo`;
      - a `503 UNAVAILABLE`.

      The error bodies are lists, as that API sends them.

  For each fixture:
  - the account receives the request at `/v1beta/openai/chat/completions`,
    the very body, the key as a bearer token, and never `x-api-key` or the
    Gateway Key;
  - the caller gets the answer byte for byte;
  - the record has the expected status, Model and tokens;
  - recorder mode saves the path as sent to Google.

  A coverage test pairs every fixture with its expectation.

  Also through the Gateway:
  - Claude Code's Messages for `gemini-2.5-pro` are translated to Chat
    Completions, and back.
  - A Responses request reaches no Gemini account (503).
  - After Google's 429 the request falls back to a second Gemini account.
    The first is held back for the `retryDelay`'s 23 s; after its 503, for
    30 s.

  Server (`apps/server/src/ai-accounts/providers.test.ts`): a Gemini key
  is added and never returned or logged, and a Gemini subscription is
  refused. Web (`apps/web/src/ai-accounts-card.test.tsx`): adding a Gemini
  key, with Google's endpoint as the placeholder.

  **Mutation checks** (each reverted):

  | Mutation | Tests failed |
  | --- | --- |
  | Gemini's `apiPath` set to `/v1` | 5 |
  | Gemini's `serves` removed (Responses sent to it) | 1 |

### Verified on the host

- [ ] **A real Gemini key serves a request through the Gateway.** Not done
      here: there is no Gemini key in the sandbox, and no network to
      Google.

### Not verifiable in this sandbox

- **Recorded provider responses.** The Gemini fixtures were written by hand
  from Google's documented OpenAI-compatible formats and error model, as
  #45 is open. Some details should be checked against real answers on the
  host:
  - whether the compatibility layer lists errors (`[{"error":…}]`) or not
    (both are read);
  - whether it sends `RetryInfo`;
  - where its usage chunk falls when streaming.
- The Playwright suite (`pnpm e2e`) was not run.

## Notes, and disagreements with the canon

- **No Responses API.** FR-34 asks that any agent tool can reach any AI
  Account by translation. Codex speaks Responses, and the Gateway has no
  Responses-to-Chat-Completions translator (#41 built Chat Completions and
  Responses to Messages, and Messages to Chat Completions). So a Responses
  request cannot reach a Gemini account, and is routed elsewhere or
  refused. Gemini's agent tool, opencode (FR-16), speaks Chat Completions.
- **The custom endpoint** replaces the host only. `/v1beta/openai` still
  follows, as `/v1` does for the other kinds. A proxy in front of Google
  must serve that path.
- **Vertex AI** is out of scope (#105).

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
 Test Files  105 passed (105)
      Tests  1083 passed | 190 skipped (1273)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  105 passed (105)
      Tests  1258 passed | 15 skipped (1273)
   Duration  47.95s (tests 86%, import 10%, environment 2%, transform 1%)
```
