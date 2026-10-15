# Issue #13: Encryption at rest and central redaction — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at the last commit of the
issue (`2919762`), after `pnpm install --frozen-lockfile`.

## What was built

### Encryption: `@ai-office/shared/crypto` (`packages/shared/src/crypto.ts`)

- **Algorithm.** AES-256-GCM, with a random 12-byte IV for each value and a
  16-byte tag (`authTagLength` is pinned on both sides, so a shortened tag is
  refused).
- **Sealed format.** `aio1:<key version>:<iv>:<ciphertext>:<tag>`, each part
  base64url. The format prefix, the key version and an optional `context`
  (for example `ai_account.credential:7`) are authenticated as associated
  data. A value whose key version was relabelled, or that was copied into
  another field, fails to decrypt.
- **Key-version tagging.** `createEncryptor({ keys, currentKeyVersion })`
  holds keys by version. It seals with the current key and opens any value
  whose version it holds; `keyVersionOf()` reads the version without
  decrypting. `encryptorFromKey(key)` is the single-key case, as version 1.
  Rotation tooling is out of scope.
- **Errors.** `DecryptionError` for malformed, tampered, wrong-key,
  unknown-version or wrong-context values. Its message never contains the
  plaintext, the key or the sealed value.
- **`parseEncryptionKey()`** is now the one definition of `ENCRYPTION_KEY`'s
  format: 32 bytes, canonical base64. The server's config validation (#7)
  uses it.
- **Node only.** It is exported as a subpath (`@ai-office/shared/crypto`), so
  the browser entry of `@ai-office/shared` never pulls in `node:crypto`.

### Redaction: `@ai-office/shared` (`packages/shared/src/redact.ts`)

- **What `createRedactor({ secrets, patterns })` returns:**
  - `register(...secrets)` adds exact values.
  - `redactText()` returns a string.
  - `redact()` returns a deep copy of any value.
- **Registered values** are removed as written, JSON-escaped (a PEM key's
  newlines inside a JSON string) and URL-encoded, longest first. Values
  shorter than 4 characters are ignored, because they would only match noise.
- **Credential shapes** (`credentialPatterns`), removed from every string:
  - PEM private keys, including unterminated ones;
  - Anthropic API keys and OAuth access and refresh tokens (`sk-ant-…`);
  - OpenAI keys (`sk-`, `sk-proj-`, `sk-svcacct-`);
  - xAI keys (`xai-`);
  - Google API keys (`AIza…`) and OAuth tokens (`ya29.`, `1//0`);
  - GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`);
  - `btr-` keys;
  - AWS access key IDs;
  - JWTs (most OAuth tokens);
  - `Bearer`/`Basic` header values (the scheme is kept);
  - URL passwords (`scheme://user:[REDACTED]@host`);
  - credentials in query strings (`token=`, `access_token=`, `id_token=`…);
  - credential values in JSON (`"password":"…"`, `"apiKey":"…"`);
  - credential assignments in text (`DB_PASSWORD=…`, `client_secret: …`).
- **Objects.** `redact()` copies arrays, plain objects, Maps, Sets and Errors
  (including an Error's message and stack), handles cycles, and never
  changes its input.
  - **Sensitive keys** are matched exactly, ignoring case, `-` and `_`:
    `password`, `apiKey`, `x-api-key`, `authorization`, `cookie`,
    `set-cookie`, `privateKey`, `accessToken`, `refreshToken`,
    `encryptionKey`, `gatewayKey`, `credentials` and similar. Their values
    are replaced whatever they are (a string or a Buffer), item by item for
    an array, and key by key for an object.
  - **Usage counts are left alone.** `tokens`, `inputTokens` and `maxTokens`
    are deliberately not treated as sensitive.
- **JSON stays valid.** Every replacement keeps JSON log lines valid, which a
  test checks for every shape.
- **Wired into the server.** The logger from #7 now uses the central
  redactor. Each log object (and each child logger's bindings) is redacted
  before serialisation, and each serialised line again afterwards. This
  replaces #7's own secret-value scrubber.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below).
- [x] **Round-trip and tamper tests for encryption.** `crypto.test.ts`, 39
      tests:
      - **Round trip:** a credential, an empty string, Unicode, a PEM key and
        a 1 MB body; with a context; the plaintext never appears in the
        sealed value; a fresh IV each time (100 seals, 100 distinct values).
      - **Tamper:** one flipped bit in the IV, the ciphertext or the tag; a
        truncated tag; truncated ciphertext; the wrong context or none; the
        wrong key; a key version relabelled to another version that holds the
        *same* key, so only the authenticated version number can catch it;
        10 malformed values. The error message holds neither the plaintext
        nor either key.
      - **Key versions:** a value sealed under version 1 opens after rotating
        to version 2; new values carry version 2; an encryptor without
        version 2 refuses them by name. Invalid key sets are refused.
      - **`parseEncryptionKey`:** accepts 32 base64 bytes and refuses 16 or 64
        bytes, hex, base64url, text and the empty string.
- [x] **Redaction tests cover each credential shape and registered values
      inside nested objects.** `redact.test.ts`, 72 tests (counting each
      parametrised case):
      - **Each shape** (23 fake credentials, assembled at run time) is removed
        from plain text and from a JSON log line, which stays valid JSON.
        Further tests cover an unterminated key, `Authorization` headers, URL
        passwords, query strings, assignments, JSON values, idempotence, and
        five ordinary lines that must come through unchanged (SHAs, UUIDs,
        token counts, branch names, GitHub URLs).
      - **Registered values** are removed from text, in JSON-escaped and
        URL-encoded forms, and inside nested objects, arrays, Maps, Sets and
        an Error's message and stack. Further tests cover registration after
        creation, too-short values, and overlapping values.
      - **Objects:** sensitive keys of every shape, recursion into
        `credentials`, nulls left alone, input not mutated, cycles, and other
        objects returned as they are.
      - **Server logger** (`apps/server/src/logger.test.ts`): credential
        shapes and sensitive keys are removed from log lines and child
          bindings without being registered, alongside #7's tests that secret
        config values never appear.

**Negative checks.** These show that each test can fail:

- Each of the 15 credential patterns was dropped in turn (through a temporary
  filter, since reverted), and at least one test failed every time.
- The first run showed two patterns with no independent test: the OpenAI
  pattern also matched `sk-ant-` keys, and the query-string test used a name
  that the assignment pattern also caught. I narrowed the OpenAI pattern
  (`sk-(?!ant-)`) and changed the test so it uses `token=` and `id_token=`.
  After that, dropping any pattern fails 1 to 13 tests.
- With the logger's redaction hooks turned into the identity function, all
  three logger tests fail.

**Found by dogfooding.** I ran `credentialPatterns` over every tracked file
in the repository. It showed that the assignment pattern's `\s*` crossed
newlines: `SESSION_SECRET=` followed by an empty line swallowed the next
line's first token. It also showed that `DecryptionError`'s message ("the
secret: <reason>") would have had its reason redacted. Both are fixed in
`2919762`, with a test that fails on the old pattern. The remaining matches
are placeholders (`.env.example`) and test fixtures.

## Output (fresh clone, `/tmp/clone13`)

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/shared typecheck: Done
apps/server typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  14 passed (14)
      Tests  159 passed | 5 skipped (164)
test exit=0
```

The 5 skipped tests are #6's Postgres integration tests (no Docker).

```text
$ pnpm exec vitest run --project @ai-office/shared --reporter=verbose   (excerpt)
 ✓ crypto.test.ts > encryption round trip > returns a credential unchanged
 ✓ crypto.test.ts > encryption round trip > returns a large body unchanged
 ✓ crypto.test.ts > encryption round trip > uses a fresh IV each time
 ✓ crypto.test.ts > tampering > a flipped bit in the IV fails to decrypt
 ✓ crypto.test.ts > tampering > a flipped bit in the ciphertext fails to decrypt
 ✓ crypto.test.ts > tampering > a flipped bit in the tag fails to decrypt
 ✓ crypto.test.ts > tampering > a truncated tag fails to decrypt
 ✓ crypto.test.ts > tampering > the wrong context fails to decrypt
 ✓ crypto.test.ts > tampering > the wrong key fails to decrypt
 ✓ crypto.test.ts > tampering > a relabelled key version fails to decrypt, even when the key exists
 ✓ crypto.test.ts > tampering > never puts the plaintext or the key in the error
 ✓ crypto.test.ts > key versions > opens values sealed with an earlier key and seals new ones with the current key
 ✓ redact.test.ts > credential shapes > removes an RSA private key from text
 ✓ redact.test.ts > credential shapes > removes an Anthropic OAuth access token from text
 ✓ redact.test.ts > credential shapes > removes a GitHub App installation token from text
 ✓ redact.test.ts > credential shapes > removes a btr- key from text
 ✓ redact.test.ts > credential shapes > removes a JWT (an OAuth access token) from a JSON log line
 ✓ redact.test.ts > credential shapes > never reaches past the end of the line for an assignment's value
 ✓ redact.test.ts > credential shapes > leaves ordinary text alone: Ada (coder, Claude claude-opus-5-5) opened PR #14 for issue 4 using 12,345 tokens.
 ✓ redact.test.ts > registered secret values > are removed in their JSON-escaped and URL-encoded forms
 ✓ redact.test.ts > registered secret values > are removed inside nested objects, arrays, Maps, Sets and Errors
 ✓ redact.test.ts > redact (objects) > replaces the values of sensitive keys, whatever their shape
 ✓ redact.test.ts > redact (objects) > copes with cycles
 …
 Tests  113 passed (113)       (39 crypto.test.ts, 72 redact.test.ts, 2 health.test.ts)

$ pnpm exec vitest run --project @ai-office/shared --project @ai-office/server
      Tests  149 passed (149)
```

## Notes for the reviewer

- **The Gateway Key prefix is not decided yet.** The issue names "`btr-`/Gateway
  Key prefixes". `btr-` keys are redacted, but neither the PRD nor an ADR says
  what AI Office's own Gateway Keys will look like. `createRedactor({ patterns })`
  takes extra shapes, so the issue that defines Gateway Keys should add its
  prefix to `credentialPatterns`. A test shows how, with an illustrative
  `aio-gk-` prefix that is not a decision.
- **Rotation.** The single `ENCRYPTION_KEY` is key version 1. How a second key
  is supplied (a new variable, say) is left to the rotation tooling, which is
  out of scope. The format and the encryptor already support it.
- **Over-redaction is preferred to leaks.** The assignment pattern also redacts
  the word after `password:` in prose. Sensitive keys are an exact list, so
  token *counts* are never hidden.
- **The event bus doesn't exist yet** (`packages/events`), so "before it is
  emitted" is satisfied by the utility being central and browser-safe. Wiring
  it into the bus belongs with the bus.
- **Fake credentials in tests are built at run time** (for example
  `` `ghp_${chars(36)}` ``), so no token-shaped literal is committed for secret
  scanners to report.

## Not verifiable in this sandbox

Nothing in this issue's acceptance criteria needs Docker, a browser, GitHub
or a real AI account; every criterion was checked here.
