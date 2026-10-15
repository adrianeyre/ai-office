# Issue #41: OpenAI Responses and Chat Completions endpoints with translation — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last code commit of
the issue (`46e8a0d`), after `pnpm install --frozen-lockfile`.

## What was built

### Endpoints (`packages/gateway/src/gateway.ts`)

- `POST /v1/chat/completions`, `POST /v1/responses` and
  `POST /v1/responses/compact`, beside `/v1/messages` and
  `/v1/messages/count_tokens`, streamed or not, all behind Gateway Keys
  (#35). Errors are answered in the caller's format (OpenAI's `{"error":
  {message, type, param, code}}` or Anthropic's).
- **Checked first:** an OpenAI-format body is checked against a strict
  schema (`translate/openai.ts`) before an account is chosen. An unknown
  top-level field is `400 invalid_request_error` with OpenAI's wording
  (`Unrecognized request argument supplied: …`) and the field as `param`;
  a field of the wrong shape names its path. Nothing is forwarded, and the
  400 is recorded.
- **Plans:** each request is either passed through (the account speaks the
  caller's format: the very bytes are forwarded, with the account's key as
  `x-api-key` or a bearer token, and usage read from the answer, streamed
  or not) or translated both ways. `GatewayAccount.apiFormat` says what an
  account speaks (`anthropic` by default; every account kind so far speaks
  Messages, so OpenAI-format accounts arrive with #42 to #44).
- **Streaming throughout:** translated streams are translated event by
  event as they arrive (`SseReader`), never buffered; a stream that fails
  or ends early ends with an error in the caller's format.
- Records carry the endpoint (`chat_completions`, `responses`,
  `responses_compact`) and usage counted as Anthropic counts it (cached
  prompt tokens apart). Fixture recording names files after the AI
  Provider's endpoint.

### Translators (`packages/gateway/src/translate/`)

- **Chat Completions → Messages** (`chat.ts`): system and developer
  messages to `system`; text, images (URL or data URL) and PDFs; assistant
  text and `tool_calls` to `tool_use`; tool messages to `tool_result`s,
  merged into one user turn; tools, `tool_choice` (`none`, `auto`,
  `required`, a named function) and `parallel_tool_calls`; `max_tokens` /
  `max_completion_tokens` (32 000 when absent, as Messages requires one);
  `temperature`, `top_p`, `stop`; `reasoning_effort` to adaptive thinking
  at that effort (`output_config.effort`); `user`. Back: text, tool calls,
  `reasoning_content`, `finish_reason`, usage, and the stream as
  `chat.completion.chunk`s with an optional usage chunk and `[DONE]`.
- **Responses → Messages** (`responses.ts`): `instructions`; string or item
  input; messages, `function_call`, `function_call_output` (text or images),
  custom tool calls and their outputs, and reasoning items. Claude's
  thinking comes back as reasoning items whose `encrypted_content` carries
  the thinking block with its signature, so Codex (`store: false`) gives it
  back unchanged; reasoning the Gateway did not make is left out. Custom
  (free-form) tools such as Codex's `apply_patch` become tools taking one
  string, with any grammar in the description, and come back as custom
  tool calls. Back: the Response (status, incomplete reasons, usage, the
  request's settings echoed) and the full event stream (`response.created`
  … `response.completed`, `response.incomplete` or `response.failed`, with
  sequence numbers).
- **Compaction** asks the model for a summary after the conversation, and
  answers `response.compaction` with the user's own messages and the
  summary (OpenAI's own answer carries an opaque compaction item instead).
- **Messages → Chat Completions** (`messages.ts`), for a Messages client on
  an OpenAI-format account: system, images, tool use and results (errors
  marked), tool choice, effort to `reasoning_effort`, streaming with
  `include_usage`; back as a Messages response or event stream.
- **Refused with a 400, not dropped:** `previous_response_id`, stored
  conversations and prompts, background responses, `n` > 1, log
  probabilities, audio, non-text output formats, hosted tools (web search
  and the like), item references, and token counting from an
  OpenAI-format account.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** Lint and
      typecheck exit 0 from a fresh clone. `pnpm test` without Docker: 828
      passed, 136 skipped, in three consecutive runs in the clone; against
      Postgres 18: 949 passed, 15 skipped (output below). In two earlier runs
      in the clone, one web component test each timed out (`findBy…` in
      `activity-feed.test.tsx`, then `notice-board.test.tsx`): the first
      while I was running other Vitest processes at the same time, the
      second the first run after install. Both files pass on their own, and
      the full suite passed three times in a row afterwards. Neither test
      touches anything this issue changed; I note it as a load-sensitive
      timeout rather than hide it.
- [x] **Contract tests over recorded fixtures for each direction, including
      tool calls and streaming.** `src/translation.test.ts` replays each of
      the ten fixtures in `fixtures/translation/` with the AI Provider's
      answer in 1-byte, 7-byte and whole chunks (30 cases), checking the
      request the AI Provider receives (translated, or the very bytes for a
      passthrough; the account's key; never the Gateway Key), the answer
      the caller gets (JSON body, event list, or bytes), and the record. A
      coverage test asserts every direction is there:

  | Fixture | Direction |
  |---|---|
  | `chat-to-messages-tools` | Chat → Messages, whole: image, tool call and result, reasoning |
  | `chat-to-messages-streaming` | Chat → Messages, streamed, text then a tool call, usage chunk |
  | `chat-to-messages-rate-limited` | Chat → Messages, a 429 back in OpenAI's format with `retry-after` |
  | `responses-to-messages-tools` | Responses → Messages, whole: thinking carried back, custom tool |
  | `responses-to-messages-streaming` | Responses → Messages, streamed: thinking, text, function call |
  | `responses-compact-to-messages` | compaction → Messages |
  | `messages-to-chat-tools` | Messages → Chat, whole: image, tool call and result |
  | `messages-to-chat-streaming` | Messages → Chat, streamed: text then a tool call |
  | `chat-passthrough-streaming` | Chat passed through to an OpenAI-format account, streamed |
  | `responses-passthrough` | Responses passed through to an OpenAI-format account |

  `src/openai-endpoints.test.ts` (18 tests) covers unknown top-level fields
  (400 on every endpoint, whatever the account, never forwarded), bad JSON
  and shapes, each untranslatable feature, a passthrough of what
  translation refuses, errors in the caller's format, streams that fail or
  end early, and translated events passed on as they arrive.
  `src/translate/translate.test.ts` (12 tests) covers the translators'
  finer points and the SSE reader (split at every byte, `\n` and `\r\n`).
  The Gateway's latency benchmark (PRD §7, under 10 ms median) still
  passes.

  **Negative checks** (each reverted afterwards):
  - `tool_use` mapped to `finish_reason: "stop"`: 6 tests failed.
  - The Chat Completions schema made loose (unknown fields allowed): 2
    tests failed.
  - Claude's thinking not decoded from `encrypted_content`: 5 tests failed.

The Playwright suite still passes (17 tests) against the embedded Postgres
18 with Chromium.

### How Postgres and Chromium were run here

As for #35: `@embedded-postgres/linux-x64@18.3.0-beta.16` in `/tmp/pg18`
(port 54329), with a scratch, reverted edit pointing the clone's
`postgresTest` at it, and `E2E_POSTGRES_URL` for `pnpm e2e`; Chromium with
Debian bookworm's libraries in `/tmp/chromelibs`.

### Not verifiable in this sandbox

- **Recorded provider responses.** The AI Provider side of every fixture was
  written by hand from the documented formats, because #45 (recording real
  provider responses) is open and there is no AI Account here. The
  expectations were produced by running them through the Gateway, then
  checked by hand against the formats. Re-recording against real accounts
  is for the host.
- Real Codex and Claude Code sessions through the Gateway, and a real
  OpenAI-format account (none can be added until #42 to #44).
- Model-specific refusals by real accounts of what is translated (for
  example, forced `tool_choice` `any`/`tool` is refused by some current
  Claude Models; the Gateway translates `required` to `any` and lets the AI
  Provider answer).

## Output

`pnpm lint` (fresh clone):

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

`pnpm test`, without Docker (three runs in a row):

```text
      Tests  828 passed | 136 skipped (964)
   Duration  26.62s (tests 39%, import 36%, transform 16%, environment 9%)
      Tests  828 passed | 136 skipped (964)
   Duration  17.40s (import 44%, tests 31%, transform 20%, environment 5%)
      Tests  828 passed | 136 skipped (964)
   Duration  19.83s (tests 49%, import 33%, environment 11%, transform 7%)
```

`pnpm test`, with `postgresTest` on the embedded Postgres 18:

```text
 Test Files  83 passed (83)
      Tests  949 passed | 15 skipped (964)
   Duration  43.22s (tests 79%, import 14%, environment 3%, transform 3%)
```

`pnpm e2e` (tail):

```text
  17 passed (19.6s)
```
