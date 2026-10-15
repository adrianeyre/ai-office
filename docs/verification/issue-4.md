# Issue #4: Scaffold the pnpm workspace — verification

All checks below were run in the Sandcastle sandbox (Node 26.10.0, pnpm
12.10.0) against a fresh `git clone` of this branch at the commit that
completed the issue (`7b82e94`), after `pnpm install --frozen-lockfile`.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass from a clean
      clone.** Cloned the branch into `/tmp/clone`, ran
      `pnpm install --frozen-lockfile`, then each script: all three exit 0
      (output below). To make sure the gates are real and not passing
      vacuously, I also broke them on purpose in the working tree and saw each
      fail: a type error and an unused variable in `packages/events` failed
      `pnpm typecheck` (TS2322, TS6133); an `async` function with no `await` in
      `apps/web` and the unused variable failed `pnpm lint`
      (`@typescript-eslint/require-await`, `no-unused-vars`, so type-aware
      linting is on); a throwing test in `packages/db` failed `pnpm test`. All
      deliberate breakages were reverted before committing.
- [x] **Each package has one trivial passing Vitest test.** Each of the eight
      packages has `src/index.test.ts`; the verbose reporter shows one passing
      test per package, labelled by project (output below). Each package also
      runs its own tests alone (`pnpm --filter @ai-office/db test` → 1 passed).
- [x] **`pnpm sandcastle` still works (the harness and `devEngines`
      survive).** The root `package.json` was extended, not rewritten: the
      `sandcastle` script, `@ai-hero/sandcastle` and `tsx` devDependencies,
      `packageManager`, `engines` and `devEngines` are unchanged (dump below).
      `.sandcastle/` was not touched. `pnpm sandcastle` with no arguments loads
      `.sandcastle/main.ts` under `tsx` (its `@ai-hero/sandcastle` imports
      resolve before any code runs) and reaches the harness's own refusal,
      `prompt.md contains {{ISSUE}}, so it needs an issue number`, exiting 1 as
      designed. A full run needs Docker; see below.

## What was built

- Root: `tsconfig.base.json` (strict, ESM `nodenext`, erasable syntax only so
  Node 26 can strip types, `noEmit`), `tsconfig.json` for the root config
  files, `eslint.config.js` (flat config: `@eslint/js` recommended,
  typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`,
  `eslint-config-prettier`), `.prettierrc.json`, `.prettierignore`,
  `vitest.config.ts` (each workspace package is a Vitest project).
- Root scripts: `lint` (`eslint . && prettier --check .`), `typecheck` (root
  `tsc`, then `tsc` in every package), `test` (`vitest run`), `format`.
- `apps/server`, `apps/web`, `packages/{orchestrator,gateway,github,db,events,shared}`
  as `@ai-office/*`: `package.json` (ESM, `exports` → `src/index.ts`),
  `tsconfig.json` extending the base, `src/index.ts`, `src/index.test.ts`.
- `THIRD-PARTY-NOTICES.md` with an empty table. No `LICENSE`.
- README: a short table of the workspace scripts.

## Notes for the reviewer

- **TypeScript 6.0, not 7.** `typescript@latest` is 7.0.2, but
  `typescript-eslint` 8.71.1 declares `typescript >=4.8.4 <6.1.0`, so
  type-aware linting requires 6.0.x. Revisit when typescript-eslint supports 7.
- **Vite pinned to 8.3.3** (a Vitest 5 peer). `pnpm add` first resolved 8.3.4,
  published the same day, and pnpm's minimum-release-age policy rejected it
  (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) on the next install. Rather than
  add an exclusion to `pnpm-workspace.yaml`, I pinned the newest version
  outside the window. `pnpm-workspace.yaml` is unchanged; no new package needed
  `allowBuilds`.
- **Prettier ignores Markdown, `.sandcastle/` and the lockfile**, and ESLint
  ignores `.sandcastle/` and `docs/`, so `pnpm format` never rewrites the canon
  or the harness.
- Packages export their TypeScript source (`./src/index.ts`) and nothing is
  built yet; how the server is run or bundled is left to #7 and #8.
- `apps/web` is plain TypeScript with the DOM lib for now; React, Vite and the
  rest of its stack are #8.

## Output (fresh clone, `/tmp/clone`)

```text
$ pnpm install --frozen-lockfile
+ vite 8.3.3
+ vitest 5.0.3
Done in 75ms using pnpm v12.10.0

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck   (tail)
apps/server typecheck: Done
packages/events typecheck: Done
packages/db typecheck: Done
packages/gateway typecheck: Done
packages/github typecheck: Done
packages/orchestrator typecheck: Done
packages/shared typecheck: Done

$ pnpm test
 RUN  v5.0.3 /tmp/clone
 Test Files  8 passed (8)
      Tests  8 passed (8)

exit codes: lint exit=0  typecheck exit=0  test exit=0

$ pnpm exec vitest run --reporter=verbose
 ✓ |@ai-office/db| src/index.test.ts > @ai-office/db > is importable 1ms
 ✓ |@ai-office/gateway| src/index.test.ts > @ai-office/gateway > is importable 1ms
 ✓ |@ai-office/github| src/index.test.ts > @ai-office/github > is importable 2ms
 ✓ |@ai-office/orchestrator| src/index.test.ts > @ai-office/orchestrator > is importable 2ms
 ✓ |@ai-office/events| src/index.test.ts > @ai-office/events > is importable 1ms
 ✓ |@ai-office/web| src/index.test.ts > @ai-office/web > is importable 1ms
 ✓ |@ai-office/shared| src/index.test.ts > @ai-office/shared > is importable 2ms
 ✓ |@ai-office/server| src/index.test.ts > @ai-office/server > is importable 2ms
 Test Files  8 passed (8)
      Tests  8 passed (8)

$ pnpm sandcastle
$ tsx .sandcastle/main.ts
"./.sandcastle/prompt.md" contains {{ISSUE}}, so it needs an issue number.
Usage:
  pnpm sandcastle <issue>                # ./.sandcastle/prompt.md, against that issue
  ...
sandcastle exit=1   (the harness's intended refusal without an issue number)

package.json (harness fields, unchanged)
 "sandcastle": "tsx .sandcastle/main.ts"
 "packageManager": "pnpm@12.10.0"
 "devEngines": { "runtime": { "name": "node", "version": "26.10.0", "onFail": "error" },
                 "packageManager": { "name": "pnpm", "version": "12.10.0", "onFail": "error" } }
```

## Not verifiable in this sandbox

- **A full `pnpm sandcastle <issue>` run.** It builds and starts a Docker
  sandbox, and there is no Docker here. Only the harness's loading and argument
  handling were exercised.
- **`devEngines` enforcement with a wrong Node or pnpm.** Only Node 26.10.0 and
  pnpm 12.10.0 are installed here; the fields are verified present and
  unchanged, not exercised against a mismatched version.
