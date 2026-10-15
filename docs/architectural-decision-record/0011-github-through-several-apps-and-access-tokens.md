# GitHub through several Apps and access tokens, each repository through the first that reaches it

AI Office reached GitHub through one GitHub App (ADR 0002), so it could work only the repositories that one App was installed on: an Owner whose repositories sit under several accounts or organisations, each with its own App, or who cannot create an App at all, could not use them. So **GitHub is now any number of connections**, each a GitHub App or an access token, set as start-up secrets in the environment as the App was (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`, then `_2`, `_3`…; `GITHUB_ACCESS_TOKEN`/`GITHUB_READ_ONLY_ACCESS_TOKEN`, then `_2`…). **They are seen as one GitHub**: the Floors card lists every connection's repositories once, and **each repository is worked through the first connection, Apps first, that reaches it**, found once and remembered. Nothing past the connections changes: every Stage, the Manager and the Merge Policy call the same `GitHubApp` interface as before.

## Considered Options

- **Keep one App**: no change, but the Owner's repositories under other accounts cannot be Floors without moving them.
- **Connections kept in Postgres, added in General Settings**: friendlier, but the App's key and a token are start-up secrets, which live in the environment, never the database (PRD FR-67), and the services that need GitHub are built at start-up.
- **One App per Floor, chosen when the Floor is added**: exact, but a column on every Floor and a choice the Owner must make, when which connection reaches a repository is GitHub's to say.
- **Connections in the environment, each repository through the first that reaches it** (chosen).

## Consequences

- **An access token cannot mint narrower tokens**, as an App's installation can (W1-2, W1-3). So a token comes with a second, read-only one, which is all a sandbox, a chat session or a fact-finding run is given; the server refuses to start with one and not the other, or with the same token as both. AI Office never revokes either: they are the Owner's. A sandbox's read-only token therefore lives as long as the Owner lets it, not an hour; the Owner should give it an expiry and the fewest repositories.
- Apps come before tokens: where both reach a repository, the App's narrower, short-lived tokens are used.
- With an access token AI Office acts as the token's user, not as `<app>[bot]`: its comments, issues and pull requests are that user's. Commits are authored as the Owner either way (ADR 0002).
- One connection whose credentials have gone bad does not hide the others' repositories: the list holds every connection that answered.
- ~~Docker Compose passes on three of each; for more, add their lines to `docker-compose.yml`.~~ Superseded by the addendum below.

## Addendum: connections kept in Postgres, added in Floor Settings

The connections were start-up secrets, read from the environment, so adding or changing one meant editing `.env` and restarting, and the number Docker Compose passed on was fixed. **They are now added, disabled and removed in Floor Settings' GitHub card, and kept only in Postgres** (`github_connections`), an App's private key and a token sealed with `ENCRYPTION_KEY` like every other credential AI Office keeps (AI Accounts, Connections), re-sealed when it rotates, and never read back by the API: it shows an App's ID and the last characters of the key or token. The environment no longer gives any: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_ACCESS_TOKEN` and `GITHUB_READ_ONLY_ACCESS_TOKEN` (and their `_2`, `_3`…) are warned of at start, naming the variable but never its value, so a credential left in `.env` is not thought in use; they do not stop the server starting, since Floor Settings, where the connection is added again, needs it running. `GITHUB_API_URL` stays in the environment.

This revisits the option first set aside. The services that need GitHub are still built at start-up, but now around one **live GitHub**: it is always there, and works through whichever connections are enabled at each call, so a change in Floor Settings is used at once, with no restart, and one written to the database by another process (the pen-test seed) within a minute. With none, every call fails with "GitHub is not set up", which the Floors card shows, and AI Office starts and runs without GitHub as before. The rest stands: each repository is worked through the first enabled connection, **Apps first**, then oldest first, that reaches it; a token still comes with its read-only partner, which must be another token.
