# Pen-testing: the credentials package

What the red team gets to sign in to and call [the pen-test stack](stack.md),
how the Owner mints it, how it is delivered, and how each credential in it
is revoked at the end of the window. This is Enablement E4
([#190](https://github.com/adrianeyre/temp3/issues/190)). The brief is the
[pen-testing PRD](../product-requirements-document/pen-testing.md)
(Engagement shape, "Type", and Sequence step 3: E2 comes before E4). The
[rules of engagement](rules-of-engagement.md) say how the red team may use
the package. Its files are in [`docker/pen-test/`](../../docker/pen-test/):
`credentials`, `credentials.ts`, `credentials-cli.ts` and the `credentials`
service in `compose.yml`.

## In short

1. Stand the stack up and seed it. Set the Owner password on its setup
   screen.
2. `docker/pen-test/credentials mint` writes the package to one file, `0600`.
3. Hand the file over out of band. Never put it in a command-line flag, an
   issue, a commit, a chat or an email.
4. At the end of the window, `docker/pen-test/credentials revoke`.
5. Teardown destroys whatever is left.

## What the red team gets

The grey box, as the PRD sets it: enough to start probing at once, and
nothing that would let the red team skip a control.

| In the package | What it is | Where it is used |
| --- | --- | --- |
| **One Owner password** (`credentials.ownerPassword`) | A further Owner password named **Pen-test red team**: 32 random characters, stored only as an Argon2id hash. It is not the Owner's own password, so it can be revoked without changing that. | The stack's sign-in page, as any of the Owner's passwords signs in. |
| **One UI-capable API key** (`credentials.uiApiKey`) | An Owner tool's key named **Pen-test red team (UI)**, with **AI proxy and UI** access (see [API Key Management](../guide/ai-gateway.md#api-key-management)). | The sign-in page's **Use an API key instead**, which never asks for a second factor (H5), and the AI Gateway. |
| **One Gateway Key** (`credentials.gatewayKey`) | An Owner tool's key named **Pen-test red team (Gateway)**, with **AI proxy only** access: it calls models and opens nothing else. | The AI Gateway as a sandbox reaches it, `http://sandbox-relay:3047` (`stack.gatewayUrl`). |
| **The seeded Floor and fixture IDs** (`fixtures`) | E2's fixture ID listing, as the seed wrote it: the Floor IDs, Agent IDs, AI Account names, the corpus items and the throwaway repository's issue numbers ([The seed](stack.md#the-seed)). It holds no credential. | Starting from IDs instead of a directory listing. |
| **The read-only source at the pinned commit** (`source`) | The commit checked out when the package was minted: the pinned commit the stack was built from ([the window](rules-of-engagement.md#the-window)). | Reading this repository at that commit. |

The package says where to use them (`stack.url`, the address the red team
reaches the stack at) and when it was minted (`mintedAt`). It holds no read
access to this repository itself. The red-team Floor already reads it. A
human tester is given **Read** access on GitHub by the Owner, and nothing
more.

**Why the keys are Owner tools' keys and not an Agent's.** An Agent's
Gateway Key belongs to its Agent's sandboxes and goes with the Agent. It is
rotated, never revoked, so it could not be withdrawn at the end of the window
without changing the Agent. Attacker position 3 already holds an Agent's key
in its sandbox. Position 4's stolen credential is one of the Owner's tools'
keys, which the Owner makes and revokes in API Key Management.

**If the Owner turns on two-factor sign-in** on the stack, it applies to
every Owner password, so the package's password signs in only with a code
it does not hold. The UI-capable API key still signs in (H5). The Owner
records which way the stack was set for the window.

The file is JSON. With obviously fake values, it looks like this:

```json
{
  "about": "The pen-test stack's credentials package (…). Handed over out of band; …",
  "mintedAt": "2026-10-20T09:00:00.000Z",
  "stack": { "url": "http://10.0.0.5:3145", "gatewayUrl": "http://sandbox-relay:3047" },
  "source": { "commit": "0123456789abcdef0123456789abcdef01234567", "access": "read-only" },
  "credentials": {
    "ownerPassword": { "id": "…", "name": "Pen-test red team", "password": "<32 characters>" },
    "uiApiKey": { "id": "…", "name": "Pen-test red team (UI)", "access": "proxy_and_ui", "key": "aio_gk_<…>" },
    "gatewayKey": { "id": "…", "name": "Pen-test red team (Gateway)", "access": "proxy", "key": "aio_gk_<…>" }
  },
  "fixtures": { "floors": ["…"], "issues": ["…"], "corpus": { "…": "…" } }
}
```

## What it never holds

The red team **never** gets any of these, and the package is refused if it
holds one:

- the stack's `ENCRYPTION_KEY`;
- its `SESSION_SECRET`;
- its database password;
- its GitHub App's private key;
- CI credentials, or any GitHub token;
- write access to this repository;
- an AI Account's credential, even a stub's canary credential.

Two things hold the line:

- **The service that mints the package never holds most of them.** The
  stack's `credentials` service is given the database's URL, where to write
  the package and where the fixture ID listing is. It is never given
  `ENCRYPTION_KEY`, `SESSION_SECRET` or the GitHub App's settings. An Owner
  tool's key is stored only as its hash and is never sealed, so minting
  needs no encryption key. No AI Account's credential is ever opened.
- **The package is checked before it is written.** `packageProblems`
  (`credentials.ts`) refuses a package that:
  - holds anything but exactly the three credentials;
  - has a UI-capable API key without UI access, or a Gateway Key with it;
  - contains, anywhere, the value of any of `ENCRYPTION_KEY`,
    `SESSION_SECRET`, `GITHUB_APP_PRIVATE_KEY` or `POSTGRES_PASSWORD`, or
    the database password, wherever the service was given them;
  - names any of those settings;
  - contains a database URL, a private key, a GitHub token or an AI
    Account's canary credential.

  What it refuses is named, never its value, and nothing is written.

## Minting it

Before you mint:

- **The stack is stood up and seeded.** `docker/pen-test/stand-up` writes
  the fixture ID listing the package carries.
- **You have set the stack's Owner password** on its setup screen. Minting
  refuses until you have, because until then the setup screen is open to
  whoever reaches it first (H4).
- **The pinned commit is checked out.** It is the commit stand-up built,
  and the one the package names.

```bash
docker/pen-test/credentials mint
```

1. It checks the credentials directory, `PEN_TEST_CREDENTIALS_DIR` in
   `docker/pen-test/.env`. Stand-up sets it, by default
   `~/.local/state/ai-office-pen-test/credentials` (under `$XDG_STATE_HOME`
   when set). It must be absolute, outside this repository, and neither
   inside the sandbox work directory nor holding it: the app bind-mounts the
   work directory's clones into the sandboxes, and no sandbox may reach the
   package.
2. It makes that directory `0700` and marks it as the stack's, so teardown
   knows it may delete it.
3. It runs the stack's `credentials` service, with stand-up's user and
   group IDs (`PEN_TEST_UID`, `PEN_TEST_GID`), so the file is yours alone.
   The service mints the three credentials in the stack's own
   database, through AI Office's own code: a further Owner password, and
   two Owner tools' keys, each recorded in the Activity Feed as made. It
   then writes the package to `credentials-package.json` in that directory,
   `0600`.
4. It checks the file is there and `0600`. A file with any other mode is
   deleted, and you revoke and mint again.

What it prints names each credential by its name and id, and the file's
path. It never prints a credential. The pinned commit reaches the service
through the environment (`--env PINNED_COMMIT`, with no value on the command
line), and no credential is ever on one.

**One of each.** Minting refuses while any of the red team's credentials is
in use, and while a package is already in the directory: revoke first. If
the package cannot be written, the credentials just minted are revoked at
once, so nothing that was not handed over stays in use.

## Delivering it

**Never** through a command-line flag, an issue, a comment, a commit, a pull
request, a chat (the Manager chat included), an email, a Notice or a
Connection, and never pasted anywhere. Each of those is kept, indexed or
sent on.

- **The file is the delivery.** It is written `0600` in a `0700` directory
  outside this repository and the sandbox work directory. Only the
  `credentials` service mounts it: not the app, so no sandbox.
- **Handed over out of band.** For a human tester, use a channel the Owner
  names in the [record](rules-of-engagement.md#the-record): in person, or an
  end-to-end-encrypted file transfer. Never email.

  For the AI red team, the file goes to whoever runs the position 4 probes
  for it, the same way. An Agent's sandbox takes in only its repository,
  its issue and its environment's allow-list, none of which may carry the
  package. See #190's verification note.
- **Recorded, without its contents.** The Owner fills in **Credentials
  package delivered** in the rules' record: when, to whom, and how, with the
  package's `mintedAt`. Never a value from it.
- **Kept as it came.** The recipient keeps the file `0600`, outside every
  repository and sandbox, and uses its credentials only against the stack
  ([rules of engagement](rules-of-engagement.md#attacker-positions-and-how-each-is-wired)).
  Anything in it that turns up anywhere else is a leak. The Owner revokes
  at once, and mints a new package if the window goes on.

## Revoking it

At the end of the window, and at once if the package leaks:

```bash
docker/pen-test/credentials revoke
```

| Credential | How it is revoked | What then |
| --- | --- | --- |
| The Owner password | Removed from the stack's Owner passwords | It no longer signs in. Every session it began ends with it. |
| The UI-capable API key | Revoked, as **Revoke** in API Key Management does | Sign-in refuses it. Every web session it began is refused from its next request. The AI Gateway refuses it. |
| The Gateway Key | Revoked | The AI Gateway refuses it. |

Each revoked key is in the Activity Feed. What revocation prints names
each credential by its name and id.

It also names any Owner password or Owner tool's key made since the package
was minted that is not the package's own. It does not revoke these. A
session the package opened could have made them (H5), so the Owner looks at
each in API Key Management and decides.

Then it deletes the host's copy of the package. The copy handed over now
holds nothing that works: ask the recipient to delete it. Running revoke
again revokes nothing more. After teardown it says there is nothing to
revoke: the credentials went with the database volume.

A "stop" from the Owner ([rules of engagement](rules-of-engagement.md#what-stop-means))
does not revoke the package by itself, because the window is paused, not
closed. The Owner revokes when they close it, or at once if a credential
was misused.

## Destroyed at teardown

[Teardown](stack.md#tearing-it-down) removes the stack's database volume,
and with it every credential the package held, revoked or not. It also
deletes the credentials directory with any package still in it, if the
directory holds the stack's marker and passes the same checks as at
minting. It refuses to delete a directory the stack did not make.

## The tests

`pnpm test` checks the package without Docker (the `deployment` Vitest
project):

- **`credentials.test.ts`**, against memory stores:
  - minting makes one Owner password, one UI-capable API key and one
    Gateway Key, each of which works as it should;
  - minting refuses before setup and while the credentials are in use;
  - the package holds exactly the allowed credentials, the fixture IDs and
    the pinned commit, and none of the forbidden ones, by value or by name;
  - a package holding any of them is refused and never written;
  - the file is written `0600`, never over another;
  - minting and revoking print no credential: their output, stdout, stderr
    and the console are captured;
  - revocation leaves nothing working, sessions included, and names what
    else was made.

  Against a real database (in CI, or wherever Docker runs), the
  `credentials` service's own CLI mints and revokes in a process of its own,
  and prints no credential.
- **`stack.test.ts`**, with the Docker CLI faked:
  - `credentials mint` makes the directory `0700`, runs the service with no
    value on its command line and prints no credential;
  - it refuses before stand-up, before the seed's listing and over a package
    already there, and deletes a package that is not `0600`;
  - `credentials revoke` runs the service and deletes the host's copy;
  - teardown destroys the directory.
- **`compose.test.ts`**:
  - the `credentials` service is in the setup profile, and is given none of
    `ENCRYPTION_KEY`, `SESSION_SECRET` or the GitHub App's settings;
  - no other service mounts the credentials directory.
