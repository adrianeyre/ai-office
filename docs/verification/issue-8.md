# Issue #8: React app shell: Vite, TanStack Router and Query, Tailwind and shadcn — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no browser) against a fresh `git clone` of this branch at the commit
that implemented the issue (`d88d0ba`), after `pnpm install --frozen-lockfile`.

## What was built

- **`apps/web`** is a Vite 8 + React 19 + TypeScript app (`index.html`,
  `src/main.tsx`). The placeholder `src/index.ts` from the scaffold (#4) is
  gone; the package is an app, so it no longer has `exports`.
- **Routing (`src/router.tsx`):** TanStack Router with code-based routes. A
  root route renders the layout; its children are `/` (Office), `/notices`,
  `/activity` and `/admin`, each a placeholder page (`src/pages.tsx`), and
  any other path gets a "Page not found" page. `createAppRouter(history?)`
  takes a memory history in tests and uses the browser's otherwise; the
  router type is registered so `<Link to>` is type-checked.
- **Layout (`src/layout.tsx`):** a sidebar with the main navigation (an
  `aria-label="Main"` `<nav>`; the current page's link has
  `aria-current="page"`), the server status, and the page. On narrow screens
  (below Tailwind's `md`) the sidebar collapses behind a menu button with
  `aria-expanded`/`aria-controls`, and following a link closes it (PRD §7
  Responsiveness: phones get the 2D pages).
- **TanStack Query (`src/health.ts`):** the layout's server status reads
  `GET /health` and parses it with `healthResponseSchema` from
  `@ai-office/shared`. This is the first use of the shared Zod schemas in the
  web app. A 503 body ("database down") is shown as such; an unexpected body
  or a failed request shows "Server unreachable".
- **Zustand (`src/ui-store.ts`):** UI state that is not server data (whether
  the narrow-screen navigation is open).
- **Tailwind 4 and shadcn/ui:** `@tailwindcss/vite`, the shadcn theme tokens
  in `src/styles.css`, `components.json` (new-york, neutral, lucide), `cn()`
  in `src/lib/utils.ts`, and the shadcn `Button` and `Card` components in
  `src/components/ui/`. `@/` is an alias for `src/`, as the shadcn CLI
  expects.
- **Build and dev:**
  - `pnpm build` (new root script: `pnpm --recursive --if-present build`)
    runs `vite build` into `apps/web/dist`. That is the server's default
    `WEB_DIST_DIR` (#7), so the server serves it at `/`, with page paths
    falling back to `index.html`.
  - `pnpm --filter web dev` runs Vite and proxies `/api` (and `/health`) to
    the server at `http://localhost:<PORT>`. `PORT` is read from the root
    `.env` (3000 unless set).
- **Lint:** `eslint-plugin-react-hooks` (recommended) is on for `apps/web`.
- **README:** a "Running the web app" section and `pnpm build` in the
  commands table.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three exit
      0 from a fresh clone (output below).
- [x] **A Vitest + Testing Library test renders the layout and each
      placeholder route.** `apps/web/src/app.test.tsx` runs in jsdom and
      renders the real `App` (QueryClient + RouterProvider) with a memory
      history. It checks:
      - the navigation links to all four pages, in order, with their hrefs;
      - for each of `/`, `/notices`, `/activity` and `/admin`, the page's
        `<h1>` renders and exactly one navigation link (the right one) is
        `aria-current="page"`;
      - clicking each navigation link changes the page and the router's
        location without a reload (client-side navigation);
      - an unknown path renders "Page not found";
      - the narrow-screen menu opens and closes through the Zustand store,
        and a followed link closes it;
      - the server status calls `/health` and shows "up", "Database down" for
        a 503 body, and "Server unreachable" for a body the shared schema
        refuses.
      **Negative check:** with the `/admin` route renamed in `router.tsx`, two
      tests fail (`Tests  2 failed | 9 passed (11)`); the change was then
      reverted.

### Verified on the host

- [ ] **`pnpm build` then the server serves the app at `/` with working
      client-side navigation.** Not verified on the host, and there is no
      browser in the sandbox. What was checked here:
      - `pnpm build` succeeds from a fresh clone.
      - The real server (`node src/main.ts`, with an unreachable database)
        serves the built `index.html` at `/` and at `/notices` (SPA
        fallback) and the built JavaScript bundle with
        `application/javascript`. `/health` and `/api/*` are unaffected
        (output below).
      - Client-side navigation was exercised only in jsdom, by the test
        above.

## Output

### Fresh clone (`/tmp/clone8`)

```text
$ pnpm install --frozen-lockfile
Done in 846ms using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
lint exit=0

$ pnpm typecheck   (tail)
apps/server typecheck: Done
apps/web typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  14 passed (14)
      Tests  169 passed | 5 skipped (174)
test exit=0

$ pnpm build   (tail)
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-7thAW5pM.css   14.28 kB │ gzip:   3.63 kB
dist/assets/index-Dd9UZb3r.js   431.52 kB │ gzip: 136.71 kB
✓ built in 215ms
build exit=0
```

The 5 skipped tests are #6's Postgres integration tests (no Docker).

```text
$ pnpm exec vitest run --project @ai-office/web --reporter=verbose
 ✓ src/app.test.tsx > the app layout > links to every page from the navigation
 ✓ src/app.test.tsx > the app layout > renders the Office placeholder at /
 ✓ src/app.test.tsx > the app layout > renders the Notices placeholder at /notices
 ✓ src/app.test.tsx > the app layout > renders the Activity placeholder at /activity
 ✓ src/app.test.tsx > the app layout > renders the Admin placeholder at /admin
 ✓ src/app.test.tsx > the app layout > navigates between pages in the browser
 ✓ src/app.test.tsx > the app layout > shows a not-found page for an unknown path
 ✓ src/app.test.tsx > the app layout > opens and closes the navigation on narrow screens
 ✓ src/app.test.tsx > the server status > reads /health with the shared schema
 ✓ src/app.test.tsx > the server status > reports a database that is down
 ✓ src/app.test.tsx > the server status > reports a server that does not answer as expected
      Tests  11 passed (11)
```

### The server serving the build (sandbox, no database)

```text
$ DATABASE_URL=postgres://nobody:pw@127.0.0.1:1/none SESSION_SECRET=… ENCRYPTION_KEY=… \
  PORT=3917 node src/main.ts
$ curl -i localhost:3917/
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
content-length: 394

<!doctype html>
$ curl localhost:3917/notices
<!doctype html>
<html lang="en">
  <head>
$ curl -w '%{http_code} %{content_type}' localhost:3917/assets/index-….js
200 application/javascript; charset=utf-8
$ curl localhost:3917/health
{"status":"unavailable","database":"down"} 503
$ curl localhost:3917/api/x
{"error":"Not Found"} 404
```

### The dev proxy (sandbox)

With the server on port 3000 and `vite --port 5173`:

```text
$ curl localhost:5173/health
{"status":"unavailable","database":"down"} 503     (proxied to the server)
$ curl localhost:5173/api/nothing
{"error":"Not Found"} 404                          (proxied to the server)
$ curl localhost:5173/admin | grep main.tsx
<script type="module" src="/src/main.tsx">         (Vite serves the app)
```

## Notes for the reviewer

- **Code routes rather than file routes.** The issue allows either. Code
  routes need no generated route tree or extra Vite plugin, and four routes
  don't need one.
- **The status indicator** is a small addition so the shell uses TanStack
  Query and a shared schema for something real, as "What to build" asks. It
  calls the existing `/health`, not a new API.
- **shadcn/ui components** are copied into `src/components/ui/` as shadcn
  intends (MIT-licensed source). `THIRD-PARTY-NOTICES.md` covers assets and
  says npm dependencies are not repeated, so they are not listed there.
- **`tsconfig.json` for the web app** uses `moduleResolution: bundler` and
  `jsx: react-jsx`, and turns off `rewriteRelativeImportExtensions`. tsc
  emits nothing here, and that option rejects `.ts` extensions on `@/`
  alias imports. It includes Node's types for `vite.config.ts`.
- **A stray pnpm store.** `pnpm add` created a `.pnpm-store/` in the
  workspace root. It was moved out (to `/tmp`) and not committed, and a
  fresh-clone `pnpm install --frozen-lockfile` works without it.

## Not verifiable in this sandbox

- Client-side navigation in a real browser on the served build (there is no
  browser here; jsdom covers it in the test).
- How the layout looks at desktop, tablet and phone widths.
