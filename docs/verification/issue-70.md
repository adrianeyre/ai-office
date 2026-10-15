# Issue #70: Modular character kit, animations and Avatar schema — verification

Checks were run in the Sandcastle sandbox (Node 26.10.0, pnpm 12.10.0, no
Docker, no GPU or display) on this branch, at the issue's last code commit
(`31ae710`), with the README commits around it changing only Markdown.

The blockers are built on this branch:

- #63, the art direction ([`issue-63.md`](issue-63.md)):
  `docs/reference/art-direction.md`, whose Avatar sizes, rig limits,
  triangle budgets, LOD rule, materials and contact shadows the kit is
  checked against, and the palette with the Avatar swatches
  (`hairColours`, `skinTones`, `outfitColours` in `@ai-office/shared`);
- #66, a Floor's layout ([`issue-66.md`](issue-66.md)): the desks, chairs
  and seats the Agents sit at, and the Floor scene they are drawn in.

The Avatar schema and a random generator already existed (from #21, with
the Agents); this issue makes the schema strict, seeds the generator and
draws the Avatars.

## What was built

- **The Avatar** (`packages/shared/src/avatar.ts`; PRD FR-13):
  - `avatarSchema` is strict: an unknown field (`cape`), an unknown option
    of any part (a `mohawk`, `monocle` glasses, a `unicorn` mascot, a
    `spacesuit` outfit), an unknown field of the outfit, an accessory worn
    twice, a missing part or another version is refused. Every option is a
    part of the kit below, so the schema refuses any part the kit does not
    have.
  - `seededRandom(seed)` (mulberry32 seeded by the string's FNV-1a hash)
    gives the same numbers, and so the same Avatars, for the same seed, in
    the browser and on the server.
  - `randomAvatar(random, others)` keeps a Floor's Avatars distinct: each
    differs from every other in at least two (`distinctFeatures`) of
    presentation, hairstyle, hair colour, skin tone, outfit style and
    outfit colour (`avatarLook`, `lookDistinct`); one feature alone, such
    as two shades of brown hair, was easy to miss from the Office's high
    view. Only men get facial hair at random (half of them); the Avatar
    Editor (#71) may give anyone any.
  - `@ai-office/shared/avatar` exports it alone, for the scene.
- **One shared rig** (`apps/web/src/scene/avatar-rig.ts`): 19 bones (the
  spec allows 50), the same names and hierarchy for every Avatar, each at
  rest with no rotation, so one animation plays on every body. Only where
  the bones sit changes: 1.57 m to 1.85 m tall by body shape and
  presentation (1.70 m on average), broader shoulders or hips, thicker
  limbs, about six heads tall. Avatars stand on the floor facing +z, left
  towards +x (glTF's convention).
- **The parts** (`scene/avatar-parts.ts`): every option of FR-13 is shapes
  (ellipsoids, domes, capsules, frustums, boxes, rings) at real size, each
  bound to a bone and tinted:
  - presentation and body shape (the rig's proportions); five faces (the
    head and jaw); ten hairstyles (a shell over the crown, solved to cover
    the head however it is tilted, and the style's masses: a bob's sides,
    a ponytail, a bun, curls, braids; an afro; bald); four kinds of facial
    hair; three frames of glasses; five accessories (headphones, earrings,
    a watch, a scarf, a cap, sized over the hair); seven outfits (collars,
    a placket, lapels and a shirt, a hood with drawstrings and a pocket,
    cuffs, a dress's skirt and belt, overalls' bib and straps); six desk
    mascots;
  - tints: skin tone, hair colour and the outfit's two colours from the
    Avatar, a mix of skin and hair for stubble, palette tokens for eyes,
    frames, a blazer's shirt, a ticket and a mug, and the Avatar swatches
    for shoes and gold.
- **Geometry** (`scene/avatar-geometry.ts`): an Avatar's shapes are one
  skinned mesh with vertex colours, in one material every Avatar, prop and
  mascot shares (`avatar/finishes`), so each Avatar is one draw call. Each
  surface's finish (skin, hair, fabric, plastic, metal) is a texel of an
  8 × 1 roughness-metalness map its vertices point at: metalness 0 or 1,
  nothing shinier than 0.4. Each vertex is on one bone, or, in a dress's
  skirt, shared between the hips and the thighs by height (at most three
  influences), so the skirt falls over the lap when its Agent sits.
  - **LODs**: High, Medium and Low use LOD0, LOD1 and LOD2. The heaviest
    Avatar (every accessory, a beard and glasses, over every hairstyle and
    outfit) is 6,680, 3,557 and 2,178 triangles, within the spec's 10,000,
    6,000 and 3,000; LOD1 is 0.53 of LOD0 and LOD2 0.33. The lightest is
    4,908, 2,554 and 1,408.
  - Mascots are 80 to 256 triangles on Medium (the spec's small prop: 500).
- **The animation set** (`scene/avatar-animations.ts`): idle, sit, type,
  walk, carry, stand up, stretch, sleep, drink, work out and chat, as
  poses (a rotation per bone and how far the hips moved) at times, made
  into three.js clips with a Catmull-Rom curve through the poses, so a
  motion flows through a key rather than stopping at it. Carry holds a
  ticket (A4, in `paper`) and drink a mug (`ceramic`), shown only while
  they play (`scene/avatar-figure.ts`). Poses that meet the Office are
  solved for each rig:
  - **seated** (sit, type, sleep, the start of stand up): the thighs on
    the chair's seat (0.46 m), the shins sloped so the feet are flat on the
    floor, short legs sloping the thighs, long ones pushing the feet
    forwards;
  - **typing**: the arms solved (two-bone IK) to put the wrists just
    behind the desk's keyboard, the hands lying over the keys, tapping;
  - **work out**: squats solved at several depths, so the feet stay put.
- **Agents at their desks** (`scene/desk-agents.tsx`, `scene/floor.tsx`):
  every Agent sits in its chair as its Avatar, facing its screens, typing
  while it works (its monitor's status) and sitting back otherwise. Its
  mascot stands at the back of its desk's left end, clear of the ticket
  pile and each Role's dressing; all of a Floor's mascots are one mesh.
  The Avatar follows the quality setting's LOD, plays from the scene's
  frame loop, cross-fades between animations (0.3 s), and with reduced
  motion holds its pose. On Low and High a contact shadow lies under each
  Agent, as the spec's shadow table says. An Agent without an Avatar is
  drawn with one seeded from its id. Avatars are rebuilt only when what
  they look like changes, not at each refetch of the team.
- **README**: "Agents" (distinct Avatars) and "The 3D Office" (Avatars,
  the rig, parts, LODs, animations, Agents at their desks).

### Why the kit is built in code, not from a CC0 pack

The issue asks for a CC0 base. The approved sources were tried first:

- **Kenney's Blocky Characters** (CC0): no skin (rigid parts), textured
  in a voxel style, with no elbows or knees.
- **Kenney's Mini Characters** (CC0): skinned, but seven bones (no elbows
  or knees, so no typing or sitting with bent knees) and chibi proportions
  of about two and a half heads, against the spec's six.
- **Quaternius's Universal Base Characters** (CC0): a humanoid rig with
  hairstyles, but downloadable only through itch.io's browser flow, and a
  full-detail mesh against a 6,000-triangle Avatar on Medium.

None has parts for most FR-13 options (glasses, facial hair, accessories,
seven outfits, mascots) or the animations asked for (sit, type, sleep,
drink, work out), and each would have needed them authored onto a rig
that could not be seen here. So the kit is AI Office's own, built in code
from simple rounded shapes, as the lobby and the desks already are
(`pieces.ts`): it adds no third-party file, so `THIRD-PARTY-NOTICES.md`
is unchanged, and it is released with the repository. It meets the spec's
look ("simple forms, real proportions", slightly rounded shapes, flat
colours with no texture) and every number the spec gives for Avatars.
Whether that is the look the Owner wants is for the host (below); a pack
could replace the parts later without changing the schema, the rig's
role or the animations' names.

## Acceptance criteria

### Verified in the sandbox

- [x] **`pnpm lint`, `pnpm typecheck` and `pnpm test` pass.** All three
      exit 0 (output below). `pnpm build` passes too.
- [x] **Unit tests: random generator distinctness.**
      `packages/shared/src/avatar.test.ts`:
      - a Floor of 31 Avatars has 31 different looks;
      - a Floor of 12, from each of 100 seeds, has every pair differing in
        at least two features;
      - an Avatar differing in one feature alone is not distinct;
      - the same seed gives the same Floor of 12, and another seed
        another; `seededRandom` repeats for its seed, stays in [0, 1) and
        is spread evenly (mean of 1,000 within 0.45 to 0.55);
      - 500 Avatars use every hairstyle, outfit and accessory; only men get
        facial hair, and every kind of it;
      - it gives up with an error rather than loop when it can only repeat
        itself.

      `packages/orchestrator/src/agents/agents.test.ts` (unchanged) still
      checks a new Floor's Agents have Avatars that look different.
- [x] **Unit tests: the schema rejects unknown parts.** The same file
      refuses an unknown hairstyle, presentation, body shape, face, facial
      hair, glasses, accessory and desk mascot, an accessory worn twice,
      an unknown field, colours that are not `#rrggbb`, another version, an
      unknown outfit style or outfit field, and a missing part; it accepts
      every hairstyle and every accessory together.

Beyond them, `apps/web/src/scene/avatar-kit.test.ts` checks the kit
against the art direction without WebGL:

- the rig: the same 19 bones for every body and presentation, within 50;
  heights within 1.55 m to 1.85 m, averaging 1.70 m, 5.5 to 7 heads tall,
  the head's top at the height; shoes' soles on the floor, toes forwards;
- a part of its own for every presentation, body shape, face, hairstyle,
  facial hair, glasses, outfit style, accessory and desk mascot (each
  option's geometry differs from every other's);
- tinting: changing the hair colour, skin tone or either outfit colour
  changes only some vertices' colours, never the shape, and no two of
  them change the same vertices;
- the triangle budgets and LOD ratios above, over every hairstyle and
  outfit at their heaviest;
- every vertex on at most four bones (the kit uses three at most), its
  weights adding to one; the skirt shared with the thighs;
- finishes: metalness 0 or 1, roughness 0.3 or more, each used;
- mascots within the small-prop budget and under 13 cm, props in hand;
- the animation set: the issue's eleven, each a valid three.js clip with a
  track for every bone and the hips; loops ending where they start; carry
  holding a ticket and drink a mug, and nothing else;
- for each of the twelve bodies (four shapes, three presentations), posed
  by three.js's own mixer: sitting, typing and sleeping with the thighs on
  the seat (within 3 cm) and the ankles at standing height (the soles on
  the floor), the wrists over the keyboard and on the desk while typing;
  the feet still (within 3 cm) through a squat; standing up ending on the
  hips' rest height.

`apps/web/src/scene/floor.test.tsx` renders Floors with
`@react-three/test-renderer`:

- each Agent seated at its desk's seat, facing its screens, as a skinned
  mesh; its own Avatar, or one seeded from its id;
- a working Agent's hand at the keyboard after 30 frames, a resting one's
  in its lap;
- Avatars moving from frame to frame, and holding still with reduced
  motion;
- each quality setting's LOD, within its budget, finer from Low to High;
- the mascots in one mesh, each on its own desk's top;
- a contact shadow under each Agent on Low and High, none on Medium;
- **the per-frame budget with 12 Agents at work** (the test #66 wrote,
  which reserved one draw call and 6,000 triangles per Avatar until now):
  the real twelve Avatars are now drawn and counted, each one skinned mesh
  in one material casting a shadow, and the whole Floor stays within
  Medium's 200 draw calls and 300,000 triangles.

### Rendered in headless Chromium

As in #64 to #69: Playwright's Chromium headless shell, its missing
libraries unpacked from Debian bookworm's packages into `/tmp` (nothing
installed), and SwiftShader. A throwaway page under Vite (deleted
afterwards) drew Avatars at 1280 × 720, with the art direction's lights:

- **A lineup of eleven Avatars**, one in each animation, at Medium's LOD:
  idle, sit, type, walk, carry (the ticket in its hands), stand up
  (leaning forwards to rise), stretch (arms overhead), sleep (leaning
  back, head tipped), drink (the mug raised), work out (a squat, arms out)
  and chat (a hand raised). Each read as what it is.
- **A Floor** (the real `Floor`, with a Manager and seven Agents, every
  other one working): each Agent in its chair at its desk, facing its
  screens, the working ones' monitors lit, the Manager in the glass
  office, mascots on the desks, shadows on the carpet.
- **Close-ups** of faces, hair, beards, glasses, earrings and a watch, and
  of eleven Avatars seated in dresses, their skirts over their laps.
- The first renders showed three faults the tests could not: a tilted
  hair shell let the scalp show through (the head is taller than deep), a
  torso of three ellipsoids read as stacked beads, and a beard covered the
  mouth like a mask. Each was fixed and rendered again: hair shells are
  solved to cover the head (`coveringDepth`), the torso is two flattened
  capsules, and the beard sits under the nose.
- The only console output was the three.js shadow map's
  `PCFSoftShadowMap` notice (see #64), React's DevTools notice and
  Vite's.

### Verified on the host

- [ ] **Characters match the art spec.** On the host: `pnpm dev`, open
      http://localhost:3045, ride the lift to a Floor, and look at the
      Agents at their desks from Overview and Close up, at Low, Medium and
      High: the proportions, the parts and colours of each Avatar, the
      typing and sitting, and that no part pokes through another. To see
      the other animations, the lineup page described above can be
      recreated; nothing in the app plays them yet (below).
- [ ] **12 animated characters hold 60 fps at Medium.** On the host: a
      Floor with a Manager and eleven Agents (raise the team in the Floor
      admin), at 1080p, Medium, **Show frame rate**, with some Agents
      working, read over a minute. In the sandbox the scene's cost is
      counted instead (12 Avatars, one draw call and one shadow each,
      3,557 triangles at most each on Medium; the Floor within 200 draw
      calls and 300,000 triangles); SwiftShader's frame rate says nothing
      about a GPU.

### Not verifiable in this sandbox

- **How it looks and moves on a real GPU**: the look, the shadows and
  post-processing on the Avatars, and whether the motion reads well at
  the Office's distance.
- **The frame rate**, above.
- **The e2e suites** (no Docker): nothing they check changes.
- **The Postgres cases** (no Docker): nothing here touches the database;
  Avatars are stored as before.

## Noticed, out of scope

- **Only sit and type are played in the Office.** Walking a ticket to
  the next desk (FR-59), idle behaviours (FR-61) and meetings (FR-60)
  will play walk, carry, stand up, stretch, sleep, drink, work out and
  chat; they need the walking along waypoints those issues bring.
  `walk` and `carry` are in place: the scene moves the Avatar.
- **Clicking an Agent** to open the Avatar Editor or its card (FR-13,
  FR-63) is #71 and later; Avatars are not inspectable yet.
- **A stored Avatar with a field it no longer has** would now be refused
  where it is read (`avatarSchema.parse` in the Agents' store). Every
  stored Avatar was made by `randomAvatar` with exactly these fields, so
  none is; a future change to the Avatar needs a migration of `agents.avatar`.
- **The art direction's chamfer and LOD rules** were written for packs'
  models; the kit follows them (rounded shapes, three LODs), but the
  spec does not say how a code-built character's shapes are reviewed.
  Worth a line in `art-direction.md` (not changed here: `docs/` is the
  canon).

## Output

`pnpm lint`:

```text
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

`pnpm typecheck` (tail):

```text
apps/web typecheck: Done
apps/server typecheck: Done
e2e typecheck$ tsc && tsc -p server
e2e typecheck: Done
```

`pnpm test`, without Docker (the Postgres and Docker tests skip):

```text
 Test Files  180 passed (180)
      Tests  1933 passed | 297 skipped (2230)
   Duration  33.82s (tests 41%, import 36%, environment 13%, transform 9%, setup 2%)
```

`pnpm build` (the web app's scripts):

```text
dist/assets/index-DLl-_ag-.js              896.83 kB │ gzip: 274.10 kB
dist/assets/office-scene-DRQ4Nbez.js     1,427.64 kB │ gzip: 461.56 kB
✓ built in 1.04s
```

The new and changed tests, verbose:

```text
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > is a valid Avatar
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > is the same for the same random numbers
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > looks different from the others on its Floor
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > differs from every other Avatar on its Floor in at least two features
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > is not distinct from an Avatar it differs from in one feature only
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > gives men alone facial hair, at random
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > uses every part of the kit, given enough Avatars
✓ |@ai-office/shared| src/avatar.test.ts > a random Avatar > gives up rather than loop when it can only repeat itself
✓ |@ai-office/shared| src/avatar.test.ts > a seeded random source > gives the same numbers for the same seed, in [0, 1)
✓ |@ai-office/shared| src/avatar.test.ts > a seeded random source > gives other numbers for another seed, a string or a number
✓ |@ai-office/shared| src/avatar.test.ts > a seeded random source > gives a Floor the same Avatars from the same seed
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > accepts every part of the kit
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown hairstyle
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown presentation
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown body shape
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown face
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses unknown facial hair
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses unknown glasses
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown accessory
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an accessory worn twice
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown desk mascot
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown part
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses a hair colour that is not a colour
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses a skin tone that is not a colour
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses another version
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an unknown outfit style, or an unknown part of an outfit
✓ |@ai-office/shared| src/avatar.test.ts > the Avatar schema > refuses an Avatar missing a part
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the shared rig > has the same bones for every Avatar, within the spec's 50
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the shared rig > is 1.55 m to 1.85 m tall by body, 1.70 m on average, about six heads tall
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the shared rig > stands on the floor, facing +z with its left towards +x
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every presentation
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every body shape
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every face
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every hairstyle
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every facial hair
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every glasses
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every outfit style
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a part of its own for every accessory
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > has a desk mascot of its own for each of the Avatar Editor's
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > tints its parts with the Avatar's colours, and only the parts that wear them
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > is within each quality setting's triangle budget, with LODs of about a half and a quarter
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > binds every vertex to at most four of the rig's bones, its weights adding to one
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > shares a dress's skirt between the hips and the thighs, so it follows the legs
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > gives every surface the finish the spec gives it: metal 1, the rest 0 and no shinier than 0.3
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the character kit > keeps its mascots small props, its props in hand
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > has the issue's eleven animations, each for every bone of the rig
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > ends each loop where it starts, and moves in each
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > holds a mug to drink and a ticket to carry, and nothing else
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a slim male Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a slim female Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a slim androgynous Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a average male Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a average female Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a average androgynous Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a broad male Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a broad female Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a broad androgynous Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a curvy male Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a curvy female Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > sits a curvy androgynous Avatar on the seat with its feet on the floor and its hands on the keys
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a slim male Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a slim female Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a slim androgynous Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a average male Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a average female Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a average androgynous Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a broad male Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a broad female Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a broad androgynous Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a curvy male Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a curvy female Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/avatar-kit.test.ts > the animation set > keeps a curvy androgynous Avatar's feet where they stand while it works out and stands up
✓ |@ai-office/web| src/scene/floor.test.tsx > a Floor in the scene > seats each Agent at its desk as its Avatar, facing its monitor
✓ |@ai-office/web| src/scene/floor.test.tsx > a Floor in the scene > types while its Agent works, its hands at the keyboard, and sits back otherwise
✓ |@ai-office/web| src/scene/floor.test.tsx > a Floor in the scene > moves its Agents' Avatars each frame, and holds them still with reduced motion
✓ |@ai-office/web| src/scene/floor.test.tsx > a Floor in the scene > draws each quality setting's LOD of its Avatars
✓ |@ai-office/web| src/scene/floor.test.tsx > a Floor in the scene > puts each Agent's desk mascot on its desk, all in one mesh
✓ |@ai-office/web| src/scene/floor.test.tsx > a Floor in the scene > puts a contact shadow under each Agent on Low and High, and none on Medium
✓ |@ai-office/web| src/scene/floor.test.tsx > a Floor's cost > is within Medium's per-frame budgets with 12 Agents at work, leaving room for their Avatars
  (and the 7 other tests in floor.test.tsx, unchanged)
```
