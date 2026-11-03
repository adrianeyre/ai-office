# Developing AI Office

What you need, the commands, the tests and how AI Office's own issues are
worked. To run AI Office for yourself, see [Running AI Office](running.md).

## Requirements

- Node **26** or later and pnpm **12** or later (`devEngines` in
  `package.json`; older versions are refused)
- Docker, for the Sandcastle sandboxes and the Postgres integration tests

## Getting started

```bash
pnpm install
```

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Starts the development Postgres (Docker), applies the schema, builds any sandbox image not built yet, then runs the server (restarts on change) and the Vite dev server together; see [Running in development](running.md#running-in-development) |
| `pnpm lint`      | ESLint (type-aware) and a Prettier check                 |
| `pnpm typecheck` | `tsc` for the root config and every workspace package    |
| `pnpm test`      | Vitest, with each workspace package as its own project   |
| `pnpm format`    | Prettier and `eslint --fix`, rewriting files in place    |
| `pnpm build`     | Builds every package that has a build (the web app)      |
| `pnpm db:schema` | Apply the schema to the database at `DATABASE_URL` if it is empty, or check it is the same schema if not |
| `pnpm db:reset` | Recreate the development Postgres, empty, and apply the schema |
| `pnpm db:up` / `pnpm db:down` | Start / stop the development Postgres, and the sandboxes' network and sandbox relay (`docker-compose.dev.yml`) |
| `pnpm e2e`       | Builds the web app, then runs the Playwright end-to-end tests |
| `pnpm scenes`    | Screenshot tests of the 3D scenes in headless Chromium with software WebGL, without a GPU: the 3D Office's key scenes (see [Scene screenshot tests](#scene-screenshot-tests)) and a Floor in each 3D theme (see [the guide](web-app.md#screenshot-tests-of-the-3d-scenes)) |
| `pnpm screenshots` | Builds the web app, then retakes the README's screenshots in `docs/images/` |
| `pnpm site:build` | Builds the project website (`site/`, its stageshow demos bundled by Vite) in `site/dist/` |
| `pnpm site:dev` / `pnpm site:preview` | Serves the website as you change it / serves the built `site/dist/` |
| `pnpm sandbox:build` | Builds the sandbox images for Claude Code, Codex and opencode (needs Docker); for compose, `AGENT_UID=1000 AGENT_GID=1000 pnpm sandbox:build` |
| `pnpm sandbox:ensure` | Builds only the sandbox images not built yet; `pnpm dev` runs it first |
| `docker compose up --build` | Runs the whole AI Office in Docker: the app, Postgres, and Agents' and the Manager chat's sandboxes, started from inside the app (build the sandbox images first, as above); see [Running with docker compose](running.md#running-ai-office-with-docker-compose) |

AI Office has one address, `http://localhost:3045` both in `pnpm dev` and
under compose: the web app, its `/api`, and the AI Gateway at `/v1`. Point
your own tools at it with a Gateway Key from **API Key Management**:
Claude Code with `ANTHROPIC_BASE_URL=http://localhost:3045`, Codex and
other OpenAI clients with `http://localhost:3045/v1` (see
[Gateway Keys](ai-gateway.md#gateway-keys)). Whatever that
address is opened to, the Gateway is too, still behind Gateway Keys; to
open it beyond your machine, use compose's `tls` profile.

Tests that need Postgres start Postgres 18 with Testcontainers, so they need
Docker. Without it they are skipped with the reason (or fail when `CI` is
set, so CI never skips them). AI Office is not in production yet, so its
schema has no migrations: it is one plain SQL file, `packages/db/schema.sql`.
After changing `packages/db/src/schema.ts` (or
`src/schema-extras.sql`, the trigger and starting rows it cannot say),
`pnpm --filter @ai-office/db db:generate` writes it again, and
`pnpm db:reset` recreates the development database from it.

### End-to-end tests

`pnpm e2e` builds the web app and runs the Playwright suites in `e2e/` in
Chromium. Postgres 18 is started once with Testcontainers and the schema is
applied to a template database. Each test then gets a fresh copy, and its own server
process on a free port, so tests start from a first run and can run in
parallel. Each server's GitHub App talks to the test's own fake GitHub
(`office.github`), served over HTTP through `GITHUB_API_URL`.

The server process is `e2e/server/main.ts`: AI Office started as
`apps/server/src/main.ts` starts it, plus an IPC channel to the test. Through
it a test does what no part of AI Office does yet: `office.raiseNotice()`
raises a Notice, and `office.publish()` publishes an event on the bus.
`office.pollIntake()` runs issue intake at once. With no Docker, Agents'
tasks go to a stand-in sandbox runner (`startOffice`'s `sandboxRunner`
option), which records each task's Agent, AI Provider, Model and effort
(`office.sandboxTasks()`) and fails it.

```bash
pnpm --filter @ai-office/e2e exec playwright install chromium   # once
pnpm e2e
```

Without Docker the tests are skipped with the reason (CI fails instead).
To use a Postgres you already run, set `E2E_POSTGRES_URL` to a superuser
URL for it. Failed tests keep a trace, a screenshot and the server's log in
`e2e/test-results/` (`pnpm --filter @ai-office/e2e exec playwright
show-trace <trace.zip>`); CI uploads them as the `playwright-traces`
artifact.

### Scene screenshot tests

`pnpm scenes` compares the 3D Office's key scenes with reference
pictures (PRD §9, Visual): the lobby, its reception desk close in, a
Floor, the same Floor with the Context Usage bars and tokens above its
Agents' heads, its meeting room and the Avatar Editor's preview. It needs
no GPU, no Docker and no server.

- **The scenes** are drawn by the Office's own components
  (`OfficeScene`, `AvatarPreview`) on a page of their own,
  `apps/web/screenshots/`, never part of the app's build. Its data is
  fixed (`screenshots/scene-data.ts`). It has a Floor of seven Agents
  whose Avatars come from fixed seeds (`seededRandom`), and they show
  every state the Office draws at a desk: working at a lit monitor,
  waiting on review, paused, capped, and piles of tickets. It also has
  fixed Notices on the boards and lift stops, and in the lobby the
  Communications Agent at reception (its Avatar from a fixed seed) and
  the visitor, three envelopes in the out-tray and a failing Connection's
  red marker (FR-96). Above the Floor's Agents' heads (FR-62, FR-85), the
  busy coder has its Context Usage bar and its tokens today, the idle
  designer its tokens alone, and others tokens at 80% and at 100% of the
  daily cap, built from fixed Context Usage and token usage as the API
  sends them. Each scene has a fixed camera: the Office's
  overview for the lobby and both Floor scenes, the view the Office flies to when
  the Communications Agent is clicked for the reception desk (without the
  marker it differs by 741 pixels; the overview alone would not notice),
  a view into the meeting room, and the preview's own. They are drawn at Medium
  quality with reduced motion, so nothing moves. The models and the logo
  load before the first frame. After ten frames the page stops drawing
  and says it is ready (`data-scene="ready"` on `<html>`).
- **The browser** is Playwright's headless Chromium with WebGL in
  software (SwiftShader through ANGLE, `--use-angle=swiftshader`), at
  1280 × 720 and a device pixel ratio of 1. Each test checks it really
  draws with SwiftShader. Only the canvas is compared, so fonts play no
  part, except in the scene with the displays above the Agents' heads:
  they are HTML over the canvas, so that one compares the canvas and its
  labels together, after checking the labels' text and colours in the
  page. The page sets its fonts to DejaVu (`screenshots/styles.css`),
  which Debian and Ubuntu both ship, so the labels' text is drawn alike
  on every Linux. Without the coder's bar it differs by 1,653 pixels.
- **The tolerance** (`e2e/scenes/scenes.spec.ts`): a pixel counts as
  changed past Playwright's default colour threshold (0.2), and a picture
  fails when more than 100 pixels change. Repeated runs of the same build
  differ by none. One Agent stopping work on the Floor changes 252 pixels,
  and another hair colour in the preview changes 418.
- **The reference pictures** are in `e2e/scenes/reference/`, named
  for Linux, where CI runs them. After a change to how a scene looks, look
  at the new pictures, then take them again and commit them:

```bash
pnpm --filter @ai-office/e2e exec playwright install chromium   # once
pnpm scenes                       # compare
pnpm scenes --update-snapshots    # take new reference pictures
```

`e2e/playwright.scenes.config.ts` builds the page and serves it on
127.0.0.1:3049 (`pnpm --filter @ai-office/web screenshots:serve`), as its
`key-scenes` project. The same command also runs the Floor themes'
screenshot tests, its `chromium` project, on a page of their own (see
[the guide](web-app.md#screenshot-tests-of-the-3d-scenes));
`--project=key-scenes` runs these alone. A failed
comparison leaves the actual, expected and diff pictures in
`e2e/test-results/scenes/`. CI's **Screenshots** job uploads them as
the `screenshot-differences` artifact.

The workspace follows the layout in §8 of the PRD: `apps/server`,
`apps/web`, and
`packages/{orchestrator,gateway,github,communications,db,events,shared}`.

## Working on AI Office with Sandcastle

AI Office's own issues are worked by a coding agent inside a Docker sandbox
using [Sandcastle](https://github.com/mattpocock/sandcastle)
(`@ai-hero/sandcastle`). Setup, running, writing prompts and landing a run
are covered in
[`docs/processes/running-sandcastle.md`](../processes/running-sandcastle.md).

```bash
cp .sandcastle/.env.example .sandcastle/.env   # then fill in credentials
pnpm exec sandcastle docker build-image
git checkout -b issue-9-some-slice origin/main
pnpm sandcastle 9
```
