# The AI Gateway

The built-in AI Gateway: its endpoints, prices, analytics, request history, Gateway Keys, AI Accounts and AI Providers. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## The AI Gateway

The server also starts the AI Gateway (`packages/gateway`). **One entry
point:** AI Office's own address serves it, at `/v1` and below, next to
the web app and its `/api`: `http://localhost:3045` both in `pnpm dev`
(Vite proxies `/v1` to the server) and under compose. The app hands each
`/v1` request straight to the Gateway, unchanged and streamed as it
arrives; none of the web app's sign-in, session or CSRF checks apply to
it, and a signed-in session never authorises a Gateway call: only a
[Gateway Key](#gateway-keys) does. Two things the app does for every
request it does for these too: it takes the proxy's `X-AI-Office-Proxy`
proof off (and a forwarded client address that does not carry it), so
`PROXY_SECRET` never reaches the request history or an AI Provider, and
the answer carries the [security headers](running.md#signing-in). The
Gateway also listens on its own port, `GATEWAY_PORT` (3047, on loopback
by default), which is only the sandboxes' way in, through the sandbox
relay (`SANDBOX_GATEWAY_URL`: `http://sandbox-relay:3047`, under compose
and in `pnpm dev` alike; see
[Sandboxes](issue-pipeline.md#sandboxes)); compose never publishes it. Whatever AI Office's address is opened to, the Gateway is opened to
as well, still behind Gateway Keys; to open it beyond your machine, use
the `tls` profile (see
[Running with docker compose](running.md#running-ai-office-with-docker-compose)).

It is an Anthropic Messages-compatible API: `POST /v1/messages` (streamed or not) and
`POST /v1/messages/count_tokens` are forwarded unchanged to one of the
Owner's AI Accounts (below), with the caller's own credentials removed.
The answer comes back as the AI Provider sent it, but never with the AI
Account's credential in it: wherever the AI Provider writes the key or
token it was given (an error naming it, a header, a streamed answer),
passed through or translated, it reaches the caller as `[REDACTED]`
(pen-testing G1-6), and so does the body kept in the request history.
The request, and the account's credential with it, goes only to the
account's own endpoint: an AI Provider's redirect is neither followed nor
passed on to the caller, whose client would follow it with its Gateway
Key. It counts as an AI Provider that could not be reached, so another
account is tried, or the caller gets a `502` (pen-testing G1-7).
Every request is recorded in the `gateway_requests` table with its AI
Account, Model, status, latency, token counts and who made it. With no AI
Account to serve from, it answers `503` in the Anthropic error format.

```bash
curl localhost:3045/v1/messages -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' -H "x-api-key: $GATEWAY_KEY" \
  -d '{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"Hi"}]}'
```

### OpenAI endpoints and translation

The Gateway also speaks OpenAI's formats (PRD FR-34), so Codex and other
OpenAI clients can use it, and any client can reach any AI Account:

- `POST /v1/chat/completions` (Chat Completions), `POST /v1/responses`
  (Responses) and `POST /v1/responses/compact` (compaction), streamed or
  not.
- **Checked first.** An OpenAI-format request with an unknown top-level
  field, or a field of the wrong shape, is refused with `400
  invalid_request_error` naming it (`param`), as OpenAI refuses it, and
  goes nowhere.
- **Passthrough.** A request in the format its AI Account speaks is
  forwarded unchanged, both ways, with its usage read on the way. Claude
  accounts speak Anthropic Messages, and Grok's and Gemini's speak OpenAI's
  formats.
- **Translation.** Otherwise the request is translated to the account's
  format and the answer back, streamed event by event: Chat Completions
  and Responses to Anthropic Messages, and Messages (Claude Code) to Chat
  Completions. System prompts and instructions, images (URLs and data
  URLs), PDFs, tools, tool choices, tool calls and their results, stop
  sequences and reasoning effort (as adaptive thinking at that effort) are
  translated; errors come back in the caller's format, with the same
  status and `retry-after`. Claude's thinking comes back to a Responses
  client as reasoning items whose `encrypted_content` carries the thinking
  block, so Codex gives it back unchanged next turn. Codex's custom
  (free-form) tools, such as `apply_patch`, become tools taking one string.
  A compaction asks the model for a summary, and answers with the user's
  messages and the summary.
- **What cannot be translated is refused with a 400**, rather than dropped:
  `previous_response_id` and stored conversations (send the whole
  conversation, with `store: false`), more than one choice, log
  probabilities, audio, structured output formats, hosted tools such as
  web search, and token counting from an OpenAI-format account.
- Records name the endpoint (`chat_completions`, `responses`,
  `responses_compact`), and usage is counted as Anthropic counts it:
  cached prompt tokens apart from the rest.

### Jev's decisions

`POST /v1/systemone` is Jev's own API, for the Decision Model (PRD FR-17;
see [below](#the-decision-model)). Jev writes no text: a request names a
`model`, a `state` (what to judge) and `questions`, each a `noul` (the
probability that a statement is true) or a `choice` (one of a set of
options), and the answer gives each question's.

- **Like any model call** it needs a Gateway Key, is attributed to the
  Agent that asks and its issue and pull request (FR-42), and is refused
  at that Agent's Token Cap (FR-33).
- **Only an AI Account that answers it serves it:** OpenRouter's, at
  `/api/v1/systemone`, which names Jev `typesafe/jev-1.13` (or
  `~typesafe/jev-latest` for the newest). It is passed through unchanged,
  never translated; with no OpenRouter account it is a `503`.
- **Records** name the endpoint `systemone` ("Decisions (Jev)" in Gateway
  requests), with Jev's `input_tokens` and `output_tokens`. OpenRouter's
  Models list leaves Jev out, so its price is in the pricing table: $0.042
  per million input tokens, and output free.

### Model prices and estimated costs

Every request through the Gateway is recorded with an estimated cost in US
dollars (`gateway_requests.estimated_cost_usd`; PRD FR-43), for
information only: Token Caps count tokens, never dollars (FR-31). It is
each token type at its own price per million tokens (input, output, cache
writes and cache reads) for the Model the caller asked for, or null when
that Model has no price or the response counted no tokens.

- **The pricing table** is `packages/gateway/pricing.json`: Claude's
  Models at Anthropic's first-party prices (cache writes at the
  five-minute rate), and DeepSeek's, Z.ai's, Minimax's and Kimi's at their
  own published prices; its `source` says where each came from, and how
  prices with conditions were flattened (DeepSeek's peak-hour price, which
  is twice its off-peak one; MiniMax-M3's for prompts up to 512K tokens).
  Change it by pull request.
- **Published prices.** Where an AI Provider publishes its prices through
  an API, they are fetched when the server starts and once a day, and win
  over the table. OpenRouter publishes them (its public Models list, by
  its `vendor/model` names); they are fetched only while the Owner has an
  unpaused OpenRouter AI Account, so after the first is added they arrive
  with the next daily refresh or restart. A source that cannot be reached
  keeps its last prices.
- **Your prices.** AI Settings' **Model prices** card lists every priced Model
  with where its price comes from, and sets the Owner's own price for a
  Model (`PUT /api/gateway/prices/:model` with `{"input","output",
  "cacheWrite","cacheRead"}`), which wins over both, or for a Model in no
  table. **Use default** removes it (`DELETE`). `GET /api/gateway/prices`
  lists them. Each change is a `config.changed` event naming the Model.
  Prices are kept in `model_prices`.

### Analytics

**Analytics** in the web app (`/analytics`) holds the Gateway's dashboards
(PRD FR-43), for the last 24 hours (by the hour) or the last 7, 30 or 90
days (by the day), in UTC. The range is kept in the address
(`?range=30d&by=agent`) and scopes everything on the page:

- **Totals**: requests, tokens (input plus output, with cache reads and
  writes), estimated cost, mean latency, prompt-cache keep-alives (and
  what they cost) and error rate (answers with a status of 400 or more).
- **Over time**: requests; tokens by type (input, output, cache read,
  cache write); estimated cost; mean latency; error rate; prompt-cache
  keep-alives; mean time to first byte; and the share of input tokens read
  from the prompt cache.
- **Performance** of each **Floor**, **Agent**, **AI Provider**, **AI
  Account** and **Model**: requests, share of the tokens, tokens,
  estimated cost, mean latency, mean time to first byte, error rate and
  cache reads; the Agents' widget also shows the five busiest by
  requests. The time to first byte is the mean of the requests that had
  one: requests deleted by retention keep none.

- **Insights**: the top consumers (Agents and Owner tools, by tokens and
  their share), and the AI Accounts close to their limits (a usage window
  at 80% or more, or held back now).
- **Breakdown** by AI Account, AI Provider (from the Model), Model, Floor,
  Agent, issue or Owner tool: the ten that used the most tokens (the rest
  as "Other"), and a table of all of them.
- **Usage-window history**: each AI Account's five-hour and weekly
  windows over the range (the highest reading each hour or day).

The charts follow the app's design system (`.viz` tokens in
`apps/web/src/styles.css`, light and dark). Every chart has a legend when
it shows two series or more. A tooltip appears on hover and on keyboard
focus (arrow keys move along the buckets), and every chart has a table
view, so no value is shown by colour or tooltip alone.

Each section is a **widget** on a 12-column grid (`widget-grid.tsx`,
`widget-layout.ts`). Drag a widget by its grip (top right) to move it, or
by its corner (bottom right) to resize it; it snaps to whole cells, and
whatever it lands on moves down while the rest rise to close any gap.
While it is dragged it leans slightly to the right; when it drops into
place, the widgets around it shake. From the keyboard, the arrow keys on
a grip move its widget a cell at a time and Shift with the arrow keys
resizes it; each change is announced. The layout is kept in this
browser (`localStorage`, `ai-office:analytics-layout`) until **Reset
layout**. With reduced motion nothing leans or shakes, and on a screen
under 768 px wide the widgets stack in one column and do not move.

- **API** (signed-in sessions; `from` and `to` are ISO 8601, at most 366
  days apart, 31 by the hour):
  - `GET /api/analytics/series?from&to&bucket=hour|day`, with
    `&aiAccountId=<id>` for one AI Account's requests alone (`404` for an
    account there is none of), as AI Settings charts each account;
  - `GET /api/analytics/breakdown?from&to&by=ai_account|ai_provider|model|floor|agent|issue|owner_tool`;
  - `GET /api/analytics/insights?from&to`;
  - `GET /api/analytics/usage-windows?from&to`.

  They roll up from one `GROUP BY` over `gateway_requests` per bucket,
  account, Model and caller. By the day, they add what requests deleted by
  retention or the storage clean-up used, kept a day at a time in
  `gateway_usage_days` (see [Storage](running.md#storage)), so a range
  reaching back past the requests kept still counts them; by the hour,
  only the requests still kept count. Every total, the breakdowns' items too,
  carries `keepAliveRequests` and `keepAliveCostUsd`: the
  [prompt-cache keep-alives](#prompt-cache-keep-alive) among its requests,
  deleted ones included.

### Request history and live streams

**Gateway** in the web app is the request history (PRD FR-44): every
request through the Gateway, newest first, with its endpoint, Model, caller
(its Agent and Floor, or the Owner tool), AI Account, status, tokens,
estimated cost and latency. New requests stream in at the top, and the
Gateway's own log streams live below. Filters (search, status class,
endpoint) are kept in the address; **Load older requests** reads the next
page. Each request opens on its own page (`/gateway/requests/<id>`) with
its timings (latency and time to first byte), tokens, cost, account,
caller, the AI Provider's request id, its headers and the answer's
(credentials such as `x-api-key`, `authorization` and `cookie` shown as
`[REDACTED]`), and its bodies when they were kept.

- **Bodies.** While AI Settings' **Request history** card has **Keep request
  and response bodies** on (the default, PRD §7), each request's body and
  the answer the caller got are kept in `gateway_request_bodies`, each
  sealed with `ENCRYPTION_KEY` for its own request (context
  `gateway_request.body:<id>:request` or `…:response`), up to 1 MiB each.
  They are redacted as they are read back. Turned off, no bodies are kept
  from the next request on (`GET` and `PUT /api/office/request-bodies` with
  `{"store"}`). Bodies are deleted after 7 days, and requests after 90,
  unless the Owner sets other periods (see
  [Retention](running.md#retention)).
- **API.** `GET /api/gateway/requests` lists requests, newest first, with
  `q`, `status` (`2xx`, `4xx`, `5xx` or one status), `endpoint`, `model`,
  `accountId`, `agentId`, `floorId`, `ownerTool`, `from`, `to`, `limit`
  (50, at most 200) and `before` (pass the answer's `nextBefore`).
  `GET /api/gateway/requests/:id` shows one.
- **Live streams** (server-sent events, signed-in sessions only, with the
  event stream's heartbeat): `GET /api/gateway/requests/stream` sends each
  new request as it is recorded, with the list's filters, resuming after
  `Last-Event-ID` (or `?lastEventId=`); `GET /api/gateway/logs/stream` sends
  the Gateway's last 500 log lines, then each new one. Log lines are
  redacted by the logger before they are kept or sent.

### Gateway Keys

Every request to the Gateway presents a Gateway Key (PRD FR-46, ADR 0001),
as `x-api-key` or as a bearer token (`Authorization: Bearer …`, which is
how Claude Code sends `ANTHROPIC_AUTH_TOKEN`). Without one in use it is
refused with `401` (`authentication_error`), before anything else, and not
recorded. The key is checked as the request arrives, before its body is
read, so a caller without one never has the Gateway take in a body of up
to its 32 MiB limit; a path the Gateway does not serve is answered `404`
before its body too (pen-testing I2-2). A key is `aio_gk_` and 43 random
characters; it only calls models, and opens nothing else in AI Office.

Keys presented at `/v1` on AI Office's address are limited per client, as
[sign-ins](running.md#signing-in) are, by the same client address (so
behind a proxy, `TRUST_PROXY` and `PROXY_SECRET` decide it), but counted
apart from them: five keys not in use in a row lock the client out of the
Gateway for a minute, `429` with `Retry-After`, its right key too, and
each one after a lockout doubles it, up to an hour. A key in use, or a day
without one not in use, starts the count afresh; a request with no key
counts nothing. Only keys not in use count, once they are checked, so
however many requests a tool sends at once, its right key never locks it
out. Each key not in use, and each lockout, is in the Activity Feed
(`gateway_key.failed`, `gateway_key.locked_out`), with the client's
address and never the key (pen-testing I2-3). The count is kept in memory
and starts afresh when the server restarts. The Gateway's own port is not
limited: the sandboxes reach it through the sandbox relay, so they are all
one client there, and one sandbox would lock every Agent out.

- **Agents.** Each Agent gets its own key when it is made, and every Agent
  without one gets one when the server starts. Its sandboxes are given the
  Gateway's URL and that key (`ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`), never an AI Account's credential (see
  [Sandboxes](issue-pipeline.md#sandboxes)). **Rotate** in
  Floor Settings' Agents table gives it a new key at once and revokes
  the old one (`POST /api/floors/:floorId/agents/:agentId/gateway-key/rotate`).
  Removing an Agent (`agent.removed`) revokes its key. While the Agent is
  paused, or its Floor archived, the Gateway refuses its key (`401`, "That
  Gateway Key is not in use"), so a key a sandbox held, or one taken from
  it, is no use once the Owner has stopped its Agent's work (pen-testing
  G1-4). Resuming the Agent lets the same key call models again.
- **The Communications Agent** (PRD FR-90) has a key of its own (kind
  `communications`), made when the server first starts it and kept
  sealed, for the Digests its Model writes (see
  [Digests](notices-and-skills.md#communications-and-connections)). It
  belongs to no Floor: its requests are attributed to the Agent id
  `communications` with no Floor ("Communications Agent" in the
  analytics), and the Gateway refuses them with a cap error once its own
  tokens reach the office's daily or monthly Token Cap. Its key cannot be
  revoked on its own, and calls no model while it is paused.
- **The Terminal** (see
  [Direct chats and the Terminal](events-and-chat.md#direct-chats-and-the-terminal))
  has a key of its own too (kind `terminal`), made the first time it is
  used and kept sealed. Its requests are attributed to the Owner tool
  "Terminal", with no Agent or Floor. It cannot be revoked on its own.
- **Owner tools.** In AI Settings' **Gateway Keys** card, or in [API Key
  Management](#api-key-management), the Owner makes a
  named key for each of their own tools. It is shown once, when it is
  made, and never again, with the base URLs to use it with: AI Office's
  own address. Claude Code takes the address itself, and OpenAI clients
  (Codex, the OpenAI SDKs) the address with `/v1`:

  ```bash
  # Claude Code
  ANTHROPIC_BASE_URL=http://localhost:3045 ANTHROPIC_AUTH_TOKEN=aio_gk_… claude
  # An OpenAI client
  OPENAI_BASE_URL=http://localhost:3045/v1 OPENAI_API_KEY=aio_gk_… …
  ```

  Behind the `tls` profile, use `https://<your domain>` (and
  `https://<your domain>/v1`) instead. **Revoke** stops it
  at once. Each key shows when it was last used (to the minute). Its
  calls are held to the office's Token Caps, against its own use, as the
  Terminal's are (see
  [Owner tools' caps](floors-and-agents.md#owner-tools-caps)).
- **Attribution (FR-42).** Each row in `gateway_requests` names the key
  it presented and the Agent and Floor it belongs to, or the Owner tool,
  and the issue and pull request it is for. The request history shows
  them with the caller ("for #4, PR #7").
  - **An Agent's** (and the Communications Agent's) are the work AI Office
    gave it, never what its call names (pen-testing G1-1): code in a
    sandbox can send any header, or none. While a task's sandbox runs, its
    runner holds the issue and its pull request for the Agent, and every
    call the Agent's key makes counts against them, whatever it names. A
    call AI Office makes itself for an Agent (a review, a Manager's
    judgement, a Fresh Start's summary, the Decision Model's questions)
    opens its work and sends the token it is given as `x-ai-office-work`,
    good for that Agent alone and only until the call is answered. Any
    other call of an Agent's counts against no issue, so it is held to its
    own, its Floor's or the office's Token Cap.
  - **An Owner tool's** are the numbers it names in `x-ai-office-issue`
    and `x-ai-office-pull-request`. It belongs to no Floor, so no issue's
    Token Cap counts them.

  Sandboxes still send `x-ai-office-issue` and its kin, which the Gateway
  reads only from an Owner tool. None of AI Office's headers is ever
  forwarded to the AI Provider, and `x-ai-office-work` is shown redacted
  in the request history.
- **At rest.** Only a key's SHA-256 is kept for checking it, in
  `gateway_keys`. An Agent's key is also kept sealed with `ENCRYPTION_KEY`,
  for its sandboxes; an Owner tool's never is. Keys are registered with the
  central redactor, and anything shaped like one is redacted from logs and
  events.
- **API.** `GET /api/gateway-keys` lists the keys in use, without the
  keys; `POST /api/gateway-keys` with `{"name"}` makes an Owner tool's key
  and answers `{"gatewayKey","key"}`, the only answer that carries a key;
  `DELETE /api/gateway-keys/:id` revokes one. An Agent's key goes with the
  Agent: it is rotated, not revoked (`409 agent_key_not_revocable`).

#### API Key Management

**API Key Management** in the navigation (`/api-keys`,
`apps/web/src/api-keys-page.tsx`) is where the keys are looked after:

- **At a glance:** how many keys there are, how many are enabled, and how
  many were used in the last day.
- **Make an API key** for a tool, with its **access**: **AI proxy only**
  (the default) calls models through the Gateway and nothing else; **AI
  proxy and UI** also signs in to AI Office, from the sign-in page's
  **Use an API key instead**. Such a key opens the whole web app,
  as the Owner's password does, without a second factor: keep it as safe
  as the password. So making one, giving a key UI access, or enabling a
  disabled one that has it, asks for your **current password** (and a
  code from your authenticator app when TOTP is on), never just the
  session. A session begun with an API key cannot give it.
- **Each key's card:** its kind and access, its hint, when it was made
  and last used, and its **usage** (requests, input and output tokens and
  estimated cost, of the requests retention keeps). Its **name**,
  **nickname** and **time zone** (British time until set) are edited
  there; signed in with a key, the lobby's receptionist greets you by its
  nickname (else its name) in its time zone. One of your tools' keys can
  also change its access, be **disabled** (the Gateway and sign-in refuse
  it, and its web sessions end, until it is **enabled** again) and be
  revoked. An Agent's key keeps its Agent's name, is always enabled and
  only calls models.
- **API.** `POST /api/gateway-keys` with `{"name", "access"}`, plus
  `{"currentPassword", "code"}` for `proxy_and_ui` (`403 proof_required`
  without them, or from a session begun with an API key; `422
  wrong_password` or `wrong_code`). `PATCH /api/gateway-keys/:id` with any
  of `{"name", "access", "enabled"}` (an Owner tool's key only; `409
  agent_key_no_ui` for an Agent's), with the same proof when the change
  lets the key sign in where it could not, `PUT /api/gateway-keys/:id/profile` with `{"nickname",
  "timeZone"}`, `GET /api/gateway-keys/usage`, and `POST
  /api/login/api-key` with `{"key"}`, rate-limited and recorded as a
  password sign-in is (`401 wrong_api_key` for a key that is not in use,
  enabled and with UI access). A session records the key that began it
  (`sessions.gateway_key_id`, and `gatewayKeyId` in `GET /api/session`).

With `GATEWAY_FIXTURES_DIR` set, the Gateway also writes each
request/response pair there as a contract-test fixture
([`packages/gateway/fixtures/`](../../packages/gateway/fixtures/README.md)).
To record the scripted ones against the Owner's real AI Accounts (#45),
`pnpm --filter @ai-office/gateway record --target <AI Provider>:<Model>`
sends a plain message, a streamed one, a tool call and an image through
the Gateway for each AI Provider named, with an Owner tool's Gateway Key
from `AI_OFFICE_GATEWAY_KEY` (never printed), routed as any Owner tool's
requests are (by Model, or to the AI Account `--account` forces). It
prints each scenario's status and the fixture it produced, and says why a
rate limit and a token refresh are not recorded, and why a subscription
is recorded through its own agent tool instead. How to run it, and #45's
steps with it, are in [the fixtures'
README](../../packages/gateway/fixtures/README.md#recording).

### AI Accounts

The Owner adds AI Accounts in AI Settings' **AI Accounts** card (PRD FR-35,
FR-36); none come from the environment. So far an account is one of:

- an **Anthropic Console API key**, with an optional custom endpoint URL in
  place of `https://api.anthropic.com`;
- a **Claude subscription** (Pro or Max), added through its OAuth login;
- an **xAI API key** or a **Grok subscription**, for the Grok AI Provider
  (below);
- a **Gemini API key**, for the Gemini AI Provider (below);
- a **ChatGPT subscription**, for the ChatGPT AI Provider, added through
  OpenAI's OAuth login (below);
- an **AWS Bedrock** or **Google Vertex AI** account, for Claude Models
  through that cloud platform (below);
- an **OpenRouter**, **DeepSeek**, **Z.ai**, **MiniMax** or **Kimi** API
  key, each for the AI Provider of that name (below);
- a **Qwen sign-in** (Qwen Code's free tier), for the Qwen AI Provider,
  added through Qwen's device login (below);
- the Owner's own **Ollama** server, or an **Ollama Cloud** API key, for the
  Ollama AI Provider (below);
- an **Anthropic-compatible** or **OpenAI-compatible endpoint** at a URL
  the Owner gives, with a key only if it asks for one (below).

Every request to any of them can go through an
[outbound proxy](#the-outbound-proxy).

None of them may be on an internal address the Owner has not allowed:
see [Internal addresses](#internal-addresses).

- **The key is shown once: never.** It is typed in when the account is
  added (a cloud platform's credentials too), sealed with `ENCRYPTION_KEY`
  and stored in `ai_accounts`. It is
  bound to its row, so it cannot be copied to another one, and no answer,
  event or log line carries it. Once the server opens a key to forward a
  request, it is registered with the central redactor too.
- **The Model decides the AI Provider.** A request for a Model of a known AI
  Provider (`claude-*` and Bedrock's `anthropic.claude-*`, `grok-*`, `gemini-*` or `gemma-*`, `gpt-*`, `o1`…
  and `codex-*`, `deepseek-*`, `glm-*` for Z.ai, `MiniMax-*`, `kimi-*` or
  `moonshot-*`, Qwen's `qwen*`, `qwq-*`, `coder-model` and `vision-model`,
  OpenRouter's `vendor/model`, such as `anthropic/claude-sonnet-4.5`, and
  Ollama's `model:tag`, such as `qwen3-coder:30b`, whoever made the Model)
  is served only by that AI Provider's accounts, and by the Owner's
  compatible endpoints, which are sent any Model. With none, it is a
  `503`. A Model of no known AI Provider goes to the compatible endpoints
  while one can serve it, and otherwise to any account.
- **Order.** The Gateway serves each request from the active accounts with
  the lowest priority (1 first, up to 100), as the load-balancing strategy
  chooses among them (below); accounts of a worse priority serve only when
  none of a better one can. A new account goes after the others. Changes
  apply from the next request.
- **Actions.** Rename, change the priority, pause, resume and delete. A
  paused account is left alone until it is resumed. Each change is a
  `config.changed` event naming what changed (`aiAccounts.paused`, …).
  Requests an account served keep its name after it is deleted.
- **API.** `GET /api/ai-accounts` lists them; `POST /api/ai-accounts` adds
  one (`{"name","aiProvider":"Claude" | "Grok" | "Gemini" | "OpenRouter" | "DeepSeek" | "Z.ai" | "Minimax" | "Kimi" | "Ollama","accountType":"api_key",
  "credential","endpointUrl"}`, an endpoint's or a cloud platform's, below); `PATCH /api/ai-accounts/:id` takes `name`,
  `priority`, `paused` and the pause thresholds; `DELETE
  /api/ai-accounts/:id` deletes it.

#### Load balancing

AI Settings' **Load balancing** card chooses, at runtime, how the Gateway spreads
requests across the AI Accounts (PRD FR-37, FR-38). Each request is routed
in this order:

1. **A forced account.** An Owner tool's request with
   `x-ai-office-account: <account name or id>` is served from that account,
   whatever its priority or the strategy; if it does not exist, is paused
   or cannot serve the request (a subscription, for anything but Claude
   Code), the request is refused with `503` naming why, rather than served
   elsewhere. Agents' requests cannot force an account (their sandboxes
   are untrusted); the header is ignored from them, and never forwarded.
2. **The strategy**, among the unpaused accounts that can serve the
   request, keeping to the best (lowest) priority among them:
   - **Session** (the default): each session stays on the account it
     started on for the session window (300 minutes by default, from 1
     minute to 7 days), and a new session starts on the account with the
     fewest sessions. A session is an Agent's sandbox run (its sandbox
     sends `x-ai-office-session: <sandbox id>` with its model calls) or,
     for a request without one, the caller's Gateway Key. A session whose
     account is paused, or can no longer serve it, moves and starts a new
     window.
   - **Session affinity**: each session stays on its account for as long
     as it is in use. Every call renews it, and it lets go only after the
     session window passes without one, however long the session runs (so
     its prompt cache stays warm). A new session starts on the least-used
     account (below).
   - **Drain soonest**: a new session starts on the account whose usage
     window resets first (the sooner of its five-hour and weekly resets,
     as its AI Provider reports them; see [Usage windows](#usage-windows-pause-thresholds-and-force-reset)),
     so what is left of that window is used before it is lost. Accounts
     that report no windows (API keys) come after those that do. Sessions
     stay on their accounts while in use, as with session affinity.
   - **Drain soonest (strict)**: every request goes to the account whose
     window resets first, sessions or not, so a session moves as soon as
     another account's window resets sooner.
   - **Least used**: each request goes to the account that has used the
     fewest tokens (input and output) in the last five hours, counted from
     the request history (read back when the server starts).

   Every strategy keeps to the best priority first, and a tie goes to the
   account first in the Owner's order.

   **Back to the preferred account** (PRD FR-39, §5 scenario 6). A session
   keeps to its account only among the accounts of that account's
   priority. When a session falls back to a worse priority because every
   better account is held back (rate-limited, overloaded, at a pause
   threshold or failing), it stays there only while they are. Once one of
   them can serve again, because its limit reset or its circuit breaker's
   cooldown ended, the session's next request moves back to it and starts
   a new session window there, as new sessions do.

Sessions are kept in memory, so a restart starts them afresh. `GET` and
`PUT /api/office/load-balancing` read and set `{"strategy":"session" |
"session_affinity" | "drain_soonest" | "drain_soonest_strict" |
"least_used","sessionWindowMinutes"}`; each change is a `config.changed`
event (`loadBalancing.strategy`, `loadBalancing.sessionWindowMinutes`), and
applies from the next request. The settings live in `office_settings`.

After the strategy ranks the accounts, two checks follow, in this order
(PRD FR-38), and the first account they leave serves:

3. **The model-capacity filter** leaves out an account exhausted for the
   requested Model's family: rate-limited outright, or rate-limited for
   that family only. A family is Claude's tier (`claude-opus`,
   `claude-sonnet`, `claude-haiku`, whatever the version), or else the
   Model itself without a pinned date (`gpt-4o-2024-08-06` is `gpt-4o`). A
   rate limit is for one family only when the answer says so: Google's
   `QuotaFailure` naming a `model` in its quota's dimensions, or a Claude
   subscription's `anthropic-ratelimit-unified-representative-claim`
   naming a weekly Opus or Sonnet limit (`seven_day_opus`; Anthropic does
   not document it). The account then serves its other families, and
   nothing about it is stored or shown as limited. These exhaustions are
   kept in memory, until their reset or **Reset limits**.
4. **Usage throttling** leaves out an account that is overloaded, at its
   usage pause threshold, or ahead of its pace. AI Settings' **Usage
   throttling** card turns on two optional pacing gates, off by default:
   with one on, an account that has used more of its five-hour (or
   weekly) window than the share of it gone by, plus 10 points, waits
   until the window catches up. An hour into a five-hour window (20%), up
   to 30% may be used. Accounts that report no windows (API keys) are
   never paced. `GET` and `PUT /api/office/usage-throttling` read and set
   `{"fiveHourPacing","weeklyPacing"}`; each change is a `config.changed`
   event (`usageThrottling.fiveHourPacing`, …).

When a check leaves no account, the Gateway answers for it: **429** for
capacity ("…has no capacity left for claude-opus models", or "…is
rate-limited"), **529** for throttling ("…is ahead of its weekly pace"),
with `retry-after` until the first it left out is back. With no account
that can serve at all, or only failing ones, it is a **503**.

#### Rate limits, retries and the circuit breaker

The Gateway reads each AI Provider's answer for what it says about the AI
Account that gave it (PRD FR-38, FR-39): its status, its headers and its
error body, as Anthropic, OpenAI-compatible APIs and Google write them.

- **Rate-limited** (`429`, `rate_limit_error`, `RESOURCE_EXHAUSTED`) or
  **overloaded** (`529`, `overloaded_error`, Google's `503 UNAVAILABLE`,
  DeepSeek's `503` "Server overloaded", and the `429`s with which Kimi
  (`engine_overloaded_error`) and Z.ai (business code `1305`) say so):
  the account is held back until its reset, the latest of `retry-after`
  (or `retry-after-ms`), the `anthropic-ratelimit-*-reset` times of the
  limits with nothing left, a subscription's
  `anthropic-ratelimit-unified-reset`, OpenAI's `x-ratelimit-reset-*` and
  Google's `retryDelay`; 60 seconds (rate limit) or 30 (overload) when the
  answer does not say. The request goes at once to the next account that
  can serve it, and is not sent to the held-back one again.
- **Failed** (a 5xx, no answer, or a `402`: OpenRouter and DeepSeek say an
  account has no credit left with one): the request is tried again, on another
  account at once if there is one, or back on one already tried after a
  wait that grows each time (500 ms, then twice as long). Failures in a
  row (5) open the account's **circuit breaker**: it is rested for a
  cooldown (60 s), after which one request may try it; a failure then opens
  it again at once, and a success closes it.
- **Anything else** (a 4xx) is the request's fault, and is sent back as is.
- **Nothing left.** When the attempts (3) run out, the caller gets the last
  answer. When every account that could serve is already held back, the
  Gateway answers itself, with `retry-after` until the first is back:
  `429` when they are rate-limited (a capacity exclusion), `529` when the
  rest are overloaded or paced (throttling), and `503` when they are all
  failing or there is no account at all (see
  [Load balancing](#load-balancing) for the order of the checks).
- An account's limit shows in AI Settings' **AI Accounts** card, live, and is
  kept in `ai_accounts` (`limit_reason`, `limited_until`). Serving lifts it,
  and so does its reset passing (checked every minute). Each change is an
  `ai_account.limit_changed` event. When an AI Provider has no account left,
  an action Notice, "No Claude AI Account left", offers **Open AI
  Accounts**; it closes once an account of that AI Provider serves again.
- A forced account (`x-ai-office-account`) is tried once, held back or not,
  so it can be used to probe a limit.
- AI Settings' **Retries** card sets the attempts, the first wait, the
  multiplier, and the circuit breaker's threshold and cooldown at runtime
  (`GET` and `PUT /api/office/retries` with `{"attempts","delayMs",
  "multiplier","circuitBreakerThreshold","circuitBreakerCooldownSeconds"}`;
  each change is a `config.changed` event, `retries.attempts` and so on).

#### Usage windows, pause thresholds and force-reset

- **Usage windows** (PRD FR-36, FR-43). A subscription reports its
  five-hour and weekly windows with each answer, and the Gateway reads them
  from the headers (`packages/gateway/src/limits/usage-windows.ts`):
  - a **Claude subscription** in `anthropic-ratelimit-unified-5h-*` and
    `-7d-*` (`-utilization`, the share used as a fraction, and `-reset`,
    seconds since the epoch);
  - a **ChatGPT subscription** (Codex's backend) in `x-codex-primary-*`
    and `x-codex-secondary-*` (`-used-percent`; `-window-minutes`;
    `-reset-at`, seconds since the epoch, or else `-reset-after-seconds`,
    kept to the minute since it moves with the clock). The primary window
    is usually the five-hour one and the secondary the weekly one, but each
    is placed by its length when it says it (300 minutes is the five-hour
    window, 10,080 the weekly one, within a tenth either way), since a Pro
    plan has been seen with a weekly primary. A window of another length is
    left out. These are what Codex reads (`codex-rs/codex-api/src/rate_limits.rs`);
    OpenAI does not document them.

  No other AI Provider reports anything of that shape: xAI's and OpenAI's
  `x-ratelimit-*` headers count requests and tokens a minute, and a Grok
  or Qwen sign-in's answers carry no plan windows. The Gateway stores the
  windows on the account (`five_hour_*` and `weekly_*` in `ai_accounts`),
  whichever AI Provider reported them. Each change of a whole percent, or a
  new reset, is kept in `ai_account_usage`. AI Settings' **AI Accounts**
  card shows each window as a meter, with when it resets, and pause
  thresholds apply to it as to a Claude subscription's.
- **Usage charts** (FR-43). **Usage history** on any AI Account, an API
  key's too, opens its last week, an hour at a time (UTC), drawn as
  Analytics draws its charts (legend, tooltip, keyboard focus and **Show
  as a table**):
  - **Tokens**: input and output (what Token Caps count), and cache reads;
  - **Requests**: every request it served, and those that failed;

  both from the Gateway's own request history, so every account has them
  (`GET /api/analytics/series?bucket=hour&aiAccountId=<id>`; requests are
  matched by the account's id, so a renamed account keeps its history).
  Then, for an account whose AI Provider reports usage windows:
  - **Usage windows**: the share of each window used, the highest reading
    each hour;
  - the readings themselves, newest first, with when each window resets
    (`GET /api/ai-accounts/:id/usage`).

  An account whose AI Provider reports no windows (API keys, endpoints,
  cloud platforms, Grok and Qwen sign-ins) says so under its charts.
- **Read from Anthropic, too.** A Claude subscription's windows are also
  read from Anthropic's usage endpoint (`GET
  https://api.anthropic.com/api/oauth/usage`, what Claude Code's `/usage`
  shows) with its own token. That happens when it is signed in, at start, and every five minutes, so its
  5-hour and weekly usage show (and pace it) before any request has gone
  through it. Only Claude's usage can be read this way: ChatGPT's
  windows show once a request has gone through the account.
  **Refresh usage** in the card (`POST
  /api/ai-accounts/:id/refresh-usage`) reads them at once; it answers `502`
  when Anthropic does not say. The card always shows both windows for a
  Claude subscription ("not reported" until they are known) and reads the
  list again each minute. Anthropic does not document the endpoint either.
- **A usage bar for every account.** An account without 5-hour and
  weekly windows still shows the best its AI Provider honestly reports,
  under its name in the card (`rateLimits`, `balance` and `tokensToday` in
  `GET /api/ai-accounts`):
  - **Rate limits, from the headers.** An API key's answers carry its
    per-minute limits, and the Gateway keeps the latest of each answer (in
    memory at once, stored in `ai_accounts.rate_limits` at most every 15
    seconds): Anthropic's
    `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`
    (resets in RFC 3339; token counts rounded to the thousand) and the
    OpenAI-style `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
    (resets as durations, such as `6m0s`), which xAI's API sends too. The
    card shows "Requests left this minute" and "Tokens left this minute"
    (or input and output tokens, as Anthropic counts them); a limit whose
    reset has passed shows full again. OpenRouter sends these headers only
    on its own `429`s, and DeepSeek, Kimi, Z.ai, MiniMax and Gemini
    document none, so their accounts have no such bars.
  - **Prepaid credit, from a balance endpoint.** With the usage refresh
    above (at start, every five minutes, and **Refresh usage**), the
    Gateway reads the credit of the API keys whose AI Provider documents a
    balance an inference key may read, with the account's own key, into
    `ai_accounts.balance`: OpenRouter's `GET /api/v1/key` (the key's credit
    used of its limit, in US dollars: a "Credit used" bar), DeepSeek's `GET
    /user/balance` and Kimi's `GET /v1/users/me/balance` (what is left,
    shown as a figure: a balance has no limit to draw a bar against).
    OpenRouter's account-wide `/credits`, xAI's billing API and OpenAI's
    costs need a management or admin key, so they are not read.
  - **Its share of the Gateway's day, otherwise.** An account with none of
    these (Ollama, compatible endpoints, Bedrock, Vertex AI, Grok and Qwen
    sign-ins, and the AI Providers above that report nothing) shows "Share
    of the AI Gateway's tokens today": the input and output tokens it served
    since midnight UTC against every account's together, labelled so it is
    never taken for a limit of its AI Provider's. AI Accounts have no Token
    Caps of their own.

  Like the usage windows, none of these is an event: the card reads the
  list again each minute.
- **Pause thresholds.** Each account can pause at a share of each window,
  from 1% to 100%: `PATCH /api/ai-accounts/:id` with
  `fiveHourPauseThreshold` and `weeklyPauseThreshold` (null for none), or
  **Edit** in the card. At its threshold the account is held back until
  that window resets ("Paused at its usage threshold"). This is
  throttling: when no other account can serve, the Gateway answers `529`.
  An AI Provider left with no account raises the "No AI Account left"
  Notice too.
- **Force-reset.** **Reset limits** (`POST
  /api/ai-accounts/:id/reset-limits`) clears an account's rate-limit state.
  It lifts its limit, closes its circuit breaker and forgets its usage
  windows until its AI Provider reports them again, so the Gateway uses it
  at once. The thresholds and the history are kept. It is a
  `config.changed` event (`aiAccounts.limitsReset`).

#### Prompt cache TTL

General Settings' **Prompt cache TTL** card has a button for each TTL the Gateway
gives every prompt-cache breakpoint (`cache_control: {type: "ephemeral"}`)
of a request to Anthropic's Messages API, in its system prompt, tools and
messages (`GET` and `PUT /api/office/prompt-cache`, `{"ttl": …}`):

- **As sent** (the default): each request keeps the TTL its agent tool
  asked for.
- **5 minutes**: Anthropic's default, with the cheapest cache writes.
- **1 hour**: cache writes cost more, but the cache stays warm through
  longer pauses between an Agent's turns.

Every breakpoint gets the same TTL, so Anthropic's rule that longer TTLs
come first always holds. A request with no breakpoint is sent exactly as it
came. It applies from the next request (`config.changed`,
`promptCache.ttl`).

#### Auto-refresh

A subscription's usage window starts with its first request after the last
one reset. A window that resets while nothing is asked of its account starts
late, whenever work next arrives. AI Settings' **Auto-refresh** card turns on
auto-refresh (PRD FR-39), which is off by default. With it on, the AI Gateway
starts each window as soon as it can:

- **When.** Every minute, with the token refresh and the limit check, it
  looks for an AI Account whose five-hour or weekly window reset more than a
  minute ago (`autoRefreshBufferMs`), so that its AI Provider has surely
  started the next one.
- **What it sends.** One minimal request: a Messages request for one output
  token from `claude-haiku-5-5`, presented as the account presents every
  request. Its answer is read like any other. The new window is stored and
  shown, a rate limit holds the account back, and a failure counts towards
  its circuit breaker.
- **Once per window.** A window gets one request, served or not, and a window
  that a real request already restarted gets none. The windows already
  refreshed are kept in memory, so after a restart a window that reset
  unrefreshed is refreshed then.
- **Accounts left alone.** An account that is paused, held back, or whose
  token has expired or needs a new sign-in waits for a later minute.
  Only Claude accounts are sent one, as the request is a Messages request:
  accounts that report no usage windows (API keys, and every AI Provider's
  but Claude's and ChatGPT's subscriptions) have none to start, and a
  ChatGPT subscription serves only Codex's own requests (FR-35).
- **Activity Feed.** Each request is an `ai_account.window_refreshed` event,
  which says which windows reset, whether the request was served and when
  the new five-hour window resets. It is not a request in the request
  history, since no Agent or Owner tool made it.
- **Terms.** The request is the AI Gateway's own, not Claude Code's, while
  Anthropic's terms allow a Claude subscription only through Claude Code
  (PRD FR-35). The card says so, and that is why auto-refresh is off until
  the Owner turns it on.
- **API.** `GET` and `PUT /api/office/auto-refresh` read and set
  `{"enabled"}`. Each change is a `config.changed` event
  (`autoRefresh.enabled`), and applies from the next minute.

#### Prompt-cache keep-alive

Anthropic keeps a prompt cache for its TTL (five minutes unless a breakpoint
asks for an hour), counted from the start of the last request that read or
wrote it. An Agent that pauses longer, for a long test run or a slow build,
pays to write its whole conversation to the cache again. AI Settings'
**Prompt-cache keep-alive** card turns on keep-alive (PRD FR-39), which is
off by default. With it on, the AI Gateway keeps active Agents' caches warm:

- **What it keeps.** For each Agent session (its Gateway Key and the session
  it names) and Model, the latest Messages request an Anthropic-format AI
  Account served with a cache breakpoint. A request with a thinking budget,
  structured outputs or a forced tool choice cannot be sent the minimal way,
  so it is never kept warm.
- **What it sends.** A minute before the cache would expire
  (`keepAliveLeadMs`), the same request again with `max_tokens: 0` and not
  streamed, to the same account, with the agent tool's own headers. It
  generates nothing: it reads the cache, which starts its TTL again, and is
  billed as a cache read. Its answer is read like any other, so a rate limit
  holds the account back and a failure counts towards its circuit breaker.
  The server runs a round every 15 seconds (`keepAliveRoundMs`).
- **Only active sessions.** A session whose Agent has asked nothing of its
  own for the **idle time** (30 minutes by default, 5 to 480) is let go. So is
  one whose cache expired before it could be kept warm (a request then would
  write it anew), one whose keep-alive was not served, and one whose Agent is
  paused at a Token Cap. An Agent whose own requests keep its cache warm
  is never sent one. Its next request starts its session again. Sessions are kept in
  memory, so a restart lets them all go.
- **Bounded per account.** Each AI Account is sent at most the Owner's number
  of keep-alives in any hour (60 by default, up to 600: enough for four
  sessions on the five-minute TTL). A session over the bound waits, and is let
  go if its cache expires meanwhile. An account that is paused, held back,
  exhausted for the Model's family or signed out is not sent one; its
  sessions wait for it.
- **Visible.** Each keep-alive is a request in the request history,
  attributed to its Agent, Floor and issue, marked **(keep-alive)**
  (`keepAlive` in the API, the `keep_alive` column of `gateway_requests`).
  Analytics shows the keep-alives and their estimated cost, as a tile and
  over time. They count towards their Agent's Token Caps like any request,
  but their tokens are almost all cache reads, which caps do not count.
- **Terms.** The request is the agent tool's own, but the AI Gateway sends
  it, while Anthropic's terms allow a Claude subscription only through
  Claude Code (PRD FR-35). The card says so, and that is why keep-alive is
  off until the Owner turns it on.
- **API.** `GET` and `PUT /api/office/prompt-cache-keep-alive` read and set
  `{"enabled", "idleMinutes", "maxPerAccountPerHour"}`. Each change is a
  `config.changed` event naming what changed (`keepAlive.enabled`,
  `keepAlive.idleMinutes`, `keepAlive.maxPerAccountPerHour`), and applies
  from the next round.

#### Combos

A Combo (PRD FR-40) is a named, ordered fallback chain of slots, each an AI
Account and a Model, assigned to one or more model families. AI Settings'
**Combos** card builds them, and turns them on and off. While Combos are on
(they are off by default), a request for a Model of a family an enabled
Combo is assigned to waterfalls through its slots, in place of the
load-balancing strategy:

- **Families.** A family is as the model-capacity filter names it:
  `claude-opus`, `claude-sonnet` or `claude-haiku` for Claude's Models,
  whatever their version, and any other Model's name without a date it is
  pinned to (`gpt-4o`). A Model's name stands for its family when a Combo is
  assigned (`claude-opus-5-5` is `claude-opus`). No two enabled Combos share
  a family, so a request has at most one; a disabled Combo may wait for its
  turn.
- **The waterfall.** The first slot that can serve the request does, asking
  for the slot's Model in place of the one asked for, in its AI Account's
  own format (a Claude Code request can reach a Grok slot, translated). When
  it is rate-limited, overloaded or fails, the next slot serves at once.
  Each slot gets its turn, however few the retry attempts. The request
  history records the account and the Model that served.
- **Skipped slots.** A slot is skipped while its AI Account is paused,
  deleted, held back (rate-limited, exhausted for the slot Model's family,
  overloaded, at a pause threshold, ahead of its pace, or with its circuit
  open), or cannot serve the request (another agent tool's subscription, or
  an endpoint it does not have). One account may be in two slots with two
  Models: out of Opus for the week, its Sonnet slot still serves.
- **Nothing left.** When every slot is held back, the Gateway answers as in
  [Rate limits](#rate-limits-retries-and-the-circuit-breaker): `429`, `529`
  or `503`, with `retry-after`. Accounts outside the Combo do not serve its
  families.
- **Left alone.** A request for another family, a request whose Model the
  Gateway cannot read, and a forced account (`x-ai-office-account`) are
  routed as before. Sessions do not apply to a Combo: its order does.
- **Checked when saved.** A slot must name an AI Account that exists, a
  Model of that account's AI Provider (or of none the Gateway knows), and
  not repeat another slot. A Combo has 1 to 20 slots and 1 to 20 families,
  and its name is its own.
- **API.** `GET` and `PUT /api/office/combos` read and set `{"enabled"}`,
  the switch for every Combo (`config.changed`, `comboSettings.enabled`).
  `GET` and `POST /api/gateway/combos`, `PATCH` and `DELETE
  /api/gateway/combos/:id` list, add, change and delete Combos (`{"name",
  "modelFamilies","slots":[{"aiAccountId","model"}],"enabled"}`). Each
  change is a `config.changed` event naming what changed (`combos.added`,
  `combos.slots`, `combos.deleted`…), and applies from the next request.
  Combos are kept in `gateway_combos`.

#### Model mappings, aliases and forced Models

AI Settings' **Model mappings** card (PRD FR-41) sends a request for one
name as another Model, and each AI Account's **Edit** form can force a
Model:

- **Aliases.** A mapping that applies to every AI Account is an alias, such
  as `opus` for `claude-opus-5-5`. It is resolved before anything else, so
  the request is routed as the Model it stands for: to that AI Provider's
  accounts, through its family's Combo, and judged by its family's
  capacity.
- **Mappings for one kind of AI Account.** A mapping for a kind (an AI
  Provider and an account type, such as **Anthropic Console API key**)
  applies when an account of that kind serves. Its Model must be that AI
  Provider's (or of none the Gateway knows). It may map another AI
  Provider's name: with `gpt-5-codex` mapped to `claude-sonnet-5-5` for
  Claude API keys, those accounts serve requests for `gpt-5-codex`.
- **Forced Models.** An AI Account's forced Model is sent whatever was
  asked for, and must be its own AI Provider's. It narrows which Model the
  account is sent, not which requests it serves.
- **Precedence.** Each account is sent, most specific first: its forced
  Model; the Model of the Combo slot serving the request; its kind's
  mapping of the name as asked; its kind's mapping of the alias's Model;
  the alias's Model; the Model asked for. Aliases and mappings take one
  step each and never chain. (`modelSentTo` in
  `packages/shared/src/model-mappings.ts`.)
- **Routing and records.** Whether an account can serve a request, and its
  model-capacity check, go by the Model it would be sent. The request
  history, its estimated cost and the analytics record the Model that
  served. The answer comes back as the AI Provider gave it.
- **Checked when saved.** A name is mapped once as an alias and once per
  kind; there are at most 200 mappings. A mapping to itself, or with only
  half a kind, is refused.
- **API.** `GET` and `POST /api/gateway/model-mappings`, `PUT` and `DELETE
  /api/gateway/model-mappings/:id` list, add, change and delete mappings
  (`{"from","to","aiProvider","accountType"}`, the last two both `null`
  for an alias); a name already mapped is a `409`. `PATCH
  /api/ai-accounts/:id` takes `{"forcedModel"}` (`null` for none); another
  AI Provider's Model is a `400` (`forced_model_mismatch`). Each change is
  a `config.changed` event (`modelMappings.added`, `modelMappings.changed`,
  `modelMappings.deleted`, `aiAccounts.forcedModel`) and applies from the
  next request. Mappings are kept in `gateway_model_mappings`.

#### Extra usage

Anthropic lets a Claude subscription go on past its plan's limits, billed as
extra usage, where the Owner has turned that on in their Claude account.
Each Claude subscription has an **Extra usage** toggle in its **Edit** form
(PRD FR-41), off by default; no other kind of AI Account offers it.

- **Off.** The AI Gateway spends no extra usage on purpose: once one of the
  account's usage windows is full (100%), or an answer says it was served
  on extra usage (`anthropic-ratelimit-unified-status: rejected` with
  `anthropic-ratelimit-unified-overage-status: allowed`), the account is
  held back ("At its plan's limit (extra usage off)") until the plan's
  limit resets (`anthropic-ratelimit-unified-reset`, or an hour when it
  does not say), and requests go to other accounts. When nothing else can
  serve, the caller gets a `429` with `retry-after`. The answer that said
  so was already served: that one request is billed.
- **On.** The account goes on serving past its plan's limits, and a full
  window does not hold it back. A `429` from Anthropic (extra usage
  refused, or its spending limit reached) still does. Turning it on lets an
  account held back for it serve at once.
- **API.** `PATCH /api/ai-accounts/:id` with `{"extraUsage"}`; an account
  that does not offer it is a `400` (`extra_usage_not_offered`). Accounts
  carry `extraUsage`, `null` where their AI Provider offers none. The
  headers are those Claude Code reads; Anthropic does not document them.

#### Claude subscriptions

- **Terms first.** Choosing **Claude subscription** shows a warning:
  Anthropic's terms allow a subscription only through Claude Code (PRD
  §11). The Owner ticks that they have read it before signing in
  (`acceptedTerms` must be `true`).
- **Signing in (OAuth with PKCE).** **Sign in to Claude** starts a login
  and links to Claude's sign-in page; the Owner signs in, and pastes back
  the code the page shows (`code#state`). AI Office exchanges it, with the
  login's PKCE verifier, for an access token and a refresh token. A login
  is used once and lasts 15 minutes; it is kept in memory only. AI Office
  signs in as Claude Code's public OAuth client (`anthropicOAuth` in
  `packages/gateway/src/accounts/oauth.ts`); Anthropic does not document
  these endpoints, so they may change.
- **At rest.** The access token is the account's credential, and the
  refresh token is kept beside it, each sealed with `ENCRYPTION_KEY` for its
  own row (`ai_account.credential:<id>`, `ai_account.refresh_token:<id>`),
  with the token's expiry. Both are registered with the redactor; neither
  is ever sent back, logged or published.
- **Token health, live.** Each subscription shows **valid** (until when),
  **expiring** (within 15 minutes) or **expired**. Every minute the server
  refreshes each token due to expire within 15 minutes (one refresh at a
  time per account, since a refresh token is used once), and tells each
  change of health as an `ai_account.token_health` event, which the card
  follows live.
- **Re-authentication.** When Anthropic refuses a refresh, the account is
  marked as needing a new sign-in, and an action Notice, "Re-authentication
  needed: <name>", offers **Re-authenticate**, which opens AI Settings with that
  account's sign-in. Taking the action before signing in again fails, and
  the Notice stays; signing in again (`POST
  /api/ai-accounts/:id/reauthenticate`, then the code) closes it. A refresh
  that fails for another reason is tried again the next minute. The account
  serves until its access token expires.
- **Only Claude Code.** A subscription serves only requests from Claude
  Code (a `claude-cli/…` user agent) to the Messages endpoints, forwarded
  unchanged; never another tool's, nor a translated request. It presents
  its token as a bearer token, with the `oauth-2025-04-20` beta flag added
  to the caller's `anthropic-beta`.
- **Only a caller that runs Claude Code.** A user agent is the caller's
  word, so it counts only for a caller that runs that agent tool
  (pen-testing G1-5): an Agent's key, for its own AI Provider's agent tool
  (FR-16), as AI Office knows it at that call (Claude and
  Anthropic-compatible run Claude Code); never the Communications Agent's
  key, which runs none; an Owner tool's key, as it says. So a Grok
  Agent's sandbox sending `claude-cli/…` is served by no subscription. The
  same holds for every subscription's agent tool, Codex and opencode too.
- **API.** `POST /api/ai-accounts/oauth` with `{"name","aiProvider":
  "Claude","acceptedTerms":true}` (or `POST /api/ai-accounts/:id/
  reauthenticate`) answers `{"loginId","authorizeUrl","expiresAt"}`;
  `POST /api/ai-accounts/oauth/:loginId` with `{"code"}` adds the account
  (`201`) or signs it in again (`200`). Accounts carry `tokenHealth`,
  `tokenExpiresAt` and `reauthenticationNeeded`; every account carries
  `limitReason`, `limitedUntil`, its `usage` windows and its two pause
  thresholds.
- **Notice actions on a page.** A Notice's action may name a page of AI
  Office (`href`); the Notice Board links there, and the action's handler
  only checks it was done.

#### Grok (xAI) accounts

Grok's accounts (PRD FR-35) speak OpenAI's formats to `https://api.x.ai/v1`
(or a custom endpoint), with the key or token as a bearer token. Chat
Completions and Responses pass through unchanged, and Claude Code's
Messages are translated to Chat Completions.

- **xAI API key.** Added like an Anthropic key (`"aiProvider":"Grok"`).
  It serves any caller.
- **Grok subscription.** It signs in as xAI's Grok CLI does, with the
  device login: **Sign in to xAI** shows a code and a link to xAI's page.
  The Owner approves the code there, then **Finish signing in**.
  - `POST /api/ai-accounts/oauth/:loginId` with `{}` answers `409
    oauth_login_pending` until the code is approved.
  - AI Office signs in as the Grok CLI's public client (`xaiOAuth` in
    `packages/gateway/src/accounts/oauth.ts`). xAI does not document it,
    so it may change.
- **Importing a Grok CLI login.** Choose **Import an existing Grok CLI
  login** and paste the contents of `~/.grok/auth.json` (`POST
  /api/ai-accounts/import` with `{"name","aiProvider":"Grok",
  "acceptedTerms":true,"login"}`).
  - The first object in it with an access and a refresh token is taken.
    Its expiry is read from the file, or from the token's own `exp`, and
    is otherwise taken as now, so it is refreshed at once.
  - Nothing else in the file is kept.
  - Once AI Office refreshes the tokens, the CLI's own copy stops working
    (xAI rotates refresh tokens).
- A Grok subscription is kept, refreshed and shown like a Claude one
  (token health, re-authentication). Like a Claude one, it serves only its
  AI Provider's agent tool: **opencode** (PRD FR-16), whose Chat
  Completions or Responses requests (`opencode/…` user agent) reach it
  unchanged; never another tool's, nor a translated request (FR-35). The
  Owner accepts a warning saying so before adding one.
- Rate limits are read from xAI's `x-ratelimit-*` headers (see
  [Rate limits](#rate-limits-retries-and-the-circuit-breaker)).

#### Gemini accounts

A **Gemini API key** (from Google AI Studio) serves the Gemini AI Provider
through Google's OpenAI-compatible API (PRD FR-35):
`https://generativelanguage.googleapis.com/v1beta/openai`, or a custom
endpoint in place of the host, with the key as a bearer token. Add it like
any key (`"aiProvider":"Gemini"`).

- Chat Completions pass through unchanged, and Claude Code's Messages are
  translated to Chat Completions.
- That API has no Responses endpoint, so Responses requests (Codex's) are
  never sent to a Gemini account: with no other account for the Model, they
  are a `503`.
- Google's `429 RESOURCE_EXHAUSTED` holds the account back for its
  `RetryInfo` delay, and `503 UNAVAILABLE` ("overloaded") for 30 seconds
  (see [Rate limits](#rate-limits-retries-and-the-circuit-breaker)).
- Recorder mode saves each request with the path as sent to Google
  (`/v1beta/openai/chat/completions`).

#### OpenRouter, DeepSeek, Z.ai, MiniMax and Kimi accounts

Each of these is an API key for an AI Provider of the same name (PRD
FR-35), added like any key (`"aiProvider":"OpenRouter"`, `"DeepSeek"`,
`"Z.ai"`, `"Minimax"` or `"Kimi"`), with an optional custom endpoint in
place of the host. Each speaks OpenAI's formats to its own API, with the
key as a bearer token:

| AI Provider | API | Responses | Its Models |
| --- | --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | yes | every vendor's, as `vendor/model` (`anthropic/claude-sonnet-4.5`, `openrouter/auto`); and Jev, for the Decision Model |
| DeepSeek | `https://api.deepseek.com` (no `/v1`) | yes | `deepseek-*` |
| Z.ai | `https://api.z.ai/api/paas/v4` (pay-as-you-go, not the GLM Coding Plan) | no | `glm-*` |
| Minimax | `https://api.minimax.io/v1` | yes | `MiniMax-*` |
| Kimi | `https://api.moonshot.ai/v1` (Moonshot AI) | yes | `kimi-*`, `moonshot-*` |

- Chat Completions (and, where the table says so, Responses) pass through
  unchanged, and Claude Code's Messages are translated to Chat
  Completions. None counts tokens, so `count_tokens` is never sent to one;
  nor is a Responses request to Z.ai.
- **Their AI Providers** run opencode in sandboxes (PRD FR-16), like Grok
  and Gemini, and take no effort level. Each needs a default Model from the
  catalogue before an Agent can use it (see
  [AI Providers](#ai-providers-and-the-model-catalogue)).
- **Usage.** Cached prompt tokens are read from
  `prompt_tokens_details.cached_tokens`, and the tokens OpenRouter and
  Kimi say were written to the cache (`cache_write_tokens`) are counted as
  cache writes, apart from the rest of the input.
- **Limits.** A `429` holds the account back for its `retry-after`, or 60
  seconds; an overload (DeepSeek's `503`, Kimi's `engine_overloaded_error`,
  Z.ai's code `1305`) for its `retry-after`, or 30 seconds. A `402` (no
  credit left) is a failure: the request goes on to another account (see
  [Rate limits](#rate-limits-retries-and-the-circuit-breaker)).
- **Prices.** OpenRouter's come from its published Models list; the
  others' are in the pricing table (see
  [Model prices](#model-prices-and-estimated-costs)).
- Recorder mode saves each request with the path as sent to the AI Provider
  (`/api/v1/chat/completions`, `/chat/completions`, …).

#### Qwen sign-ins

A **Qwen sign-in** is Qwen Code's free tier, for the Qwen AI Provider (PRD
FR-35). It is added in **Add an AI Account** like a Grok subscription,
after a warning about its terms: AI Office asks Qwen for a device login
(`https://chat.qwen.ai/api/v1/oauth2/device/code`) as Qwen Code does, with
its public client and a PKCE challenge; the Owner opens Qwen's page and
approves the code it shows, then presses **Finish signing in**, which
proves the login with the PKCE verifier (`POST /api/ai-accounts/oauth`
with `"aiProvider":"Qwen"`, then `POST /api/ai-accounts/oauth/:loginId`).

- **Where it is reached.** Each answer of Qwen's token endpoint names the
  host its API is at (`resource_url`, such as `portal.qwen.ai`). The
  account is reached there, at `/v1`, and follows it when a refresh names
  another. It is shown as the account's endpoint.
- **What it serves.** Only opencode's Chat Completions, passed through
  unchanged with the access token as a bearer token: never Claude Code's
  Messages, another tool's requests or translated ones (PRD FR-35, §11).
  The Qwen AI Provider runs opencode in sandboxes.
- **Tokens** are sealed, refreshed ahead of expiry, never shown, and kept
  out of sandboxes, as every subscription's are.
- **Its Models.** Qwen's sign-in lists none, so the catalogue holds the
  ones Qwen Code names: `coder-model`, `vision-model`, `qwen3-coder-plus`
  and `qwen3-coder-flash`. It is free, so none has a price.
- **Limits.** Its free quota running out (`429 insufficient_quota`) holds
  the account back for 60 seconds, as Qwen says nothing of when it comes
  back.

#### Ollama and Ollama Cloud accounts

Both serve the Ollama AI Provider (PRD FR-35), through Ollama's
OpenAI-compatible API at `/v1`, with Chat Completions passed through and
Claude Code's Messages translated to them (Ollama counts no tokens and
serves no Responses here). Ollama names Models `model:tag`
(`qwen3-coder:30b`, `gpt-oss:120b`), and the AI Provider runs opencode in
sandboxes.

- **The Owner's own server** is an endpoint
  (`{"aiProvider":"Ollama","accountType":"endpoint","endpointUrl"}`) and is
  sent **no key**. Its URL is `http://localhost:11434` unless given another;
  from the `docker compose` stack, Ollama on the host is
  `http://host.docker.internal:11434`. Either is an
  [internal address](#internal-addresses), so `ALLOWED_INTERNAL_HOSTS`
  names its host (`localhost`, or `host.docker.internal`) or it is
  refused. A key may be given, for a server
  behind a proxy that asks for one. A Model it has not pulled is a `404`
  (the request's fault, sent back as it is); a runner that dies is a `500`,
  a failure.
- **Ollama Cloud** is an API key (`"accountType":"api_key"`) for
  `https://ollama.com/v1`, sent as a bearer token. Its usage limits are a
  `429`, which holds the account back for 60 seconds.
- **Prices.** Neither has one: the Owner's own server costs nothing per
  token, and Ollama Cloud is paid for by plan.

#### Anthropic- and OpenAI-compatible endpoints

An **Anthropic-compatible** or **OpenAI-compatible endpoint** is any API in
that format at a URL the Owner gives (PRD FR-35): a LiteLLM or vLLM server,
LM Studio, llama.cpp, Groq, or an AI Provider's own compatible API. Each is
its own AI Provider. It is added as an endpoint
(`{"aiProvider":"Anthropic-compatible" | "OpenAI-compatible","accountType":"endpoint","endpointUrl","credential"}`),
its URL required and its key optional:

| AI Provider | Its URL | Requests go to | Key | Agent tool |
| --- | --- | --- | --- | --- |
| Anthropic-compatible | as `ANTHROPIC_BASE_URL` is given (`https://llm.example.com/anthropic`) | the URL, then `/v1/messages` | as `x-api-key` and as a bearer token | Claude Code |
| OpenAI-compatible | as `OPENAI_BASE_URL` is given, `/v1` included (`http://gpu-box.lan:8000/v1`) | the URL, then `/chat/completions` or `/responses` | as a bearer token | opencode |

- **Any Model.** Only its owner knows what it serves, so it is sent any
  Model asked of it, whoever's it is by name, and may be forced any Model
  or given any in a Combo's slot. A Model no AI Provider claims by name
  goes to it before any other account; a Model of a known AI Provider goes
  to that AI Provider's accounts and the endpoints in priority order, so
  give an endpoint a worse priority than accounts that should serve
  first.
- **Formats.** Requests in its own format pass through; the other format's
  are translated (opencode's Chat Completions to an Anthropic-compatible
  endpoint's Messages, Claude Code's Messages to an OpenAI-compatible
  endpoint's Chat Completions). Neither is sent `count_tokens`.
- **Its Models.** Each endpoint's own list (`/v1/models`, or `/models`
  after an OpenAI-compatible endpoint's URL) is fetched, and the
  catalogue lists the Models of every endpoint of that kind together.
  vLLM's `max_model_len` is read as a context window. None has a price.
- **A key, or none.** Without one, it is sent no credential at all.
- Recorder mode and the request history keep the path as sent, the
  endpoint's own path included (`/openai/v1/chat/completions`).

#### AWS Bedrock and Google Vertex AI accounts

An **AWS Bedrock** or a **Google Vertex AI** account serves Claude Models
through that cloud platform, in a region, signed with the platform's own
credentials rather than an Anthropic key (PRD FR-35). Each serves Claude
Code's Messages and, translated to Messages, Chat Completions and Codex's
Responses, like an Anthropic Console API key. Their region (and Vertex
AI's project) is shown with the account; their credentials never are.

- **AWS Bedrock** (Claude in Amazon Bedrock) serves the Messages API itself,
  at `https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages` (or a
  custom endpoint in place of the host). Each request goes unchanged, but
  for the Model, and is signed with AWS Signature Version 4 for
  `bedrock-mantle` in the account's region
  (`packages/gateway/src/cloud/aws-sigv4.ts`). The IAM identity needs
  `bedrock-mantle:CreateInference` on the Models it uses.
  - **Credentials:** an **IAM access key** (an access key ID and a secret
    access key, with a session token for temporary ones, which stop
    working when they expire), or the name of a **profile** in the
    server's AWS files (`AWS_SHARED_CREDENTIALS_FILE` and
    `AWS_CONFIG_FILE`, or `~/.aws/credentials` and `~/.aws/config`). A
    profile is read each time a request is signed, so a rotated key is used
    at once; only its `aws_access_key_id`, `aws_secret_access_key` and
    `aws_session_token` are read, not single sign-on, roles or a credential
    process. A profile that gives no key is refused when the account is
    added (`400 cloud_credentials_unusable`). With docker compose, mount
    the AWS files into the server's container read-only.
  - **Models** are named as Bedrock names them: a Claude Model asked for is
    sent with Bedrock's `anthropic.` prefix and without a snapshot date
    (`claude-opus-5-5` → `anthropic.claude-opus-5-5`). A name Bedrock
    already uses, such as an inference profile
    (`us.anthropic.claude-opus-5-5`), is sent as it is, so a model mapping
    for AWS Bedrock accounts or a forced Model can choose one.
  - It counts no tokens: `/v1/messages/count_tokens` never goes to it.
- **Google Vertex AI** names the Model in the path:
  `…/v1/projects/<project>/locations/<region>/publishers/anthropic/models/<model>:rawPredict`,
  `:streamRawPredict` for a stream, and `count-tokens:rawPredict` to count
  tokens, at `https://aiplatform.googleapis.com` for the `global` region
  (Google's recommendation), `https://aiplatform.<us|eu>.rep.googleapis.com`
  for a multi-region, or `https://<region>-aiplatform.googleapis.com`. The
  body is Anthropic's, with `anthropic_version: vertex-2023-10-16` in place
  of the Model. Answers, streams included, are Anthropic's.
  - **Credentials:** a **service account's key** (the JSON file Google
    Cloud gives; the service account needs the Vertex AI User role). Its
    project is the account's unless the Owner gives another. Each request
    carries an access token the service account signs in for at Google's
    token endpoint (a JWT signed with its private key, exchanged for an
    hour's token; `packages/gateway/src/cloud/google-auth.ts`). Tokens are
    kept in memory only, shared by requests that arrive together, and
    renewed five minutes before they expire. While Google refuses the key,
    the account counts as failing (towards its circuit breaker) and the
    caller gets a `502` when no other account serves.
  - **Models** keep their names (`claude-opus-5-5`); a snapshot date goes
    after `@` (`claude-haiku-4-5-20251001` → `claude-haiku-4-5@20251001`).
- **Limits.** AWS's `429 ThrottlingException` and Vertex AI's `429
  RESOURCE_EXHAUSTED` hold the account back as rate-limited; `529
  overloaded_error` as overloaded (see
  [Rate limits](#rate-limits-retries-and-the-circuit-breaker)). Error
  bodies reach the caller as the platform wrote them.
- **Not yet for these accounts:** the model catalogue (neither platform
  lists its Models through the API AI Office calls, so the AI Providers
  card's catalogue comes from other Claude accounts), prompt-cache
  keep-alive and auto-refresh, which they report nothing for. Estimated
  costs use the pricing table by the Model's name: a Bedrock name
  (`anthropic.claude-…`) needs a price of the Owner's, and neither
  platform's own prices (such as a regional endpoint's premium) are known.
- **API.** `POST /api/ai-accounts` with `{"name","aiProvider":"Claude",
  "accountType":"bedrock","region":"us-east-1","awsCredentials":
  {"accessKeyId","secretAccessKey","sessionToken"} | {"profile"},
  "endpointUrl"}`, or `{"name","aiProvider":"Claude","accountType":"vertex",
  "region":"global","projectId","serviceAccount":"<the key file's text>",
  "endpointUrl"}`.
- Recorder mode saves each request with the path and body as sent to the
  platform, never its signature or token.

#### ChatGPT subscriptions

A **ChatGPT subscription** (Plus, Pro or Business) serves the ChatGPT AI
Provider through ChatGPT's own Codex backend, as Codex signed in with
ChatGPT does (PRD FR-35, FR-36): `https://chatgpt.com/backend-api/codex`.

- **Terms first.** Choosing it shows a warning: OpenAI's terms allow a
  ChatGPT subscription for coding only through Codex. The Owner ticks that
  they have read it (`acceptedTerms`).
- **Signing in (OAuth with PKCE).** **Sign in to OpenAI** links to OpenAI's
  sign-in page. AI Office signs in as Codex's public OAuth client
  (`openaiOAuth` in `packages/gateway/src/accounts/oauth.ts`), so the
  sign-in ends on Codex's local callback,
  `http://localhost:1455/auth/callback`, the only address OpenAI allows
  for that client. AI Office takes the code from it, checks its state, and
  exchanges it with the login's PKCE verifier. OpenAI does not document
  this client for other tools, so it may change.
- **Finished by itself on this machine.** While a ChatGPT sign-in waits,
  AI Office listens on that port itself
  (`apps/server/src/ai-accounts/oauth-callback.ts`; `OAUTH_CALLBACK_HOST`,
  127.0.0.1 by default, which compose sets to 0.0.0.0 and publishes to the
  host's `127.0.0.1:1455`). When the browser is on the same machine, the
  page it lands on says it is signed in, and the AI Accounts card, asking
  `GET /api/ai-accounts/oauth/:loginId` every 2 s (`{"status":"pending"}`
  or `{"status":"done","account","added"}`), shows the account added. The
  port is held only while a sign-in waits, so the Codex CLI's own sign-in
  can use it otherwise; if it is busy, AI Office logs so and leaves it.
- **Pasted back otherwise.** When AI Office runs elsewhere (on EC2, say),
  the page on `localhost:1455` does not load: the Owner pastes its whole
  address back.
- **Tokens.** Kept, refreshed and shown like a Claude subscription's: both
  sealed for the account's row, the expiry read from the access token when
  OpenAI's answer does not give it, token health live, refreshed ahead of
  expiry (OpenAI rotates refresh tokens), and the "Re-authentication
  needed" Notice when OpenAI refuses a refresh.
- **Only Codex, natively.** It serves only Codex's Responses requests
  (`POST /v1/responses` and `/v1/responses/compact` with a `codex_…/`
  user agent, such as `codex_cli_rs/…` or `codex exec`'s `codex_exec/…`),
  forwarded unchanged to the Codex backend with its token as a bearer token
  and the ChatGPT account it is for (`chatgpt-account-id`, from the token).
  Chat Completions, Messages and any other tool's requests never reach it
  (FR-35).
- **Usage limits.** Its `429 usage_limit_reached` holds the account back
  until the plan's window resets (`resets_in_seconds`, or `resets_at`).
- **Usage windows.** Each answer's `x-codex-primary-*` and
  `x-codex-secondary-*` headers give its five-hour and weekly windows,
  stored, shown, charted and paused at like a Claude subscription's (see
  [Usage windows](#usage-windows-pause-thresholds-and-force-reset)). Unlike
  Claude's, they cannot be read before a request has gone through it.
- **API.** As for Claude: `POST /api/ai-accounts/oauth` with
  `{"name","aiProvider":"ChatGPT","acceptedTerms":true}`, then `POST
  /api/ai-accounts/oauth/:loginId` with `{"code":"<the address>"}`.

#### Calls outside a sandbox, through the agent tool

The Manager chat (where it is not a
[read-only session](events-and-chat.md#a-read-only-session-as-claude-code-is)),
reviewers, triage, Fresh Start summaries, the Terminal and the other calls
AI Office makes outside a sandbox (ADR 0001) go to the
Gateway as Messages requests with the Agent's (or the Terminal's) Gateway
Key. A subscription serves only its agent tool's requests (above), so when
the Owner's only AI Accounts for the Model's AI Provider are Claude or
ChatGPT subscriptions, the Gateway answers `503`. The call is then made by
the agent tool itself (`withAgentToolFallback`, `agentToolModelClient` in
`packages/orchestrator/src/models/agent-tool-client.ts`): Claude Code
(`claude --print --output-format stream-json`, no tools, one turn, the
system prompt as `--system-prompt`) or Codex (`codex exec --json`, with the
Gateway as its model provider), run once with `docker run --rm` in its
sandbox image on a Docker network of its own that the sandbox relay
joins, as a sandbox is (see
[Sandboxes](issue-pipeline.md#sandboxes)),
reaching the Gateway at `SANDBOX_GATEWAY_URL` with the same Gateway Key,
given in the environment, never on the command line. Its request is Claude
Code's or Codex's own, so the subscription serves it, attributed and
capped as any. Claude Code's answer streams as it is written; Codex's
arrives whole. Only a `503` before any of the answer falls back, and only
for Models Claude Code or Codex call; without `SANDBOX_GATEWAY_URL` there
is no fallback.

### The outbound proxy

AI Settings' **Outbound proxy** card sets an optional HTTP proxy (PRD
FR-35). While one is set, everything the AI Gateway sends upstream goes
through it: requests through AI Accounts, model lists, published prices,
subscriptions' sign-ins, token refreshes and usage, auto-refreshes and
keep-alives. Requests from sandboxes to the Gateway, and AI Office's own
GitHub requests, do not.

- **Its address** is an `http://` or `https://` URL with a host and port,
  such as `http://proxy.corp:3128`. Requests to `https://` AI Providers go
  through it as `CONNECT` tunnels; requests to `http://` ones, as plain
  proxied requests. A proxy on the Owner's own network is an
  [internal address](#internal-addresses), so `ALLOWED_INTERNAL_HOSTS`
  names it. Through it, a host asked for is checked by its form (an
  internal address or name is refused); the proxy resolves names in its
  own network.
- **Its username and password**, when it asks for them, go to it as
  `proxy-authorization` (Basic) and to no AI Provider. The password is
  sealed with `ENCRYPTION_KEY` in `office_settings`, registered with the
  redactor once opened, and never shown again: the card says only that one
  is stored. Left empty, it stays as it is while the username stays the
  same; it can be removed.
- **Reached directly.** The AI Office host itself (`localhost`,
  `127.0.0.1`, `::1`), such as the Owner's own Ollama, and every host the
  Owner lists (a name with its subdomains, a `.domain`, an address, or `*`
  for every host).
- **No redirects.** Nothing the AI Gateway sends upstream, through the
  proxy or not, follows a redirect: an AI Account's credential, a token or
  a prompt goes only where it was sent (pen-testing G1-7). A model list,
  usage or token refresh answered with one fails, as an error does.
- **At once.** A change applies from the next request, without a restart.
  Each is a `config.changed` event naming what changed
  (`outboundProxy.url`, `.username`, `.password`, `.noProxy`), never the
  values.
- **API.** `GET /api/office/outbound-proxy` answers
  `{"url","username","hasPassword","noProxy"}`; `PUT` takes
  `{"url","username","password","noProxy"}`, where a null `url` turns it
  off, an absent `password` keeps the stored one and a null one removes it.

### Internal addresses

Every address the Owner gives AI Office to reach is checked before it is
reached, and each connection as it is made
([ADR 0007](../architectural-decision-record/0007-owner-given-addresses-never-reach-internal-hosts.md),
pen-test findings I1-1 to I1-3): an AI Account's endpoint URL (and a
Vertex AI key's `token_uri`), the outbound proxy, a Connection's webhook,
Slack incoming webhook, ntfy server, Confluence site or SMTP server
([Connections](notices-and-skills.md)), and the Git repository a Skill
or Floor Template is imported from.

- **Refused:** a loopback, link-local (the cloud metadata service at
  `169.254.169.254`), private or other non-public address, IPv4 or IPv6;
  `localhost`; a name of one label, such as the stack's own `app` and
  `postgres`; a name under a private suffix (`.internal`, `.local`,
  `.lan`, `.home.arpa`, `.corp` and the like); and a public name that
  resolves to any of those addresses, checked as each connection is made,
  a redirect's included. Plain `http://` is refused too, except to the
  outbound proxy.
- **Unless the Owner allows the host** in `ALLOWED_INTERNAL_HOSTS`, in the
  environment: comma-separated names (`ollama.lan`, which also covers its
  subdomains), domains (`.lan`) or IP addresses, without ports. An allowed
  host is reached whatever it resolves to, over `http://` too. It is set
  in the environment, not in General Settings, so a stolen session cannot widen it;
  it takes effect at the next start.
- **Where it shows.** The forms refuse such an address, naming
  `ALLOWED_INTERNAL_HOSTS` (the web app learns the hosts with its
  session, `GET /api/session`'s `allowedInternalHosts`); the API answers
  `400` with the same. An AI Account stored before is not served: the
  Gateway answers as for an account it cannot reach. A Connection's
  delivery to one fails, saying why; an import fails before Git runs.

### The Decision Model

AI Settings' **Decision Model** card, beside the AI Providers, turns Jev,
TypeSafe's fast decision model, on or off (PRD FR-17). It is off until the
Owner turns it on. While it is on, each Floor's Manager and AI Office's
safety checks ask it for their quick judgements, through
[Jev's endpoint](#jevs-decisions) with the Manager's own Gateway Key, so
each call is the Manager's in Gateway requests and Analytics and counts
against its Token Caps:

- **Is this issue clear enough to work?** In the Manager's
  [triage](issue-pipeline.md#triage), in place of the Manager's Model.
- **Is this Review Loop stalled or repeating?** In the
  [Review Loop](issue-pipeline.md#the-review-loop), in place of AI
  Office's stall rules.
- **Is this tool call safe?** Each tool call an Agent makes in its
  sandbox is [screened](issue-pipeline.md#sandboxes), before it runs where
  its agent tool asks (Claude Code), with Jev shown the whole call. AI
  Office's own rules judge every call too, so with the Decision Model off,
  or Jev unable to answer, no call is let be unjudged (P1-8).

Everything Jev reads is redacted first. When Jev cannot be asked (the
Floor has no Manager, there is no OpenRouter account, the Gateway refuses
the call, say at the Manager's Token Cap, or the answer is not one), each
judgement is made as it is while the Decision Model is off, and the server
logs why.

**The screen's route.** `POST /v1/ai-office/tool-calls` on the Gateway is
where a sandbox's Claude Code asks about a call before it runs: only an
Agent's own Gateway Key reaches it (an Owner tool's is a `403`), with the
session its `x-ai-office-session` header names, and it is not a model
call, so it is in no Gateway request's record. It answers Claude Code's
hook: nothing, or a denial saying why.

- **Its Model** is Jev, as OpenRouter names it: `typesafe/jev-1.13` by
  default, or `~typesafe/jev-latest`. Nothing else is taken, and Jev is
  never an Agent's AI Provider or Model, nor an AI Provider's default
  (`400`).
- **Summaries** (FR-89): a second switch, off by default, has the
  Decision Model write Fresh Start and Manager chat compaction summaries
  in place of each Agent's own Model, while it is on
  (`DecisionModel.summaryWriter` says which writes them).
- **At once.** A change applies from the next judgement, and is a
  `config.changed` event naming what changed (`decisionModel.enabled`,
  `.model`, `.summaries`).
- **API.** `GET /api/office/decision-model` answers
  `{"enabled","model","summaries"}`, and `PUT` takes the same. They live
  in `office_settings`.

### AI Providers and the model catalogue

AI Settings' **AI Providers** card lists Claude, ChatGPT, Grok, Gemini,
OpenRouter, DeepSeek, Z.ai, Minimax, Kimi, Qwen, Ollama,
Anthropic-compatible and OpenAI-compatible (PRD FR-15). Each shows the agent tool it runs in sandboxes (Claude Code, Codex,
opencode) and its **default Model**, which every Agent of that AI Provider
uses unless it chooses its own.

- **The model catalogue** (FR-41) is each kind of AI Account's Model list,
  fetched from its AI Provider's models endpoint with one of its accounts:
  the first unpaused one, and a subscription only while its token is
  valid. The lists come from:
  - Anthropic's `/v1/models`, a page at a time;
  - xAI's and Google's `/models` (Google's ids without `models/`);
  - ChatGPT's Codex backend's `/models`, asked as Codex `0.999.0`: it
    lists only the Models the Codex version it is told can use, and the
    sandboxes run the latest Codex;
  - OpenRouter's, DeepSeek's, Minimax's and Kimi's `/models`, with each
    Model's name to show and context window where they say (Minimax's
    says none);
  - for Z.ai, whose API lists none, the Models Z.ai documents, kept in
    the code with their context windows: GLM-5.3, 5.2, 5.3-FlashX,
    5.3-Flash, 5.1, 5, 4.7 and 4.6. Like a list, they are in the
    catalogue only while the Owner has an unpaused Z.ai account;
  - for a Qwen sign-in, likewise, the Models Qwen Code names;
  - the Owner's own Ollama's and Ollama Cloud's `/v1/models`;
  - every unpaused compatible endpoint's own list, the Models of all the
    endpoints of a kind listed together (one that cannot be reached
    leaves the others').

  It is fetched when the server starts, once a day, as soon as an AI
  Account is added, imported or signed in again (so its Models are listed
  at once), and on demand
  (**Refresh the model catalogue**, `POST /api/model-catalogue/refresh`,
  which answers what each kind listed and which could not be fetched, and
  then, as the daily refresh does, gives AI Providers with an account but
  no default Model the first their catalogue lists). A list that cannot be
  fetched keeps the last one; why it failed is kept until it is fetched
  again, and the AI Providers card shows it for an AI Provider the Owner
  has an AI Account for (`hasAccount` and `catalogueError` in `GET
  /api/ai-providers`), in place of "add an AI Account". The catalogue lives in
  `model_catalogue`, with each Model's display name and context window when
  its AI Provider says.
- **Default Models** are chosen from the catalogue, or typed in when it
  does not list them (a subscription whose list cannot be fetched, or a
  Model just released): `PUT /api/ai-providers/:aiProvider` with
  `{"defaultModel"}`. A Model the catalogue lists only for another AI
  Provider is `400 model_not_in_catalogue`. Each
  change is a `config.changed` event (`aiProviders.<AI Provider>.defaultModel`).
  Defaults live in `ai_provider_settings`. Claude's is `claude-opus-5-5`
  until the Owner chooses, so a new Floor's team works from the start. The
  others have none until the Owner adds an AI Account for them: then,
  once the catalogue lists its Models, an AI Provider with no default gets
  the first its catalogue lists (`chooseMissingDefaults`, after each
  refresh), and the Owner may choose another.
- **An AI Provider without a default Model cannot be used.** No Agent is
  added on it, even one with a Model of its own, until it has one
  (`model_required`). The Agent editor lists it as "(no default Model
  yet)", disabled, and says where to choose one.
- `GET /api/ai-providers` lists each AI Provider with its agent tool,
  default Model, its Models in the catalogue (those its kinds of AI Account
  list, less any the Gateway would send to another AI Provider; a
  compatible endpoint keeps every one it lists) and when they were
  fetched.
