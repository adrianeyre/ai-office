# Issue #63: Art direction spec — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) against a fresh `git clone` of this branch at the
last code commit of the issue (`706cbf0`), after
`pnpm install --frozen-lockfile`.

## What was built

- **The spec**, [`docs/reference/art-direction.md`](../reference/art-direction.md)
  (PRD §7, Visual bar):
  - the look: stylised and soft-lit, simple chamfered forms, a restrained
    palette with saturated colour kept for Stages, states and screens, no
    pure black or white, readable from the high three-quarter view, no text
    in the scene;
  - the colour palette: 32 named tokens in seven groups (architecture,
    furniture and props, screens and light sources, paper and ink, Stages,
    the states of FR-62 and FR-85, light colours), each with its value, its
    foreground where it carries a label, and what it is for; the two kinds
    of colour outside it (the Avatar swatches, and up to 8% variation
    within a token);
  - lighting: key, fill, hemisphere ambient, environment and emissives, with
    colours, intensities and angles; shadow softness per quality setting;
    bias; baked AO; Neutral tone mapping;
  - post-processing defaults: N8AO ambient occlusion, bloom for emissives
    only, tone mapping, colour grading, vignette and anti-aliasing, per
    quality setting;
  - world scale (1 unit = 1 m, Y up, origins, grids, ceiling, doors,
    walkways), desk dimensions, and the sizes of Avatars and rooms;
  - material rules (metallic-roughness only, roughness by surface, binary
    metalness, glass and foliage, shared materials, KTX2 textures);
  - polygon and texture limits per quality setting (Low, Medium, High),
    LODs, instancing, the shared rig's limits and file sizes;
  - approved CC0 sources (Kenney, Quaternius, Poly Pizza's CC0 models only),
    the rule for purchased packs (only if redistributable in a public
    repository), and the licence-tracking rule for
    `THIRD-PARTY-NOTICES.md`; a checklist for adding an asset.
- **The palette in code**: `palette`, `paletteTokens` and
  `paletteForegrounds` in `packages/shared/src/palette.ts`, exported from
  `@ai-office/shared` and on their own from `@ai-office/shared/palette`
  (which imports nothing, so Tailwind's config loader and the browser can
  load it alone).
- **Tailwind**: `apps/web/tailwind.config.ts` makes the palette the
  `office-*` colours (`bg-office-stage-work`,
  `text-office-state-critical`); `apps/web/src/styles.css` loads it with
  `@config`. The shadcn/ui theme and Tailwind's own colours are unchanged.
  The charts' existing `--viz-status-warning` and `--viz-status-critical`
  were already `#fab219` and `#d03b3b`, so the palette's `state-warning` and
  `state-critical` take those values, and a test keeps them equal.
- README: a short section on the palette, and `docs/reference/` in the
  Documentation table.

## Acceptance criteria

### Verified in the sandbox

- [x] **The palette tokens are exported from `packages/shared` and used by
      Tailwind config.**
  - `packages/shared/src/palette.test.ts` (5 tests): every token is kebab
    case with a `#rrggbb` value; no token is pure black or white, and `ink`
    and `paper` are the darkest and lightest; every Stage and state token
    has a foreground; every foreground is 4.5:1 or more on its colour
    (WCAG 2.2's formula); and the spec's palette tables list exactly the
    tokens of `palette.ts`, in order, with the same values and foregrounds.
  - `apps/web/src/tailwind-palette.test.ts` (4 tests) compiles
    `styles.css` with `@tailwindcss/node`, the compiler Vite's Tailwind
    uses: the config is one of its dependencies, and its `office` colours
    are the very object `@ai-office/shared` exports (`toBe`, not a copy);
    `bg-office-<token>` and `text-office-<token>` are generated for every
    token with the token's value; `bg-background` and `text-red-500` still
    work; the charts' warning and critical colours are the palette's.
  - In the real build: with a scratch file using `bg-office-stage-work` and
    `text-office-state-critical` (deleted afterwards), `pnpm --filter
    @ai-office/web build` wrote
    `.bg-office-stage-work{background-color:#2f6fc4}` and
    `.text-office-state-critical{color:#d03b3b}` into `dist/assets/*.css`.

  **Negative checks** (each reverted afterwards):
  - The config's `office` colours a copy with one value changed: 2 tests
    failed.
  - The `@config` line removed from `styles.css`: 2 tests failed.
  - One value in the spec's table changed (`sofa`): the table test failed.
  - `state-info` changed to a colour under 4.5:1 with its foreground: the
    contrast and table tests failed.

  The "ink is the darkest" test also caught a real mistake while writing
  it: `screen-off` was darker than `ink`. It is now `#2a3037`, still 12.6:1
  with `paper`.
- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass**, from the
      fresh clone (output below). `pnpm build` passes too.

### Not verifiable in this sandbox

- **How it looks.** There is no GPU or display, and no 3D scene yet (scene
  code is out of scope). The lighting intensities, shadow softness,
  post-processing values and the colours as lit in 3D are starting values
  chosen to the spec's intent; whether they give the soft-lit look, and
  whether Medium holds 60 fps on an integrated GPU within the polygon and
  texture limits, can only be judged on the host once the scene exists.
- The palette's contrast was checked by formula, not by eye or with a
  colour-vision simulator.
- The approved sources' licences (Kenney and Quaternius CC0 across their
  packs; Poly Pizza's mix of CC0 and CC-BY) are as those sites state them;
  no asset was downloaded here.

## Noticed, out of scope

- The 2D UI does not use the `office-*` colours yet. The Floor admin's
  Token Cap meters and Notices could take `state-*`, and Stage badges
  `stage-*`, when those views next change, so they match the 3D Office.
- Nothing yet checks that every asset file has its row in
  `THIRD-PARTY-NOTICES.md`; a test over the asset directory would enforce
  the rule once the first asset lands.
- Tailwind scans `tailwind.config.ts` as a source file, so the two example
  class names in its comment are generated in the built CSS (two small
  rules).
- `pnpm build` warns that the web app's JavaScript chunk is over 500 kB;
  this issue changes no JavaScript the app imports.

## Output

`pnpm lint` (fresh clone):

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker (the Postgres and Docker tests skip):

```text
 Test Files  126 passed (126)
      Tests  1268 passed | 239 skipped (1507)
   Duration  35.81s (import 47%, tests 32%, transform 12%, environment 7%, setup 1%)
```

The new tests, verbose:

```text
 ✓ |@ai-office/shared| src/palette.test.ts > palette > names each token in kebab case, with a six-digit sRGB hex value 3ms
 ✓ |@ai-office/shared| src/palette.test.ts > palette > has no pure black or white: ink and paper are the extremes 2ms
 ✓ |@ai-office/shared| src/palette.test.ts > palette > gives every Stage and every state a foreground 1ms
 ✓ |@ai-office/shared| src/palette.test.ts > palette > has each foreground at 4.5:1 or more on its colour 1ms
 ✓ |@ai-office/shared| src/palette.test.ts > palette > matches the palette tables of docs/reference/art-direction.md 2ms
 ✓ |@ai-office/web| src/tailwind-palette.test.ts > the Tailwind config > is loaded by styles.css, and takes the palette from @ai-office/shared 250ms
 ✓ |@ai-office/web| src/tailwind-palette.test.ts > the Tailwind config > makes every palette token an office-* colour with its value 66ms
 ✓ |@ai-office/web| src/tailwind-palette.test.ts > the Tailwind config > keeps the shadcn/ui theme and Tailwind's own colours 90ms
 ✓ |@ai-office/web| src/tailwind-palette.test.ts > the Tailwind config > gives the charts' state colours the palette's values 6ms
 Test Files  2 passed (2)
      Tests  9 passed (9)
```
