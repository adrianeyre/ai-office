# Issue #285: [fix] G1-9 — ENCRYPTION_KEY cannot be rotated: the server takes one key, so replacing a leaked one loses every sealed credential — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no Postgres, no network beyond the registry and the model). The
fix is commit `7882474`,
`fix(security): G1-9 ENCRYPTION_KEY can be replaced, with the key it replaced retired beside it, and every sealed value is sealed again with the new one`,
on top of G1-8's `238fb5d` (#283). Its blocker, the G1 probe (#195), is in
the tree: `docs/pen-testing/assessments/G1.md` and
`apps/server/src/config.pen-test.test.ts`.

This is the remediation of finding **G1-9** (`severity:low`, H16). The
real output of the checks, run once on the finished tree for both fixes of
this run, is in
[issue-283.md](issue-283.md#real-output-of-the-checks).

## What was fixed

Every sealed value carries the version of the key that sealed it, and
`createEncryptor` already takes a keyring. But the server was configured
with one key and built `encryptorFromKey`, which knows version 1 only.
Replacing a leaked `ENCRYPTION_KEY` (G1-8's public sample is one) left
every AI Account credential, Agent Gateway Key, Connection credential and
TOTP secret unreadable.

Now:

- **`ENCRYPTION_KEY` may carry its key version**, as `<version>:<key>`.
  A key alone is version 1, as every key so far is, so nothing configured
  today changes (`parseVersionedEncryptionKey`, `@ai-office/shared/crypto`).
- **`RETIRED_ENCRYPTION_KEYS`** holds the keys `ENCRYPTION_KEY` replaced,
  separated by commas, each written as it was. The server builds its
  encryptor from all of them (`config.encryptionKeyring`, `server.ts`).
  A value sealed with a retired key still opens, and new values are
  sealed with `ENCRYPTION_KEY`.
- **Each sealed value is sealed again with the new key** when AI Office
  starts beside a retired key, before it serves anything
  (`apps/server/src/reseal.ts`). Every column that holds sealed values is
  read a batch at a time, in key order. Each value not sealed as the
  current version is opened with its own row's context and sealed with
  the current key. It is written back only if it is still the value that
  was read, so a value saved meanwhile (already with the new key) is left
  alone. The log then says how many values were re-sealed and that
  "RETIRED_ENCRYPTION_KEYS can be removed". It records counts only, never
  a value.
- **A rotation that would make a sealed value ambiguous is refused**,
  naming the problem and never a key:
  - a new key without a version after every retired one: "write it as
    2:<the new key>", with the number filled in;
  - two retired keys with one version;
  - the new key among the retired ones.
- **`secretValues`** gives the logger every retired key too, so the
  logger redacts them.

The documents say so: `.env.example` (how to replace `ENCRYPTION_KEY`,
and `RETIRED_ENCRYPTION_KEYS`), `docs/guide/running.md` ("Replacing
`ENCRYPTION_KEY`") and `docs/processes/deploying-to-ec2.md` (§6 and
restoring a dump). Compose passes `RETIRED_ENCRYPTION_KEYS` to the app.

### Sibling paths

- **Every place AI Office seals a value**, not only AI Account
  credentials. `sealedColumns` lists all thirteen columns:
  - `ai_accounts.credential` and `refresh_token`;
  - `gateway_keys.sealed_key`;
  - `gateway_request_bodies.request_body` and `response_body`;
  - `owner.totp_secret` and `totp_pending_secret`;
  - `office_settings.gateway_outbound_proxy_password` and
    `github_webhook_secret`;
  - `connections.credentials`;
  - `google_sign_in.client_secret`, `refresh_token` and `access_token`.

  Each column re-seals with its context, imported from the module that
  seals it, never copied. For that, the webhook secret's, a Connection's,
  the Google sign-in's and the TOTP secret's contexts are now exported
  (`webhookSecretContext`, `connectionCredentialsContext`,
  `googleSealContext`, `totpSecretContext`). Their values are unchanged.
- **The pen-test stack's tools** (`docker/pen-test/seed-stores.ts`,
  `add-ai-accounts.ts`) sealed with one key, as version 1. They now read
  `ENCRYPTION_KEY` as written (`encryptorFromVersionedKey`), so after a
  rotation they seal under the version the server expects.
- **G1-8 agrees.** The public sample key is refused as `ENCRYPTION_KEY`
  beyond this machine, even under a version of its own. Kept in
  `RETIRED_ENCRYPTION_KEYS`, it is accepted: that is how an Office still
  on the sample leaves it without losing anything. G1-8's refusal of
  `ENCRYPTION_KEY` now says so: "to keep what it sealed, move it to
  RETIRED_ENCRYPTION_KEYS beside the new key, written as 2:<the new key>".

## Acceptance criteria

- [x] **The finding's `it.fails` becomes an `it` and passes.** "G1-9: the
      server's configuration can carry a retired ENCRYPTION_KEY beside the
      current one, so a rotation keeps sealed values readable" is an `it`,
      its assertion unchanged: `environmentKeys` names two encryption keys.
- [x] **The "pins today" test becomes a regression test asserting the old
      behaviour is gone; neither is deleted.** "regression (G1-9): the
      server is configured with every key, the new one as a version of its
      own, and a value sealed with the previous key still opens".
      - `environmentKeys` names `ENCRYPTION_KEY` and
        `RETIRED_ENCRYPTION_KEYS`.
      - The encryptor `startServer` builds from the configuration is
        version 2.
      - It opens what the old one-key Office sealed, and seals as version
        2.
      - Without the retired key, that value would still not open.
- [x] **Sibling paths with the same flaw are fixed and tested.**
      - `config.pen-test.test.ts`:
        - "G1-9: once AI Office has started beside the retired key, every
          value is the new key's, and opens with it alone";
        - "G1-9: a rotation that would leave two keys one version, or the
          new key not the newest, is refused, naming no key" (five
          refusals, and three keys of their own versions accepted);
        - "G1-8 and G1-9 agree: …".
      - `reseal.test.ts`:
        - "seals every value in every sealed column again with the new
          key, so it opens once the retired key is gone";
        - "goes through every row, a batch at a time, leaving alone what is
          already the new key's, what is empty, and what no key opens";
        - "leaves a value changed meanwhile to whoever changed it";
        - "knows every column the schema keeps a sealed value in": every
          `LIKE 'aio1:%'` constraint in the migration is in
          `sealedColumns`;
        - "knows every module that seals a value: a new one needs its
          columns here": any new `.encrypt(` call outside these modules
          fails it;
        - in Postgres, "seals each value again with the new key, in place,
          and says the retired key can go" (skipped here; see below).
      - `crypto.test.ts`: `parseVersionedEncryptionKey` (formats accepted,
        seven refused, never echoing the key) and
        `encryptorFromVersionedKey`.
      - `logger.test.ts`: a retired key never reaches the log.
      - `deployment.test.ts`: compose passes `RETIRED_ENCRYPTION_KEYS`.

      With the retired keys left out of the keyring
      (`[values.ENCRYPTION_KEY]` in `loadConfig`), and with the re-seal's
      write disabled (`false && await store.replace(…)`):

      ```
      × regression (G1-9): the server is configured with every key, the new one as a version of its own, and a value sealed with the previous key still opens 3ms
      × G1-9: once AI Office has started beside the retired key, every value is the new key's, and opens with it alone 1ms
      × G1-9: a rotation that would leave two keys one version, or the new key not the newest, is refused, naming no key 6ms
      × G1-8 and G1-9 agree: the public sample key is refused as ENCRYPTION_KEY beyond this machine, but is how an Office leaves it, as a retired key 2ms
      × seals every value in every sealed column again with the new key, so it opens once the retired key is gone 14ms
      × goes through every row, a batch at a time, leaving alone what is already the new key's, what is empty, and what no key opens 2ms
      × leaves a value changed meanwhile to whoever changed it 4ms
            Tests  7 failed | 10 passed | 1 skipped (18)
      ```

      With both restored, all of them pass.
- [x] **The assessment's findings table marks `G1-9` fixed.**
      `docs/pen-testing/assessments/G1.md`: **fixed** (issue #285), with
      the commit's subject (hash filled at merge).
- [ ] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** `pnpm lint`
      and `pnpm typecheck` pass. `pnpm test` still fails on eight tests
      that were already failing before this run, none of them this
      finding's. See
      [issue-283.md](issue-283.md#real-output-of-the-checks).

## Decisions

1. **Versions are explicit, `<version>:<key>`, with a key alone as
   version 1.** That keeps the sealed format's meaning (`crypto.ts`
   expected "adding version 2 and re-sealing"), and every key configured
   today keeps working unchanged. The alternatives were:
   - **inferring the version** from how many keys are retired: it breaks
     when the retired key is removed, because the new key would become
     version 1 again;
   - **deriving it from the key**: it changes what every new sealed value
     says, even with no rotation.

   The cost is that the Owner must write the new key as `2:<key>` and
   keep that form. A key written without its version is refused while a
   retired key is configured, and a missing version afterwards shows up
   as values no key opens.
2. **Retired keys are a comma-separated list**, usually of one key, so a
   second rotation before the first has finished still opens everything.
3. **The re-seal runs at start, before anything reads a sealed value, and
   only while `RETIRED_ENCRYPTION_KEYS` is set.** It needs no command for
   the Owner to run, and the same steps work under compose and outside
   it. With no retired key there is nothing another key could open, and
   scanning the request bodies on every start would cost a full read of
   them.
4. **A re-seal that cannot finish is not fatal.** If the database is
   unreachable, the error is logged and every value still opens with the
   retired key, and the next start tries again. A value no configured key
   opens is left as it is and counted per column in a warning, which does
   not say the retired key can go.
5. **The re-seal reads and writes the tables directly** (`sql.identifier`
   over the thirteen columns), not through each store. Adding a re-seal
   method to eight stores, each in memory and in Postgres, would be a
   larger change for the same result. Two static tests hold the list to
   the schema and to the code: the migration's constraints, and the
   modules that call `.encrypt(`.
6. **No ADR.** FR-67 already says start-up secrets come from the
   environment. A retired key is one more of them, read and redacted as
   `ENCRYPTION_KEY` is. No architectural decision changes.

## Noticed, out of scope

- **Request bodies can be large.** The first start after a rotation reads
  and rewrites every stored body (7 days' worth by default, PRD §7 retention, and only
  while body storage is on). That start takes correspondingly longer.
- **The pen-test stack** has no `RETIRED_ENCRYPTION_KEYS`. Its keys are
  generated per window and destroyed at teardown, so it never rotates.
- **Owner tools' Gateway Keys** are kept only as hashes, never sealed, so
  a rotation does not touch them, and need not.
- **`SESSION_SECRET`** has no retired form. Changing it signs everyone out
  (`docs/guide/running.md`), which is what replacing a leaked one should
  do.

## What could not be verified here

- **The re-seal against Postgres.** `reseal.test.ts`'s Postgres test seals
  five values through raw `INSERT`s with the old key:
  - an AI Account's credential;
  - the TOTP secret;
  - a Connection's credentials;
  - the Google client secret;
  - the webhook secret.

  It then runs `resealWithCurrentKey` and opens each with the new key
  alone. It is skipped here, and runs in CI:

  ```
  ↓ … > re-sealing in Postgres as AI Office starts (pen-testing G1-9) > seals each value again with the new key, in place, and says the retired key can go 3ms [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
  ```

  The SQL it exercises (`databaseSealedValues`) is the only part not run
  here; the logic above it is tested against an in-memory store.
- **A real rotation of a running Office** (compose restarted with a new
  `ENCRYPTION_KEY` and the old one retired, then without it). The same
  steps are covered piecewise: the configuration, the keyring
  `startServer` builds, the re-seal, and the new key alone opening the
  result.
