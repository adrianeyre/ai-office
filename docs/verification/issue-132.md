# Issue #132: Google Docs, Slides and Drive Wrap-up reports — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in the working tree of this branch, clean at
`9ae3ad8` (the code is in `cd0e247`, `2745a77`, `6e22062`, `11386d1` and
`9ae3ad8`, the guide in `110b521`): `pnpm lint`, `pnpm typecheck`,
`pnpm test` and `drizzle-kit generate`. After them only Markdown changed
(`54ffdf6`, a sentence in the guide, and this note), which `prettier
--check .` passes.

The blockers are built on this branch: #130, Wrap-up reports to
publishing destinations ([`issue-130.md`](issue-130.md)), whose report
Markdown, detail levels, redaction and `publicationsTo` these
destinations are sent; and #131, Google sign-in
([`issue-131.md`](issue-131.md)), whose OAuth client, minimal scopes,
token refresh and revoked-grant handling they publish through.

## What was built

### Connections (`packages/shared` `connections.ts`, `google.ts`; `packages/db`)

- `connectionTypes` gains **`google_docs`**, **`google_slides`** and
  **`google_drive`**: publishing destinations (not work logs) and Google
  Connections, each naming a **Google Drive folder** by its address
  (`https://drive.google.com/drive/folders/…`) or its id
  (`googleFolderCredentialsSchema`). The folder is not secret; the tokens
  stay with the sign-in.
- **Changelog**: the new `changelogTypes` / `keepsChangelog` are
  Confluence, Notion and Google Docs (FR-92). `rulesFor` keeps a
  changelog off for Slides and Drive, whatever is asked.
- **Scopes**: `googleServices` gains `docs`, `slides` and `drive`, each
  needing only `https://www.googleapis.com/auth/drive` (see Notes).
- **Migration `0075_google_docs_slides_drive`** widens the
  `connections_type` check.

### The transports (`packages/communications` `transports/google-*.ts`, `pdf.ts`, `deck.ts`)

- **`google-api.ts`**: Drive, Docs and Slides calls with the sign-in's
  access token, refreshed once on a 401. It handles Drive's search by
  parent and private property (`appProperties`), multipart upload in one
  request, and metadata-only create. Errors carry no token: "The Google
  account signed in may not do that: share the folder with that account,
  as an editor (403).", a 404 naming the folder, and a rate limit (429,
  or a 403 `rateLimitExceeded`) with its `Retry-After`.
- **Google Docs**: each finished Batch's report becomes a document
  titled as the report, made in **one request**: the report's Markdown,
  written as HTML (`confluenceStorage`, every text escaped), is uploaded
  with the document MIME type so Drive converts it. With **A running
  changelog**, each merged pull request is appended through the Docs
  API to one "AI Office changelog" document in the folder, made with the
  first entry. The entry reads "2026-10-10 · Web shop · Pull request #15
  merged…", with its date bold and its title linking the pull request.
  The style of the text before it is cleared first, and the write names
  the revision it read (`requiredRevisionId`).
- **Google Slides**: a short deck (`deck.ts`, read from the report's own
  Markdown by its section headings, now constants in `reportSections`).
  It has a title slide (the title, when it finished with counts, tokens
  and cost, and a link to the Wrap-up), **Outcomes** (the Summary),
  **Issues and pull requests** (outcome and pull request per issue, links
  kept) and **Tokens and cost** (the total in bold, then each issue's),
  eight lines to a slide. Drive makes the deck in the folder; its slides
  go in one `batchUpdate` (applied whole or not at all), with slide and
  placeholder ids AI Office chooses (`aio_s0`…), and the slide Google
  made it with is deleted.
- **Google Drive**: the report saved as `<title>.md` (the Markdown) and
  `<title>.pdf`. The PDF writer (`pdf.ts`) needs no dependency. It
  writes A4 pages in Helvetica (WinAnsi), with bold headings, wrapped
  paragraphs, numbered and bulleted lists, and the Results table with
  grid lines and columns sized to their text. Each link is a URI
  annotation. The file is ASCII throughout.
- **Exactly once**: every file carries a private property with its
  delivery's id, which stays the same on every attempt. The folder is
  searched for it before anything is made, and a deck is checked for its
  `aio_` slides before they are written. A changelog entry is looked for
  by its pull request's link. A retry after a lost answer therefore
  makes no second document, deck, file, slide or entry.
- **Send test** only reads the folder (`GET /drive/v3/files/<id>`) and
  writes nothing. A file's address says "That Google Drive address is a
  file, not a folder: give a folder's."
- **The fake** (`serveFakeGoogle`, now with `folders` and `apiUrls`;
  `google-workspace-fakes.ts`):
  - **Drive**: folders and files with private properties, `q` search,
    multipart uploads (HTML converted into a document), and metadata
    creates; a missing folder is a 404.
  - **Docs**: a document's characters with bold, links, paragraph styles
    and a revision. `insertText` takes on the style before it, as Google
    does, and `updateTextStyle` changes it; a stale `requiredRevisionId`
    is a 400.
  - **Slides**: slides and their layouts' placeholders, with
    `createSlide`, `insertText`, `updateTextStyle` and `deleteObject`;
    each batch is applied whole or refused with a 400.
  - **All three**: only tokens with the `drive` scope are accepted, and a
    write can be carried out with its answer lost. `readPdf` (in the same
    testing module) reads a PDF back and checks its structure as it goes:
    the header, every cross-reference offset, the page tree, stream
    lengths and ASCII. It returns the title, each page's lines (cells
    separated by ` | `), its bold text and its links.

### The server, the web app and the docs

- The server needed no change: `defaultTransports({ google })` gives the
  three their transports. `routes.test.ts` gains a case adding each
  through the API.
- **Web** (`connections-page.tsx`, `google-sign-in.tsx`):
  - The add form offers the three types, each with one field, **Folder
    address or id**, and a hint.
  - The rules describe a document, a deck, or Markdown and PDF files.
    Only Docs offers the changelog checkbox; switching to Slides or Drive
    resets the rules.
  - A Connection's rules read "Wrap-up decks" or "Wrap-up reports as
    Markdown and PDF files", and Send test says "the folder can be read".
  - The Google sign-in card names Docs, Slides and Drive.
- **Docs**: [`notices-and-skills.md`](../guide/notices-and-skills.md) has
  a new "Google Docs, Google Slides and Google Drive" entry, Drive's
  scope in "Google sign-in", and the API's shapes. The README's and the
  guide index's lines are updated.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below): 366 test files, 4090 tests passed, 551
      skipped. `drizzle-kit generate` finds nothing more to generate.
- [x] **Contract tests against fake Docs, Slides and Drive APIs: one
      artefact per Batch each, idempotent on retry, detail level and
      redaction applied.** They are in
      `packages/communications/src/transports/google-publishing.test.ts`
      (10 tests). Each runs the real Communications Agent, Google sign-in
      (signed in through the fake's consent screen), memory queue and
      event bus against `serveFakeGoogle`.
  - **One document per Batch, idempotent.** The upload's answer is lost:
    the document is made, but the delivery fails ("Google Drive answered
    502: Bad gateway."). The retry finds it by its delivery's id, so the
    folder holds exactly one document, named "AI Office: Batch 3 Wrap-up
    (Web shop)". The only write was one upload. Its paragraphs are
    compared one by one, with their styles: the heading, the summary
    line, the Summary, the Plan, the Results rows cell by cell, the
    Total, what was left out, and the link to the Wrap-up. Its ten links
    are compared too.
  - **The changelog, once per merge.** Three merges on web-shop and one
    on another Floor (outside its Floors) give one "AI Office changelog"
    document holding three entries in order, each pull request once. The
    third entry's answer is lost and retried without a second entry.
    Each entry's runs are compared: the date bold, the Floor plain (not
    a link taken on from the entry before), and the title linking its
    pull request. A second Docs Connection without a changelog was sent
    nothing.
  - **One deck per Batch, idempotent.** The deck's answer is lost, then
    its slides' answer is lost; the third attempt finds both and writes
    nothing. That makes one deck, one create and one `batchUpdate`. Its
    four slides are compared with their layouts, every placeholder's
    text, every link and the bold Total, and Google's own first slide is
    gone.
  - **One Markdown and one PDF file per Batch, idempotent.** The Markdown
    file's answer is lost; the retry saves only the PDF, making two
    files and two uploads. The Markdown is exactly the delivery's
    report. The PDF reads back with the report's title, its lines (the
    Plan item, a Results row cell by cell, the Wrap-up link) and its ten
    links, in order.
  - **Detail level and redaction**, across all four artefacts (the
    document, the deck, the Markdown read as a reader shows it, and the
    PDF):
    - **Titles and summaries**: no `sk-ant-` anywhere and `[REDACTED]`
      in each. The planted `**now** [click](https://evil.example)` title
      and the Model's `[Open](https://evil.example)` are text, with no
      link to `evil.example` in any of them. The Floor, the Agents and
      the reason are named where the report names them. The Model was
      asked once for all three Connections, with the title already
      redacted.
    - **Links only**: none of the Floor's name, an issue title, an
      Agent, the reason or the Model's summary appears in any artefact.
      The names are "AI Office: Batch 3 Wrap-up" (and `.md`, `.pdf`),
      the counts and the pull request and Wrap-up links remain, and the
      Model was never asked.

  **Sabotage**, each restored after with `git checkout`, and each
  failing its test:
  - Docs: no look-up before making the report's document.
  - Docs: no look-up of a changelog entry's link.
  - Docs: the style before an entry not cleared (its Floor became a
    link).
  - Slides: no look for its slides before writing them.
  - Drive: no look-up of the files already saved.
  - `docs` asking for the `documents` scope as well.

  Restored: 10 passed.

**Beyond the criteria:**

- **Sign-in and failures.** With Docs, Slides and Drive Connections the
  consent screen asks for exactly `…/auth/drive`; with a Sheets work log
  too, for both scopes, and the earlier sign-in shows Sheets missing. A
  sign-in that did not allow Drive makes Send test say "The Google
  sign-in does not allow Google Docs: sign in to Google again to allow
  it." and calls no Drive API. Send test reads only the folder; a
  document's id or an unknown folder says what is wrong. Slides and
  Drive keep no changelog when asked for one, and a merge sends them
  nothing. A 429 is retried after its `Retry-After`. A revoked grant
  marks these Connections failing like Sheets, since `isGoogleConnection`
  includes them; that path is #131's test and was not retested here.
- `pdf.test.ts` (4 tests):
  - Every line of a report is read back in order, with its headings and
    the table's header bold.
  - Each link is an annotation with a real rectangle, and escaped
    Markdown is never a link.
  - 120 long paragraphs wrap within the margins over more than three
    pages.
  - Latin-1 and WinAnsi's own characters are escaped (`Café – “ok”`),
    and anything else (`日本`) is a question mark.
- `deck.test.ts` (2 tests): the four slides and their links (the
  summary's Markdown stays text, the Total is bold), and 20 issues
  continuing over three slides each, eight lines at most, an issue only
  its link at "links only".
- `apps/server` `routes.test.ts`: the three added through the API by a
  folder's address. Each answers `Folder 1DocsFol…` and `In folder <id>`,
  only Docs keeps its changelog, and a document's address is refused
  (400).
- `apps/web` `connections-page.test.tsx`: adding Google Docs with a
  changelog by the folder's address, after refusing a file's address;
  Slides and Drive offering no changelog; adding Drive; and the bodies
  sent. The rules text of Docs, Slides and Drive is checked too.

### Verified on the host

- [ ] **A real Batch produces a document, a deck and two files in real
      Google Drive (after #135).** This needs a real Google Cloud OAuth
      client with the Drive, Docs and Slides APIs enabled, a Google
      account, a shared folder and the network. The fake stands in here.

## Not verifiable in this sandbox

- **Real Google**:
  - How Drive converts the report's HTML into a document (its table and
    heading styles), and how the deck looks in Slides: whether eight
    lines fit its placeholders without shrinking, and long titles wrap.
  - That a presentation made through Drive starts with one slide; AI
    Office deletes whichever slides it finds, so either way works.
  - Drive's real rate limits, and how the PDF looks in Drive's viewer
    and in other readers. Here it is checked structurally by `readPdf`,
    not rendered.
- **Postgres 18** (no Docker): the Postgres variant of the new
  `routes.test.ts` case (skipped with the reason), and migration `0072`
  itself.
- **Playwright** (`pnpm e2e`, needs Docker and Chromium): the Connections
  page in a browser, including its axe check with the new folder field.

## Notes

- **FR-91's "a Google Docs folder or document"** is read as: the
  Connection names the folder, and the running changelog is a document
  AI Office makes in it ("AI Office changelog"), as Confluence's and
  Notion's changelog is a page under their parent. Naming an existing
  document as the changelog is not offered.
- **Drive's full scope.** Docs, Slides and Drive write into a folder the
  Owner names, which `drive.file` cannot reach (it covers only files AI
  Office made, or the Owner opened with it through Google's Picker,
  which AI Office does not use). `drive` also covers the Docs and Slides
  APIs, so `documents` and `presentations` would add nothing; it is the
  one scope asked for. It reaches every file the account can, so the
  guide suggests signing in with an account that only has the folders
  shared with it.
- **"One artefact per Batch"** rests on the queue's "at most once per
  Connection per event" (FR-94) and the delivery's id on the files.
  Moving a file out of the folder, or to the bin, before a retry makes a
  retry make it again. A retry happens only after a failed attempt.
- **The PDF** is AI Office's own, since no PDF library is in the
  workspace. It has only Helvetica's WinAnsi characters, so a character
  outside them (CJK, emoji) is `?` in the PDF; the Markdown file, the
  document and the deck keep it.
- **The deck** is read from the report's Markdown rather than built
  from the report's data, so it can say no more than the report does at
  that detail level, and it is redacted with it. At "links only" its
  Outcomes slide is the template summary.
- **The changelog's write** names the revision it read. If the Owner
  edits the changelog document between the read and the write, Google
  refuses it (400) and the delivery is retried, so an entry is never
  written into the middle of the Owner's edit.

## Noticed, out of scope

- **Send test wording for Sheets.** It says "The test reached it: the
  parent can be read. Nothing was written." for a Google Sheets
  Connection, although Sheets' Send test writes a test row (from #131).
  The new Docs, Slides and Drive Connections say "the folder can be
  read"; the Sheets wording is unchanged.
- **Configuration export.** As #125's and #131's notes say, it carries
  no Connections.
- **No end-to-end coverage.** The end-to-end suite has no test of a
  Google Connection.
- **Calendar** is #133.

## Output

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
typecheck exit=0

$ pnpm --filter @ai-office/db exec drizzle-kit generate
No schema changes, nothing to migrate 😴
generate exit=0

$ cat /proc/loadavg
6.84 11.14 14.17 3/27979 24509
$ pnpm test   (no Docker: Postgres tests skip with the reason)
 Test Files  366 passed (366)
      Tests  4090 passed | 551 skipped (4641)
   Duration  61.18s
test exit=0
```

This issue's tests (verbose):

```text
✓ src/pdf.test.ts > a report's PDF > is a well-formed PDF whose page says what the report says, in order, with its headings bold
✓ src/pdf.test.ts > a report's PDF > makes each link an annotation over its text; escaped Markdown is never a link
✓ src/pdf.test.ts > a report's PDF > wraps long paragraphs within the margins, and runs over as many pages as it needs
✓ src/pdf.test.ts > a report's PDF > writes every character as ASCII: Latin-1 and WinAnsi's own escaped, anything else a question mark
✓ src/deck.test.ts > a report's deck > is a title slide, then its outcomes, issues and pull requests, and tokens and cost
✓ src/deck.test.ts > a report's deck > puts at most 8 lines on a slide, continuing on the next
✓ src/transports/google-publishing.test.ts > Google sign-in for Docs, Slides and Drive > asks for Drive's scope and nothing else; beside a work log, Sheets' too
✓ src/transports/google-publishing.test.ts > Google sign-in for Docs, Slides and Drive > a sign-in that did not allow Drive says so, for each of them
✓ src/transports/google-publishing.test.ts > Google Docs > a finished Batch makes exactly one document in the folder with its Wrap-up report, even when the answer is lost and it is sent again
✓ src/transports/google-publishing.test.ts > Google Docs > the changelog: one document in the folder, made with the first entry, and each merged pull request appended once, a lost answer included
✓ src/transports/google-publishing.test.ts > Google Slides > a finished Batch makes exactly one deck in the folder, its slides written once, even when answers are lost
✓ src/transports/google-publishing.test.ts > Google Drive > a finished Batch saves exactly one Markdown and one PDF file in the folder, even when an answer is lost
✓ src/transports/google-publishing.test.ts > detail levels and redaction in Docs, Slides and Drive > "titles and summaries": titles, the Floor and Agents named, every credential redacted, and what a title or the summary says only ever text
✓ src/transports/google-publishing.test.ts > detail levels and redaction in Docs, Slides and Drive > "links only": kinds, counts and links; no Floor name, issue title, Agent or reason, and no Model call
✓ src/transports/google-publishing.test.ts > Send test and failures > Send test only reads the folder, and says when it is a file or cannot be found
✓ src/transports/google-publishing.test.ts > Send test and failures > Slides and Drive keep no changelog; a 429 is retried after its Retry-After
 Test Files  3 passed (3)
      Tests  16 passed (16)

$ vitest run --project @ai-office/communications
 Test Files  11 passed (11)
      Tests  107 passed | 18 skipped (125)

✓ (server) routes.test.ts > the Connections API, kept in memory > adds Google Docs, Slides and Drive by a folder's address: only Docs keeps a changelog
↓ (server) routes.test.ts > the Connections API, kept in Postgres 18 > adds Google Docs, Slides and Drive by a folder's address: only Docs keeps a changelog [Docker is not available (Could not find a working container runtime strategy), so the Postgres integration tests are skipped. They run in CI and on the host.]
 Test Files  1 passed (1)
      Tests  8 passed | 8 skipped (16)

✓ (web) connections-page.test.tsx > the Connections page > adds Google Docs with a running changelog by the folder's address; Slides and Drive keep none
✓ (web) connections-page.test.tsx > a delivery's outcome > names a publishing destination's Wrap-up reports and changelog
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

Sabotage runs (each restored before the next):

```text
== 1. Docs: no look-up before making the report's document
× a finished Batch makes exactly one document in the folder with its Wrap-up report, even when the answer is lost and it is sent again
== 2. Docs changelog: no look-up of the entry's link
× the changelog: one document in the folder, made with the first entry, and each merged pull request appended once, a lost answer included
== 3. Docs changelog: the style of the entry before not cleared
× the changelog: one document in the folder, made with the first entry, and each merged pull request appended once, a lost answer included
== 4. Slides: no look for its slides before writing them
× a finished Batch makes exactly one deck in the folder, its slides written once, even when answers are lost
== 5. Drive: no look-up of what was saved
× a finished Batch saves exactly one Markdown and one PDF file in the folder, even when an answer is lost
== 6. Docs asks for the documents scope too
× asks for Drive's scope and nothing else; beside a work log, Sheets' too
== restored
Tests  10 passed (10)
```
