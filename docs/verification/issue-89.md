# Issue #89: Bookshelf inspectable — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker) against a fresh `git clone` of this branch at `f53d9e7` (every
code commit of the issue), after `pnpm install --frozen-lockfile`. The
Postgres runs were made in that clone with a scratch edit (below); the
sabotage, Playwright and browser runs in the working tree, holding the
same code. This builds on #67 (the generic inspectable object, whose
bookshelf said "This Floor's memory will be shown here"), #87
(repository memory) and #88 (office-wide and Role memory).

## What was built

### The repository's memory, read for the bookshelf (`packages/shared`, `packages/orchestrator`)

- **`repositoryMemorySchema`** (`memory.ts`): the Floor's `repository`
  and `branch`, the memory's `content` (null when there is none or it was
  not read), whether it was `truncated`, the `readError` saying why it
  was not read, the `proposals` waiting for the Manager's next curation
  (text, issue, Agent, when) and the `pullRequest` of the Manager's
  latest curation. **`maxShownMemoryLength`** is 12,000 characters, the
  same as an Agent's prompt carries (`maxMemoryCharacters` is now defined
  from it).
- **`createRepositoryMemoryShelf({ floors, store, github?, redactor? })`**
  (`memory/bookshelf.ts`) gives `show(floorId)`: the memory read as every
  Agent reads it (`readMemoryFile`, now shared with
  `createRepositoryMemory.read`: `.agents/MEMORY.md` at the default
  branch through the GitHub App, redacted, blanks as none), cut at 12,000
  characters, with the proposals waiting and the latest curation's pull
  request. Without the GitHub App it says "The GitHub App is not set up,
  so the repository's memory cannot be read."; when GitHub refuses, "The
  repository's memory could not be read from GitHub: …" (redacted). A
  Floor that does not exist is a `FloorError`. It only reads.

### The server (`apps/server`)

`GET /api/floors/:floorId/repository-memory` (`access: "owner"`) answers
the schema above, `404` for no such Floor; a read error is logged as a
warning and answered in the body. `buildApp` makes the shelf from its
stores, the GitHub App when configured, and the server's redactor (so the
Owner's own secrets are redacted, whatever their shape).

### The web app (`apps/web`)

- **`Bookshelf`** (`bookshelf.tsx`), the bookshelf's panel
  (`inspectorPanels.bookshelf`, replacing #67's placeholder; scrolls
  within 60% of the view, as the whiteboard's does). Three sections,
  each a region named by its heading:
  - **The repository's memory**: where it is (`.agents/MEMORY.md on
    main`), the memory as written in a `<pre>` (memory is untrusted text,
    so it is never rendered), "Only the first 12,000 characters are
    shown, as Agents read them." when cut, the proposals waiting (each
    with its Agent's name and issue), **Edit the repository's memory on
    GitHub** (GitHub's editor at the default branch, or a new file there
    when there is none; in a new tab) and **The Manager's memory pull
    request #N**. A read error is shown as an alert, without a GitHub
    link.
  - **Role memory**: each Role's accepted entries (never proposed,
    rejected or removed ones), "N proposals wait for the Manager or
    you.", and **Edit the Role memory** → `/admin/floors/<floor>#role-memory`.
  - **Office-wide memory**: as written, or "There is no office-wide
    memory yet.", and **Edit the office-wide memory** →
    `/admin#office-wide-memory`.
  
  Links into AI Office open without a reload (the panel's `navigate`).
  The panel follows `memory.proposed`, `memory.curated`,
  `memory.role_proposed`, `memory.role_changed` and
  `memory.office_changed` on one live stream, reading again only the
  memory each event is about, and ignoring other Floors' events.
- **Anchors** (`anchor.ts`, `useAnchor`): the Office-wide memory card and
  the Role memory card have the ids the links name, and are brought into
  view when the address ends with them, as they are shown, and kept in
  view while the page above them grows (a `ResizeObserver` on the page),
  until the Owner scrolls, types or clicks, or for five seconds.
- `PageLink` moved from `scene/inspector-panels.tsx` to `page-link.tsx`,
  unchanged, so the bookshelf can use it without an import cycle.

### Docs

README: "The bookshelf: a Floor's memory" (new, under Office-wide and
Role memory), and the 3D Office's "Panels by type".

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 from the fresh clone at `f53d9e7` (output below). Without
      Docker the Postgres tests skip with the reason (2321 passed, 347
      skipped). Against an embedded Postgres 18.4, 2648 passed and 20
      skipped (the real-App GitHub contract and the Docker image and
      compose checks, as in #87 and #88). An earlier Postgres run, before
      the last two commits, had two timeouts in the 3D scene's
      `floor-layout.test.ts` (5 s; host load average 70 on 16 cores), the
      same file and failure #88 recorded; that file passed alone (77
      tests) and in every later full run, and this issue does not touch
      it.

**What "What to build" asks, and how it was checked** (beyond the
criterion above):

- **Each Floor's bookshelf opens a panel with the repository memory, the
  Role memory and the office-wide memory, with links to edit them.**
  - `apps/web/src/bookshelf.test.tsx` (5 tests): the panel opened from
    the Floor's bookshelf object (`floorInspectables`) through the real
    `InspectorPanel`, against a stubbed server. Its three sections in
    order; the repository's memory as written, on `main`, with the
    proposal "(Ada, on #7)", the GitHub edit and pull request links;
    the coder's and QA's accepted entries only, and "1 proposal waits";
    the office-wide memory as written; the two in-app links, which call
    `navigate` with their address; the GitHub link opens in a new tab.
    Then: no memory file (on `release/2`) links to GitHub's new-file
    page, and empty Role and office-wide memory say so; a read error is
    an alert with no GitHub link, the other links still there; a cut
    memory says so; and the live stream (one, for the five `memory.*`
    types): another Floor's event reads nothing again, `memory.curated`
    reads the repository's memory again, `memory.role_changed` the Role
    memory, `memory.office_changed` the office-wide memory.
  - `scene/office-view.test.tsx` > "opens the right panel for each type
    of object selected in the scene": selecting the bookshelf in the real
    `OfficeView` opens the bookshelf's panel, showing "The repository's
    memory" and linking to edit the Role and office-wide memory. (Its
    `panel()` helper now reads the dialog's own heading, level 2, since
    the bookshelf's sections have headings of their own.)
  - `role-memory-card.test.tsx` and `office-memory-card.test.tsx`: each
    card is brought into view when the address names it, and only then;
    the Role memory card is brought back into view as the page grows, and
    no longer once the Owner scrolls.
  - `packages/orchestrator/src/memory/bookshelf.test.ts` (5 cases, **in
    memory and in Postgres 18**): the memory at the default branch,
    redacted (an Anthropic key becomes `[REDACTED]`, in nothing
    answered), with a proposal waiting and the latest curation's pull
    request; none, with no pull request; without the GitHub App, and with
    an App not installed on the repository, `readError` says why; a
    14,999-character memory is cut at 12,000; an unknown Floor is a
    `FloorError`.
  - `apps/server/src/memory/routes.test.ts` (**in memory and in Postgres
    18**): the route answers none, then the memory pushed to `main`
    with a leaked key and one of the Owner's own opaque secrets both
    `[REDACTED]` and neither anywhere in the body, and the proposal
    waiting; `404` for no Floor; `401` signed out. Without the GitHub
    App, it answers the reason.

**Negative checks.** Each sabotage was applied to the working tree, run
on the six test files above (orchestrator, server and web, in memory and
in Postgres; 55 tests, 56 with the last), and reverted with `git
checkout` (`git status` clean afterwards).

| Sabotage | Failed |
| --- | --- |
| The bookshelf's panel is #67's placeholder again | 6 |
| The repository's memory is not redacted | 4 (the orchestrator's and the API's, each store) |
| The server's shelf is not given the redactor (the Owner's own secrets) | 2 (the API's, each store) |
| The repository's memory is not cut | 2 (each store) |
| The Role memory shows proposed and rejected entries too | 1 |
| No link to edit the office-wide memory | 3 |
| A missing memory file links to GitHub's editor, not a new file | 1 |
| Another Floor's memory events are not ignored | 1 |
| The bookshelf does not follow memory events | 1 |
| A card the address names is not brought into view | 2 |
| A card is not brought back into view as the page grows | 1 |

**In a real browser.** `pnpm e2e` (Playwright, Chromium 156, the built
app, the real server and the embedded Postgres 18.4 through
`E2E_POSTGRES_URL`) passes all 25 tests at `f53d9e7` (output below), so
the server starts with the new route. A throwaway spec (deleted
afterwards, not committed) then used the same harness: the fake GitHub's
`main` held a memory with an Anthropic key, the Floor was added and an
office-wide memory saved in Admin, and
`/?floor=web-shop&inspect=bookshelf:web-shop` was opened. The panel
showed the memory with `Deploy with [REDACTED].` (the key nowhere in the
panel), "No Role has memory yet." and the office-wide memory, and its
links were exactly:

```text
[["Edit the repository's memory on GitHub","https://github.com/adrianeyre/web-shop/edit/main/.agents/MEMORY.md"],
 ["Edit the Role memory","/admin/floors/web-shop#role-memory"],
 ["Edit the office-wide memory","/admin#office-wide-memory"]]
```

Its screenshot shows the bookshelf close in, with the panel beside it.
Following **Edit the office-wide memory** reached `/admin#office-wide-memory`,
but the first time **the card was not in view**: it had been scrolled
to, and then the cards above it (AI Accounts, Gateway Keys and others)
loaded and pushed it down. That is what `1b0e43a` fixed (the card is kept
in view as the page grows), with the unit test above. Run again, both
links landed with their card in the viewport (Playwright's
`toBeInViewport`), which the screenshots show.

### Not verifiable in this sandbox

- **Testcontainers:** the Testcontainers path of the Postgres tests and
  of `pnpm e2e` needs Docker. Both ran against an embedded Postgres 18.4
  instead (`@embedded-postgres/linux-x64@18.4.0-beta.17` in `/tmp`, port
  54329; the Vitest fixture pointed at it by a scratch edit to
  `packages/db/src/testing/postgres.ts`, made in the clone and reverted,
  never committed), and run in CI.
- **Chromium's system libraries**, which the sandbox lacks (NSS, ATK,
  X11 and others), were extracted from Debian bookworm's packages into
  `/tmp/chromelibs` and used through `LD_LIBRARY_PATH`; nothing was
  installed or committed.
- **GitHub's own editor.** That GitHub's `edit/` and `new/` pages open on
  a real repository, and offer a pull request where the default branch
  is protected, is GitHub's behaviour, for the host. Here the links are
  checked as addresses.
- **The look and feel** of the panel on the host's GPU, and its frame
  rate, are for the host (PRD §9). Here it was rendered by SwiftShader.

## Notes

- **Repository memory is edited on GitHub, not in AI Office.** FR-53 says
  it "changes only through pull requests that the Manager curates", and
  the bookshelf only reads it. The edit link opens GitHub's editor at the
  default branch; with the branch protected as FR-70's setup guide says,
  GitHub proposes the Owner's change as a pull request. That is a pull
  request the Owner writes, not one the Manager curates: the Manager's
  next curation reads the memory as merged. If the PRD means the Owner
  should not edit it at all, the link should go; say so on the issue.
- **What "the Role memory" shows** on the bookshelf: each Role's accepted
  entries, which Agents read, and a count of the proposals waiting.
  Deciding proposals and removing entries stays in the Floor admin, where
  the link goes, so the bookshelf has one place to edit each memory and
  no second set of buttons.
- **The latest curation's pull request** may since have been merged or
  closed; the bookshelf links it without asking GitHub which, as the
  Notice that announced it does.
- **One read per open panel.** The repository's memory is read from
  GitHub each time the panel opens (and on its events), not cached by
  the server.

## Outside this issue

- **Skills on the Manager's bookshelf** (#92), as the issue says.
- **The 2D route.** The whiteboard has a page of its own
  (`/floors/:floorId/whiteboard`); the bookshelf is reached in the 3D
  Office only (by click, the **Inspect** list, or
  `/?floor=<floor>&inspect=bookshelf:<floor>`). Browsers without WebGL 2
  cannot see it, though each memory is still edited where the links go.
  A `/floors/:floorId/bookshelf` page would be a small follow-up.
- **Agent names** in the panel are text, not links: `AgentLink` needs the
  router, which the panel's tests do not mount, and FR-63's "clicking an
  Agent's name flies the camera to it" is not built anywhere yet.
- **`needs-code` vs `needs-work`** (ADR 0003): unchanged here, as in #79
  to #88.

## Output

### Fresh clone at `f53d9e7`

```text
$ git clone -q /home/agent/workspace /tmp/clone89 && cd /tmp/clone89 && git log --oneline -1
f53d9e7 docs: the bookshelf's links keep their card in view

$ pnpm install --frozen-lockfile
Done in 3.7s using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
packages/orchestrator typecheck: Done
apps/server typecheck$ tsc
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  204 passed (204)
      Tests  2321 passed | 347 skipped (2668)
test exit=0
```

### Against the embedded Postgres 18.4

The first run (working tree, before `1b0e43a`), under load:

```text
$ SCRATCH_PG_URL=… pnpm test
     × keep every path of 8 Agents' Floor clear of furniture and walls 5374ms
     × keep every path of 9 Agents' Floor clear of furniture and walls 5331ms
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 8 Agents' Floor clear of furniture and walls
 FAIL  |@ai-office/web| src/scene/floor-layout.test.ts > a Floor's waypoints > keep every path of 9 Agents' Floor clear of furniture and walls
 Test Files  1 failed | 203 passed (204)
      Tests  2 failed | 2645 passed | 20 skipped (2667)
exit=1

$ cat /proc/loadavg; nproc
70.07 52.53 39.16 39/31472 25216
16
$ pnpm vitest run --project @ai-office/web src/scene/floor-layout.test.ts
 Test Files  1 passed (1)
      Tests  77 passed (77)
```

The next full run (working tree), then the fresh clone at `f53d9e7`:

```text
$ SCRATCH_PG_URL=… pnpm test
 Test Files  204 passed (204)
      Tests  2647 passed | 20 skipped (2667)
exit=0

$ SCRATCH_PG_URL=… pnpm test   (clone at f53d9e7)
 Test Files  204 passed (204)
      Tests  2648 passed | 20 skipped (2668)
exit=0
```

### The new tests (verbose, Postgres 18.4, clone at `f53d9e7`)

`SCRATCH_PG_URL=… pnpm vitest run --project @ai-office/orchestrator
--project @ai-office/server --project @ai-office/web
src/memory/bookshelf.test.ts src/memory/routes.test.ts
src/bookshelf.test.tsx src/role-memory-card.test.tsx
src/office-memory-card.test.tsx src/scene/office-view.test.tsx
--reporter=verbose`: 56 passed in 6 files. The tests this issue added
or changed:

```text
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in memory > is the memory on the default branch, redacted, with the proposals waiting and the Manager's latest pull request
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in memory > is none when the repository keeps no memory, and no curation has opened a pull request
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in memory > says why when it cannot be read: no GitHub App, or GitHub refused
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in memory > cuts a long memory where an Agent's prompt does, saying so
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in memory > is refused for a Floor that does not exist
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in Postgres 18 > is the memory on the default branch, redacted, with the proposals waiting and the Manager's latest pull request
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in Postgres 18 > is none when the repository keeps no memory, and no curation has opened a pull request
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in Postgres 18 > says why when it cannot be read: no GitHub App, or GitHub refused
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in Postgres 18 > cuts a long memory where an Agent's prompt does, saying so
 ✓ |@ai-office/orchestrator| src/memory/bookshelf.test.ts > the bookshelf's repository memory, in Postgres 18 > is refused for a Floor that does not exist
 ✓ |@ai-office/server| src/memory/routes.test.ts > office-wide and Role memory's API, in memory > a Floor's bookshelf reads its repository memory from the default branch, redacted, with the proposals waiting for the Manager
 ✓ |@ai-office/server| src/memory/routes.test.ts > office-wide and Role memory's API, in Postgres 18 > a Floor's bookshelf reads its repository memory from the default branch, redacted, with the proposals waiting for the Manager
 ✓ |@ai-office/server| src/memory/routes.test.ts > a Floor's repository memory without the GitHub App > is not read, saying why
 ✓ |@ai-office/web| src/bookshelf.test.tsx > a Floor's bookshelf > shows the repository's memory, the Role memory and the office-wide memory, with links to edit each
 ✓ |@ai-office/web| src/bookshelf.test.tsx > a Floor's bookshelf > links to create the repository's memory when it has none, and says when there is none of the others
 ✓ |@ai-office/web| src/bookshelf.test.tsx > a Floor's bookshelf > says why the repository's memory could not be read, and still links to edit the rest
 ✓ |@ai-office/web| src/bookshelf.test.tsx > a Floor's bookshelf > says when only part of a long memory is shown
 ✓ |@ai-office/web| src/bookshelf.test.tsx > a Floor's bookshelf > changes live as the memory's events arrive, for this Floor or the whole Office
 ✓ |@ai-office/web| src/role-memory-card.test.tsx > a Floor's Role memory in its admin > is brought into view when the address names it, as the bookshelf's link does
 ✓ |@ai-office/web| src/role-memory-card.test.tsx > a Floor's Role memory in its admin > is kept in view while the page above it grows, until the Owner scrolls
 ✓ |@ai-office/web| src/office-memory-card.test.tsx > the office-wide memory in Admin > is brought into view when the address names it, as the bookshelf's link does
 ✓ |@ai-office/web| src/scene/office-view.test.tsx > inspectable objects > opens the right panel for each type of object selected in the scene
```

### Playwright, at `f53d9e7`

```text
$ LD_LIBRARY_PATH=/tmp/chromelibs/… E2E_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm e2e
  25 passed (29.0s)
exit=0
```

An earlier run (before `1b0e43a`, with only Chromium's headless shell
installed) failed 2 of 25 for reasons that were not this issue's: the
notifications test needs the full Chromium (`Executable doesn't exist at
…/chromium-1248/chrome-linux64/chrome`; installed, then fine), and the
whiteboard spec waited 5 s for "Batch 1: In progress" in the 3D Office,
whose failure screenshot shows the heading there, arrived late. The next
full run passed all 25, as did the one above.
