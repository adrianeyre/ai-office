# Groundwork for #45: `pnpm --filter @ai-office/gateway record` — verification

#45 ("Record provider responses for the contract tests") is an
owner-action issue. Its step 1 names a command, `pnpm --filter gateway
record`, which did not exist. This run builds that command. The recording
itself needs the Owner's real AI Accounts, so it stays the Owner's job, on
the host.

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no AI Account). `pnpm lint`, `pnpm typecheck` and `pnpm test` ran
in a fresh `git clone` of this branch at `cf96d4f` (the code and docs
commits), after `pnpm install --frozen-lockfile`. After that, the only
change was a sentence in `packages/gateway/fixtures/README.md`; no code
changed.

## What was built

### The script (`packages/gateway/src/record/`)

- **`pnpm --filter @ai-office/gateway record`** (`"record": "node
  src/record/main.ts"`). #45's `pnpm --filter gateway record` runs the
  same script, because pnpm matches a package name without its scope. It
  takes one or more `--target <AI Provider>:<Model>`, for example
  `--target Claude:claude-haiku-5-5 --target Grok:grok-4`. For each
  target it sends the scripted scenarios through a running AI Gateway,
  one at a time, so the server's recorder mode (`GATEWAY_FIXTURES_DIR`)
  writes one fixture per exchange.
- **Inputs.** Each input can come from an environment variable or a flag:
  - the Gateway's URL: `AI_OFFICE_GATEWAY_URL` or `--url`; the default is
    `http://localhost:3047`, the Gateway's default port;
  - an Owner tool's Gateway Key: `AI_OFFICE_GATEWAY_KEY` or `--key`.
    `AI_OFFICE_GATEWAY_KEY` is the variable sandboxes already give Codex
    for its Gateway Key. The usage text recommends the variable, because
    a flag shows in `ps`;
  - the fixtures directory: `GATEWAY_FIXTURES_DIR` or `--fixtures-dir`.
    This is the same variable the server reads. A relative path is
    resolved from where pnpm was run (`INIT_CWD`);
  - `--account <AI Provider>:<AI Account>` and `--scenario <id>`.

  The script checks each target before it sends anything. A Model the
  Gateway would route to another AI Provider is refused (`aiProviderTakes`
  from `@ai-office/shared`), as is an unknown AI Provider or scenario. The
  script then exits `2`.
- **Routing: no new path.** Each request is an ordinary Owner tool
  request. It goes to `/v1/messages` when the AI Provider's accounts
  speak Anthropic, and to `/v1/chat/completions` when they speak OpenAI.
  The format comes from `aiAccountKinds`, so the request reaches the AI
  Provider untranslated. It authenticates with `Authorization: Bearer
  <Gateway Key>`. The Gateway then routes it as it routes any Owner
  tool's request:
  - by Model, to that AI Provider's accounts;
  - with `x-ai-office-session: fixture-recording-<run>-<n>`, so the
    session strategy keeps one target's scenarios on one account;
  - with `x-ai-office-account: <name>` when `--account` forces an
    account. This is the existing forced-account routing, which only an
    Owner tool's key may use.
- **Scenarios** (`scenarios.ts`). Each one is sent in Anthropic's or
  OpenAI's format, as the target needs:
  - a plain message (not streamed, at most 64 tokens);
  - a streamed message (with `stream_options.include_usage` for Chat
    Completions);
  - a tool call (`get_weather`: forced for Anthropic, `auto` for Chat
    Completions);
  - an image (a 16 × 16 PNG made in the script with `node:zlib`).

  Each prompt carries a marker (`AI Office fixture recording
  <run>-<n>-<scenario>`). After each answer, the script waits up to 5 s
  for a new file in the fixtures directory that holds that marker. Other
  traffic writing fixtures at the same time therefore does not confuse
  it.
- **Skipped scenarios, with the reason.**
  - *Rate limit.* No AI Provider gives a 429 on request. Provoking one
    means spending a limit's worth of tokens or flooding the API. A 429
    met in normal use is recorded only when its account was forced,
    because otherwise the Gateway answers from another account.
  - *Token refresh.* The Gateway refreshes OAuth tokens itself, at the
    provider's sign-in server rather than through its endpoints, so no
    fixture is ever written for it. It happens once a token is due within
    15 minutes.
- **Subscriptions are not impersonated.** A subscription serves only its
  own agent tool (PRD FR-35, `servesOnly`), and the Gateway identifies the
  tool by its user agent. The script sends `user-agent:
  ai-office-record/1`, so its requests reach the AI Provider's other AI
  Accounts. For an AI Provider that has only subscriptions (ChatGPT,
  Qwen), the script skips every scenario and says how to record them
  instead: run the agent tool itself through the Gateway. The README
  gives the commands for Claude Code and Codex.
- **Summary.** There is one row per scenario, showing:
  - its status: `recorded`, `failed` or `skipped`;
  - the Gateway's HTTP status;
  - the fixture file it produced;
  - for a skip, a numbered note, with each reason given once below the
    rows.

  A failed row says why. Either the Gateway refused the request itself
  (its message is quoted, and such refusals are never recorded), or no
  fixture appeared (is the server running with that
  `GATEWAY_FIXTURES_DIR`?). The script flags a tool call answered without
  one. It also flags a fixture that still holds anything shaped like a
  credential, or the Gateway Key, with "do not commit it". The summary
  ends by telling the Owner to check every file by eye before
  committing. The exit code is `1` if any scenario failed.
- **The Gateway Key is never printed.** Everything the script shows goes
  through `createRedactor` with the key registered, including errors.
  The URL is shown without its user info.

### Docs

- `packages/gateway/fixtures/README.md`, new **Recording** section: how to
  start the server and make the key, the command, the scenario table,
  failures, recording subscriptions through their agent tools, checking
  by eye, and **"#45, step by step"**, which gives #45's three steps with
  this command (the docs note the brief asks for; the issue itself is not
  edited).
- `docs/guide/ai-gateway.md`: the recorder-mode paragraph under Gateway
  Keys now describes the command and links to the README section.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** On the
      host, after merging `main` with #176 (see below). In the sandbox, not all
      of them. `pnpm lint` and `pnpm typecheck` exit 0. `pnpm test` exits
      1 because two `apps/web` tests fail (output below). These failures
      were already there:
      - this branch does not touch `apps/web` (`git diff --stat b2bea87
        HEAD` lists only `packages/gateway/` and docs);
      - a fresh clone of `main` at `b2bea87` fails the same two tests
        (output below).

      A third test, `src/scene/meeting-room.test.tsx`, failed in three of
      seven runs, on `main` and on this branch alike. It looks flaky.

      I left all three alone. They are outside this issue, and the brief
      forbids reaching green by changing tests (see "Outside this
      issue"). Every other project passes. The gateway project passes
      58 of 58 files (597 tests, 97 skipped for want of Docker), including
      the new one.
- [x] **A test runs the script against a real Gateway with recorder mode
      on and a fake AI Provider, and checks one fixture is written per
      scenario, with credentials redacted.**
      `packages/gateway/src/record/record.test.ts` starts the script as
      its own process (`node src/record/main.ts`, which is what `pnpm …
      record` runs). The process gets only `PATH`, `AI_OFFICE_GATEWAY_URL`,
      `AI_OFFICE_GATEWAY_KEY` and `GATEWAY_FIXTURES_DIR`. It runs against
      a real Gateway (`buildGateway`) set up as the server sets it up:
      - recorder mode is on (`directoryFixtureRecorder`), using a redactor
        that every AI Account credential is registered with as it is
        opened (`onCredential`), as in `apps/server/src/server.ts`;
      - it serves from real AI Accounts (`createAiAccounts`): a Claude
        API key and a Grok API key, each at its own fake AI Provider.

      The fake AI Providers echo back the key they were sent, in a header
      and in their answer, so there is something to redact. With targets
      `Claude:claude-haiku-5-5` (account forced), `Grok:grok-4` and
      `ChatGPT:gpt-5.5`, the test asserts:
      - exit 0, and nothing on stderr;
      - Claude's provider received four `/v1/messages` requests, Grok's
        four `/v1/chat/completions`, and nothing went to ChatGPT;
      - exactly 8 fixtures were written, one per scenario per target.
        Each one's summary row reads `recorded  200  <file>`, with the
        right endpoint in its name and path. The plain message is not
        streamed, the streaming one is, the tool call carries `tools`,
        and the image carries a PNG;
      - no fixture contains either AI Account key or the Gateway Key;
        the echoed header reads `[REDACTED]`; no `authorization` or
        `x-api-key` is recorded;
      - rate limit and token refresh are `skipped [1]` and `skipped [2]`,
        with their reasons; ChatGPT's scenarios are `skipped [3]`, naming
        Codex; the summary includes the subscription note, the count and
        the "check by eye" reminder;
      - the Gateway Key appears nowhere in stdout.

      Two more script tests cover the failure paths:
      - a forced AI Account that does not exist: `failed  503`, with the
        Gateway's message, no fixture, and exit 1;
      - a Model of another AI Provider: refused before any request, exit
        2.

      **Negative checks** (each made in the clone, then reverted):
      - With the recorder's redaction removed (`fixtures.ts` writing the
        fixture unredacted), the main test fails. The first assertion to
        fail is the summary's: the script's own credential check now
        names each file a second time, with "do not commit it".
      - With the image scenario removed, the main test fails (`expected
        [ Array(3) ] to deeply equal [ Array(4) ]`).

## Output

### Fresh clone (`/tmp/clone45`, `cf96d4f`)

```text
$ pnpm install --frozen-lockfile
Done in 379ms using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
pnpm lint exit 0

$ pnpm typecheck
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
pnpm typecheck exit 0

$ pnpm test
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  |@ai-office/web| src/activities-card.test.tsx > Agent activities in AI Settings > turns activities off for a Floor, and saves them
 FAIL  |@ai-office/web| src/floors.test.tsx > the Floors on the admin page > picks the Floor Template a new Floor starts from, showing each one's starting team (PRD FR-97)
 Test Files  2 failed | 368 passed (370)
      Tests  2 failed | 4101 passed | 552 skipped (4655)
   Duration  60.41s (tests 45%, import 37%, environment 10%, transform 7%, setup 1%)

$ pnpm exec vitest run --project @ai-office/gateway
 Test Files  58 passed (58)
      Tests  597 passed | 97 skipped (694)
   Duration  9.09s (import 59%, tests 32%, transform 8%)

$ pnpm exec vitest run packages/gateway/src/record --reporter=verbose
 ✓ |@ai-office/gateway| src/record/record.test.ts > pnpm --filter @ai-office/gateway record > writes one fixture per scenario for each AI Provider, with credentials redacted 998ms
 ✓ |@ai-office/gateway| src/record/record.test.ts > pnpm --filter @ai-office/gateway record > says why nothing was recorded when the Gateway answers itself 5277ms
 ✓ |@ai-office/gateway| src/record/record.test.ts > pnpm --filter @ai-office/gateway record > refuses what it cannot record, without a request 203ms
 ✓ |@ai-office/gateway| src/record/record.test.ts > recordingOf > speaks each AI Provider's own API, and none for a subscription alone 1ms
```

### The same `apps/web` tests on `main` (fresh clone at `b2bea87`)

```text
$ git log --oneline -1
b2bea87 Merge pull request #175 from adrianeyre/feat/issues-131-to-153
$ cd apps/web && pnpm exec vitest run src/activities-card.test.tsx src/floors.test.tsx src/scene/meeting-room.test.tsx
 FAIL  |@ai-office/web| src/activities-card.test.tsx > Agent activities in AI Settings > turns activities off for a Floor, and saves them
 FAIL  |@ai-office/web| src/floors.test.tsx > the Floors on the admin page > picks the Floor Template a new Floor starts from, showing each one's starting team (PRD FR-97)
 Test Files  2 failed | 1 passed (3)
      Tests  2 failed | 34 passed (36)
```

(An earlier run of the same three files on `main` failed all three; the
meeting-room one is the flaky one.)

### Negative checks (in the clone, reverted)

```text
--- recorder without redaction
     × writes one fixture per scenario for each AI Provider, with credentials redacted 668ms
AssertionError: expected [ …(3) ] to have a length of 2 but got 3
      Tests  1 failed | 3 passed (4)
--- image scenario removed
     × writes one fixture per scenario for each AI Provider, with credentials redacted 664ms
AssertionError: expected [ Array(3) ] to deeply equal [ Array(4) ]
      Tests  1 failed | 3 passed (4)
```

### What the Owner sees (the main test's run, against the fakes)

```text
Recording through the AI Gateway at http://127.0.0.1:45145; fixtures in /tmp/gateway-record-HYWGQW.

Claude · claude-haiku-5-5 (AI Account: Claude API key)
  plain message  recorded  200  2026-10-10T18-09-44-327Z-0001-messages-200.json
  streaming      recorded  200  2026-10-10T18-09-44-337Z-0002-messages-200.json
  tool call      recorded  200  2026-10-10T18-09-44-442Z-0003-messages-200.json
  image          recorded  200  2026-10-10T18-09-44-548Z-0004-messages-200.json
  rate limit     skipped  [1]
  token refresh  skipped  [2]

Grok · grok-4
  plain message  recorded  200  2026-10-10T18-09-44-556Z-0005-chat-completions-200.json
  streaming      recorded  200  2026-10-10T18-09-44-662Z-0006-chat-completions-200.json
  tool call      recorded  200  2026-10-10T18-09-44-768Z-0007-chat-completions-200.json
  image          recorded  200  2026-10-10T18-09-44-873Z-0008-chat-completions-200.json
  rate limit     skipped  [1]
  token refresh  skipped  [2]

ChatGPT · gpt-5.5
  plain message  skipped  [3]
  streaming      skipped  [3]
  tool call      skipped  [3]
  image          skipped  [3]
  rate limit     skipped  [1]
  token refresh  skipped  [2]

[1] no AI Provider gives a 429 on request: provoking one means spending a limit's worth of tokens or flooding the API. A 429 met in normal use is recorded when its AI Account was forced (--account), as the Gateway otherwise answers from another account.
[2] the AI Gateway refreshes a subscription's OAuth token itself, at the AI Provider's sign-in server and not through its endpoints, so recorder mode writes no fixture of it. It happens once the token is due within 15 minutes (AI Settings shows it as expiring); the requests after it are recorded as any others.
[3] a ChatGPT subscription serves only Codex's own requests (PRD FR-35), which this script does not make; record them by running Codex through the Gateway (packages/gateway/fixtures/README.md, "Recording").

Claude's requests above went to its AI Accounts other than subscriptions, which serve only Claude Code.
Grok's requests above went to its AI Accounts other than subscriptions, which serve only opencode.
To record a subscription, run its agent tool through the Gateway (packages/gateway/fixtures/README.md, "Recording").

8 fixtures written to /tmp/gateway-record-HYWGQW.
Before committing any, open each one and check by eye that it holds no credential: the recorder redacts every one it knows of, but only you know what yours look like.
```

## Notes for the reviewer

- **Subscriptions go through their own agent tools.** #45 asks for a
  Claude subscription and ChatGPT. PRD FR-35 says a subscription "is only
  used through the AI Provider's own agent tool", and the Gateway
  enforces that by the caller's user agent. The script could pass that
  check by sending `claude-cli/…` or `codex_exec/…` as its user agent,
  but that would defeat the guard, so it doesn't. For those accounts,
  #45's step 1 is therefore the script plus one agent-tool run per
  subscription, using the commands in the README. Running the agent
  tools from the script itself (`claude -p`, `codex exec`) is possible
  as a follow-up. I did not build it here because the sandbox has
  neither tool, so it could not be tested.
- **Tool choice for Chat Completions is `auto`**, not a named function,
  because not every OpenAI-compatible API is documented to accept a
  named one (Gemini's, for instance). The summary flags an answer with
  no tool call, so the Owner can record it again.
- **The script and the server must see the same directory.** The script
  finds fixtures by reading `GATEWAY_FIXTURES_DIR`. Under `pnpm dev` the
  server runs from `apps/server`, so the README asks for an absolute
  path. Under docker compose, the README asks for a mounted directory
  and the host's path.
- The test drives `buildGateway` with real AI Accounts and the server's
  redaction set-up, not `apps/server` itself. The server needs Postgres,
  and this sandbox has no Docker. `server.ts` passes
  `directoryFixtureRecorder(config.gateway.fixturesDir, { redactor })`
  to the same Gateway.

## Outside this issue

- **Two `apps/web` tests fail on `main`** (`b2bea87`), and so `pnpm test`
  fails on any branch from it:
  - `src/floors.test.tsx`, "picks the Floor Template a new Floor starts
    from…": each Floor's list item now has a **Remove Floor** button
    (`floors-card.tsx`), so its text is `…started from
    DevelopmentRemove Floor`, while the test expects `…started from
    Development`;
  - `src/activities-card.test.tsx`, "turns activities off for a Floor,
    and saves them": times out after 5 s.

  Both came in with the merges of #174 and #175. Also,
  `src/scene/meeting-room.test.tsx`, "a Kickoff over at once still
  gathers them for a moment…", failed in three of seven runs. It looks
  like a flaky timing test.
- #45's text says `pnpm --filter gateway record (from #33)`. #33 built
  recorder mode, not this command; the command now exists, so the
  wording can stay.

## Not verifiable in this sandbox

- Recording against real AI Accounts (Claude API key and subscription,
  ChatGPT, Grok, Gemini): no AI Account here. This is #45 itself, on the
  host.
- How each real AI Provider answers the scripted requests. For example,
  whether Gemini's OpenAI-compatible API takes the tool call and the
  `data:` image as sent: the requests follow each API's documented
  format, but only a real run will show.
- Claude Code and Codex run through the Gateway on a subscription, as the
  README describes (neither tool is installed here).
- The script against `apps/server` started with `GATEWAY_FIXTURES_DIR`
  (needs Postgres, so Docker). It was run against the same Gateway
  (`buildGateway`) with the server's recorder and redaction set-up.

## On the host, after merging `main` (#176)

`main`'s #176 fixed the two `apps/web` tests that failed above. On the
host, with Docker, so the Postgres tests run too:

```text
$ pnpm lint && pnpm typecheck        # exit 0
$ pnpm test
 Test Files  370 passed (370)
      Tests  4637 passed | 18 skipped (4655)
```
