# Issue #134: The Communications Agent in 3D, the lobby reception desk — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) in the working tree of this branch, clean at
`66ebe71`. The code is in `7aec619`, `e81371a`, `771d903` and `bd811b0`;
the guide and README are in `66ebe71`. The checks were `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `drizzle-kit generate` and `pnpm scenes`.
After them, only this note changed.

The blockers are built on this branch:

- **#125**, the Communications Agent and Connections
  ([`issue-125.md`](issue-125.md)): its one row (`communications_agent`),
  `GET`/`PATCH /api/communications-agent`, and each Connection's `status`
  (`failing` after 5 failures in a row) and `lastDelivery` from
  `GET /api/connections`, which this issue reads.
- **#65**, the lobby ([`issue-65.md`](issue-65.md)): the reception desk,
  its out-tray and chair as data. Its note left "the Communications Agent
  is not at its desk yet … its envelope into the out-tray and its
  failing-Connection marker (FR-96)" to this work.
- **#73**, Agent state visuals ([`issue-73.md`](issue-73.md)): the marker
  style and the Manager's pulsing red light, which the desk's marker
  follows. The shared character kit (#70) draws the Agent.

## What was built

### Who sits at reception

Since #65, main added a lobby **receptionist** ("Rita"): a character in
the lobby's cast, not an Agent, who sits in the reception chair, greets
the Owner and has idle routines. The PRD (FR-57, FR-90, FR-96) and the
glossary put the **Communications Agent** at that desk. Two figures cannot
share one chair, so **the receptionist is now the Communications Agent**,
in its own name and Avatar. It keeps main's greeting and routines, so
nothing main built is lost. The issue puts idle behaviours out of scope,
and these routines are main's, not new ones.

- **Its Avatar** (`7aec619`; FR-90 lists one, and #125 did not build it).
  The new column is `communications_agent.avatar` (jsonb, migration
  `0077_communications_agent_avatar`). Null means the default look,
  `defaultCommunicationsAgentAvatar`, which is the receptionist's old
  default look. The migration gives it the look the Owner had given the
  receptionist (`office_settings.lobby_cast -> 'receptionist' -> 'avatar'`),
  if they gave one. An Avatar that no longer parses reads as the default.
  `GET /api/communications-agent` sends `avatar`. `PATCH` takes it and
  publishes `config.changed` (scope `communications`, key `avatar`) only
  when the look really changed (compared by value).
- **Agent Settings** (`771d903`). In the lobby, the receptionist's card is
  now "Grace, the Communications Agent". Its name and Avatar are saved with
  `PATCH /api/communications-agent`, sending only what changed. A link
  points to the Connections admin for the rest. The visitor's card is
  unchanged. The greeting's status message uses the Communications
  Agent's name ("Grace says: Hi, Ade. Good morning.").

### The reception desk (`e81371a`; `apps/web/src/scene/reception-desk.ts`, `.tsx`)

- **What was sent.** A successful delivery is never on the event bus; it
  is only in its Connection's own log (FR-94). So while the lift is in
  the lobby, the Office reads `GET /api/connections` every 5 s
  (`receptionRefreshMs`). It does not read it on a Floor.
  `tallySent` counts a message when a Connection's `lastDelivery` (a
  message or a test) is `delivered` and was not counted before. The
  first reading is the baseline, so history is not replayed. Two
  deliveries on one Connection between readings count as one.
- **The envelope.** Each message sent drops a DL envelope (22 × 11 cm,
  `paper`) from the Agent's hands over the desk. It follows an eased arc
  (0.9 s, rising 18 cm over the straight line) and goes from held up to
  flat as it lands on the pile in the out-tray (up to 8 show). Three drop
  one after another, 0.3 s apart; any more land at once, so the
  animation catches up. With reduced motion every envelope lands at
  once. What was sent before the desk was drawn (back from a Floor) is
  already in the tray. The out-tray moved from the work top to the
  counter's ledge (`outTray` in `lobby-layout.ts`). On the work top it
  sat 25 cm below the counter's top, hidden from every view of the lobby.
- **The red marker.** While any Connection is `failing`, a sign stands on
  the counter's ledge at the end away from the out-tray
  (`receptionMarker`). It is an 18 cm disc on a post with an exclamation
  mark in `paper`, glowing `state-critical` × 1.6 so it blooms. It pulses
  as the Manager's red light does (`lightIntensity`, 1.2 to 2.0 over
  1.4 s; steady with reduced motion) and turns about its post towards
  the camera.
- **Delivery never waits for an animation.** Nothing in the delivery path
  knows about the scene. The scene only reads what was already sent, and
  envelopes far behind land at once.
- **Cost.** The pile is one instanced mesh; the dropping envelope is one
  mesh; the marker is four meshes, and only while a Connection fails.
  The per-frame work is one `OutTray.advance` and, with the marker, one
  colour and one rotation.

### Clicking it: its Agent card (`inspectable.ts`, `communications-agent-card.tsx`)

- The Communications Agent is an inspectable `agent` in the lobby, id
  `communications` (`communicationsAgentObject`, `lobbyInspectables(name)`).
  It is in the keyboard **Inspect** list and in the address
  (`/?inspect=agent:communications`). Its box is the seated-Agent box at
  the reception chair, facing +z. Its view looks down over the counter
  from the front right with the whole desk in frame, so the Agent, the
  out-tray and the marker are all visible.
- Its panel, `CommunicationsAgentCard`, shows its Role (Communications),
  AI Provider, Model ("(default)" when it has no override), whether it is
  sending or paused, and how many Connections it has, naming the failing
  ones. It ends with **Open the Connections admin** (`/admin/connections`).

### Screenshots (`bd811b0`)

The screenshot page's lobby now has the Communications Agent at reception
(Avatar from the seed `screenshots:communications`) and the visitor,
three envelopes in the tray and a failing Connection. A new key scene,
`reception`, uses the Communications Agent's own fly-in view
(`e2e/scenes/reference/reception-linux.png`). The lobby's reference
picture was retaken.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below): 375 test files, 4157 tests passed, 557
      skipped (Postgres and Mailpit, which need Docker).
      `drizzle-kit generate` finds nothing more to generate. The first
      full run had one failure, in `grilling-room.test.tsx`, which this
      issue does not touch. It is a known flaky test (see "Noticed, out of
      scope" and #133's note). The second full run passed.
- [x] **Screenshot test of the lobby with the reception desk, including
      the failing marker.** `pnpm scenes` passes, **15 passed** (output
      below). That covers the five key scenes, the new `reception` one
      included, and the ten Floor-theme scenes, which did not change.
      - **The lobby** (`lobby-linux.png`, retaken) shows the
        Communications Agent typing at reception and the visitor on the
        sofa. Before the retake it differed from the old reference by 970
        pixels, all on the two figures and the marker (checked in the
        diff picture).
      - **The reception desk** (`reception-linux.png`, new) shows the
        Agent at the desk, the envelopes on the out-tray on the ledge, and
        the red marker with its exclamation mark. I looked at the picture.
      - **It catches a missing marker.** As a check, I set
        `reception.failing` to `[]` in `scene-data.ts`, ran the
        comparison, then reverted the edit. `reception` failed by 741
        pixels (tolerance 100), while `the lobby` still passed. At the
        overview the marker is under 100 pixels, which is why the
        close-up scene exists.
      - Chromium ran as earlier notes describe (below).

The behaviour is also covered by unit and component tests, all passing:

- `reception-desk.test.ts` (13): counting what was sent, the failing
  Connections, the envelope's arc and landing, and the tray's queue,
  catch-up and reduced motion.
- `lobby.test.tsx` (6 new, in the test renderer): no desk until the
  Connections are read; an envelope from the hands into the tray; the pile
  already there and capped; reduced motion; the marker at
  `receptionMarker`, glowing past `state-critical`, and gone once the
  Connection recovers; the lobby's mesh count with all of it.
- `office-view.test.tsx` (4 new): the receptionist is the Communications
  Agent in its name. Two new deliveries are "2 sent", a re-read with
  nothing new adds none, and the failing Connection is named. The
  Connections are not read on a Floor. Its card opens with
  "Failing: Team chat", "2 Connections", its Model and the link to
  `/admin/connections`.
- `inspectable.test.ts` and `inspectable-hotspots.test.tsx`: it is
  listed, picked by its seat (the chair inside its box, the counter
  outside), its view is clear and framed between the controls and the
  panel, and clicking it selects `agent:communications`.
- `agent-settings-page.test.tsx` (2 changed): renaming it and changing its
  Avatar send `PATCH /api/communications-agent` with only that field.
- The backend tests: `communications.test.ts` (its default look, a new
  look stored, one `config.changed` with `avatar`, none for the same look
  again); `routes.test.ts` (the API sends and sets it and refuses an
  unknown hairstyle with 400); and `communications-avatar-migration.test.ts`
  (the receptionist's look carried over; null when there was none).
  These need Postgres for their database cases. They were also run
  against Postgres 18 (below): db 19 passed, communications 135 passed
  (3 skipped, Mailpit), the Connections API 18 passed, with no Postgres
  skips.

### Verified on the host

- [ ] **The animation plays smoothly and the lobby keeps the frame-rate
      target.** This was not verifiable here: there is no GPU or display,
      and SwiftShader's frame rate says nothing about a laptop's. On the
      host, open the Office in the lobby with **Show frame rate**, add a
      Connection and press **Send test** a few times in a row (each test
      drops an envelope within 5 s), and make one fail 5 times to see the
      marker. In the sandbox, the lobby's cost test passes with the desk's
      envelopes and marker drawn. The desk adds at most six meshes, and
      per frame only one tray update and one colour and rotation.

## Not verifiable in this sandbox

- **How it looks and moves in a real browser on a GPU.** The envelope's
  arc, its timing, the marker's pulse and bloom, and how readable the
  sign is at the overview. The screenshots are taken with reduced motion,
  so the drop itself is only checked by the tests.
- **The end-to-end suites**, which need Docker. `e2e/tests/agent-settings.spec.ts`
  and `accessibility.spec.ts` were updated for the renamed card. The
  greeting now uses the Communications Agent's name, which is chosen at
  random at first start and read from `GET /api/communications-agent`.
  They typecheck, but did not run.

## Notes

- **How Postgres and Chromium were run here** (outside the repository,
  as for earlier issues):
  - **Postgres**: `@embedded-postgres/linux-x64@18.4.0-beta.17` (PostgreSQL
    18.4) in `/tmp/pgdl`, on port 54329. A scratch edit to
    `packages/db/src/testing/postgres.ts` pointed `postgresTest` at it
    through `SCRATCH_PG_URL`, with the files run one at a time. It was
    reverted with `git checkout` and never committed.
  - **Chromium**: `playwright install chromium` (headless shell 1248). Its
    missing shared libraries came from Debian bookworm packages,
    extracted to `/tmp/chromelibs` and put on `LD_LIBRARY_PATH`.
- **A git mistake, repaired.** To test the flaky test on the base commit,
  I made a temporary worktree and then ran `git worktree remove` and
  `git worktree prune`. In this sandbox, the workspace's `.git` points to
  the host repository's `.git/worktrees/sandcastle-20261010-184027-e17068`.
  That entry's `gitdir` names a host path that does not exist in here, so
  the prune deleted the whole `.git/worktrees/` directory.
  - **What was repaired.** No commits were lost: the branch
    `sandcastle/20261010-184027-e17068` was at `66ebe71` throughout. I
    recreated this worktree's entry by hand (`HEAD`, `commondir`, and a
    `gitdir` of
    `/home/eyread01/projects/a/temp3/.sandcastle/worktrees/sandcastle-20261010-184027-e17068/.git`,
    inferred from the entry's name and Sandcastle's
    `.sandcastle/worktrees/<name>` layout), then rebuilt its index with
    `git reset`. Git works again here.
  - **What to check on the host.** Run `git worktree list` in the main
    repository and confirm the `gitdir` path above. Any other worktree
    registered on the host at the time also lost its entry. The branch
    `sandcastle/20261009-121853-381953` is the only other Sandcastle
    branch; if it still had a worktree, re-register it with
    `git worktree repair <path>`.

## Noticed, out of scope

- **The lobby cast's receptionist is no longer shown.**
  `GET`/`PUT /api/office/lobby-cast/receptionist` and `lobby_cast` still
  hold it, since main's API and its tests rely on them, but the lobby and
  Agent Settings now use the Communications Agent. Retiring the role from
  the cast (or keeping it only for the migration) is a small follow-up.
- **The name limits differ.** The Communications Agent's name allows 40
  characters, while the lobby cast allowed 60. Agent Settings shows the
  server's message when a name is too long.
- **Configuration export and import** do not carry the Communications
  Agent, now including its Avatar. #125's note already records this gap
  (#113).
- **The overview screenshot is blind to the marker** (under 100 pixels),
  so the close-up `reception` scene carries that check. A bigger marker
  would show at the overview but would be out of scale with the desk.
- **The envelopes are the same `paper` as the tray's letters**, so a pile
  reads as paper, not envelopes, at a distance. The palette has no
  envelope colour, and `docs/reference/art-direction.md` is canon.
- **The hotspot stays at the chair** while the receptionist walks to the
  water cooler or the Notice Board, as each Floor Agent's does during its
  idle activities.
- **A flaky test, not touched here**:
  `grilling-room.test.tsx > … the Manager walks to the table …`. The
  Floor's idle behaviours use an unseeded `Math.random`, and now and then
  a non-Manager Agent's idle walk ends inside the meeting room's bounds.
  - **On this branch** it failed in 1 of 2 full runs, and 2 of 25 runs of
    the file alone.
  - **On the base commit `1f8434f`** it failed 1 of 75 times, with the
    same assertion (`reviewer: expected true to be false`).
  - #133's note saw it too. Seeding the Floor's random in that test would
    fix it.

## Output

```text
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/web typecheck: Done
e2e typecheck: Done
typecheck exit=0

$ pnpm --filter @ai-office/db exec drizzle-kit generate
No schema changes, nothing to migrate 😴

$ pnpm test   (first run; no Docker: Postgres tests skip with the reason)
 FAIL  |@ai-office/web| src/scene/grilling-room.test.tsx > a Grilling Session on a Floor > the Manager walks to the table as it starts and sits there while it runs, with the door's sign lit and the whiteboard filled in; it walks back when the session pauses
AssertionError: qa: expected true to be false // Object.is equality
 ❯ src/scene/grilling-room.test.tsx:174:9
 Test Files  1 failed | 374 passed (375)
      Tests  1 failed | 4156 passed | 557 skipped (4714)

$ pnpm test   (second run)
 Test Files  375 passed (375)
      Tests  4157 passed | 557 skipped (4714)
exit=0

$ pnpm vitest run src/scene/grilling-room.test.tsx   (25 times on this branch; 75 on 1f8434f)
this branch: 2 of 25 failed
base 1f8434f: 1 of 75 failed   (AssertionError: reviewer: expected true to be false)

$ pnpm scenes   (LD_LIBRARY_PATH=/tmp/chromelibs/…)
  ✓   1 [chromium] › scenes/floor-themes.spec.ts:22:1 › covers every theme (6ms)
  ✓   2 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the office theme, from development (1.3m)
  ✓   4 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the studio theme, from website-and-marketing (1.3m)
  ✓   3 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the stockroom theme, from online-store (1.3m)
  ✓   7 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the atelier theme, from design-system (1.8m)
  ✓   5 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the editorial theme, from content-and-blog (1.8m)
  ✓   6 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the library theme, from documentation (2.0m)
  ✓   8 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the observatory theme, from data-and-analytics (1.9m)
  ✓   9 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the data-centre theme, from infrastructure (1.9m)
  ✓  10 [chromium] › scenes/floor-themes.spec.ts:29:3 › a Floor in the device-lab theme, from mobile-app (1.8m)
  ✓  11 [key-scenes] › scenes/scenes.spec.ts:55:1 › the lobby (8.5s)
  ✓  12 [key-scenes] › scenes/scenes.spec.ts:60:1 › the lobby's reception desk, with a failing Connection's marker (9.4s)
  ✓  15 [key-scenes] › scenes/scenes.spec.ts:83:1 › the Avatar Editor's preview (1.5s)
  ✓  13 [key-scenes] › scenes/scenes.spec.ts:70:1 › a Floor (8.9s)
  ✓  14 [key-scenes] › scenes/scenes.spec.ts:75:1 › the meeting room (9.1s)
  15 passed (5.4m)

$ pnpm scenes --project=key-scenes   (before retaking the lobby)
  ✘  2 [key-scenes] › scenes/scenes.spec.ts:53:1 › the lobby (6.7s)
      970 pixels (ratio 0.01 of all image pixels) are different.

$ pnpm scenes --project=key-scenes -g "reception|the lobby$"   (scratch: no failing Connection; reverted)
  ✓  1 [key-scenes] › scenes/scenes.spec.ts:55:1 › the lobby (6.8s)
  ✘  2 [key-scenes] › scenes/scenes.spec.ts:60:1 › the lobby's reception desk, with a failing Connection's marker (7.4s)
      741 pixels (ratio 0.01 of all image pixels) are different.

$ SCRATCH_PG_URL=… vitest run --no-file-parallelism   (Postgres 18.4, embedded; scratch edit reverted)
packages/db:              Test Files  7 passed (7)    Tests  19 passed (19)
packages/communications:  Test Files  12 passed (12)  Tests  135 passed | 3 skipped (138)   (Mailpit: needs Docker)
apps/server connections/routes.test.ts:               Tests  18 passed (18)

$ vitest run (the new and changed web tests)   (verbose, abridged)
 ✓ reception-desk.test.ts > what the Communications Agent has sent > counts nothing sent before the Connections were first read
 ✓ reception-desk.test.ts > what the Communications Agent has sent > counts each new delivered message or test once, on any Connection
 ✓ reception-desk.test.ts > what the Communications Agent has sent > does not count a delivery until it is delivered
 ✓ reception-desk.test.ts > the out-tray > catches up: beyond a few, envelopes land at once
 ✓ reception-desk.test.ts > the out-tray > lands every envelope at once with reduced motion
 ✓ lobby.test.tsx > the Communications Agent's reception desk > drops an envelope from the Agent's hands into the out-tray for each message sent
 ✓ lobby.test.tsx > the Communications Agent's reception desk > shows a red marker on the desk while a Connection is failing, and none once it recovers
 ✓ lobby.test.tsx > the Communications Agent's reception desk > keeps the lobby within its budgets with the desk's envelopes and marker
 ✓ office-view.test.tsx > the lobby and the Floors > seats the Communications Agent at reception as the receptionist, in its own name
 ✓ office-view.test.tsx > the lobby and the Floors > drops an envelope at reception for each message sent, and shows a failing Connection's marker
 ✓ office-view.test.tsx > the lobby and the Floors > reads the Connections in the lobby only
 ✓ office-view.test.tsx > inspectable objects > opens the Communications Agent's card at reception, linking to the Connections admin
 ✓ inspectable.test.ts > the lobby's inspectable objects > fly in to each, seeing it whole between the controls and the panel, with nothing in the way
 ✓ agent-settings-page.test.tsx > Agent Settings > changes the Communications Agent's Avatar, as the reception desk shows it
 Test Files  7 passed (7)
      Tests  145 passed (145)
```
