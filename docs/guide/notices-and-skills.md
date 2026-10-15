# Notices, the wall board and Skills

The Notice Board, browser notifications, the wall board and the Skill library. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## The Notice Board

A Notice is something the Owner should see or act on (PRD FR-48). It is
an **action** Notice, which may offer one-click actions, or an **info**
Notice, which offers none. Each has a title, the Floor it is about (or
none, for the whole Office) and links: the issue, the pull request, the CI
run, the Agent, and up to ten more (`links`, each `{ label, url }`, such as
each round of a Review Loop). A Notice about a conflict between Roles also
carries both sides (`positions`, each `{ label, text, url? }`, at most two,
in the order they arose), which the board shows side by side. It stays on
the Notice Board until the Owner dismisses it or takes one of its actions;
the row in `notices` is kept either way, until
[retention](running.md#retention) deletes it a year after it was closed.

- **Raising one.** Parts of AI Office raise Notices with
  `notices.raise({ kind, title, floorId, agentId, issue, pullRequest,
  ciRunUrl, links, positions, actions })` (`createNotices` in
  `@ai-office/orchestrator`).
  Each action is `{ id, label }`, such as `{ id: "approve_and_merge",
  label: "Approve and merge" }`, and its source must first register the
  handler that does it, with `notices.registerAction(id, handler)`. An
  action that acts on one commit names it, `sha`: "Approve and merge"
  names the head it merges. A handler that finds its Notice out of date
  throws a `NoticeOutdatedError`: nothing was done, and the Notice is
  closed as dismissed, not acted on, with the reason.
  Titles, links and positions are redacted before they are stored; links
  must be `http` or `https`.
- **Events.** Raising, dismissing and acting are `notice.raised`,
  `notice.dismissed` and `notice.acted_on`, so the board updates live.
- **API.** `GET /api/notices` lists the open Notices, newest first
  (`?floorId=` for one Floor's). `POST /api/notices/:id/dismiss` dismisses
  one. `POST /api/notices/:id/act` with `{"action":"…"}` runs that
  action's handler, and the Notice leaves the board only if the handler
  succeeds; if it fails, the answer is `502 action_failed` with the reason.
- **The page.** **Notices** in the web app is the lobby Notice Board: every
  Floor's Notices, or one Floor's (`/notices?floorId=web-shop`), with a
  **Dismiss** button and a button per action. A conflict's two positions
  sit side by side wherever the Notice has the room (one above the other
  where it has not, as on a phone), each headed by whose position it is,
  linked to where they said it. `/notices?notice=<id>` brings one Notice
  into view.

### Browser notifications

Each new action Notice can also show a browser notification with a short
sound (PRD FR-51); info Notices never do. They are off until the Owner
turns on **Notify me of action Notices** in General Settings' **Browser
notifications** card, which is when the browser asks for permission (never
on load). **Play a sound** mutes the sound. Clicking a notification brings
AI Office forward on that Notice (`/notices?notice=<id>`). The settings
belong to the browser they were set in, as its permission does, and are
kept in its local storage. Browsers play sound only once the page has had
a click or a key press.

## Communications and Connections

The **Communications Agent** (PRD FR-90) tells the Owner, outside AI
Office, about Notices and finished work, through **Connections**. There is
exactly one, made when the server first starts (`communications_agent`,
one row): its Role is `communications`, it belongs to no Floor, and it has
no sandbox, no repository access and no GitHub token. It reads the event
bus and writes only to Connections. Its name, AI Provider, Model (for
Digests and Wrap-up reports, below) and status are edited in
**Admin → Communications → Manage Connections** (`/general-settings/connections`),
and its name and Avatar in **Agent Settings** in the lobby;
changes are `config.changed` events (scope `communications`). While it is
paused nothing is sent, and deliveries wait until it resumes. In the 3D
Office it sits at the lobby's reception desk (FR-96): an envelope drops
into its out-tray for each message sent, a failing Connection shows a red
marker on its desk, and clicking it opens its card, with a link to the
Connections admin (see [the reception desk](web-app.md#the-3d-office)).

- **Connections.** Each is one outbound integration (`connections`): a
  name, a type, its rules, a detail level (`titles_and_summaries`), its
  credentials and its status. The first type is the **generic webhook**:
  a JSON POST to the Owner's address (Discord, Teams, Zapier, n8n…).
  With a signing secret, the body is signed with HMAC-SHA256 in
  `X-AI-Office-Signature-256: sha256=<hex>`, as GitHub signs its
  webhooks; `X-AI-Office-Delivery` carries the delivery's id, the same on
  every attempt, so a receiver can drop a repeat. The body is
  `{"id","test","kind","title","floor","links":{"aiOffice","github"},"occurredAt"}`.
- **Internal addresses.** A webhook's address, a Slack incoming
  webhook's, an ntfy server, a Confluence site and an SMTP server may not
  be on an internal address (loopback, link-local such as the cloud
  metadata service, private, `localhost`, a one-label name such as `app`
  or `postgres`, `.internal`, `.lan` and the like), nor be plain
  `http://`, unless the Owner allows the host in `ALLOWED_INTERNAL_HOSTS`
  ([Internal addresses](ai-gateway.md#internal-addresses), ADR 0007,
  pen-test finding I1-2): a self-hosted n8n or ntfy on their network, or
  Mailpit on this machine, is named there. The form and the API refuse
  it; a delivery to one stored before fails with that reason, never
  connecting, so whether anything listens there is not shown. A name is
  checked by what it resolves to as well, as each connection is made (an
  SMTP connection goes to the address checked).
- **Slack** (FR-91) sends through an incoming webhook (its address is
  the credential), or as a bot: a bot token (`xoxb-`, with the
  `chat:write` scope, the bot invited to the channel) and a channel
  (`#ops` or its id) or a user's id, through `chat.postMessage`. Each
  message is in Slack's block format: the title, the Floor and the kind,
  and **Open in AI Office** and **Open on GitHub** link buttons (links
  only: nothing Slack sends back is acted on). A 429 is retried after its
  `Retry-After`; a refused token (`invalid_auth`) fails like any other
  delivery, so 5 in a row make the Connection failing. Slack tokens and
  incoming webhook addresses are among the central redactor's credential
  shapes.
- **Email** (FR-91) sends over the Owner's SMTP server: host, port, TLS
  (STARTTLS, usually on 587; TLS from the start, 465; or none, only for a
  server on the same machine or network), an optional username and
  password, a from address and up to 20 to addresses. Each message goes
  to every address at once, as plain text and HTML, with the title, Floor
  and kind and links back to AI Office and GitHub, and an
  `X-AI-Office-Delivery` header. Replies are not read. A refused sign-in
  ("The SMTP server refused the username or password (535).") fails like
  any delivery. The Connection shows its server, TLS, who it signs in as
  and its addresses; the password is never shown again. The contract
  tests run against [Mailpit](https://mailpit.axllent.org/) in a
  container (`@ai-office/communications/testing/mailpit`; skipped with
  the reason without Docker, failing in CI), and against a small fake
  SMTP server in the test process.
- **Phone push** (FR-91) sends through **ntfy** or **Pushover**.
  - **ntfy:** a server (`https://ntfy.sh` by default, or the Owner's
    own), a topic, and an optional access token (`tk_…`) for a topic that
    needs one. Each message is published as JSON to the server's root: the
    title, "Floor · kind" as the text, a click action that opens it in AI
    Office, and an **Open on GitHub** button when there is a GitHub link.
    On a public server anyone who knows the topic can subscribe, so the
    topic is a credential like the token: sealed, never shown again, and
    kept out of every log and delivery. The Connection shows the server's
    host and whether it publishes with a token. A refused token ("ntfy
    refused the access token (401).") or a topic that needs one ("ntfy
    needs an access token to publish to this topic (403).") fails like
    any delivery; a 429 is retried after its `Retry-After`. ntfy access
    tokens are among the central redactor's credential shapes.
  - **Pushover:** an application token and a user (or group) key, both
    secrets. Each message is posted to `/1/messages.json`: the title,
    "Floor · kind" and the GitHub link as the text, the time it happened,
    and the AI Office link as the message's link ("Open in AI Office").
    Pushover's limits (250-character title, 1024-character text, 512-
    character link) are kept to. A refused application token or user key
    ("Pushover refused the application token (400).") fails like any
    delivery. The Connection shows only the start of the user key.
  - **Priority:** action Notices go at high priority (ntfy 4, Pushover 1),
    so the phone sounds; everything else at the default (ntfy 3, Pushover
    0).
  - The contract tests run against a fake ntfy server and a fake Pushover
    in the test process (`serveFakeNtfy` and `serveFakePushover` in
    `@ai-office/communications/testing`).
- **Rules** (FR-92). Action Notices (on by default), info Notices (off)
  and work complete (on: a pull request merged, which closes its issue,
  and a Batch finished, as "Batch 3 finished: 2 of 5 issues merged, 1
  blocked", linking its Wrap-up on the whiteboard; see [The
  Wrap-up](batches-and-memory.md#the-wrap-up)),
  and a Floor filter (none chosen sends every Floor's; Notices about the
  whole Office always pass it). Quiet hours and a Digest are optional
  rules too (below).
- **Detail level** (FR-95), per Connection, chosen when it is added and
  changed with **Edit** (`detailLevel`): **Titles and summaries** (the
  default) sends each message whole; **Links only** sends its kind and
  its links, with a title such as "New action Notice" in place of the
  Notice's own, and no Floor name. Either way, everything queued passes
  the central redactor first (a credential planted in a Notice's title is
  sent as `[REDACTED]`), and code, diffs, request or response bodies,
  memory and issue bodies are never sent: messages come only from the
  templates below.
- **Quiet hours** (FR-92), per Connection: from and until a time of day
  in a time zone (`22:00` to `07:00` in `Europe/London`, say; overnight
  when the end is earlier), following summer time. A message that falls
  due in them is held, and the Connection's log says until when. Without
  a Digest it is sent when quiet hours end; with one, it waits for the
  next Digest, which summarises it instead (its log then says
  "summarised in a Digest", status `summarised`). With **Let action
  Notices through**, action Notices are sent at once all the same.
  Changing a Connection's quiet hours or Digest lets go at once whatever
  they no longer hold.
- **Digests** (FR-90, FR-92), per Connection: hourly (on the hour) or
  daily at a time in a time zone, summarising what happened since the
  last one (from when the Digest was turned on, at first). A Digest that
  falls due in quiet hours waits until they end; one with nothing to tell
  is not sent. It is made from the same events and templates as the
  messages, within the Connection's Floor filter but whatever its
  triggers (turn them all off to have only Digests), as structured data
  only: counts by kind (pull requests merged and Batches finished
  counted apart), and each item's kind, Floor, title and outcome,
  never an issue's text. At **Titles and summaries** the Communications
  Agent's Model writes it, through this process's own AI Gateway with
  the Communications Agent's own Gateway Key (see [Gateway
  Keys](ai-gateway.md#gateway-keys)), so the request is attributed to it
  and counted against the office's Token Caps; what the Model reads is
  redacted, and the titles are marked as data, not instructions. When
  no Model can write it (none chosen, the Gateway unreachable, or a Token
  Cap reached), and always at **Links only**, it comes from a template:
  the counts, and at titles and summaries each item's Floor and title.
  Its title is "Digest:" and the counts; its text is the `summary` of the
  message (a webhook's `summary` field, a section in Slack, a paragraph
  in email, the body of a push), and its link is the Activity Feed.
- **Messages** come from deterministic templates
  (`packages/communications/src/messages.ts`), never a model: the title,
  the Floor, the kind, and links to the Notice (or the issue's activity)
  in AI Office and to GitHub. Each is redacted before it is queued.
- **Publishing destinations** (FR-91, FR-92) keep a written record
  instead of sending short messages: each finished Batch's **Wrap-up
  report** as a page (see [The Wrap-up](batches-and-memory.md#the-wrap-up)),
  and, with **A running changelog** on, an entry for each pull request AI
  Office merges. Their only rules are their Floors and the changelog
  (`rules.changelog`); the notification triggers, quiet hours and Digests
  are not theirs, and are kept off (`rulesFor`). Notices never go to them.
  - **Confluence:** the site's address, an Atlassian account's email and
    API token (the secret), a space's key and the parent page's id. Each
    report is a child page of the parent page, titled "AI Office: Batch 3
    Wrap-up (Web shop)", in the storage format, through Confluence Cloud's
    REST API (v2) with Basic authentication. The changelog is one "AI
    Office changelog" page under the same parent, made with its first
    entry; each entry is a line ("2026-10-10 · Web shop · Pull request #15
    merged, closing issue #5: Pay at checkout", linking the pull request)
    appended as the page's next version.
  - **Notion:** an internal integration's token (`ntn_` or `secret_`, the
    secret) and a parent page or database (its 32-character id, with or
    without hyphens), shared with the integration. Each report is a page
    under the parent page, or in the database (its title property found
    from the database), as blocks: headings, paragraphs, lists and a
    table. The changelog is one "AI Office changelog" page there, each
    entry a bulleted item appended to it.
  - **Exactly once.** A report's page is looked for by its title before
    it is made (titles are unique in a Confluence space; a database is
    queried by its title property; a page's children are listed), and an
    entry by its pull request's link before it is appended, so a retry
    after a lost answer makes neither twice. **Send test** only reads: the
    space and the parent page, or the Notion parent, writing nothing.
  - **The report** (`packages/communications/src/report.ts`) is Markdown,
    made from the finished Batch's Wrap-up as AI Office keeps it (never
    from GitHub: the Communications Agent has no repository access): when
    it finished, its counts, tokens and estimated cost; a **Summary**; the
    Plan's order, each issue's coder and dependencies, and the parallel
    groups; a **Results** table of each issue's outcome, pull request,
    Review Loop and QA rounds, tokens and estimated cost, with the
    totals; what was left out; and a link to the Wrap-up on the
    whiteboard. The Summary is written by the Communications Agent's
    Model through the AI Gateway with its own Gateway Key, from structured
    data only (counts, and each issue's title, outcome, rounds, tokens and
    cost), so it is counted against the office's Token Caps; when no Model
    can write it, and at **Links only**, it comes from a template. The
    Markdown is then written in each destination's own format
    (`markdown.ts`).
  - **Detail level and redaction.** At **Links only** a report has kinds,
    counts and links: no Floor name (its title is "AI Office: Batch 3
    Wrap-up"), no issue title, no Agent's name, no reason, no Model call;
    a changelog entry is "Pull request merged" and its link. Everything is
    redacted before the Markdown is written (escaping could otherwise
    split a credential so the redactor no longer matched it), and
    anything quoted (an issue's title, the Model's summary) is escaped, so
    it is only ever text: it cannot add a link, a heading or a table cell.
  - The contract tests run against a fake Confluence and a fake Notion in
    the test process (`serveFakeConfluence` and `serveFakeNotion` in
    `@ai-office/communications/testing`).
- **Google sign-in** (FR-91). The Google Connections publish through one
  Google account. In Google Cloud the Owner enables the APIs of the
  Google Connections they use (Google Sheets; Google Drive, with Google
  Docs and Google Slides for theirs; Google Calendar) and creates an OAuth client ID of type **Web application**, whose
  authorised redirect URI is `/admin/connections/google` on `PUBLIC_URL`
  (the **Google sign-in** card on the Connections page shows the exact
  address); then enters the client's ID and secret in that card. The
  secret is sealed and never shown again; a new client ID signs the
  account out (a refresh token belongs to its client). **Sign in to
  Google** goes to Google's consent screen with the authorization code
  flow and PKCE, asking for a refresh token (`access_type=offline`,
  `prompt=consent`) and **only the scopes of the services the Google
  Connections use**: for Google Sheets, `…/auth/spreadsheets`; for
  Google Docs, Slides and Drive, `…/auth/drive`; for Google Calendar,
  `…/auth/calendar.events`; nothing for the
  account's identity, and nothing granted before (no
  `include_granted_scopes`). Docs, Slides and Drive make files in a folder
  the Owner names, which only `drive` reaches (`drive.file` reaches only
  what AI Office made itself), and `drive` covers the Docs and Slides APIs
  too, so neither `documents` nor `presentations` is asked for. As
  `drive` reaches every file the account can, sign in with an account
  that has only AI Office's folders shared with it. Calendar asks for
  `calendar.events`, which makes and changes events on any calendar the
  account can change: not `calendar.events.owned` or
  `calendar.app.created`, which cannot reach a calendar shared with it,
  and never the whole of `calendar`, which could change calendars'
  settings and sharing. With no Google Connection there is
  nothing to ask for, so add one first. Google sends the Owner back to
  `/admin/connections/google`, which is served without a session
  (Google's cross-site redirect carries no SameSite=Strict cookie, and
  the page holds nothing) and hands the code and state to the API, which
  needs the session; each sign-in's state is used once, within 10
  minutes. If the Owner unticks a service on the consent screen, the card
  says so, and that Connection's deliveries fail until they sign in again.
  - **Tokens.** The refresh and access tokens are sealed in
    `google_sign_in` (one row). The access token is refreshed a minute
    before it expires, and once when Google refuses it early (a 401).
  - **A revoked grant.** When Google refuses the refresh token
    (`invalid_grant`: the Owner removed AI Office's access in their
    Google account, or the grant expired), the sign-in is **revoked**
    (`google.grant_revoked`), and **every** Google Connection is marked
    failing at once, not after 5 failures, with an action Notice each
    (`connection.failing` with `reason: google_sign_in_revoked`). Their
    deliveries keep being retried as usual; after the Owner signs in again
    (`google.signed_in`) whatever waits for them goes at once, and each
    recovers with its next delivery. **Sign out of Google** revokes the
    grant at Google as well as it can (`google.signed_out`). Entering the
    client is a `config.changed` event with scope `google`.
- **Google Sheets** (FR-91, FR-92), a publishing destination, keeps a
  **work log**: a spreadsheet (its address or its id) and a tab, made
  with a header row when the spreadsheet has none by that name. Each
  completed issue (its pull request merged, which closes it) is one row:
  **Date, Kind, Floor, Issue, Title, Pull request, Agents, Review Loop
  rounds, Tokens, Estimated cost (USD), AI Office, AI Office ID**. The
  Agents are those dispatched to it, reviewing it or checking it, in the
  order they began; the rounds, tokens and cost come from the event log
  and the AI Gateway's usage for that issue (never from GitHub). With
  **A row for each Notice too** (`rules.notices`), each Notice within its
  Floors is a row as well (its kind, Floor, title and link), except one
  about that Connection. A work log's only rules are its Floors and
  Notices; it publishes no Wrap-up report or changelog. At **Links
  only** a row has no Floor name, title or Agents, only links and
  numbers. Rows are redacted, and written `RAW`, so nothing a title says
  is ever read as a formula. **Exactly once:** each row ends with its
  delivery's id, the same on every attempt, and the tab's ids are read
  before a row is appended, so a retry after a lost answer writes no
  second row. **Send test** writes a test row. Share the spreadsheet with
  the Google account signed in: otherwise "The Google account signed in
  cannot edit the spreadsheet: share it with that account (403)."
  - The contract tests run against a fake Google in the test process
    (`serveFakeGoogle` in `@ai-office/communications/testing`): its
    consent screen, token endpoint and Sheets API.
- **Google Docs, Google Slides and Google Drive** (FR-91, FR-92),
  publishing destinations through Google sign-in, each name a **Google
  Drive folder** (its address, `https://drive.google.com/drive/folders/…`,
  or its id), shared with the Google account signed in, as an editor.
  Each finished Batch's Wrap-up report (the same Markdown as Confluence's
  and Notion's, at the Connection's detail level, redacted) is published
  there:
  - **Google Docs:** a document titled as the report ("AI Office: Batch 3
    Wrap-up (Web shop)"), made in one request: the report is uploaded as
    HTML, which Drive converts (headings, lists, the Results table, bold
    and links). With **A running changelog**, each merged pull request is
    an entry ("2026-10-10 · Web shop · Pull request #15 merged, closing
    issue #5: Pay at checkout", its date bold and its title linking the
    pull request) appended through the Docs API to one "AI Office
    changelog" document in the folder, made with the first entry, at the
    end of the document as it was read (`requiredRevisionId`).
  - **Google Slides:** a short deck (`deck.ts`): a title slide (the
    report's title, when it finished with its counts, tokens and cost, and
    a link to the Wrap-up), **Outcomes** (the Summary), **Issues and pull
    requests** (each issue's outcome and pull request) and **Tokens and
    cost** (the total, then each issue's tokens, cost and rounds), eight
    lines to a slide, more slides when there are more issues. The deck is
    made in the folder through Drive, then its slides written in one
    Slides batch update, which Google applies whole or not at all.
  - **Google Drive:** the report saved as two files, `<title>.md` (the
    Markdown) and `<title>.pdf`. The PDF is written by AI Office itself
    (`pdf.ts`, no dependency): A4 pages in Helvetica, the headings bold,
    the Results table with its columns as wide as they need, and each link
    a link annotation.
  - **Exactly once.** Every file AI Office makes carries a private Drive
    property (`appProperties`) with its delivery's id, the same on every
    attempt; the folder is searched for it before anything is made, and a
    deck's slides (whose ids AI Office chooses) before they are written,
    so a retry after a lost answer makes no second document, deck, file or
    slide. A changelog entry is looked for by its pull request's link
    before it is appended. Renaming or moving a file in the folder does
    not matter; moving it out of the folder, or to the bin, makes a retry
    make it again.
  - Only Google Docs keeps a changelog: Slides and Drive publish reports
    only (`changelogTypes`, `keepsChangelog`). **Send test** only reads the
    folder, writing nothing: "That Google Drive address is a file, not a
    folder: give a folder's." or "Google Drive cannot find the folder or a
    file in it: check its address, and share it with the Google account
    signed in (404)." say what is wrong. Drive's rate limits (a 429, or a
    403 `rateLimitExceeded`) are retried after their `Retry-After`.
  - The same fake Google (`serveFakeGoogle`) serves Drive (folders, files
    with their private properties, search, uploads, HTML converted into a
    document), Docs (a document's text, bold, links and revision) and
    Slides (slides, their placeholders, text, bold and links), and can
    lose a write's answer or answer 429. `readPdf` in the same module
    reads back what a PDF says, for the tests.
- **Google Calendar** (FR-91, FR-92), a publishing destination through
  Google sign-in, names a **calendar**: its id, from the calendar's
  settings under **Integrate calendar**
  (`…@group.calendar.google.com` for one the Owner made), its embed or
  iCal address, or `primary`, the signed-in account's own. Share it with
  the Google account signed in, with permission to make changes to
  events. Each **Batch** within its Floors is **one event** on it
  (`calendar.ts`, `transports/google-calendar.ts`):
  - **When the Batch starts** (`batch.started`), the event is made,
    titled "AI Office: Batch 3 (Web shop), in progress" and lasting an
    hour, as its finish is not yet known. Its description says which
    issues' work started and links to the Plan on the Floor's whiteboard
    ("Open the Plan in AI Office"); the event's source is that link too.
  - **When it finishes** (`batch.finished`), the same event is changed to
    run from the Batch's start to its finish, titled with its outcome
    ("AI Office: Batch 3 (Web shop): 1 of 3 issues merged, 1 blocked, 1
    not started"). Its description then gives the counts, tokens and
    estimated cost, each issue's outcome and pull request (linking the
    issue and the pull request), and the link to the Plan. The event is
    marked free, so AI Office working never makes the Owner busy.
  - **Exactly once.** The event's id is AI Office's own: a hash of the
    Connection's id and the Batch, the same on every attempt of both
    deliveries and never another Connection's. A start looks the event up
    before making it and leaves one already there as it is, so a retry
    after a lost answer makes no second event, and a start retried after
    the finish arrived does not make it "in progress" again. A finish
    changes the event, or makes it whole when there is none: the start
    was given up, or the Connection was added during the Batch (a
    Connection is sent only what happens after it was added). An event
    the Owner deleted stays deleted. Two Calendar Connections on one
    calendar each keep their own events.
  - **Detail level and redaction.** At **Links only** the event names no
    Floor ("AI Office: Batch 3, in progress") and no issue title, keeping
    the counts and links. Everything is redacted before its description
    is written, and the description is HTML (the little Calendar keeps:
    bold, links, line breaks and lists), every text escaped, so nothing a
    title says becomes a link. It publishes no Wrap-up report and keeps
    no changelog; its only rule is its Floors. Notices and merges are
    never put on the calendar.
  - **Send test** only reads the calendar (one event at most), writing
    nothing; "Google Calendar cannot find the calendar or an event on it:
    check its id, and share it with the Google account signed in (404)."
    says when it cannot.
  - The fake Google (`serveFakeGoogle`) serves Calendar too: calendars and
    their events by an id the caller chooses, never given out twice;
    `insert` refusing an id already used (409), `get` and `patch` finding
    an event until it is purged, a deleted event kept cancelled, and an
    event never ending before it starts.
- **Credentials** are sealed with `ENCRYPTION_KEY` and write-only: no
  answer, event or log line carries them again. A Connection shows only a
  hint (a webhook's host) and what is not secret ("Signed with
  HMAC-SHA256").
- **The queue** (FR-94) is `connection_deliveries` in Postgres. Events are
  taken in from the bus after the last one taken in (a cursor kept with
  the Agent), so one published while AI Office was down is still queued
  when it starts, and each event is queued at most once per Connection. A
  failed delivery is retried after 30 seconds, then twice as long each
  time up to an hour, or after the service's own `Retry-After`, until 24
  hours after its first attempt, when it is given up
  (`connection.delivery_expired`). After 5 failures in a row the
  Connection is **failing** (`connection.failing`) and an action Notice
  says so; that Notice links to the Connection, and is never sent to it.
  The next delivery that arrives records its recovery
  (`connection.recovered`).
- **The log is kept 90 days** by default (PRD §7): General Settings' **Retention**
  card sets the period, and its **Storage** card can delete it sooner (see
  [Retention](running.md#retention)). Only finished deliveries go; one
  still waiting to go, being retried or held for quiet hours, stays.
- **The page.** Each Connection shows its status, its last delivery and,
  on request, its recent deliveries; **Send test** sends a test message
  at once and shows how it went (tests do not count towards failing).
  **Edit** renames it and changes its rules; **Pause**, **Resume** and
  **Delete** do what they say. Adding, changing, pausing and deleting are
  Activity Feed events (`connection.added`, `connection.changed`,
  `connection.removed`); successful deliveries are only in the
  Connection's own log. A Notice links to one Connection with
  `/general-settings/connections?connection=<id>`.
- **API.** `GET`/`PATCH /api/communications-agent`; `GET /api/connections`;
  `POST /api/connections` with `{"type":"webhook","name","rules"?,
  "detailLevel"?,
  "credentials":{"url","secret"?}}` or `{"type":"slack",…,"credentials":
  {"mode":"webhook","webhookUrl"}}` or `{"mode":"bot","botToken","channel"}`,
  or `{"type":"email",…,"credentials":{"host","port","tls","username"?,
  "password"?,"from","to":[…]}}`, or `{"type":"ntfy",…,"credentials":
  {"server","topic","accessToken"?}}`, or `{"type":"pushover",…,
  "credentials":{"applicationToken","userKey"}}`, or `{"type":"confluence",…,
  "credentials":{"siteUrl","email","apiToken","spaceKey","parentPageId"}}`,
  or `{"type":"notion",…,"credentials":{"token","parentType":"page" or
  "database","parentId"}}`, or `{"type":"google_sheets",…,"credentials":
  {"spreadsheetId","tab"}}` (`spreadsheetId` may be the spreadsheet's
  address), or `{"type":"google_docs"` (or `"google_slides"`, or
  `"google_drive"`)`,…,"credentials":{"folderId"}}` (`folderId` may be the
  folder's address), or `{"type":"google_calendar",…,"credentials":
  {"calendarId"}}` (`calendarId` may be the calendar's embed or iCal
  address, or `primary`); `PATCH /api/connections/:id` with
  any of `{"name","rules","detailLevel","paused"}`; `DELETE /api/connections/:id`;
  `POST /api/connections/:id/test` (`{"delivered","error","connection"}`);
  `GET /api/connections/:id/deliveries` (the latest 50, newest first).
  `rules` is `{"actionNotices","infoNotices","workComplete","floorIds",
  "quietHours"?:{"start","end","timeZone","actionNotices"},"digest"?:
  {"frequency":"hourly"} or {"frequency":"daily","at","timeZone"},
  "changelog"?,"notices"?}` (a publishing destination keeps only
  `floorIds` and `changelog`, and Google Slides, Drive and Calendar only
  `floorIds`; a work log only `floorIds` and `notices`),
  and `detailLevel` is `links_only` or `titles_and_summaries`. Google
  sign-in: `GET /api/google` (`{"status","clientId","redirectUri",
  "services","scopes","grantedScopes","missingServices","signedInAt"}`,
  never a secret or token); `PUT /api/google/client` with
  `{"clientId","clientSecret"}`; `POST /api/google/sign-in` (`{"url"}`,
  the consent screen); `POST /api/google/sign-in/complete` with
  `{"code","state"}` or `{"error","state"}`; `DELETE /api/google/sign-in`.

## The wall board

Each Floor's wall board (PRD FR-50, FR-57) is that Floor's own board: in
the 3D Office it pins up the Floor's open Notices, and inspecting it opens
its panel (`scene/wall-board-panel.tsx`), kept live by the Floor's events:

- **Health**: "Running smoothly", "Worth watching" or "Needs you", in
  `state-ok`, `state-warning` or `state-critical`, with why. It needs the
  Owner while the Floor has an action Notice open or an Agent has reached
  a Token Cap. It is worth watching while an Agent has used 80% of a cap,
  an issue has one round of review or QA left, or work waits with no Agent
  to do it.
- **Notices**: the Floor's open Notices, each with its links (issue, pull
  request, CI run and the rest) and its Agent, and a link to the 2D Notice
  Board for the Floor, where they are dismissed and acted on.
- **In progress**: every issue with work queued or running, working first,
  then waiting, oldest first. Each shows its stage (in its Stage's
  colour), whether it is being worked or waits, the Agent working it or
  that it waits for (a review round's required reviewers), its issue and
  pull request on GitHub, and its rounds of review against the Floor's
  Round Cap (and of QA, against QA's, once it has had one).
- **Queues**: the work waiting and working at each stage, and how many
  tasks wait for each Agent.
- **Tokens against caps**: each Agent's tokens today and this month
  against the cap in force for it, as a bar coloured as the Office colours
  tokens (FR-62): neutral below 80%, amber from 80%, red at 100%.

Every Agent's name flies to the Agent and opens its card, and every issue, pull request and
link opens on GitHub. The panel follows one stream of the Floor's events
(Notices, work assigned, labels, statuses, sandboxes, pull requests,
reviews, QA, model calls and caps) and reads its board, Notices and tokens
again at each event, and its tokens once a minute besides.

- **API.** `GET /api/floors/:floorId/wall-board` answers the Floor's
  issues in progress (`issues`, each with `stage`, `status`, `agentIds`,
  `url`, `pullRequest`, `reviewRounds` and `qaRounds`), its `roundCap` and
  `qaRoundCap`, its `queues` by stage, and each Agent (`agents`): its
  waiting work (`waiting`), the issues it handed to review that wait on
  their verdicts (`awaitingReview`, from each issue's latest Handoff to
  `needs-review`), and whether it is paused at a Token Cap (`capped`),
  which the Office shows (see [Agents' states](web-app.md#agents-states-in-the-office)).
  It reads the work queue, the Review Loop's verdicts, QA reports and
  Handoffs, and the `issue.picked_up` and `pull_request.opened` events for
  each issue's address and pull request (`createWallBoard` in
  `@ai-office/orchestrator`). The Notices and tokens come from `GET
  /api/notices?floorId=` and `GET /api/floors/:floorId/token-usage`.

## The Skill library

A Skill is a named set of instructions an Agent can follow, in the
[Agent Skills format](https://agentskills.io/specification): a folder with
a `SKILL.md`, whose YAML frontmatter has a `name` and a `description` above
its instructions, plus any supporting files (PRD FR-71). General Settings' **Skills**
card is the office Skill library (FR-72). Each Floor also has its
repository's own Skills, and its sandboxes are given them (below). Each
Floor's Skills are browsed in the [Available Skills list](#available-skills)
and run in the Manager chat with `/skill-name`.

- **Adding one.** **Upload a folder** from your computer, **Import from
  Git** (a public repository's `https://` URL, an optional branch or tag,
  and the Skill's folder when the repository holds several), or **Write
  one** in the editor, as a `SKILL.md` and any more files. The
  repository's host may not be an
  [internal address](ai-gateway.md#internal-addresses) the Owner has not
  allowed in `ALLOWED_INTERNAL_HOSTS` (pen-test finding I1-3): the form
  and the API refuse it, and so does the clone, before Git runs, whatever
  is listening there. Git is pinned to the address checked and follows
  no redirect. A Floor added
  from a built-in [Floor Template](floors-and-agents.md#floor-templates)
  also adds the template's Skills the library lacks, shown as "From a
  Floor Template".
- **What is checked.** The `name` is 1 to 64 lowercase letters, digits and
  single hyphens, matching its folder's name; the `description` is 1 to
  1024 characters; `license`, `compatibility`, `metadata` and
  `allowed-tools` follow the format, and other fields (such as Claude
  Code's) are kept. A Skill holds text files only, at most 200 of them and
  4 MB in all, with paths inside its folder. Names are unique in the
  library.
- **Review before use (FR-76).** Skills are instructions, so they are
  trusted input. One written in the editor is the Owner's own and starts
  enabled, as does one from a built-in Floor Template, which ships with
  AI Office. One uploaded or imported starts disabled and shows **Needs
  review**: **Review** shows every file in full (and, from Git, the
  repository, branch, commit and folder it came from), and only **I have
  read it all: enable** enables it. The review names a SHA-256 of the
  contents read, so a Skill that changed meanwhile must be read again. The
  `skills` table itself refuses an enabled Skill that was never reviewed.
- **Imports run nothing.** The clone is shallow, over HTTPS alone (for
  redirects and submodules too), with no hooks, LFS filters or system and
  global Git config, and is deleted once read. Symbolic links and binary
  files are refused rather than read.
- **Events.** Every add, change and removal is `skill.added`,
  `skill.changed` (`edited`, `reviewed`, `enabled` or `disabled`) or
  `skill.removed` in the Activity Feed, naming the Skill but never its
  contents.
- **API.** `GET /api/skills` lists them (each file's path and size);
  `GET /api/skills/:id` gives one in full; `POST /api/skills` adds one
  (`{"source":"upload"|"editor","files":[{"path","content"}],"folder"}`);
  `POST /api/skills/import` takes `{"url","ref","path"}`; `PATCH
  /api/skills/:id` takes `files` or `enabled`; `POST
  /api/skills/:id/review` takes `{"digest"}`; `DELETE /api/skills/:id`
  removes one. Enabling a Skill not yet reviewed is `409
  skill_not_reviewed`, and a review of changed contents `409
  skill_changed`.

### A Floor's Skills

A Floor's Skills are the office library's enabled Skills plus its
repository's own (PRD FR-72, FR-75):

- **Repository Skills** are the folders under `.agents/skills/` and
  `.claude/skills/` on the Floor's repository, one Skill each, checked as
  the library checks Skills (the `name` matching its folder). A Skill in
  both places is taken from `.agents/skills/`. A folder that is not a
  usable Skill is left out, saying why.
- **Reviewed first** (FR-76; pen-test finding P1-10). A repository Skill
  is used only once the Owner has read its files and reviewed exactly
  those, as an office Skill is reviewed before it is enabled. Until then,
  and again after any of its files changes, it reaches no sandbox and not
  the Manager's chat, and an office Skill of its name keeps its place.
  Floor Settings' **Skills** card lists it under **Waiting for your
  review** ("Never reviewed" or "It changed after you reviewed it"): the
  Owner reads every file of its folder, shown as it is, and reviews them.
  A review names the digest (SHA-256) of the files read; one of files
  that have changed since is refused (`409 skill_changed`). The review is
  kept per folder in `repository_skill_reviews`, and is a
  `config.changed` event (`skills.<name>.reviewed`). Each folder is read
  whole, from GitHub for the list and the chat and from the clone for a
  sandbox, and its digest compared with the one reviewed, so a sandbox
  on a branch that changed the Skill is not given it.
- **Overrides.** A reviewed repository Skill with the name of an office
  Skill overrides it on that Floor: there, its files are the repository's.
- **Never added by policy.** An Agent's pull request that adds or
  changes a repository Skill is never merged automatically: the Merge
  Policy sends it to the Owner, on any Floor (see
  [the issue pipeline](issue-pipeline.md#the-merge-policy); pen-test
  finding P1-3).
- **Per Role.** Floor Settings' **Skills** card lists them, with where
  each comes from, and turns each on or off for each Role whose Agents
  work in sandboxes (coder, QA, docs and designer). A Skill is on until it
  is turned off; the setting is kept by name in `floor_skill_toggles`, so
  it outlasts the Skill leaving and coming back. Each change is a
  `config.changed` event (`skills.<name>.<role>`).
- **In sandboxes.** Once a sandbox's clone is made, the Skills on for its
  Agent's Role (the repository's read from the clone) are written to a
  folder beside the clone, never in it, and bind-mounted **read-only**
  where the agent tool looks for its user's Skills: `~/.claude/skills`
  for Claude Code, `~/.agents/skills` for Codex and
  `~/.config/opencode/skills` for opencode. The files are read-only on
  the host too, and deleted with the clone. The agent tool does not load
  the repository's own Skill folders from its worktree as Skills: Claude
  Code reads no project settings, Skills among them, and opencode none of
  Claude Code's files (P1-9), and every sandbox Stage's prompt says the
  repository's agent-tool files, its Skills among them, are its content,
  not instructions.
- **A repository is read warily.** No symbolic link is followed (a Skill
  holding one is left out), and reading stops at the format's limits (200
  files, 4 MB).
- **API.** `GET /api/floors/:floorId/skills` answers `{"skills",
  "awaitingReview","ignored","repositoryError"}`, the repository's read through the GitHub App at
  the default branch (`RepositoryClient.listDirectory`); without GitHub,
  the office's are listed and `repositoryError` says why. `PUT
  /api/floors/:floorId/skills/:name/roles/:role` with `{"enabled"}` turns
  one on or off (`422 not_sandbox_role` for a Role without a sandbox).
  `GET /api/floors/:floorId/repository-skills?folder=…` gives a
  repository Skill's whole folder and its `digest`, reviewed or not, and
  `POST /api/floors/:floorId/repository-skills/review` with
  `{"folder","digest"}` reviews it.

### Built-in Skills

Every Floor also has AI Office's own Skills (PRD FR-77, FR-83b), listed as
**Built in**. Each is a real Skill in the Agent Skills format, a
`SKILL.md` with its frontmatter and any supporting files, kept in the
repository and checked as every Skill is when AI Office starts. Besides
`/grilling` (`packages/orchestrator/src/grilling/skill.ts`), they are
adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills)
(MIT), in `packages/orchestrator/src/skills/built-in/<name>/`, each saying
so ("Adapted from Matt Pocock's skills, MIT") beside his licence
(`built-in/LICENSE`; see `THIRD-PARTY-NOTICES.md`):

| Skill | Runs as | What it is for |
| ----- | ------- | -------------- |
| `/grilling [topic]` | A Grilling Session | AI Office's own interview |
| `/grill-with-docs <topic>` | A Grilling Session | Grilling with domain modelling: glossary terms and ADRs as they settle |
| `/wayfinder <idea>` | A Grilling Session | Naming the destination, then charting the way breadth-first |
| `/to-spec [topic]` | A Grilling Session | The PRD from the conversation so far, asking only about the seams |
| `/to-tickets <paths or description>` | A Grilling Session that writes no documents | Breaking a PRD and its ADRs into vertical-slice issues |
| `/pr` | Instructions | A pull request's body: Summary, Evidence, Merge Danger (its Summary credits Dex Horthy's `show-me`, in `CREDITS.md`) |
| `/domain-modeling` | Instructions | Sharpening the glossary and recording ADRs (`ADR-FORMAT.md`, `GLOSSARY-FORMAT.md`) |
| `/research <question>` | Instructions | Primary-source research, sent to a read-only Contractor |
| `/prototype <question>` | Instructions | A throwaway prototype (`LOGIC.md`, `UI.md`), built by a Batch on an unmerged branch |
| `/tdd` | Instructions | Test-driven development at agreed seams (`tests.md`, `mocking.md`) |
| `/codebase-design` | Instructions | Deep modules and seams (`DEEPENING.md`, `DESIGN-IT-TWICE.md`) |
| `/diagnosing-bugs` | Instructions | The loop for a hard bug or a slowdown |
| `/code-review [since]` | Instructions | A review on two axes, the standards and the spec |

- **Starting a session.** The first five start a
  [Grilling Session](events-and-chat.md#grilling-sessions), which keeps
  the Skill that started it. No office or repository Skill of their name
  overrides them, and the Manager is never offered them to choose itself.
- **Instructions.** The rest run as any `/name` does: their instructions
  are loaded into the Manager chat, with their supporting files after
  them, as the Manager cannot read a built-in Skill's folder. The Manager
  may choose one itself when a request matches its description. An
  office or repository Skill of their name takes their place on that
  Floor, so a Floor's own version wins.
- **Where documents go.** Wherever Matt's text says `docs/adr/`,
  `.scratch/`, a local tracker or a setup Skill, the adapted text says
  where AI Office keeps them instead: PRDs in
  `docs/product-requirements-document/`, ADRs in
  `docs/architectural-decision-record/`, terms in `GLOSSARY.md`, and
  research findings under `docs/`. The Manager changes the repository only
  through pull requests: a Grilling Session's, or a Batch's.
- **Never in a sandbox.** Built-in Skills are the Manager's: none is
  mounted into a sandbox, and the per-Role switches leave them out. To
  give `/tdd` or `/code-review` to the Floor's Agents, add it to the office
  library (from Matt's repository by Git, say), where the per-Role
  switches apply; it then takes the built-in's place.
- **Names.** `@ai-office/shared` exports each one's name, as the commands
  are spelt (`grillingSkillName`, `grillWithDocsSkillName`,
  `wayfinderSkillName`, `toTicketsSkillName`, `toSpecSkillName`,
  `prSkillName`, `domainModelingSkillName`, `researchSkillName`,
  `prototypeSkillName`, `tddSkillName`, `codebaseDesignSkillName`,
  `diagnosingBugsSkillName`, `codeReviewSkillName`), with
  `grillingSkillNames` (those that start a session) and
  `instructionSkillNames`.

### Available Skills

The **Available Skills** list (PRD FR-73; `apps/web/src/available-skills.tsx`)
shows a Floor's Skills: the office library's enabled Skills and the
repository's own the Owner has reviewed, a repository Skill in place of
the office Skill of its name, and the built-in Skills. Every one of them is available to the Manager (the per-Role switches
above are for sandboxes). Each entry has the Skill's name, its description
and where it comes from (**Office**, **Repository** or **Built in**).
Opened, a built-in Skill says whether running it starts a Grilling Session
or loads its instructions, and credits Matt Pocock for those adapted from
his skills.

- **Where.** Beside the [Manager chat](events-and-chat.md#the-manager-chat);
  in Floor Settings, as the **Available Skills** card, for the Floor picked there;
  and on the bookshelf in the Manager's glass office in the 3D Office
  (`/?floor=<floor>&inspect=skills-bookshelf:<floor>`).
- **Opening one** shows a modal with its `SKILL.md` rendered (its
  instructions, below the frontmatter) and its supporting files, each
  viewable in the modal: Markdown files rendered, the rest as written. The
  Markdown is rendered to elements, never as HTML: HTML written in it is
  shown as text, links open in a new tab, and images are not fetched.
- **Run** puts `/name ` at the start of the Manager chat's box, in place of
  a Skill's command already there, and anything else written there stays as
  its arguments. Focus moves to the box, to add what the Skill is for and
  send; sent, it [runs the Skill](events-and-chat.md#the-manager-chat). From Admin or the bookshelf, **Run** opens the Floor's Manager chat
  (`/floors/<floor>/manager?skill=<name>`) with the command in the box.
- **API.** `GET /api/floors/:floorId/skills/:name` gives one of the Floor's
  Skills in full (`name`, `description`, `source`, `folder`,
  `overridesOffice` and `files`, `SKILL.md` first): a repository Skill's
  whole folder is read through the GitHub App at the default branch, as
  warily as a clone (no symbolic links or submodules, text files only,
  within the format's limits). A name the Floor has no Skill of is `404
  skill_not_found`.
