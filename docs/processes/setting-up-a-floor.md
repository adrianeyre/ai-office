# Setting up the GitHub App and your Floors

Everything AI Office needs from GitHub is in this one document. It goes
from nothing to a working Floor: a test repository, the AI Office GitHub
App, added in Floor Settings, the App installed, the Floor added, the branch
protected, and a check that it all works. The later sections are
reference: [the labels](#labels-ai-office-creates),
[how intake picks issues](#how-intake-decides-what-to-pick-up),
[webhooks](#webhooks-optional) and
[troubleshooting](#troubleshooting).

| Step                                                                     | Where           | How often         |
| ------------------------------------------------------------------------ | --------------- | ----------------- |
| [1. Create the test repository](#1-create-the-test-repository)           | GitHub          | Once              |
| [2. Create the GitHub App](#2-create-the-github-app)                     | GitHub          | Once              |
| [3. Add the App in Floor Settings](#3-add-the-app-in-floor-settings)     | AI Office       | Once              |
| [4. Install the App](#4-install-the-app-on-the-repository)               | GitHub          | For each Floor    |
| [5. Add the Floor](#5-add-the-floor)                                     | AI Office Admin | For each Floor    |
| [6. Protect the default branch](#6-protect-the-default-branch)           | GitHub          | For each Floor    |
| [7. Check it works](#7-check-it-works)                                   | Both            | Once, then as you like |

Start with the test repository, `ai-office-sandbox`, and install the App
there only. Once it works there, a real repository is steps 4 to 6 again.

**Why a GitHub App:** the App pushes branches, opens pull requests,
posts reviews and comments, and merges. Every commit is still authored
and committed as the Owner, with an `Agent:` trailer naming the Agent
([ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md),
PRD FR-68 to FR-70). The App opens each pull request, not the Owner, so
the Owner can approve it: GitHub refuses an approval from a pull
request's own author.

---

## Before you start

- **AI Office runs, and you can sign in.** See
  [Running AI Office](../guide/running.md#running-in-development). For
  Agents to work issues they also need a sandbox image, an AI Account
  and `SANDBOX_GATEWAY_URL`
  ([Let Agents work issues](../guide/running.md#6-let-agents-work-issues-optional)).
  You can still do every step here before that; only the end of
  [step 7](#7-check-it-works) needs working Agents.
- **You know the Owner's GitHub login.** Intake only takes the Owner's
  issues. In Admin, the **Intake** card holds the Owner's GitHub login
  (`adrianeyre` by default): set it to yours before labelling anything.
  The **Git identity** card sets who commits are authored as (by default
  `adrianeyre`, with their GitHub noreply address); each Floor can
  override it in its settings.
- **Branch protection on a private repository needs a paid plan.** GitHub
  Free protects public repositories only. Private repositories need
  GitHub Pro, Team or Enterprise, for branch protection rules and
  rulesets alike. Without protection AI Office still works, but nothing
  stops a direct push to the default branch, and nothing requires CI. On
  GitHub Free, make `ai-office-sandbox` public instead: it holds nothing
  secret.
- **GitHub Actions must be able to run** on the account, since the test
  repository's CI is an Actions workflow. If billing has failed or the
  spending limit is reached, GitHub creates the checks but never starts
  them, and they fail within seconds. Check **Settings → Billing and
  plans** first.

---

## 1. Create the test repository

`ai-office-sandbox` is a tiny Node project with a passing `npm test` and
a CI workflow. AI Office's end-to-end checks and the
[contract suite](#run-the-contract-suite-against-the-real-app) work on it,
so nothing real is at risk. It has no dependencies, so there is no
lockfile to keep.

1. Create a **private** repository named `ai-office-sandbox` under your
   account (<https://github.com/new>), with a README so it has a `main`
   branch. Keep the defaults under **Settings → General → Pull
   Requests**: merge commits and squash merging both allowed.
2. Add these four files, either in GitHub's editor (**Add file → Create
   new file**) or by cloning the repository and pushing them.

`package.json`:

```json
{
  "name": "ai-office-sandbox",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

`src/add.js`:

```js
export const add = (a, b) => a + b;
```

`test/add.test.js`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { add } from "../src/add.js";

test("adds two numbers", () => {
  assert.equal(add(2, 3), 5);
});
```

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
    paths-ignore: ["ai-office-contract/**"]
  pull_request:
    paths-ignore: ["ai-office-contract/**"]

jobs:
  CI:
    name: CI
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: npm test
```

3. Open the repository's **Actions** tab and check the run on `main`
   passed, with one check named **CI**.

Why the workflow looks like this:

- **The job is named `CI`**, so [step 6](#6-protect-the-default-branch)
  can require a check of that name.
- **It ignores `ai-office-contract/`.** The contract suite only changes
  files there, and it reports its own `CI` check, which it expects to be
  the only one. With the workflow running too there would be two.

---

## 2. Create the GitHub App

Create one App for your AI Office, and install it on every repository
that will be a Floor.

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New
   GitHub App** (<https://github.com/settings/apps/new>). For repositories
   that belong to an organisation, create it in the organisation's
   **Settings → Developer settings → GitHub Apps** instead.
2. **GitHub App name:** anything unique on GitHub, such as `AI Office
   (your-login)`. Its pull requests, reviews and comments appear as
   `<app-slug>[bot]`.
3. **Homepage URL:** required by GitHub but unused. Your AI Office's
   address or its repository will do.
4. **Callback URL:** leave it empty, and leave **Request user
   authorization (OAuth) during installation** off. AI Office acts only as
   the App, never as a signed-in GitHub account.
5. **Webhook:** untick **Active**. AI Office checks for issues on a
   timer ([below](#how-intake-decides-what-to-pick-up)), webhooks or
   not. If GitHub can reach your AI Office over HTTPS at a public
   address, you can turn them on later so it acts at once; see
   [Webhooks](#webhooks-optional).
6. **Permissions:** under **Repository permissions**, set exactly the
   ones in the table below. Leave every other repository permission,
   and every organisation and account permission, at **No access**. To
   run the [contract suite](#run-the-contract-suite-against-the-real-app)
   against the real App, set **Checks** to **Read and write** instead,
   while the App is installed on `ai-office-sandbox` only.
7. **Where can this GitHub App be installed?** **Only on this account.**
8. **Create GitHub App.**

### The App's permissions

| Permission    | Access         | What AI Office does with it                                                                                                             |
| ------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Checks        | Read-only      | Reads the check runs on a pull request's head commit, for the Merge Policy's gate                                                       |
| Contents      | Read and write | Pushes each issue's branch, `ai-office/<issue>-<slug>`; creates and deletes branches; reads files, commits and branch protection; merges |
| Issues        | Read and write | Reads the Owner's issues and who labelled them; creates the labels; moves issues through the pipeline's labels; comments on issues     |
| Metadata      | Read-only      | Reads the repository and its rulesets. GitHub sets this for every App                                                                   |
| Pull requests | Read and write | Opens one pull request per issue, reads its files and diff, and posts AI reviewers' reviews                                             |

These are all AI Office asks for: `appPermissions` in
`@ai-office/github` holds the same list, and a test fails if this table
and that list disagree. AI Office also asks for no more each time it
mints an installation token, whatever the installation was granted: its
own token asks for this table (and **Workflows**, below, only if you
granted it), and the token it lists your repositories with asks for
**Metadata** alone. So a permission granted beyond the table, by mistake
or for something else, is in no token AI Office holds.

Not asked for, on purpose:

- **Administration.** AI Office never changes a repository's settings
  or its branch protection, so the protection you set below is yours to
  change, not an Agent's. The Manager may never change repository
  settings (PRD FR-23).
- **Workflows.** Without it, GitHub refuses a push that changes a file
  under `.github/workflows/`. The Agent that made the change is then
  blocked, with an action Notice saying why. Give the App **Workflows:
  Read and write** only if you want Agents to change CI, bearing in mind
  that CI is part of what lets a pull request merge automatically.
- **Commit statuses.** The Merge Policy reads check runs (which GitHub
  Actions reports), not commit statuses. A required check that reports
  only a commit status counts as never run, so the pull request goes to
  the Owner.

Agents' sandboxes never hold the App's write access. Each sandbox gets
its own short-lived installation token, for that repository alone, that
can read contents, issues, pull requests and checks and change none of
them (PRD FR-19). It is minted from the App, so it can never have more
than the table above. No two sandboxes share one, and AI Office revokes
each as its sandbox stops, so a token a sandbox sent out reads nothing
once that sandbox has gone. The Manager chat's clone and each
fact-finding run get their own the same way.

**Changing a permission later:** GitHub asks the installation to accept
it. Open **Settings → Applications → Installed GitHub Apps → Configure**
beside the App and accept the new permissions, or the App keeps the old
ones.

---

## 3. Add the App in Floor Settings

On the App's settings page (**Settings → Developer settings → GitHub Apps
→ Edit**):

1. Copy the **App ID** from the top of **General**.
2. Under **Private keys**, choose **Generate a private key**. GitHub
   downloads a `.pem` file, such as
   `ai-office-your-login.2026-10-09.private-key.pem`.

In AI Office, open **Floor Settings**. In the **GitHub** card, under
**Add a GitHub App**, give the App ID, paste the whole `.pem` file's
contents into **Private key** (a name is optional), and choose **Add
GitHub App**. It is kept in the database, the key encrypted with
`ENCRYPTION_KEY`, and never shown again: the card shows only the App ID
and the key's last characters. It is used at once, with no restart.

Repositories under another account or organisation can have an App of
their own: add each the same way. Each repository is worked through the
first App that is installed on it
([ADR 0011](../architectural-decision-record/0011-github-through-several-apps-and-access-tokens.md)).
**Disable** takes one out of use and keeps it; **Remove** forgets it.

**Or use an access token instead of an App.** Create two
[fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new)
for the repositories: one with **Contents**, **Issues** and **Pull
requests** read and write and **Commit statuses** and **Checks** read
(**Workflows** too, to let Agents change CI), and one with the same
read-only. Sandboxes are given only the read-only one, as a token cannot
make narrower ones the way an App does. Add both in the **GitHub** card,
under **Add an access token**.

AI Office then acts on GitHub as the tokens' user. Give the tokens an
expiry and only the repositories that are Floors; AI Office never revokes
them. Apps and tokens may be added together: a repository both reach is
worked through the App. On GitHub Enterprise Server, also set
`GITHUB_API_URL` to `https://<host>/api/v3` in `.env`, and restart AI
Office (or `docker compose up -d` again).

GitHub Apps and access tokens are never read from the environment: a
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_ACCESS_TOKEN` or
`GITHUB_READ_ONLY_ACCESS_TOKEN` left in `.env` from an older AI Office
stops it starting, naming the variable. Add it in Floor Settings, then
remove it from `.env`.

**The private key is a credential.** Anyone who holds it can act as the
App on every repository it is installed on. Delete the downloaded file
once the App is added, and never paste the key into an issue, a chat or
a Notice. To replace it, generate a new key, remove the App in Floor
Settings and add it again with the new key, then delete the old key on
the App's page.

---

## 4. Install the App on the repository

1. On the App's page, choose **Install App**, then the account that owns
   the repository.
2. Choose **Only select repositories**, and pick `ai-office-sandbox`
   (later, each repository that will be a Floor).
3. **Install.**

To add a repository later, open **Settings → Applications → Installed
GitHub Apps → Configure** beside the App (for an organisation, the
organisation's settings, under **GitHub Apps**), and add it under
**Repository access**.

---

## 5. Add the Floor

In AI Office, Floor Settings' **Floors** card lists the repositories the App is
installed on. Pick a **Floor Template** above them, then choose **Add
Floor** beside one (PRD FR-6). A repository is at most one Floor. If the
card says "GitHub is not set up", no GitHub App or access token is added,
or every one is disabled, in the **GitHub** card above it.

The new Floor takes its name and default branch from GitHub, and its team,
settings and labels from its template
([Floor Templates](../guide/floors-and-agents.md#floor-templates)). From
Development, the default, it starts with a Manager, a coder, a reviewer
and a QA Agent, and has the Merge Policy **Send to me**, a Round Cap of 3
and plan approval on; from Blank, with a Manager only. The other
templates run their checks as npm scripts or a tool's own commands:
file the set-up issue their Manager suggests first ("Set up the store's
checks", "Set up the infrastructure's checks", say), which makes them run
in a sandbox, and change the setup and test commands if the repository
uses pnpm or yarn, or another stack. The sandbox images carry Node and
pnpm, not the other tools: a Data & analytics Floor's setup command
installs dbt and sqlfluff from `requirements.txt` with `pip`, and an
Infrastructure Floor needs `terraform` and `checkov` on its sandbox
image, or a setup command of yours that installs them. An iOS simulator
needs macOS, so a Mobile app Floor's repository CI runs its simulator
tests too. An Infrastructure Floor
never applies: keep the cloud credentials and the remote state in your
own pipeline, never in AI Office. Its admin page
(`/floor-settings/<id>`) changes any of these. Choose its Merge Policy
there before protecting its branch, since the protection depends on it.

---

## 6. Protect the default branch

Protect each Floor's **default branch** (PRD FR-70, ADR 0002): require
CI, forbid direct pushes and, where the Floor merges automatically,
require no approval count. AI Office never changes protection itself;
you set it on GitHub, in either of two ways:

- **A branch ruleset** (**Settings → Rules → Rulesets → New ruleset →
  New branch ruleset**), targeting the default branch, with **Enforcement
  status: Active**.
- **A classic branch protection rule** (**Settings → Branches → Add
  classic branch protection rule**), with the default branch's name as
  its pattern.

AI Office reads the required checks of both. Protect the default branch
only: a rule that also covers `ai-office/*` branches can refuse the
App's pushes to them.

**For `ai-office-sandbox`,** use the settings for
[Merge automatically](#merge-automatically) below: require a pull
request with **0** approvals, require the status check **CI**, and block
force pushes and deletions. When adding the **CI** check, leave its
source as **any source** rather than GitHub Actions only, since the
contract suite reports its own `CI` check through the App.

### For every Floor

- **Require a pull request before merging.** This forbids direct pushes
  to the default branch. AI Office pushes only `ai-office/<issue>-<slug>`
  branches, so it costs nothing. In a classic rule, also tick **Do not
  allow bypassing the above settings** to hold the repository's admins
  to it.
- **Require status checks to pass**, adding each CI check by name (such
  as `test`). The Merge Policy waits for every one of them.
- **Block force pushes** and **restrict deletions** (classic: leave
  **Allow force pushes** and **Allow deletions** off).
- **Leave "Require signed commits" off.** Agents' commits are authored
  as the Owner and are not signed (ADR 0002), so GitHub would refuse to
  merge them.
- **Leave "Require linear history" off, and allow merge commits.** The
  App merges with a merge commit, so each of the Agents' commits stays
  the Owner's with its `Agent:` trailer. In **Settings → General → Pull
  Requests**, keep **Allow merge commits** on.
- **If you restrict who can push** to the default branch, allow the App.
  A merge is a push, and the App merges for both Merge Policies (for
  **Send to me**, when the Owner chooses **Approve and merge**).

### Send to me (the default)

Any approval rules work (ADR 0002). The App opened the pull request, so
the Owner can approve it as a normal reviewer. You may require approvals,
Code Owners' review or resolved conversations as you would for anyone's
pull request.

When a pull request has passed its pipeline, the Owner gets an action
Notice, "PR #N awaiting your approval". If the branch requires an
approval, approve the pull request on GitHub first, then choose
**Approve and merge** in the Notice. Otherwise GitHub refuses the App's
merge, and the Notice stays, with the reason. The AI reviewers' reviews
are comment reviews and never count as approvals.

### Merge automatically

The App merges a pull request on its own only when the Merge Policy's
gate lets it: every required reviewer Agent approved in the latest
round, no blocking comments remain, CI passed, and no Round Cap or Token
Cap was exceeded (PRD FR-29). GitHub's approval count plays no part, and
it must not be required, or no automatic merge could ever happen: the
App cannot approve its own pull request. So, on top of the rules for
every Floor:

- **Required approvals: 0** (classic: leave **Require approvals** off).
- **Leave "Require review from Code Owners" off**, and **"Require
  approval of the most recent reviewable push"** too: both are approvals.
- **Leave "Require conversation resolution before merging" off.** AI
  reviewers' comments start conversations on the pull request, and AI
  Office never resolves them, so GitHub would refuse every merge.
- **Require at least one status check.** The gate also waits for every
  check run on the pull request's head to pass. With no CI at all, it
  waits five minutes for a check to start, then sends the pull request
  to the Owner.
- **"Require branches to be up to date before merging"** can stay off.
  AI Office does not update a branch that has fallen behind, so with it
  on, GitHub refuses those merges and the pull request goes to the Owner.

Whenever the gate or GitHub holds a pull request back, it goes to the
Owner as for **Send to me**, the Notice saying why.

### At a glance

| Setting                                        | Send to me        | Merge automatically |
| ---------------------------------------------- | ----------------- | ------------------- |
| Require a pull request before merging          | On                | On                  |
| Required approvals                             | Any               | 0                   |
| Require review from Code Owners                | Any               | Off                 |
| Require conversation resolution before merging | Any               | Off                 |
| Require status checks to pass                  | On, naming CI's   | On, naming CI's     |
| Require branches to be up to date              | Any               | Off                 |
| Require signed commits                         | Off               | Off                 |
| Require linear history                         | Off               | Off                 |
| Force pushes and deletions                     | Blocked           | Blocked             |

A label overrides the Floor's Merge Policy for one issue:
`ai-office:manual` sends its pull request to the Owner, and
`ai-office:auto-merge` merges it automatically, through the same gate,
when the Owner added the label. If you will use `ai-office:auto-merge` on
a **Send to me** Floor, give it **Merge automatically**'s protection, or
GitHub refuses those merges and the pull requests come to the Owner
anyway.

---

## 7. Check it works

1. Floor Settings' **Floors** card lists the repository, and after **Add Floor**
   the Floor appears in the Office.
2. Within a minute, the repository's **Issues → Labels** has every label
   in [the table below](#labels-ai-office-creates).
3. Open a small issue with a list of acceptance criteria, and label it
   `ai-office`. Within a minute it has the Manager's triage comment and
   `needs-work`, and the Activity Feed shows it picked up.
4. Once an Agent has worked it (this needs working Agents; see
   [Before you start](#before-you-start)), the pull request is opened by
   `<app-slug>[bot]`, its commits are authored by the Owner, each with an
   `Agent:` trailer, and it waits for the **CI** check.

### Run the contract suite against the real App

The contract suite (`packages/github/src/contract.test.ts`) runs the
same tests against AI Office's fake GitHub and, when
`GITHUB_CONTRACT_APP_ID` is set, against the real App on
`ai-office-sandbox`. It is what shows the
fake behaves as GitHub does. It needs the App's **Checks** permission at
**Read and write** ([step 2](#2-create-the-github-app)), since it reports
its own `CI` check.

From the root of AI Office, with the App's ID and key (not in `.env`,
which AI Office refuses them in):

```bash
GITHUB_CONTRACT_APP_ID=123456 GITHUB_CONTRACT_APP_PRIVATE_KEY="$(cat ai-office-your-login.2026-10-09.private-key.pem)" \
  node node_modules/vitest/vitest.mjs run packages/github/src/contract.test.ts
```

Without `GITHUB_CONTRACT_APP_ID` it passes 26 tests and skips the 13 against the
real App; with it, all 39 run. To use another repository, set
`GITHUB_CONTRACT_REPOSITORY=owner/name` (the default is
`adrianeyre/ai-office-sandbox`).

What it changes on the repository: it opens issues with
`ai-office-contract-…` labels and closes them again, pushes branches
named `ai-office-contract-…` and `ai-office/<issue>-contract-…`, and
squash-merges one pull request that adds a file under
`ai-office-contract/`. So never point it at a real Floor.

**Before installing the App on a real repository,** set **Checks** back
to **Read-only** so the App has only what AI Office needs. The contract
suite then can no longer run against the real App.

---

## Labels AI Office creates

Intake creates these labels on each Floor's repository the first time
it checks the Floor after AI Office starts. A label the repository has
already is left as it is, colour and description included. The labels
on GitHub are the source of truth for where each issue is (PRD FR-18).

| Label                  | Colour    | Description                                            | What it means                                                                                                                       |
| ---------------------- | --------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ai-office`            | `#5319e7` | AI Office: work this issue                             | Asks AI Office to work the issue. It counts only when the Owner opened the issue or added the label                                  |
| `needs-work`           | `#1d76db` | AI Office: waiting for its work                        | The work Stage: an Agent in a work Role, such as a coder, changes the repository in a sandbox, and AI Office opens the pull request |
| `needs-review`         | `#0e8a16` | AI Office: waiting for review                          | The review Stage: the Floor's required reviewer Agents review the pull request, in rounds up to the Round Cap                        |
| `needs-qa`             | `#fbca04` | AI Office: waiting for QA                              | The QA Stage: an Agent in a QA Role checks the result. A Floor without one skips it                                                  |
| `needs-docs`           | `#c5def5` | AI Office: waiting for docs                            | The docs Stage: an Agent in a docs Role documents the change. A Floor without one skips it                                           |
| `ready-to-merge`       | `#2ea44f` | AI Office: passed its pipeline                         | The Merge Policy decides: the App merges, or a Notice asks the Owner                                                                 |
| `needs-human`          | `#d93f0b` | AI Office: handed to the Owner                         | A cap was reached, Roles disagreed or the work kept failing, and an action Notice says why. Only the Owner moves it on, on GitHub   |
| `in-progress`          | `#bfd4f2` | AI Office: an Agent is working on it                   | An Agent holds the issue while it works it                                                                                           |
| `ai-office:auto-merge` | `#0e8a16` | AI Office: merge automatically once every check passes | Overrides the Floor's Merge Policy: merge automatically, through the gate. Counts only when the Owner added it                      |
| `ai-office:manual`     | `#d4c5f9` | AI Office: send the pull request to the Owner to merge | Overrides the Floor's Merge Policy: send the pull request to the Owner. Anyone's counts, since it only asks for the Owner           |

Add `ai-office` and the two Merge Policy labels yourself. Leave the
Stage labels and `in-progress` to AI Office, except to move an issue
out of `needs-human` once you have dealt with it. An issue with two
Stage labels is refused rather than guessed at.

The four Stage labels are the Stages', not any Role's: whichever Role an
Agent fills, it works issues at its Role's Stage
([ADR 0003](../architectural-decision-record/0003-roles-are-data-on-four-fixed-stages.md)).
`needs-work` was called `needs-code` before Roles were data. On a Floor
added before then, AI Office renames the repository's `needs-code`
label to `needs-work` when it starts, and intake tries again if GitHub
could not be reached. GitHub keeps a renamed label on its issues, so
issues waiting for work keep their place. A repository that already has
both labels keeps both, and its `needs-code` issues stay where they are
until you move them to `needs-work` yourself.

Intake also creates a `role:<name>` label (`#bfdadc`, "AI Office: work
this issue as the <name>") for each work Role on the Floor's team, such
as `role:coder`, and one for a work Role added to the team later. Add
one to an issue to choose the Role that works it; on a Floor with
several work Roles, the Manager otherwise chooses, or asks you with a
Notice when it cannot tell (see
[the issue pipeline](../guide/issue-pipeline.md#routing-between-work-roles)).
A Role renamed in the library gets a label under its new name; the old
one stays on the repository.

A Floor Template may bring labels of its own, such as a store's
`product`. They are created when the Floor is added from it, and mean
nothing to the pipeline. None of the built-in templates brings any.

---

## How intake decides what to pick up

Every 60 seconds by default (General Settings' **Intake** card sets 10 seconds to
an hour; PRD FR-8), AI Office checks each Floor that is not archived:

1. **It lists the open issues labelled `ai-office`**, oldest first.
   Pull requests, closed issues and issues without the label are never
   picked up.
2. **It skips issues already in the pipeline**: any with a Stage label,
   `ready-to-merge` or `needs-human`. Those are the pipeline's business.
3. **It takes only the Owner's issues.** Issue text is untrusted (PRD
   §4). An issue counts if the Owner opened it, or if the most recent
   time `ai-office` was added to it, the Owner added it, as the Owner's
   GitHub login on the **Intake** card. Anyone else's issue is ignored,
   with no comment, until the Owner labels it.
4. **The Manager triages it.** It checks the issue is clear enough to
   work (acceptance criteria, and a scope one Agent can finish in one
   pull request) and sets its priority. Its decision is a comment on the
   issue.
   - **Clear:** the issue is labelled `needs-work`, recorded in the
     Activity Feed as picked up, and queued for an Agent in the work
     Stage, such as a coder.
   - **Unclear:** it waits, out of the pipeline. The Owner gets an action
     Notice, "Unclear issue needs your input", and the issue gets the
     Manager's questions. Edit the issue to have it triaged again, or
     choose **Work it as it is** in the Notice.

Naming issues to the Manager instead ("complete issues 1 to 5" in the
Manager chat) makes a Batch of them, with a Plan to approve; see
[Batches and Plans](../guide/batches-and-memory.md#batches-and-plans).

### Webhooks (optional)

When GitHub can reach your AI Office, the App's webhooks have it act on
an issue, a label, a pull request or a check as it happens, rather than
at the next check (PRD FR-8). The timer carries on regardless, so a
lost delivery only costs the wait. Webhooks decide when AI Office looks,
never what it does: it still reads the labels and the issue from GitHub,
and takes in only the Owner's issues.

1. **Choose a secret:** a random string of at least 20 characters, such
   as the output of `openssl rand -hex 32`.
2. **In AI Office:** General Settings' **GitHub webhooks** card. Tick **Take the
   GitHub App's webhooks**, enter the secret, and save. The secret is
   kept encrypted and never shown again; leave the field empty later to
   keep it.
3. **On the App** (**Settings → Developer settings → GitHub Apps → your
   App → General**, under **Webhook**):
   - **Active:** ticked.
   - **Webhook URL:** your AI Office's address followed by
     `/api/github/webhooks`, such as
     `https://ai-office.example.com/api/github/webhooks`. The card shows
     it.
   - **Webhook secret:** the same secret.
   - **SSL verification:** enabled.
4. **On the App's Permissions & events page**, under **Subscribe to
   events**, tick **Issues**, **Label**, **Push**, **Pull request**,
   **Check run** and **Check suite**. The permissions in the table above
   already allow them.

| Delivery                                                   | What AI Office does at once                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| An issue opened, reopened, labelled, edited or transferred | Runs intake                                                      |
| A pipeline label deleted or renamed on the repository      | Creates the pipeline's labels again, then runs intake            |
| An issue or pull request closed                            | Checks the open Batches for issues whose dependencies are done   |
| A pull request opened or pushed to, a check run or suite   | Has the Merge Policy look at CI again, if it is waiting for it   |
| A push, a pull request change, a check run or suite        | Has the Branches page read the Floor's branches again            |

A delivery whose `X-Hub-Signature-256` does not match the secret is
refused with `401`, and nothing reads it. While webhooks are off in
Admin, `/api/github/webhooks` answers `404`. Deliveries about a
repository that is not a Floor in use are accepted and ignored. GitHub's
**Recent Deliveries** tab, on the App's **Advanced** page, shows each
delivery and AI Office's answer; **Redeliver** sends one again. Each
delivery is acted on once: one AI Office already took (answered `202`)
starts nothing when it comes again, redelivered or replayed, whatever
its `X-GitHub-Delivery`. Redelivering one it refused (a `401` or `404`)
works once the cause is fixed.

One sender whose deliveries keep failing the signature check (20 in ten
minutes) is refused with `429` until ten minutes after its first, before
anything is verified, and only that sender: the warnings in the server's
log stop at the twentieth, which says so. A delivery that verifies
forgets its sender's failures, and saving the **GitHub webhooks** card
forgets every sender's, so GitHub's own deliveries, which come from
GitHub's addresses, are never refused for what a forger sent. Behind
Caddy, set `TRUST_PROXY` as the deployment guide says, or every sender
looks like Caddy.

---

## Troubleshooting

| Symptom                                                        | Cause                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The server warns at start, naming `GITHUB_APP_ID` or `GITHUB_ACCESS_TOKEN` | It is no longer read: add the App or token in Floor Settings' **GitHub** card (step 3), then remove it from `.env` |
| **Add GitHub App** says the private key is not the App's PEM file | Paste the whole `.pem` file, from `-----BEGIN` to `-----END … PRIVATE KEY-----` |
| **Add GitHub App** says the App is added already                 | An App of that ID is in the **GitHub** card: remove it first to replace its key |
| **Add an access token** says the read-only token must be another | The same token was given twice: create a second, read-only one |
| Every CI check fails within seconds, with no log               | GitHub Actions did not start: billing failed or the spending limit was reached (**Settings → Billing and plans**)             |
| The contract suite fails with `403` creating a check run       | The App's **Checks** permission is **Read-only**: set it to **Read and write**, and accept the change on the installation     |
| The contract suite finds two `CI` checks on one commit         | The test repository's workflow ran on the suite's commits: add the `paths-ignore` from step 1                                 |
| The contract suite cannot merge its pull request               | The required **CI** check is limited to GitHub Actions: allow any source, as in step 6                                        |
| A repository is missing from Floor Settings' Floors card               | The App is not installed on it. Add it under the installation's **Repository access**                                        |
| An issue labelled `ai-office` is never picked up               | It is not the Owner's (check the login on the **Intake** card), it already has a Stage label, or it is waiting on triage     |
| GitHub's **Recent Deliveries** show `401`                      | The secret on the App and on General Settings' **GitHub webhooks** card differ: set the same one in both                               |
| GitHub's **Recent Deliveries** show `404`                      | Webhooks are off on General Settings' **GitHub webhooks** card                                                                         |
| GitHub's **Recent Deliveries** show `429`                      | GitHub's address sent 20 deliveries that failed the signature check (the secrets differ): set the same one in both, and save |
| No labels appear on the repository                             | The App lacks **Issues: Read and write**, or the Floor is archived                                                           |
| "Agent blocked" after a push was refused                       | The change touched `.github/workflows/` and the App has no **Workflows** permission, or a rule protects `ai-office/*` branches |
| A pull request always goes to the Owner on an auto-merge Floor | The Notice says why: CI failed or never ran, an approval is required, or GitHub refused the merge (see the table above)      |
| **Approve and merge** fails, and the Notice stays              | The branch requires an approval: approve the pull request on GitHub first                                                     |
| **Approve and merge** closes the Notice without merging        | The branch moved on since the Notice was raised (a new Notice asks about the new head), or the issue left `ready-to-merge` |

## See also

- [ADR 0002](../architectural-decision-record/0002-github-app-acts-commits-authored-as-owner.md):
  why a GitHub App acts and commits are the Owner's
- [PRD §6.2, §6.5, §6.6 and §6.13](../product-requirements-document/ai-office.md):
  Floors and intake, the pipeline, the Merge Policy and Git identity
- The guide's [Issue intake and the pipeline](../guide/issue-pipeline.md#issue-intake-and-the-pipeline)
  and [The Merge Policy](../guide/issue-pipeline.md#the-merge-policy), for
  how each part works inside AI Office
- [Deploying to EC2](deploying-to-ec2.md), for running AI Office where
  GitHub's webhooks can reach it
