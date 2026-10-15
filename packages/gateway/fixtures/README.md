# AI Gateway contract fixtures

Each file is one request/response pair in the format the Gateway's recorder
mode writes (`Fixture` in `src/fixtures.ts`). `src/contract.test.ts` replays
every file in `anthropic/` through the Gateway against a fake AI Provider that
answers with the recorded response, and checks the response arrives
unchanged and its usage is recorded.

To record more, start the server with `GATEWAY_FIXTURES_DIR` set and send
requests through the Gateway; each pair is written to that directory with
every credential redacted. Copy the ones worth keeping here, give them a
descriptive name and add their expected usage to the contract test.
`pnpm --filter @ai-office/gateway record` sends the scripted ones for you
(see [Recording](#recording)).

The files here were written by hand in that format from the Anthropic
Messages API's documented responses, because there was no AI Account to
record against when they were added. Re-recording them against the real
API, on the host, is welcome.

## Recording

`pnpm --filter @ai-office/gateway record`
(`src/record/main.ts`) sends a scripted set of requests through a running
AI Office, for each AI Provider and Model it is given, so the server's
recorder mode writes one fixture per exchange. It is for the Owner's own
machine, with their real AI Accounts (#45); nothing in CI runs it against
a real AI Provider.

1. Start AI Office with `GATEWAY_FIXTURES_DIR` set to an empty directory,
   as an absolute path (`pnpm dev` runs the server from `apps/server`, so
   a relative path would be taken from there). With docker compose, mount
   a host directory there and give the script the host's path.
2. In AI Settings → **Gateway Keys**, make a key for an Owner tool, such
   as "fixture recorder". It must be an Owner tool's: only those may force
   an AI Account.
3. Run, from the repository:

   ```bash
   export AI_OFFICE_GATEWAY_KEY=aio_gk_…        # the key from step 2
   export GATEWAY_FIXTURES_DIR=/absolute/path    # the same as the server's
   pnpm --filter @ai-office/gateway record \
     --target Claude:claude-haiku-5-5 --account "Claude:<API key account>" \
     --target Grok:grok-4 \
     --target Gemini:gemini-2.5-flash
   ```

   Repeat `--target <AI Provider>:<Model>` for each AI Provider. Each
   target's requests go where any Owner tool's would: by their Model to
   that AI Provider's AI Accounts, with the session strategy keeping them
   on one. `--account <AI Provider>:<AI Account name or id>` forces one
   AI Account for that AI Provider (`x-ai-office-account`, as in [Load
   balancing](../../../docs/guide/ai-gateway.md#load-balancing)).
   `--scenario <id>` runs only some scenarios. The Gateway is at AI
   Office's own address, `http://localhost:3045`, unless
   `AI_OFFICE_GATEWAY_URL` (or `--url`) says otherwise. The key may be given as `--key`, but a flag shows in
   the process list, so the variable is better; the script never prints
   it, and passes everything it shows through a redactor that knows it.
4. Check every file the summary names by eye (below), then copy the ones
   worth keeping here, as described above.

Each target gets these scenarios, in the API its AI Provider speaks, so
they reach it untranslated: Anthropic Messages (`/v1/messages`) for
Claude and Anthropic-compatible endpoints, Chat Completions
(`/v1/chat/completions`) for the others. Each prompt carries a marker
(`AI Office fixture recording <run>-<target>-<scenario>`), by which the
script finds its fixture among any others the server writes meanwhile.

| Scenario | `--scenario` | What is sent |
| --- | --- | --- |
| Plain message | `plain` | A one-line prompt, not streamed, at most 64 tokens |
| Streaming | `streaming` | The same, streamed (with `stream_options.include_usage` for Chat Completions) |
| Tool call | `tool-call` | A `get_weather` tool, forced for Claude and `auto` for the others (not every OpenAI-compatible API takes a named one); the summary says when the answer holds no tool call |
| Image | `image` | A 16 × 16 PNG, as a base64 image block or a `data:` URL |
| Rate limit | `rate-limit` | Nothing: skipped, as no AI Provider gives a `429` without spending a limit's worth of tokens or flooding its API. A `429` met in normal use is recorded when its AI Account was forced; otherwise the Gateway answers from another account, and the `429` is not what the caller gets |
| Token refresh | `token-refresh` | Nothing: skipped, as the Gateway refreshes a subscription's token itself, at the AI Provider's sign-in server rather than through its endpoints, so recorder mode writes no fixture of it. It happens once a token is due within 15 minutes (AI Settings shows it as **expiring**) |

The summary gives each scenario's status (`recorded`, `failed` or
`skipped`), the Gateway's status and the fixture file it produced, and
says why each skipped one was. A scenario fails when no fixture appears
within five seconds of its answer: the Gateway refused the request
itself (a wrong key, a forced AI Account that does not exist, no AI
Account for that Model), which is never recorded, or the server was not
started with that `GATEWAY_FIXTURES_DIR`. The script exits `1` when any
scenario failed, and `2` when it was asked something it cannot do.

**Subscriptions.** A subscription serves only its own agent tool's
requests (PRD FR-35): a Claude subscription only Claude Code's, a ChatGPT
subscription only Codex's, a Grok subscription and a Qwen sign-in only
opencode's. The script is not an agent tool and does not pretend to be
one, so its requests are served by the AI Provider's other AI Accounts
(an API key, an endpoint), and it skips ChatGPT and Qwen, which have
nothing else, saying so. To record a subscription, run its agent tool
through the Gateway with the same key while the server records; each run
makes several requests, so it writes several fixtures. For instance:

```bash
# Claude Code, on a Claude subscription
ANTHROPIC_BASE_URL=http://localhost:3045 \
ANTHROPIC_AUTH_TOKEN="$AI_OFFICE_GATEWAY_KEY" \
ANTHROPIC_CUSTOM_HEADERS="x-ai-office-account: <subscription's name>" \
  claude -p "Reply with the single word: recorded." --model claude-haiku-5-5

# Codex, on a ChatGPT subscription
codex exec --skip-git-repo-check -m gpt-5.5 \
  -c 'model_provider="ai_office"' \
  -c 'model_providers.ai_office.name="AI Office"' \
  -c 'model_providers.ai_office.base_url="http://localhost:3045/v1"' \
  -c 'model_providers.ai_office.env_key="AI_OFFICE_GATEWAY_KEY"' \
  -c 'model_providers.ai_office.wire_api="responses"' \
  "Reply with the single word: recorded."
```

These are how sandboxes configure the tools (`gatewayModelEnvironment`
and `codexOverrides` in `packages/orchestrator/src/sandbox/`); opencode's
whole configuration is `opencodeModelEnvironment`'s, given as
`OPENCODE_CONFIG_CONTENT`. Ask for a tool call ("Run `echo recorded`",
with `--allowedTools "Bash(echo:*)"` for Claude Code) or an image (`-i
image.png` for Codex) the same way.

**Checking by eye.** The recorder redacts every AI Account credential the
server has opened, and anything shaped like a credential, and never
records the caller's or the AI Account's authorization headers. The
script also looks for credential shapes and the Gateway Key in each
fixture it found, and says "do not commit it" if one is left. But only
the Owner knows what their credentials look like (an account id in a
header, a cookie, an organisation name), so open every file before
committing it.

### #45, step by step

The steps of #45 ("Record provider responses for the contract tests"),
with the command it names: its `pnpm --filter gateway record` is this
one, as pnpm matches a package's name without its scope.

1. Add the real AI Accounts (Claude's API key and subscription, ChatGPT,
   Grok and Gemini) in AI Settings, and start AI Office with
   `GATEWAY_FIXTURES_DIR` set as above. Then run `pnpm --filter
   @ai-office/gateway record` with a `--target` for each of Claude, Grok
   and Gemini (forcing Claude's API key account with `--account`), and
   run Claude Code and Codex through the Gateway for the Claude and
   ChatGPT subscriptions, as above. A rate limit and a token refresh are
   recorded only as the table above says.
2. Check every file the summary names by eye for credentials.
3. Copy the ones worth keeping into the folders here, named as their
   neighbours are, with each one's expectation in its contract test,
   then commit them on a branch and open a pull request.

## Translation fixtures

`translation/` holds one exchange each for the OpenAI endpoints and format
translation (PRD FR-34): the caller's request, what the AI Provider must
receive, what it answers (the exact text that crossed the wire), what the
caller must get back (a JSON body, a list of events, or the AI Provider's
own bytes when the request passed through), and how the request is
recorded. `src/translation.test.ts` replays each one through the Gateway,
with the AI Provider's answer in 1-byte, 7-byte and whole chunks.

They cover each direction, with tool calls and streaming: Chat
Completions, Responses and compaction to Anthropic Messages; Messages to
Chat Completions; and Chat Completions and Responses passed through to an
OpenAI-format account.

The AI Providers' sides were written by hand from the APIs' documented
formats, as there was no AI Account to record against (#45). The
expectations were produced by running them through the Gateway, then
checked by hand against those formats. Re-recording the AI Providers'
sides against real accounts, on the host, is welcome.

## Rate-limit fixtures

`limits/` holds an Anthropic `429 rate_limit_error` (with its rate-limit
headers), a `529 overloaded_error` and a served answer.
`src/limits/limits.test.ts` replays them through the Gateway against real AI
Accounts (PRD FR-38, FR-39): the request falls back to the second account,
the first is held back until its reset, and when every account is exhausted
the caller gets a 429, a 529 or a 503. They were written by hand from the
documented formats (#45 will record real ones).

## xAI fixtures

`xai/` holds xAI's Chat Completions (whole and streamed, with usage and
cached tokens), a Responses answer, and a `429` with xAI's
`x-ratelimit-*` headers. `src/providers/xai.test.ts` replays each through
the Gateway against a real xAI API-key account. They were written by hand
from xAI's OpenAI-compatible API (#45 will record real ones).

## Gemini fixtures

`gemini/` holds Google's OpenAI-compatible Chat Completions (whole and
streamed), a `429 RESOURCE_EXHAUSTED` with its `RetryInfo`, and a `503
UNAVAILABLE`, each as a list of errors as that API sends them. Their paths
are as sent to Google (`/v1beta/openai/…`). `src/providers/gemini.test.ts`
replays each through the Gateway against a real Gemini API-key account.
They were written by hand from Google's documented formats (#45 will record
real ones).

## OpenRouter, DeepSeek, Z.ai, Minimax and Kimi fixtures

`openrouter/`, `deepseek/`, `zai/`, `minimax/` and `kimi/` each hold that
API key's Chat Completions (whole, with cached prompt tokens, and
streamed, with usage on a last chunk of its own), a Responses answer
where its API has one (not Z.ai's), and its documented failures, with
their paths as sent to it (`/api/v1/…`, `/chat/completions`,
`/api/paas/v4/…`, `/v1/…`):
- OpenRouter: a `vendor/model` answer counting `cache_write_tokens`, a
  `429` with `retry-after` and a `402` (no credit left), and Jev's answer
  to the Decision Model's typed questions (`/api/v1/systemone`: a `noul`
  and a `choice`, with `input_tokens` and `output_tokens`), written from
  OpenRouter's Jev tutorial and TypeSafe's quickstart;
- DeepSeek: a reasoning answer with its `prompt_cache_hit_tokens`, a
  `429`, a `503` "Server overloaded" and a `402` "Insufficient Balance";
- Z.ai: a `429` with business code `1302` (rate limit) and one with `1305`
  (overloaded);
- Minimax: a `429` written as MiniMax writes errors
  (`{"type":"error","error":{"type":"rate_limit_error"}}`);
- Kimi: an answer counting `cache_write_tokens`, a `429
  rate_limit_reached_error` and a `429 engine_overloaded_error`, each with
  `retry-after`.

`src/providers/<type>.test.ts` replays each through the Gateway against a
real API-key account of that type, as `src/providers/api-key-contract.ts`
describes, with each answer's cost at the type's prices. They were written
by hand from each AI Provider's documented formats, as of 2026-10-10 (#45
will record real ones). Where a provider does not document an error's body
(DeepSeek's `429`, `503` and `402`; MiniMax's chat errors' HTTP status),
the body is OpenAI's or Anthropic's shape, and should be checked on the
host.

## Qwen, Ollama, Ollama Cloud and compatible endpoint fixtures

- `qwen/` holds Qwen's sign-in serving opencode's Chat Completions at
  `/v1/…` on the API host its login names: whole (with cached prompt
  tokens), streamed (`coder-model`, usage on a last chunk) and a `429
  insufficient_quota` (its free quota spent). `src/providers/qwen.test.ts`
  signs a real account in against a fake OAuth server shaped like Qwen's
  (a device login proved with PKCE) and replays them.
- `ollama/` holds the Owner's own Ollama server's OpenAI-compatible Chat
  Completions (`model:tag` Models, no key), a `404` for a Model it has not
  pulled and a `500` from a runner that died.
- `ollama-cloud/` holds ollama.com's: whole and streamed answers, a `429`
  (its usage limit, without `retry-after`) and a `502`.
- `openai-compatible/` holds an endpoint at the Owner's own path
  (`/openai/v1/…`, as Groq's is): Chat Completions (whole, with cached
  tokens, and streamed), Responses, a `429` with `retry-after` and a `502`.
- `anthropic-compatible/` holds an endpoint at the Owner's own path
  (`/anthropic/v1/messages`): a Message (with cache reads and writes), a
  streamed one, a `429` with `retry-after` and a `529`.

`src/providers/ollama.test.ts`, `ollama-cloud.test.ts` and
`openai-compatible.test.ts` replay theirs as
`src/providers/api-key-contract.ts` describes;
`src/providers/anthropic-compatible.test.ts` replays its own. They were
written by hand from Qwen Code's, Ollama's and the APIs' documented
formats, as of 2026-10-10 (#45 will record real ones). Qwen's and Ollama
Cloud's error bodies are not documented, and should be checked on the
host.

## AWS Bedrock fixtures

`bedrock/` holds Claude in Amazon Bedrock's Messages API
(`/anthropic/v1/messages`): a Message, a streamed one (with cached input
tokens), a `429` with AWS's `ThrottlingException`, a `529
overloaded_error` and a `403` with AWS's `AccessDeniedException`. Their
bodies name Models as Bedrock does (`anthropic.claude-opus-5-5`); the SigV4
signature is never recorded. `src/providers/bedrock.test.ts` replays each
through the Gateway against a real AWS Bedrock account, checking each
request's signature. They were written by hand from Anthropic's documented
Messages format and AWS's documented error shapes (#45 will record real
ones): how Claude in Amazon Bedrock words its own errors should be checked
on the host.

## Google Vertex AI fixtures

`vertex/` holds Vertex AI's `rawPredict` (a Message), `streamRawPredict`
(a stream), `count-tokens:rawPredict`, a `429 RESOURCE_EXHAUSTED` quota
error as Google writes it, and a `529 overloaded_error`. Their paths name
the project, the location and the Model, and their bodies carry
`anthropic_version: vertex-2023-10-16` in place of the Model.
`src/providers/vertex.test.ts` replays each through the Gateway against a
real Vertex AI account whose service account signs in at a fake Google
token endpoint. They were written by hand from the documented formats (#45
will record real ones).

## ChatGPT fixtures

`chatgpt/` holds ChatGPT's Codex backend answering Codex's Responses
requests: a streamed answer with reasoning (and cached prompt tokens), a
streamed `shell` tool call, a compaction, and a `429
usage_limit_reached` with `resets_in_seconds`. Their paths are as sent to
ChatGPT (`/backend-api/codex/…`), and their requests carry Codex's own
headers (`codex_exec/…`, `originator`, `session_id`).
`src/providers/chatgpt.test.ts` replays each through the Gateway against a
real ChatGPT subscription signed in through a fake OAuth server. They were
written by hand from the Responses API's documented formats and what Codex
is reported to send and receive (#45 will record real ones).

## Model list fixtures

`models/` holds each AI Provider's model list, as its models endpoint
answers it:
- Anthropic's `/v1/models`, in two pages (`has_more`, `after_id`);
- xAI's `/v1/models`;
- Google's `/v1beta/openai/models`, with `models/` ids;
- ChatGPT's Codex backend's `/models`, with context windows;
- OpenRouter's `/api/v1/models?limit=1000`, with names, context lengths and
  prices (also read as its published prices);
- DeepSeek's `/models`, with names and `context_window`;
- Minimax's `/v1/models`, ids only;
- Kimi's `/v1/models`, with `context_length`.
- Ollama's own server's and Ollama Cloud's `/v1/models`, `model:tag` ids;
- two OpenAI-compatible endpoints' (`/openai/v1/models` with
  `context_window`, and vLLM's `/v1/models` with `max_model_len`), whose
  Models the catalogue lists together;
- an Anthropic-compatible endpoint's `/anthropic/v1/models`, in
  Anthropic's shape.

`src/models/catalogue.test.ts` serves them from fake AI Providers to real
AI Accounts, and checks the catalogue each refresh builds. The server's
tests read them through `modelListFixture` from `@ai-office/gateway/testing`.
They were written by hand from the documented formats (#45 will record real
ones).

## Model-family limits

`limits/anthropic-opus-weekly-limit.json` is a Claude subscription's `429`
for its weekly Opus limit (`anthropic-ratelimit-unified-representative-claim:
seven_day_opus`), and `limits/gemini-model-quota.json` Google's `429
RESOURCE_EXHAUSTED` whose `QuotaFailure` names the model in its quota's
dimensions. `src/limits/capacity.test.ts` replays them through the Gateway
(PRD FR-38): the account is left out for that model family only. Both were
written by hand: the Anthropic header is not documented, and #45 will
record real ones.

## Extra usage

`limits/anthropic-extra-usage.json` is a Claude subscription's answer
served past its plan's five-hour limit, on extra usage
(`anthropic-ratelimit-unified-status: rejected` with
`anthropic-ratelimit-unified-overage-status: allowed`, the window at 100%).
`src/limits/extra-usage.test.ts` replays it through the Gateway (PRD
FR-41): with the account's extra usage off, it serves nothing more until
the limit resets. It was written by hand from what Claude Code reads: the
headers are not documented, and #45 will record real ones.
