# Issue #105: Bedrock and Vertex AI accounts — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) on this branch at `240ce2b`: every commit of the issue except this
document.

## What was built

- **Two AI Account kinds for Claude** (`packages/shared/src/ai-accounts.ts`;
  PRD FR-35). `aiAccountTypes` gains `bedrock` and `vertex`, both for the
  Claude AI Provider, each with its `platform`:
  - **AWS Bedrock (IAM credentials or profile).** Claude in Amazon Bedrock
    serves Anthropic's Messages API itself, at
    `https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages`, and
    streams as Anthropic does. It serves Messages and, translated to
    Messages, Chat Completions and Responses; not `count_tokens`, which it
    has no endpoint for.
  - **Google Vertex AI (service account).** `rawPredict` and
    `streamRawPredict` at
    `/v1/projects/<project>/locations/<region>/publishers/anthropic/models/<model>`,
    and `count-tokens:rawPredict`, on the global
    (`aiplatform.googleapis.com`), multi-region
    (`aiplatform.<us|eu>.rep.googleapis.com`) or regional
    (`<region>-aiplatform.googleapis.com`) endpoint
    (`platformEndpointUrl`).
  - **Models as each platform names them** (`platformModel`, applied by
    `mappedModel` and `modelSentTo` to whatever an account is sent: the
    Model asked for, a mapping's, an alias's, a Combo slot's or a forced
    one). Bedrock: the `anthropic.` prefix, no snapshot date
    (`claude-opus-5-5` → `anthropic.claude-opus-5-5`). Vertex AI: a
    snapshot date after `@` (`claude-haiku-4-5-20251001` →
    `claude-haiku-4-5@20251001`). A name the platform already uses (a
    Bedrock inference profile such as `us.anthropic.…`) is sent as it is,
    so a model mapping for the kind or a forced Model can pick one.
    `aiProviderOfModel` and `modelFamilyOf` read Bedrock's and Vertex AI's
    names as Claude's, of the same family (FR-38's capacity filter).
- **The request schema** (`addAiAccountRequestSchema`, now a union on
  `accountType`): an API key as before; a Bedrock account's `region` and
  `awsCredentials` (`{accessKeyId, secretAccessKey, sessionToken?}` or
  `{profile}`); a Vertex AI account's `region`, optional `projectId` and
  `serviceAccount` (the key file's text, checked to be a
  `service_account` key with a PEM private key; only the fields AI Office
  uses are kept). A project is needed, from the key or the Owner.
  Problems never quote what was given.
- **Storage** (migration `0056_ai_accounts_bedrock_vertex`): `ai_accounts`
  gains `region` and `project_id`, with a check constraint
  (`ai_accounts_cloud`: a region exactly for the two cloud kinds, a project
  exactly for Vertex AI), and the three `account_type` check constraints
  allow the new types. The credential column holds the platform's
  credentials as JSON, sealed with `ENCRYPTION_KEY` for the account's row
  like any key.
- **The Gateway** (`packages/gateway/src/cloud/`):
  - `aws-sigv4.ts`: AWS Signature Version 4, with `node:crypto`. The path
    is encoded once more, as AWS's SDK does for every service but S3.
  - `aws-profile.ts`: a profile's access key from the AWS CLI's files
    (`AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, or `~/.aws`): the
    credentials file's `[name]`, else the config file's `[profile name]`.
    Read each time a request is signed. Only static keys are read: a
    profile of single sign-on, a role or a credential process is refused,
    saying so.
  - `google-auth.ts`: a service account's access token by OAuth 2.0's JWT
    bearer grant (an RS256 JWT for the `cloud-platform` scope, exchanged at
    the key's `token_uri`). Tokens are kept in memory per account, shared
    by requests that ask at once, renewed five minutes before they expire,
    and forgotten when the account is deleted. A refusal names Google's
    error code only.
  - `cloud.ts`: `cloudSigner`, the account's `prepare(path, body)`.
    Bedrock: the body unchanged, at `/anthropic/v1/…`, signed for
    `bedrock-mantle` in the account's region. Vertex AI: the Model moved
    from the body to the path, `anthropic_version: vertex-2023-10-16` added
    (kept if the caller sent one), `streamRawPredict` for `stream: true`,
    the access token as a bearer token.
  - `gateway.ts`: a `GatewayAccount` may carry `cloud`. Each attempt is
    prepared and signed just before it is sent (after any backoff), so
    the signature and token are fresh. Credentials that cannot sign (a
    profile gone, Google refusing the key) count as a failure towards the
    account's circuit breaker, the request goes on to another account, and
    the caller gets a `502` when none serves. A request Vertex AI cannot
    take (no Model) is a `400`. Recorder mode and request history keep the
    path and body as sent to the platform, never its signature or token.
  - `accounts.ts`: adding either kind (a profile that gives no key is
    refused at once, `cloud_credentials_unusable`); opening one into a
    signer, with no API key at all; every secret (access key ID, secret
    key, session token, a profile's keys when read, the private key and
    its ID, each access token) told for redaction; `holdsCredential` sees
    them. Their region and project are listed; their credentials never are.
- **Server** (`apps/server/src/ai-accounts/routes.ts`): the API's account
  carries `region` and `projectId`; `cloud_credentials_unusable` is a
  `400`.
- **Web** (`apps/web/src/ai-accounts-card.tsx`): AI Settings' **Add an AI
  Account** offers both kinds. Bedrock: the region, then an IAM access key
  (ID, secret, optional session token, all password fields) or a profile.
  Vertex AI: the region, an optional project, and the key file pasted into
  a text area. Each account's row shows its region and project.
- **Guide:** an **AWS Bedrock and Google Vertex AI accounts** section in
  [`docs/guide/ai-gateway.md`](../guide/ai-gateway.md), and both fixture
  sets in `packages/gateway/fixtures/README.md`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm test` without Docker: 2929 passed, 402
      skipped (the Postgres tests, with the reason). Before this issue
      (`6e6e3d2`) it was 2855 passed, 400 skipped: the two new skips are
      this issue's Postgres cases. No test was skipped, deleted or
      weakened. Two existing tests' expectations changed with the API: the
      exact account bodies in `apps/server/src/ai-accounts/routes.test.ts`,
      `oauth.test.ts` and `packages/gateway/src/accounts/accounts.test.ts`
      (and the hand-made account records and API stubs in three gateway
      and two web tests) gain `region: null` and `projectId: null`, and an
      `oauth` account type sent to `POST /api/ai-accounts` is now refused
      with "Add an API key, an AWS Bedrock or a Google Vertex AI account
      here; a subscription signs in instead." in place of "Only API-key AI
      Accounts can be added so far."

      **Mutation checks** (each reverted; `npx vitest run src/providers`
      in `packages/gateway`, the 56 contract tests of every AI Account
      kind):

      | Mutation | Tests failed |
      | --- | --- |
      | Bedrock signed for `bedrock` in place of `bedrock-mantle` | 11 |
      | Vertex AI sent the Model in the body too | 5 |
      | Bedrock sent `claude-…` without its `anthropic.` prefix | 6 |
- [x] **Contract tests with recorded or hand-built fixtures.**
      `packages/gateway/src/providers/bedrock.test.ts` and
      `vertex.test.ts` replay each hand-built fixture in
      `fixtures/bedrock/` and `fixtures/vertex/` through a real Gateway,
      serving from a real AWS Bedrock or Vertex AI account (added through
      `AiAccounts.add`, its credentials sealed), the AI Provider's answer
      in 7-byte chunks. A coverage test pairs every fixture with its
      expectation.
      - **Bedrock** (a Message; a stream with cached input tokens; AWS's
        `429 ThrottlingException`; `529 overloaded_error`; AWS's `403
        AccessDeniedException`). For each, Claude Code's request for
        `claude-…` reaches `/anthropic/v1/messages` with the fixture's very
        body (`anthropic.claude-…`), and its SigV4 signature is checked
        against the very host, path and body received, for
        `bedrock-mantle` in the account's region, with the access key ID in
        its credential scope. No `x-api-key`, no Gateway Key, no secret in
        any header. The caller gets the answer byte for byte; the record
        has the status, Model and tokens; recorder mode saves the path and
        body as sent. Neither the secret, the key ID nor the signature is
        in the saved fixture, the request record or a log line (the Gateway
        logging at `debug`).
      - **Vertex AI** (`rawPredict`; `streamRawPredict`;
        `count-tokens:rawPredict`; a `429 RESOURCE_EXHAUSTED` quota error;
        `529 overloaded_error`). For each, the request reaches the
        fixture's path (project, location, Model) with its very body
        (`anthropic_version`, no Model) and the bearer token a fake Google
        token endpoint issued after verifying the JWT's RS256 signature
        with the key's public half (its `kid`, `iss`, `scope` and `aud`
        checked too). No token or key in the saved fixture or the record.
      - Also through the Gateway: a temporary key's session token is sent
        and signed; a profile's key is read from the AWS files, and a
        rotated one is used on the next request; a profile without a key
        (single sign-on) or a missing profile is refused when adding; a
        profile that disappears fails over to the next account, and with
        none left the caller gets a `502`; Codex's Responses are translated
        to Messages for both; Bedrock is sent no `count_tokens` (`503`);
        an inference profile is sent as it is; a Vertex AI token is fetched
        once for four requests that arrive together, kept for three
        requests, and renewed 55 minutes on; while Google refuses the key
        the caller gets a `502` that does not quote Google, then the
        account serves once it signs in; the region and a dated Model are
        named as Vertex AI wants them (`us-east5`,
        `claude-haiku-4-5@20251001`; `eu`); a Messages request without a
        Model is a `400`; after each platform's `429` and `529` the request
        falls back to a second account, and the first is held back
        (rate-limited for 60 s, overloaded for 30 s); the keys are never
        listed, and `holdsCredential` finds them.
      - **SigV4 against AWS's own test suite**
        (`packages/gateway/src/cloud/aws-sigv4.test.ts`): `get-vanilla`,
        `post-vanilla`, `get-vanilla-query-order-key-case`,
        `post-x-www-form-urlencoded` and `post-sts-header-before` give the
        signatures AWS publishes for them (aws-c-auth's
        `aws-signing-test-suite/v4`).
      - Also covered: the profile reader and the token cache
        (`aws-profile.test.ts`, `google-auth.test.ts`); the kinds, Model
        names, endpoints and request schema
        (`packages/shared/src/ai-accounts.test.ts`); both kinds in memory
        and in Postgres, and the `ai_accounts_cloud` constraint
        (`packages/gateway/src/accounts/accounts.test.ts`; the Postgres
        cases skip here); recorder file names for Vertex AI's paths
        (`fixtures.test.ts`); the API, with its `400`s and no secret in any
        answer or log line (`apps/server/src/ai-accounts/cloud.test.ts`);
        and the AI Settings form (`apps/web/src/ai-accounts-card.test.tsx`).

### Verified on the host

- [ ] **A real AWS Bedrock account and a real Vertex AI service account
      serve requests through the Gateway.** Not done here: there are no
      AWS or Google credentials in the sandbox, and no AI Account of any
      kind.

## Not verifiable in this sandbox

- **The platforms' real answers.** The fixtures were written by hand
  (#45 is open), from Anthropic's Messages format, AWS's and Google's
  documented error shapes, and Anthropic's documentation of Claude in
  Amazon Bedrock and on Vertex AI. To check on the host:
  - how Claude in Amazon Bedrock words its throttling, access and
    overload errors (AWS's `{"message"}` with `x-amzn-errortype`, or
    Anthropic's `{"type":"error"}`; both are read);
  - whether it echoes the Model with its `anthropic.` prefix;
  - that Bedrock's endpoint takes the `?beta=true` Claude Code adds (the
    Gateway drops the query for both platforms; betas still go as the
    `anthropic-beta` header) and Vertex AI the `anthropic-beta` header;
  - Vertex AI's `count-tokens:rawPredict` body (the Model kept in it,
    `anthropic_version` added, as Anthropic's Vertex SDK sends it).
- **SigV4 for real.** The signer gives AWS's published signatures for its
  own test vectors, and the contract tests check the signature over what
  was received. Only AWS can say it accepts one for `bedrock-mantle`.
- **The Postgres side.** Without Docker, the database tests (migration
  `0048`, the new columns and the `ai_accounts_cloud` constraint) are
  skipped with their reason. The migration was generated by `drizzle-kit`
  from the schema; CI, which runs Postgres, fails rather than skips them.
- The Playwright suite (`pnpm e2e`) was not run.

## Notes, and disagreements with the canon

These are outside the issue's "What to build", or for the Owner to decide.

- **No model catalogue for these kinds (FR-41).** Neither Claude in Amazon
  Bedrock nor Vertex AI lists its Models through the Messages endpoints AI
  Office calls (Anthropic documents both without the Models API), so their
  kinds list none (`modelsPath: null`). Claude's catalogue still comes from
  any Anthropic Console key or Claude subscription. An Owner with **only**
  Bedrock or Vertex AI accounts has no Claude catalogue, so cannot choose a
  Claude default Model (FR-15). A follow-up could read Bedrock's
  `ListFoundationModels` / inference profiles and Vertex AI's publisher
  models.
- **Prompt-cache keep-alive (FR-39) and auto-refresh** skip these accounts:
  keep-alive would need to re-sign its request through the platform, and
  neither platform reports usage windows to auto-refresh. Both platforms
  cache prompts, so keep-alive for them is worth a follow-up.
- **Costs.** Estimates look Models up by name: a Bedrock name
  (`anthropic.claude-…`) has no price until the Owner sets one, and the
  platforms' own prices (their regional endpoints' 10% premium, for one)
  are not in the pricing table.
- **Other Bedrock and Vertex AI credentials.** Bedrock API keys (bearer
  tokens), profiles that use single sign-on, roles or a credential process,
  instance or task roles, and Google's application-default credentials or
  workload identity are not supported: the issue names IAM credentials or a
  profile, and a service account.
- **The legacy Bedrock API** (`InvokeModel` on `bedrock-runtime`, with AWS
  event-stream encoding and ARN-versioned Model IDs) is not used: Claude in
  Amazon Bedrock's Messages endpoint serves every current Claude Model and
  streams as Anthropic does. A Model only `InvokeModel` serves (Claude Opus
  4.6 and earlier) is not reachable through a Bedrock account.
- **Error bodies pass through** as each platform writes them, as for
  Gemini (#44): a Claude Code caller may get AWS's or Google's error JSON
  rather than Anthropic's.
- **A profile's keys and `holdsCredential`.** A profile's keys are read
  from disk when a request is signed and told to the redactor then, but
  `holdsCredential` (what keeps credentials out of sandboxes) checks only
  credentials AI Office stores, so it does not know them.
- **docker compose.** For a profile, the server's container needs the AWS
  files (or `AWS_SHARED_CREDENTIALS_FILE`) mounted; `docker-compose.yml`
  does not mount them. The guide says so.

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
exit 0
```

`pnpm typecheck` (tail):

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
exit 0
```

`pnpm test`, without Docker:

```text
 Test Files  259 passed (259)
      Tests  2929 passed | 402 skipped (3331)
   Start at  09:57:08
   Duration  57.44s (tests 47%, import 32%, environment 10%, transform 9%, setup 1%)
exit 0
```

The contract tests and the cloud module, verbose:

```text
$ pnpm exec vitest run packages/gateway/src/providers/bedrock.test.ts packages/gateway/src/providers/vertex.test.ts packages/gateway/src/cloud --reporter=verbose
✓ |@ai-office/gateway| src/cloud/aws-sigv4.test.ts > signAwsRequest > signs AWS's get-vanilla as AWS does 3ms
✓ |@ai-office/gateway| src/cloud/aws-sigv4.test.ts > signAwsRequest > signs AWS's post-vanilla as AWS does 1ms
✓ |@ai-office/gateway| src/cloud/aws-sigv4.test.ts > signAwsRequest > signs AWS's get-vanilla-query-order-key-case as AWS does 2ms
✓ |@ai-office/gateway| src/cloud/aws-sigv4.test.ts > signAwsRequest > signs AWS's post-x-www-form-urlencoded as AWS does 1ms
✓ |@ai-office/gateway| src/cloud/aws-sigv4.test.ts > signAwsRequest > signs a temporary key's session token too (post-sts-header-before) 1ms
✓ |@ai-office/gateway| src/cloud/aws-sigv4.test.ts > signAwsRequest > signs the body, the host (with its port) and the path 1ms
✓ |@ai-office/gateway| src/cloud/aws-sigv4.test.ts > signAwsRequest > writes the time as AWS does 0ms
✓ |@ai-office/gateway| src/cloud/aws-profile.test.ts > parseIni > reads sections and keys, leaving comments and nested settings out 3ms
✓ |@ai-office/gateway| src/cloud/aws-profile.test.ts > readAwsProfile > reads a profile's key from the credentials file first 13ms
✓ |@ai-office/gateway| src/cloud/aws-profile.test.ts > readAwsProfile > reads one from the config file's [profile name], or its [default] 5ms
✓ |@ai-office/gateway| src/cloud/aws-profile.test.ts > readAwsProfile > refuses a profile it cannot find, or one without a key, never quoting a secret 22ms
✓ |@ai-office/gateway| src/cloud/aws-profile.test.ts > readAwsProfile > finds the AWS CLI's files where its environment says 1ms
✓ |@ai-office/gateway| src/cloud/google-auth.test.ts > serviceAccountAssertion > is a JWT for Google's token endpoint, signed with the key 5ms
✓ |@ai-office/gateway| src/cloud/google-auth.test.ts > serviceAccountAssertion > refuses a key that cannot sign, without quoting it 1ms
✓ |@ai-office/gateway| src/cloud/google-auth.test.ts > createGoogleTokenCache > keeps a token until five minutes before it expires 29ms
✓ |@ai-office/gateway| src/cloud/google-auth.test.ts > createGoogleTokenCache > asks once for requests that want a token together, and again after a refusal 3ms
✓ |@ai-office/gateway| src/cloud/google-auth.test.ts > createGoogleTokenCache > keeps each account's token apart, and forgets a deleted one's 4ms
✓ |@ai-office/gateway| src/cloud/google-auth.test.ts > createGoogleTokenCache > says when Google cannot be reached 2ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > the AWS Bedrock fixtures > each have an expectation, and each expectation a fixture 3ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > the Google Vertex AI fixtures > each have an expectation, and each expectation a fixture 6ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > the AWS Bedrock fixtures > messages-access-denied.json goes to Claude in Amazon Bedrock signed with SigV4, with its usage recorded 138ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > the AWS Bedrock fixtures > messages-overloaded.json goes to Claude in Amazon Bedrock signed with SigV4, with its usage recorded 20ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > the AWS Bedrock fixtures > messages-streaming.json goes to Claude in Amazon Bedrock signed with SigV4, with its usage recorded 42ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > the Google Vertex AI fixtures > count-tokens.json goes to Vertex AI with the service account's token, with its usage recorded 106ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > the Google Vertex AI fixtures > messages-overloaded.json goes to Vertex AI with the service account's token, with its usage recorded 28ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > the Google Vertex AI fixtures > messages-rate-limited.json goes to Vertex AI with the service account's token, with its usage recorded 21ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > the Google Vertex AI fixtures > messages-streaming.json goes to Vertex AI with the service account's token, with its usage recorded 35ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > the AWS Bedrock fixtures > messages-throttled.json goes to Claude in Amazon Bedrock signed with SigV4, with its usage recorded 14ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > the AWS Bedrock fixtures > messages.json goes to Claude in Amazon Bedrock signed with SigV4, with its usage recorded 21ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > send a temporary key's session token, signed 24ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > sign with their profile's key, read again each time 26ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > are not added with a profile that has no key 4ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > the Google Vertex AI fixtures > messages.json goes to Vertex AI with the service account's token, with its usage recorded 18ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > keep their access token until shortly before it expires, then sign in again 33ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > sign in once for requests that arrive together 27ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > fail over when their profile is gone, and the caller gets a 502 when none is left 1523ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > serve Codex too, translated from Responses to Messages 23ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > count no tokens: Claude in Amazon Bedrock has no such endpoint 6ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > send a Bedrock inference profile as it is 11ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > fall back after AWS's rate_limited answer, which holds the account back 17ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > fall back after AWS's overloaded answer, which holds the account back 13ms
✓ |@ai-office/gateway| src/providers/bedrock.test.ts > AWS Bedrock AI Accounts > hold their keys as secrets: never listed, and kept out of sandboxes 1ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > answer 502 while Google refuses the service account, and serve once it signs in 1533ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > name the region, and a dated Model as Vertex AI does (us-east5) 17ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > name the region, and a dated Model as Vertex AI does (eu) 15ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > serve Codex too, translated from Responses to Messages 17ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > refuse a request that names no Model, which Vertex AI needs 5ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > fall back after Vertex AI's rate_limited answer, which holds the account back 20ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > fall back after Vertex AI's overloaded answer, which holds the account back 16ms
✓ |@ai-office/gateway| src/providers/vertex.test.ts > Google Vertex AI AI Accounts > hold the service account's key as a secret: never listed, and kept out of sandboxes 4ms
Test Files  5 passed (5)
Tests  50 passed (50)
```

The API and the shared schema:

```text
$ pnpm exec vitest run apps/server/src/ai-accounts/cloud.test.ts packages/shared/src/ai-accounts.test.ts --reporter=verbose
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's names for Claude Models > are Bedrock's: an anthropic. prefix, no snapshot date 3ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's names for Claude Models > are Vertex AI's: a snapshot date after @ 0ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's names for Claude Models > leave every other kind's Models alone 0ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's names for Claude Models > are what a mapping, an alias or a forced Model is sent as 0ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's names for Claude Models > are still Claude's, of the same family 2ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's endpoint > is Claude in Amazon Bedrock's, in the region 1ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's endpoint > is Vertex AI's global, multi-region or regional one 1ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > a cloud platform's endpoint > serves Bedrock no token counting, and Vertex AI everything 1ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > adding a cloud platform's account > takes an AWS access key, with or without a session token, or a profile 9ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > adding a cloud platform's account > reads the service account's key file, keeping only what it uses 3ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > adding a cloud platform's account > needs a project, from the key or the Owner 1ms
✓ |@ai-office/shared| src/ai-accounts.test.ts > adding a cloud platform's account > names what is wrong with a key file, never quoting it 1ms
✓ |@ai-office/server| src/ai-accounts/cloud.test.ts > AWS Bedrock AI Accounts through the API > adds one with an IAM access key, and never sends or logs the key 127ms
✓ |@ai-office/server| src/ai-accounts/cloud.test.ts > AWS Bedrock AI Accounts through the API > adds one with a profile in the server's AWS files, and refuses a profile it cannot read 37ms
✓ |@ai-office/server| src/ai-accounts/cloud.test.ts > AWS Bedrock AI Accounts through the API > refuses a bad region or half a key, quoting neither 46ms
✓ |@ai-office/server| src/ai-accounts/cloud.test.ts > Google Vertex AI AI Accounts through the API > adds one with a service account's key, in its project, and never sends or logs the key 26ms
✓ |@ai-office/server| src/ai-accounts/cloud.test.ts > Google Vertex AI AI Accounts through the API > takes another project than the key's 21ms
✓ |@ai-office/server| src/ai-accounts/cloud.test.ts > Google Vertex AI AI Accounts through the API > refuses what is not a service account's key, without quoting it 24ms
Test Files  2 passed (2)
Tests  18 passed (18)
```

The AI Settings form's new cases (the file's other 20 filtered out by `-t`):

```text
$ pnpm exec vitest run apps/web/src/ai-accounts-card.test.tsx -t "AWS Bedrock|Vertex AI|service account" --reporter=verbose
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds an AWS Bedrock account with an IAM access key 636ms
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds an AWS Bedrock account with a profile, and says what is wrong first 277ms
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > adds a Google Vertex AI account with a service account's key 210ms
✓ |@ai-office/web| src/ai-accounts-card.test.tsx > the AI Accounts in AI Settings > refuses what is not a service account's key before sending it 172ms
Test Files  1 passed (1)
Tests  4 passed | 20 skipped (24)
```
