# Art direction

How the 3D Office looks, and the rules every asset and every scene follows
to look that way. It is the "one documented colour palette and lighting
spec that every asset follows" of the PRD's visual bar
([§7](../product-requirements-document/ai-office.md#7-non-functional-requirements)).
The numbers here are the defaults the scene starts from; a change to any of
them is a pull request to this file.

The scene itself (React Three Fiber, drei and
`@react-three/postprocessing`, PRD §8) is built in later issues. This file
says what it must look like, not how it is coded.

## The look

AI Office looks like a premium indie management game: a stylised,
soft-lit miniature of an office that is fun to watch and calm enough to
leave on a second monitor all day.

- **Simple forms, real proportions.** Furniture and architecture are built
  at real size from simple, slightly rounded shapes. Hard edges get a small
  chamfer (1 to 2 cm) or weighted normals, so every edge catches a little
  light. No greebles, no clutter for its own sake.
- **Soft light, never harsh.** One warm key light, a cool fill and a soft
  sky give gentle gradients and soft-edged shadows. Nothing is lit flat,
  and nothing is lit like a theatre.
- **A restrained palette.** Warm neutrals for the Office's walls and
  floors, a few muted accents for furniture, and saturated colour kept for
  what means something: the four Stages, the states of FR-62 and the
  screens. If everything is colourful, nothing stands out.
- **No pure black or white.** The darkest value in any asset is `ink`; the
  lightest is `paper`. Shadows are tinted (`shadow`), never grey.
- **Readable from above.** The default view looks down at the Floor from a
  high three-quarter angle. An asset must read by its silhouette and its
  colour from there: a desk, a chair and a coffee machine are told apart at
  a glance, at every quality setting.
- **No text in the scene.** Text is never rendered in the 3D scene (PRD
  §7); labels, ticket numbers and panels are HTML over it. Textures carry
  no readable words. A logo or an icon is fine. The one exception is the
  game posters on a Floor's walls, adventure and arcade, whose titles
  are part of the decoration: they carry nothing the Owner needs to
  read. The posters are affectionate parodies ("Night of the Tentacle",
  "The Secret of Donkey Island", "Space Intruders", "Donkey Kongo"):
  each evokes its game's poster, box art or screen in composition,
  palette and lettering, under a title altered by a joke, but every
  picture is original, drawn procedurally from simple shapes (the arcade
  posters' pixel sprites block by block, from the Office's own
  designs), and never a copy or a tracing of the games' art, sprites or
  logos. Titles are lettered in DejaVu Sans or Serif only. The arcade
  posters share a look: neon on black, scanlines over the screen, and
  the title on a cabinet's lit marquee edged with bulbs. The posters are
  also the one exception to the palette: besides its tokens they take a
  few inks of their own (`posterInks` in
  `apps/web/src/scene/posters.ts`, the arcade ones from `arcadeInks` in
  `arcade-posters.ts`), for a sunset, a smoggy sky, a ghost's glow or an
  arcade's neon, which nothing else in the scene uses. An arcade
  screen's near-black (`arcade-black`), like the adventure posters'
  night skies, is darker than `ink`, and only ever on a poster.

## Colour palette

The palette is code: `palette` in
[`packages/shared/src/palette.ts`](../../packages/shared/src/palette.ts)
(`@ai-office/shared`, or `@ai-office/shared/palette` alone). Every colour
below is a named token, and this table must match that file:
`palette.test.ts` fails when they differ.

- **In 3D**, a material or a light takes its colour from a token
  (`new Color(palette["desk-top"])`). Tokens are sRGB hex; three.js
  converts them to linear itself, so they are never converted by hand.
- **In 2D**, the web app's Tailwind config
  ([`apps/web/tailwind.config.ts`](../../apps/web/tailwind.config.ts))
  makes every token an `office-*` colour: `bg-office-stage-work`,
  `text-office-state-critical`, `border-office-paper`. The 2D UI uses them
  wherever it shows something the 3D Office shows too (a Stage, a state, a
  ticket), so the two always agree. The rest of the 2D UI keeps its
  shadcn/ui theme, and the analytics charts their own validated `.viz`
  colours; the charts' warning and critical colours are `state-warning` and
  `state-critical` (a test checks it).
- **Foreground** is the token to write text in on that colour, where the
  colour ever carries a label (`paletteForegrounds`). Each pair is at least
  4.5:1, WCAG 2.2 AA for normal text; `palette.test.ts` checks every one.
- **A colour never carries meaning alone.** A state or a Stage always comes
  with an icon, a shape or a label too, for colour-vision deficiency and
  for WCAG 2.2 AA.

### Architecture

| Token | Value | Foreground | Used for |
| --- | --- | --- | --- |
| `wall` | `#efe8dc` | `ink` | Painted walls and columns: warm plaster |
| `wall-feature` | `#c9d8d0` | — | One feature wall per zone (lobby, meeting room, canteen) |
| `ceiling` | `#f6f2ea` | — | Ceilings and ceiling panels |
| `floor-wood` | `#c89f74` | — | Oak floor: lobby, canteen and walkways |
| `floor-carpet` | `#66737d` | — | Carpet tiles under the desks |
| `glass` | `#bcd7e3` | — | The Manager's glass office and windows, at 25% opacity |
| `metal-dark` | `#3a4047` | — | Desk legs, frames, the lift doors |
| `metal-light` | `#b9bec4` | — | Brushed steel: the coffee machine, gym kit, handles |

### Furniture and props

| Token | Value | Foreground | Used for |
| --- | --- | --- | --- |
| `desk-top` | `#d9b991` | — | Desk tops and shelves: birch |
| `chair` | `#2f5d62` | — | Desk chairs and meeting-room chairs: teal fabric |
| `sofa` | `#c8664a` | — | Soft seating in the lobby and canteen: terracotta |
| `ceramic` | `#e6dccb` | — | Mugs, plant pots, the water cooler |
| `plant` | `#5e8c4a` | — | Leaves |

### Screens and light sources

These are the emissive colours: the only ones that glow, and so the only
ones that bloom (see [Post-processing](#post-processing)).

| Token | Value | Foreground | Used for |
| --- | --- | --- | --- |
| `screen-off` | `#2a3037` | `paper` | A monitor with nothing to show; the screen's own surface |
| `screen-glow` | `#9fd3ff` | `ink` | A monitor at work; the receiving monitor lighting up at a Handoff (FR-59) |
| `lamp` | `#ffd9a0` | — | Desk lamps, pendant lights, lit windows of the lift |

### Paper and ink

| Token | Value | Foreground | Used for |
| --- | --- | --- | --- |
| `paper` | `#fbf8f2` | `ink` | Tickets, the whiteboard, Notice cards on boards; the lightest value |
| `ink` | `#23272c` | — | Marker lines, outlines, icons; the darkest value |

### Stages

Each Stage (work, review, QA, docs) has a colour, used on the tickets an
Agent carries at a Handoff, on its desk dressing (a stripe on the desk's
edge, a mug) and on Stage badges in 2D.

| Token | Value | Foreground | Used for |
| --- | --- | --- | --- |
| `stage-work` | `#2f6fc4` | `paper` | The work Stage |
| `stage-review` | `#7a4fc4` | `paper` | The review Stage |
| `stage-qa` | `#137576` | `paper` | The QA Stage |
| `stage-docs` | `#b04a78` | `paper` | The docs Stage |

### States

The states of FR-62 and FR-85, in 3D and 2D alike.

| Token | Value | Foreground | Used for |
| --- | --- | --- | --- |
| `state-neutral` | `#8b9096` | `ink` | The token label above an Agent below 80% of its daily Token Cap; Context Usage below 60% |
| `state-ok` | `#3aa866` | `ink` | Healthy: a passing check, an approved review |
| `state-warning` | `#fab219` | `ink` | The token label from 80% of the daily Token Cap; Context Usage from 60% |
| `state-critical` | `#d03b3b` | `paper` | The token label at 100%; Context Usage from 85%; the red light at the Manager's office when the Floor has an action Notice; a capped or paused Agent's marker |
| `state-info` | `#2a6bc0` | `paper` | Information: an info Notice |

### Light colours

The colours of the lights (see [Lighting](#lighting)), and the tint of
shadows.

| Token | Value | Foreground | Used for |
| --- | --- | --- | --- |
| `light-key` | `#fff1dc` | — | The key light: warm daylight |
| `light-fill` | `#cfe0ff` | — | The fill light: cool sky through the windows |
| `light-sky` | `#e4ecf5` | — | The ambient light from above |
| `light-ground` | `#cdb89c` | — | The ambient light bounced off the floor |
| `shadow` | `#3a3550` | — | The colour of ambient occlusion and contact shadows, and the grade's shadow tint |

### Colours outside the palette

Only two kinds of colour are not palette tokens:

- **Avatars.** Hair colours, skin tones and outfit colours are the Avatar
  swatches in [`packages/shared/src/avatar.ts`](../../packages/shared/src/avatar.ts)
  (`hairColours`, `skinTones`, `outfitColours`), chosen in the Avatar
  Editor.
- **Variation within a token.** A texture may vary a token's lightness by
  up to 8% either way (wood grain, fabric weave, a scuff), and its hue by
  no more than a few degrees.

Anything else needs a new token here and in `palette.ts`, in one pull
request. A Floor Template's 3D theme (FR-99) dresses a Floor with props in
the palette's colours; a theme that needs a colour of its own adds a token
the same way.

## Lighting

Lighting is physically based (three.js physical light units) and the same
on every Floor and in the lobby. The key-to-fill ratio is about 4:1: soft,
but with a clear direction.

| Light | three.js | Colour | Intensity | Set-up |
| --- | --- | --- | --- | --- |
| Key | `DirectionalLight` | `light-key` | 2.4 | From the windows' side, 50° above the horizon and 35° to the left of the default view. The only light that casts shadows. |
| Fill | `DirectionalLight` | `light-fill` | 0.6 | Opposite the key, 25° above the horizon. No shadows. |
| Ambient | `HemisphereLight` | `light-sky` above, `light-ground` below | 0.8 | Lifts every shadow so nothing falls to black. |
| Environment | `scene.environment` | — | 0.4 (`environmentIntensity`) | A small, neutral interior environment map (drei's `Environment`, at low resolution), for reflections on metal and glass only. Never shown as a background. |
| Emissive | material `emissive` | `screen-glow`, `lamp`, `state-*` | 1.2 to 2.0 | Screens and lamps are lit by their own materials, not by lights; a desk lamp adds no light of its own. |

**Shadows.** Only the key light casts shadows, and only from furniture,
props and Agents onto the floor and the desks. Walls and ceilings cast
none. The shadow camera is fitted to what the camera sees of the Floor, not
to the whole Floor.

| Quality setting | Shadows | Softness |
| --- | --- | --- |
| Low | No real-time shadows: baked contact shadows (a soft dark blob under each desk, chair and Agent, `shadow` at 35% opacity) | Fixed, about 30 cm of blur |
| Medium | `PCFSoftShadowMap`, 1024 × 1024 | `radius` 4: a penumbra of a few centimetres at desk height |
| High | `PCFSoftShadowMap`, 2048 × 2048, plus the contact shadows of Low under Agents | `radius` 6 |

Shadow bias is `-0.0005` with a `normalBias` of `0.02`, so there is no
shadow acne and no visible gap where a desk leg meets the floor.

**Baked light.** Static architecture (walls, floors, columns) may carry a
baked ambient-occlusion map in its `aoMap` at every quality setting. It is
generated from the model, never painted, and adds no colour of its own.

**Tone mapping.** `NeutralToneMapping` (Khronos PBR Neutral) at an
exposure of 1.0, with sRGB output. It keeps a base colour close to its
token, so a Stage colour in 3D matches its badge in 2D.

## Post-processing

`@react-three/postprocessing`'s `EffectComposer`, in this order. Because the
composer tone-maps, the renderer's own tone mapping is off and the
`ToneMapping` effect does it instead.

| Effect | Settings | Low | Medium | High |
| --- | --- | --- | --- | --- |
| Ambient occlusion | N8AO: `aoRadius` 0.5 m, `distanceFalloff` 0.5, `intensity` 2, `color` `shadow` | Off (baked AO only) | Half resolution | Full resolution |
| Bloom | `luminanceThreshold` 0.9, `luminanceSmoothing` 0.2, `intensity` 0.4, `mipmapBlur`, `radius` 0.6 | Off | On | On |
| Tone mapping | `ToneMapping`, Neutral, exposure 1.0 | On | On | On |
| Colour grading | `HueSaturation` saturation +0.05; `BrightnessContrast` contrast +0.05; shadows lifted towards `shadow` | On | On | On |
| Vignette | `offset` 0.3, `darkness` 0.35 | Off | On | On |
| Anti-aliasing | SMAA, and the renderer's `multisampling` | None | SMAA | SMAA, `multisampling` 4 |

- **Bloom is for emissives only.** With a threshold of 0.9, only the
  emissive tokens (screens, lamps, the red light) bloom. A bright wall in
  the key light must not.
- **Grading is gentle.** The grade warms the highlights a little and lifts
  the shadows towards `shadow`. It must never move a token so far that its
  2D and 3D versions look different side by side.
- **Reduced motion** (PRD §7) changes no effect; it is about how things
  move, not how they look.

## World scale

- **1 unit is 1 metre.** Y is up, the floor of every Floor is at `y = 0`,
  and three.js's right-handed axes apply. glTF assets face +Z.
- **Origin** of every asset is the centre of its footprint, on the floor
  (`y = 0`), so it can be placed without offsets.
- **Placement** snaps to a 0.5 m grid; desks to a 0.1 m grid within their
  zone.
- **Ceiling height** is 3.0 m; doors are 0.9 m × 2.1 m.
- **Walkways** are at least 1.5 m wide, so two Agents pass each other
  on a Handoff walk without touching.

### Desks

One desk per Agent (FR-57), with its Role's dressing on top.

| Part | Size |
| --- | --- |
| Desk top | 1.4 m wide × 0.7 m deep, 0.74 m above the floor, 3 cm thick |
| Monitor | 0.55 m × 0.33 m screen (about 24 inches), its top 1.15 m above the floor, 0.45 m from the desk's front edge |
| Chair | Seat 0.46 m high, 0.5 m × 0.5 m; back to 0.95 m |
| Desk spacing | 2.4 m centre to centre side by side, 2.8 m front to back (the chair and a walkway behind it) |
| Ticket pile (FR-62) | A4 tickets (0.21 m × 0.297 m), 5 mm each, on the desk's left; at most 10 shown however long the queue |

### Agents and rooms

| What | Size |
| --- | --- |
| An Agent's Avatar | 1.70 m tall on average, 1.55 m to 1.85 m by body shape; stylised proportions of about 6 heads tall |
| The Manager's glass office | 4 m × 4 m, glass from 0.9 m to the ceiling |
| The meeting room | 6 m × 4 m, seating 10 around one table; the whiteboard 1.8 m × 1.2 m, its bottom edge 0.9 m above the floor |
| Wall boards and Notice Boards | 1.6 m × 0.9 m, their centre 1.6 m above the floor |
| The water cooler, coffee machine and gym kit | Real size: about 0.35 m × 0.35 m × 1.1 m for the cooler |

## Materials

Every material is physically based: glTF's metallic-roughness model, which
is three.js's `MeshStandardMaterial`.

- **Base colour** comes from a token (see
  [Colours outside the palette](#colours-outside-the-palette) for the
  exceptions). 3D models from asset packs are recoloured to the palette
  before they are added.
- **Metalness** is 0 or 1, nothing in between.
- **Roughness** follows the surface. Nothing is shinier than 0.3 except
  glass and screens, because small sharp highlights shimmer and alias.

  | Surface | Metalness | Roughness |
  | --- | --- | --- |
  | Paint, plaster, ceilings | 0 | 0.85 to 0.95 |
  | Wood | 0 | 0.6 to 0.75 |
  | Fabric, carpet | 0 | 0.9 to 1.0 |
  | Plastic, ceramic | 0 | 0.45 to 0.6 |
  | Metal | 1 | 0.35 to 0.5 |
  | Screens | 0 | 0.2, with `emissive` from `screen-off` or `screen-glow` |
  | Glass | 0 | 0.05, `glass` at 25% opacity |

- **Glass** is the only blended transparency. It is `MeshPhysicalMaterial`
  with transmission on High only; on Low and Medium it is
  `MeshStandardMaterial` with opacity, which costs far less.
- **Foliage** uses `alphaTest` 0.5 (cut out, never blended), and is the only
  double-sided material.
- **Emissive** is used only by screens, lamps and state lights, in their
  tokens.
- **Shared, not unique.** Materials are shared by name across assets, one
  per token and surface (`desk-top/wood`, `metal-dark/metal`), so meshes
  batch and instance. An asset never brings its own copy of a material the
  palette already has.
- **Textures are optional.** Most assets are flat colours with no texture
  at all; a texture adds detail (grain, weave, a normal map for a chamfer)
  within the 8% rule above. No texture has lighting or shadows painted in.
- **Textures** are KTX2 (Basis Universal), sized to powers of two; base
  colour in sRGB, everything else linear.

## Polygon and texture limits per quality setting

The Office has three quality settings (PRD §7): Low, Medium and High.
Medium must hold 60 fps at 1080p on a 2022-era laptop with an integrated
GPU, with 16 Agents in view. The limits are per asset and per frame; an
asset over its limit is not added until it fits.

| | Low | Medium | High |
| --- | --- | --- | --- |
| Triangles in view, per frame | 150,000 | 300,000 | 600,000 |
| Draw calls, per frame | 100 | 200 | 300 |
| An Agent's Avatar (body, hair, outfit, accessories) | 3,000 | 6,000 | 10,000 |
| A desk set (desk, chair, monitor, dressing) | 1,500 | 3,000 | 5,000 |
| A large prop (whiteboard, coffee machine, lift, sofa) | 2,000 | 4,000 | 6,000 |
| A small prop (mug, plant, ticket pile) | 300 | 500 | 800 |
| A Floor's architecture (walls, floors, glass) | 10,000 | 20,000 | 40,000 |
| Largest texture | 512 × 512 | 1024 × 1024 | 2048 × 2048 |
| Texture memory (GPU) | 64 MB | 128 MB | 256 MB |
| Pixel ratio | 1 | up to 1.5 | up to 2 |

- **LODs.** An asset over 2,000 triangles ships three meshes: LOD0 (its
  High count), LOD1 (about half) and LOD2 (about a quarter). A quality
  setting never uses a finer one than its column allows.
- **Instancing.** Desks, chairs, monitors, ticket piles and plants are
  drawn instanced, one draw call per mesh however many there are.
- **Avatar rig.** Every Avatar uses the one shared rig (PRD §7): at most 50
  bones and 4 bone influences per vertex.
- **Files.** 3D models are GLB, compressed with Meshopt (or Draco), at most
  1 MB each and 2 MB for an Avatar's parts together.

## Asset sources and licences

AI Office uses CC0 and purchased asset packs (PRD §7), and the repository
becomes public on completion (PRD §12), so every asset in it must be one
anyone may redistribute.

**Approved CC0 sources:**

| Source | What | Licence |
| --- | --- | --- |
| [Kenney](https://kenney.nl/assets) | Furniture, props and interiors | CC0-1.0, every pack |
| [Quaternius](https://quaternius.com) | Rigged and animated people, props | CC0-1.0, every pack |
| [Poly Pizza](https://poly.pizza) | Single 3D models by many authors | **Only those marked CC0** on their page. Poly Pizza also hosts CC-BY models, which are not approved. |

- **Purchased packs** are allowed only when their licence lets their files
  be redistributed in a public, open-source repository. Many store
  licences do not; such a pack cannot be used.
- **Nothing else.** 3D models, textures or sounds from any other source, or
  of unclear licence, are not added, unless this list is changed first by
  a pull request.

**Tracking licences.** Every third-party file added to the repository
(3D model, texture, sound, font) gets a row in
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md), in the same
commit that adds it, even when the licence (CC0) asks for none:

| Column | What goes in it |
| --- | --- |
| Asset | Its name and its path in the repository |
| Used for | Where it appears in the Office |
| Source | A link to the exact pack or model page, with the pack's version if it has one |
| Author | Its author, as the source names them |
| Licence | Its SPDX identifier, such as `CC0-1.0` |

An asset changed for AI Office (recoloured to the palette, decimated,
re-rigged) keeps its row, with "modified" added to **Used for**. Removing
an asset removes its row in the same commit. One row may cover several
files from one pack, by naming their directory.

## Adding an asset: checklist

1. It comes from an approved source, and its licence is one of those above.
2. It is at real size in metres, its origin at the centre of its footprint
   on the floor, facing +Z.
3. Its colours are palette tokens, its materials shared and named
   `token/surface`, with the roughness and metalness of its surface.
4. It is within its triangle and texture limits, with LODs if it is over
   2,000 triangles.
5. It is a Meshopt- or Draco-compressed GLB, with KTX2 textures.
6. It has its row in `THIRD-PARTY-NOTICES.md`.
