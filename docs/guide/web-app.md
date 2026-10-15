# The web app and the 3D Office

The company logo, link previews, accessibility, running the web app, the 3D Office and phones. Part of the [AI Office guide](README.md); back to the [README](../../README.md).

## The company logo

The logo and name in the navigation, on the sign-in and setup screens and in the browser tab come from [`apps/web/src/brand/`](../../apps/web/src/brand/). There is no upload, because AI Office has no file storage. To rebrand, replace the three images there and rebuild:

- `logo.svg`: the horizontal logo (mark and wordmark), shown 32 px high in the navigation and 40 px on the sign-in and setup screens.
- `icon.svg`: the square mark alone, the browser tab's icon. It needs to stay readable at 16 px.
- `logo-dark.svg`: the horizontal logo for dark mode, its wordmark light.

`brand.ts` names both files and holds `name`, the logo's alternative text. SVG keeps both sharp; keep text in the logo as outlines so it does not depend on the browser's fonts. The default is three stacked Floors with lit windows and a spark, beside "AI Office" in Inter Display Bold.

Raster copies of the mark are in [`apps/web/public/`](../../apps/web/public/): `favicon.ico` (16, 32 and 48 px), `apple-touch-icon.png` (180 px), `icon-192.png`, `icon-512.png` and `icon-maskable-512.png` (the mark inside the middle 80%, for Android's masks), named in `index.html` and `site.webmanifest`. Redraw them when you rebrand, along with `og-image.png`.

## Link previews and search engines

Pasting an AI Office link into Slack, Teams, LinkedIn or iMessage shows a card: the title, a description and `apps/web/public/og-image.png` (1200 × 630). `apps/web/index.html` holds the Open Graph and X (Twitter) tags, the description, a canonical link, the web app manifest and schema.org structured data (a `SoftwareApplication`).

Link previews and canonical links need absolute URLs, so `index.html` holds `__AI_OFFICE_ORIGIN__` and `__AI_OFFICE_PAGE_URL__`, which the server fills in from `PUBLIC_URL` when it serves each page (`pnpm dev` fills them in with Vite's own address). **Set `PUBLIC_URL` to the address people reach AI Office at**, or previews point at `localhost`. Slack's servers also have to be able to reach that address to fetch the image.

The server also answers `GET /robots.txt`, which lets crawlers in but keeps them out of `/api/`, and `GET /sitemap.xml`, which lists the sign-in page: everything else needs a session. Both are public and use `PUBLIC_URL` too.

## The footer and accessibility

Every page ends with a footer: a "Website design" credit that links to AI Office's source, the version (the root `package.json`'s), and the Privacy Policy, Terms and Conditions, Cookie Policy and Accessibility statement. Each opens in a dialog ([`components/ui/dialog.tsx`](../../apps/web/src/components/ui/dialog.tsx)) with a title, a close button, a body that scrolls both ways on its own, and a footer that stays in place. The texts are in [`apps/web/src/legal/`](../../apps/web/src/legal/); keep the Cookie Policy's table in step with the cookies and browser storage the app uses.

General Settings' **Appearance** card sets light, dark or system (matching the device) mode, and one of six themes: Indigo (the logo's colours, and the default), Neutral, Ocean, Emerald, Rose and Amber. Every theme's surfaces are the same ink, a neutral with a trace of the logo's indigo; the themes change the accent. The interface is set in Inter, and code, ids and figures in JetBrains Mono, both served by AI Office itself from the `@fontsource-variable` packages, as the Content-Security-Policy allows no other site's fonts. The choice belongs to the browser, in local storage (`ai-office:appearance`); `index.html` applies it before the first paint, so a dark page never flashes white. The themes' colours are in `apps/web/src/styles.css`, and `theme-contrast.test.ts` holds every theme, in both modes, to WCAG 2.2 AA: 4.5:1 for text, 3:1 for field borders and the focus outline. To add a theme, add it to `themes` in `appearance.ts`, give it a light and a dark block in `styles.css`, and add its name to the check in `index.html`. Dark mode shows `brand/logo-dark.svg`, the logo with a light wordmark.

The web app is built to meet WCAG 2.2 at Level AA: a "Skip to main content" link, a title per page, a high-contrast focus outline that Tailwind's `outline-none` cannot remove, muted text at 4.5:1 or more on every surface, field borders at 3:1, controls at least 24 × 24 px, and no animation when the device asks for reduced motion.

`pnpm e2e` checks it with [axe-core](https://github.com/dequelabs/axe-core) (`@axe-core/playwright`), in `e2e/tests/accessibility.spec.ts`. A serious or critical violation fails the test; every violation, of any impact, is attached to its report.

- **Pages, in use.** The Office is first given a Floor, Notices, an Agent's work, Gateway requests and a Batch. Then every page is checked in light and in dark mode: setup, sign-in, the Office, Notices, Activity, Gateway requests and a request, Analytics, Agent Settings (a Floor and the lobby), AI Settings, Admin, a Floor's admin, an Agent's live view, the Manager chat, the whiteboard, and the not-found page.
- **What opens on them.** The footer's policy dialogs, and the navigation menu on a narrow screen. The Agent editor, archiving a Floor, and the forms in AI Settings and Admin part way through. The 3D Office's panels: the lift, **Inspect**, **Scene settings**, and each inspectable object's panel.
- **Themes.** Admin in every theme, in both modes. The Office's message for a browser without WebGL 2.
- **The keyboard.** The skip link, a dialog's focus trap and focus return, and **Inspect** into an object's panel and back.

A new page or panel goes in that spec too. `expectAccessible(page, name)` (`e2e/support/accessibility.ts`) runs the check once nothing on the page is loading or animating.

## Running the web app

`apps/web` is React with Vite, TanStack Router and Query, Zustand, Tailwind
and shadcn/ui (components are added with `pnpm dlx shadcn@latest add <name>`
from `apps/web`). `pnpm build` writes `apps/web/dist`, which the server then
serves at `/`. While working on the web app, `pnpm dev` runs Vite alongside
the server (see [Running in development](running.md#running-in-development)). To run
them separately:

```bash
pnpm --filter server dev   # the API, on PORT (3046)
pnpm --filter web dev      # the app on :3045, proxying /api and /health to it
```

### The navigation

The navigation on the left of every page (`apps/web/src/layout.tsx`) is
sticky on wide screens: it stays in place, scrolling on its own, while the
page scrolls.

- **Settings in two places.** **Floor Settings** (`/floor-settings`)
  holds every Floor: the **Floors** card (add, rename, archive, and each
  Floor's own settings at `/floor-settings/<floor>`: its team, Manager,
  Merge Policy, Skills, memory and the rest) and the **Available Skills**
  card. **General Settings** (`/general-settings`, once **Admin** at
  `/admin`) holds what is the
  whole Office's: appearance, the Role library, Floor Templates, the Skill
  library, office-wide memory, intake, webhooks, sandboxes and the rest.
  The Role library, Floor Templates and Connections are its pages, at
  `/general-settings/roles`, `/general-settings/templates` and
  `/general-settings/connections`. Old addresses go to the new ones,
  keeping their search and the card they named: `/admin…` to
  `/general-settings…`, and a Floor's `/admin/floors/<floor>` to
  `/floor-settings/<floor>` (`#role-memory`, say). Google's sign-in
  callback stays at `/admin/connections/google`, the redirect URI
  registered with Google.
- **Collapsed to its icons.** **Collapse the menu** (the chevrons at its
  top) leaves only each item's icon; each is still named to screen readers
  and by its tooltip. **Expand the menu** brings the labels back.
- **As wide as the Owner likes.** Drag its right edge to make it narrower
  or wider, from 160 to 400 pixels (224 to start with). With the edge
  focused, the left and right arrows move it by 16, Home and End take it
  to its least and most, and Enter or a double click puts it back.
- **In the Owner's order.** Drag an item into another's place, or press
  Alt with the up or down arrow while it has focus; the move is announced.
  **Reset the order** puts it back.
- **Kept in this browser.** The order and whether it is collapsed are kept
  in `localStorage` (`ai-office:navigation-order`,
  `ai-office:navigation-collapsed` and `ai-office:navigation-width`; `apps/web/src/navigation-prefs.ts`),
  so they belong to this browser alone. Without storage (a private window,
  blocked site data) the navigation is in its first order and expanded. An
  item added to AI Office later goes at the end of a saved order.

### The Office's colour palette

The 3D Office and the 2D UI share one colour palette (PRD §7): `palette` in
`@ai-office/shared` (`packages/shared/src/palette.ts`), named tokens such as
`desk-top`, `stage-review` and `state-warning`. The web app's Tailwind
config (`apps/web/tailwind.config.ts`, loaded by `src/styles.css`) makes
each one an `office-*` colour: `bg-office-stage-review`,
`text-office-state-critical`. What each token is for, and the lighting,
materials, scale and asset rules every asset follows, are in
[`docs/reference/art-direction.md`](../../docs/reference/art-direction.md).

### The 3D Office

**Office** (`/`) is the 3D Office (PRD §6.11): a React Three Fiber canvas
with drei and `@react-three/postprocessing`, lit and post-processed as the
art direction says. It lives in `apps/web/src/scene/`, and three.js loads
only when the page is opened. It opens on the lobby, and the lift goes to
each Floor. Its heading names where the lift is, **Office - Lobby** or **Office -**
and the Floor's name, and so does the browser tab (**AI Office - Lobby**);
every other page's tab is simply **AI Office**.

- **The lobby** (`scene/lobby-layout.ts`, `scene/lobby.tsx`): the entrance,
  the Communications Agent's reception desk with its out-tray and the
  company logo (`brand.logo`) on the wall behind it, a waiting area, a
  water cooler, the office-wide Notice Board on the back wall and the
  lift. It is
  built from pieces (simple shapes in a palette token and a surface,
  `scene/pieces.ts`), merged into one mesh per shared material
  (`scene/materials.ts`); tests check it against the art direction's
  sizes, walkways, materials and budgets.
- **The lobby's people** (`scene/lobby-people.ts`,
  `scene/lobby-people.tsx`): the receptionist, who is the Communications
  Agent in its own name and Avatar (PRD FR-96), sits behind the reception
  desk and, each time the Office opens, greets whoever signed in in a
  speech bubble: "Hi, Ade. Good morning." (afternoon from noon, evening
  from 6 pm), by the nickname (else the name) and time zone of the Owner
  password or API key they signed in with, set in API Key Management. Then they mostly type, and now and then lean back, fetch
  a drink from the water cooler, stretch or read the Notice Board. Now and
  then a visitor waits on the sofa by the front: sitting, listening to
  music (♪), dozing (zzz), stretching or fetching a drink, and after a
  while leaves by the entrance, to come back later. Each plays one routine
  after another, chosen at random, but both are seated as the lobby opens:
  the receptionist at the desk, typing or leaning back
  (`receptionistFirstRoutine`), the visitor on the sofa
  (`visitorFirstRoutine`), each made already posed in place, so no one is
  seen getting up or walking in. Their names and Avatars are set in
  **Agent Settings**; with reduced motion both stay still in their places.
  Screen readers hear the greeting from a status message.
- **The reception desk** (`scene/reception-desk.ts`,
  `scene/reception-desk.tsx`, PRD FR-96). While the lift is in the lobby
  the Office reads the Connections every five seconds
  (`GET /api/connections`): a successful delivery is in its Connection's
  own log only, never on the event bus. Each Connection whose latest
  delivery (a message or a test) is newly delivered is one message sent,
  and drops an envelope from the Communications Agent's hands, in an arc,
  into the out-tray on the counter's ledge, where it lies on the pile
  (up to eight show). What was sent before the Office opened is not
  dropped, and two sent between readings drop one. Three drop one after
  another, 0.3 s apart; any more land at once, so the envelopes catch up,
  and with reduced motion they all land at once. While any Connection is
  failing (FR-94), a red marker stands on the counter's ledge: a sign
  with an exclamation mark, glowing `state-critical` and pulsing as the
  Manager's red light does (steady with reduced motion), turned towards
  the camera. Delivery never waits for any of it: the scene only shows
  what was sent.
- **A Floor** (`scene/floor-layout.ts`, `scene/floor.tsx`) is generated
  from its Agents, and changes as Agents join or leave. Along the back
  wall: the Manager's glass office with its desk and a bookshelf of the
  Floor's Skills, the meeting room with
  its whiteboard and a table for ten (and, for a team larger than that,
  two spare chairs along its left wall), the Floor's wall board, the
  bookshelf, the lift and the canteen (counter, coffee machine, fridge and
  a café table). The company logo (`brand.logo`, as behind the lobby's
  reception) hangs on the left wall over the open plan. A corridor runs
  past them to the water cooler; an aisle
  runs from the lift between the desks and the gym, where all the fitness
  equipment stands together on one mat. Every other Agent has
  a desk in the open plan, in rows of up to five, and the Floor grows
  towards the front for more rows. Contractors are Agents like any other
  here: each has a desk of its own while it is on the Floor.
  - **Adventure game posters** (`scene/posters.ts`,
    `scene/wall-posters.tsx`) hang framed on the walls: affectionate
    parodies of classic adventures. Night of the Tentacle, Sam & Bob Hit
    the Road, Montana Jones and the Fate of Atlantis and Space Quack III
    hang either side of the meeting room's whiteboard; Simone the
    Sorcerer, Beneath a Tin Sky and Queen's Quest VII: The Princeless
    Groom on the left wall at the corridor's end; and The Secret of
    Donkey Island and Donkey Island 2: LeDuck's Revenge over the
    canteen's counter. Each evokes its game's poster or box art (its
    composition, palette, lettering and key subject, with a joke of its
    own: a duck-billed visor, a donkey on the beach) but is the Office's
    own picture, drawn procedurally on a canvas from simple shapes, never
    the game's art or logo. They use the palette's colours and a few
    inks of their own.
  - **Arcade game posters** (`scene/arcade-posters.ts`) hang as a gallery
    of two rows of four on the left wall between the dartboard and the
    basketball hoop: Space Intruders, Pac-Mum, Donkey Kongo and Galaxia
    above; Asteroidz, Frogga, Centipeed and Tetrus below. Each is its
    game's screen, neon on black under a cabinet's lit marquee with a row
    of bulbs, its title altered by a joke (Pac-Mum wears a bow, pearls
    and lipstick; Donkey Kongo's ape plays bongos; Frogga's frog wears a
    crown), with pixel sprites drawn block by block from the Office's own
    designs and scanlines over them, never the games' sprites, art or
    logos. They begin past the theme's zone, clear of the dartboard and
    its players, and end short of the hoop's backboard on the smallest
    Floor; a larger team only moves the hoop further forwards. Tests
    check that nothing stands in front of any of them in every theme for
    teams of 1 to 30.
  - **All seventeen posters** share one texture, a grid laid out to give
    each the largest cell, as large as the quality setting's largest
    texture, and one mesh, over frames that are part of the Floor's
    pieces. They hang clear of the theme's zone, so every 3D theme keeps
    them. A title is the one place the scene carries words; titles fit
    the poster's width whole, at the largest size that fits.
  - **Desk sets** (`scene/desk-set.ts`) are at the art direction's sizes,
    with a stripe in the Agent's Stage colour and the desk dressing the
    Role library gives its Role (PRD FR-57, FR-98), so a Role from a
    template or of the Owner's own is dressed as its library entry says:
    a monitor; dual monitors and a drawing tablet (a designer); a laptop,
    tablet and phone (QA's test devices); printouts (a reviewer); books
    and a notebook (docs, a writer); a copywriter's notebooks, two shut
    and one open; a merchandiser's product samples, two boxes and a jar.
    The Manager has a desk lamp. Until the library has loaded, a built-in
    Role's desk is dressed as the built-in Role is, and any other has a
    monitor. The spot on each desk's left is kept for its pile of
    tickets, and every dressing fits Low's desk-set budget.
  - **The Floor's 3D theme** (`scene/floor-themes.ts`, PRD FR-57, FR-99)
    dresses the Floor in its Floor Template's look, along its left wall
    in front of the lounge, beside the desks (x −10 to −7.5 m, z 4.4 to
    8 m). A Floor keeps the theme of the template it was
    added from (`theme` on the Floor, see
    [Floor Templates](floors-and-agents.md#floor-templates)). Each theme
    is data: a list of props, each placed and turned in the theme's zone,
    built from pieces in the palette's colours and the asset pack's
    bookcase and books.

    | Theme | Template | What it sets out |
    | --- | --- | --- |
    | `office` | Development, Blank | nothing: the Floor as it was before themes |
    | `stockroom` | Online store | two stock shelves of parcels and products, a packing table, a pallet of parcels |
    | `studio` | Website & marketing | a photo studio: a paper backdrop, a product on a plinth, two softboxes, a camera on a tripod |
    | `editorial` | Content & blog | two bookcases, a printing press with its red flywheel, bundles of printed paper |
    | `library` | Documentation | a wall of four bookcases, a library ladder, a reading table with its lamp |
    | `atelier` | Design system | a wall of the palette's swatches, a layout table, an easel, plinths with a sphere, a cylinder and a cube |
    | `observatory` | Data & analytics | two dashboards on the wall, their bars, donuts and trends glowing, and a round table |
    | `data-centre` | Infrastructure | eight server racks in two rows on a raised floor, their status lights lit, under a cable tray |
    | `device-lab` | Mobile app | a wall of phones and tablets over a test bench, a ring light, a charging cart |

    A theme is decoration only: no Agent walks to its props and nothing
    waits for them. Tests check that the desks, walkways and waypoints
    are the same in every theme, that its props stand in its zone, clear
    of every desk and walkway for teams of 1 to 12, and that a 12-Agent
    Floor in each theme stays within Medium's triangles and draw calls.
    A new theme is an id in `floorThemes` (`@ai-office/shared`), its
    props in `floorThemeProps`, and its screenshot (below). Pieces may
    be cylinders lying along x or z (`lying`), for rollers, wheels and
    discs.
  - **Waypoints** (`scene/waypoints.ts`): hand-placed points in the
    walkways (the lift, each desk, the rooms and amenities) joined by
    straight edges clear of furniture; `walk()` finds the shortest way
    between two. Tests check, for teams of 1 to 12, that no desks overlap
    and every desk reaches every spot.
  - **Models** from Kenney's Furniture Kit (CC0; the coffee machine,
    fridge, bookcase, books, laptop and plants), in
    `scene/models/`, prepared to the art direction by
    `apps/web/scripts/prepare-models.ts`: real size, the palette's shared
    materials, Meshopt-compressed. To prepare them again, download the kit
    from the page in `scene/model-catalogue.ts` and run `node
    apps/web/scripts/prepare-models.ts <the unzipped kit>`. They are listed
    in `THIRD-PARTY-NOTICES.md`.
  - On **Low**, a soft contact shadow lies under each desk and chair, and
    under each of the theme's props that stands on the floor.
  - **Agents at their desks**: each Agent sits in its chair as its Avatar
    (below), typing while it works, waiting on review or sitting back (see
    [Agents' states](#agents-states-in-the-office)), with its desk mascot
    at the back of its desk's left end and up to five desk items its
    Avatar chose, each at its real size, laid out in the order chosen
    wherever its desk has room round its Role's dressing
    (`scene/desk-item-layout.ts`; one with no room is left off; in one
    merged mesh), and gets up to walk its tickets to
    the next Agent (see [Handoff walks](#handoff-walks)). On Low and High a
    contact shadow lies under each Agent too.
- **The Notice Board** shows a stylised preview of the latest open Notices,
  live (`scene/notice-board-preview.ts`): up to six cards, newest first,
  each with a stripe in its kind's colour, lines of "writing" as long as
  its title, and pins (two on an action Notice, one on an info Notice);
  the rest are a stack of sheets. No words are drawn in the scene: a panel
  says what the board shows, with a link to the 2D Notice Board.
- **A Floor's wall board** pins up that Floor's own open Notices, live, as
  the lobby's Notice Board does every Floor's (the same cards, on the wall
  board's felt). Its panel has the rest (see [The wall board](notices-and-skills.md#the-wall-board)).
- **Avatars** (PRD FR-13, §7) are a character kit of our own, built in
  code from simple rounded shapes at real size, as the rooms are, so it
  needs no asset pack and every part fits every body:
  - **The Avatar** is `avatarSchema` in `@ai-office/shared` (also
    `@ai-office/shared/avatar`): presentation, body shape, face, hairstyle
    and colour, skin tone, facial hair, glasses, accessories, outfit style
    and its two colours, a desk mascot, and up to five of thirty desk
    items (`deskItemKinds`: a laptop, pen, paper, ruler, coffee mug and
    more; none for an Avatar saved before them). It refuses any part the kit
    does not have, and any field it does not know. `randomAvatar(random,
    others)` makes one unlike `others`; with `seededRandom(seed)` it is
    the same Avatar for the same seed. An Agent without an Avatar is drawn
    with one seeded from its id.
  - **One shared rig** (`scene/avatar-rig.ts`): 19 bones, the same for
    every Avatar; only where they sit changes, from 1.55 m to 1.85 m by
    body shape and presentation, about six heads tall.
  - **The parts** (`scene/avatar-parts.ts`): one for every option, each
    bound to a bone and tinted from the Avatar's skin, hair and outfit
    colours (`scene/avatar-geometry.ts`). An Avatar is one skinned mesh in
    one material all Avatars share, so each is one draw call; a texel per
    surface (skin, hair, fabric, plastic, metal) gives each its roughness
    and metalness. Every vertex has at most three bone influences; a
    dress's skirt is shared between the hips and the thighs, so it falls
    over the lap when its Agent sits.
  - **LODs**: High, Medium and Low draw an Avatar at about 6,700, 3,600 and
    2,200 triangles at most, within the art direction's 10,000, 6,000 and
    3,000.
  - **Animations** (`scene/avatar-animations.ts`): idle, sit, type, walk,
    carry (a ticket), hand over (reaching the ticket out), stand up, sit
    down (standing up, backwards), stretch, sleep, drink (from a mug), work
    out, chat and wait (leaning back, hands behind the head), as poses on
    the shared rig, played with a smooth curve through them and
    cross-faded from one to the next (`scene/avatar-figure.ts`). Poses
    that meet the Office are solved for each body: seated on the chair's
    seat with the feet on the floor, the hands on the keyboard, the hands
    behind the head, a squat with the feet still. With reduced motion an
    Avatar holds its pose.
- **The desks' monitors** show their Agents at work, live
  (`scene/monitor-preview.ts`, `scene/monitor-screens.tsx`). While an Agent
  is working (from its status, or its sandbox starting), its screens glow
  in `screen-glow` and fill with lines of "writing": one for each line of
  its terminal output (as long and indented as it), each tool call and
  model call, and each line of a diff, coloured by kind. New lines scroll
  up from the bottom, and the screen glows brighter for a moment at each;
  with reduced motion they are there at once, with a steady glow. An idle
  Agent's monitor is off, and starts empty when it works again. On a
  Floor, the Office reads a page each of its Agents' latest statuses and
  activity (`GET /api/events`), then follows the Floor's stream. All the
  monitors together are two instanced meshes.
- **The lift** goes to the lobby and every Floor. Waiting at a stop, it
  rests with its doors shut. Click its call button to call it: the button
  lights, the doors open a moment later and the floor picker opens; the
  doors close again after 8 seconds. Its floor picker (**Lift**, the call
  button, or click the lift's doors) lists them, each Floor by the name
  the Owner chose for it (PRD FR-7; its repository is the button's
  tooltip, and a rename shows at once, on `floor.renamed`) and
  with a count of its open action Notices; over the doors, a lamp per stop
  shows where the car is, with a red marker under a stop with an action
  Notice. Above the lamps a sign names where the lift is: **Lobby**, or the
  Floor's name, renamed as it is renamed. From 19:00 to 07:00 by the
  viewer's clock its lettering is lit and glows a little, never so much that its
  letters run together: in bold, drawn sharp, it is read from across the Floor. Picking a stop flies the camera to the doors, which close; the
  car travels, the new stop is shown, and the doors open as the camera
  steps back (`scene/lift.ts`, `scene/lift-store.ts`). With reduced
  motion it is there at once.
- **Inspectable objects** (PRD FR-58; `scene/inspectable.ts`): each
  Agent's monitor, a Floor's whiteboard, wall board and bookshelf, the
  bookshelf in its Manager's office, the lobby's Notice Board, the
  Communications Agent at the lobby's reception desk (`agent:communications`,
  seen from over the counter, the whole desk in view), and each Agent where it sits (its box takes in its
  chair and reaches past its head; its view looks over its shoulder, or
  from the first side with nothing in the way). Each is an object type and an id (an Agent's for a
  monitor, the Floor's for its whiteboard, `office` for the lobby's Notice
  Board), with a box over it and a camera view close in on it, framed
  between the controls on the left and the panel on the right. One mechanism serves them all:
  - **In the scene** (`scene/inspectable-hotspots.tsx`), an unseen box over
    each object picks it: pointing at it highlights it (a veil of `paper`
    outlined in `ink`) with a pointing cursor, and clicking it opens it.
  - **Opening one** (`scene/inspection.ts`) flies the camera in and opens
    its HTML panel beside it. **Close panel** or Escape flies back to the
    view the camera was at; opening another on the way still goes back
    there. A ride in the lift closes it, and so does its object leaving
    (an Agent removed with its monitor open).
  - **Panels by type** (`scene/inspector-panels.tsx`): each type's entry is
    its panel. A monitor's is its Agent's live view (see
    [The Agent live view](events-and-chat.md#the-agent-live-view)), following it while the
    panel is open, with a link to the live view's own page. A wall
    board's is the Floor's wall board (see [The wall board](notices-and-skills.md#the-wall-board)).
    An Agent's is its card (see
    [Agent cards](#agent-cards-and-flying-to-an-agent)); the Communications
    Agent's (`scene/communications-agent-card.tsx`) gives its Role, AI
    Provider, Model, whether it is sending or paused, and how many
    Connections it has, naming the failing ones, with a link to the
    Connections admin (`/general-settings/connections`).
    The whiteboard's shows the Floor's Plans, editable while one awaits
    approval (see
    [The whiteboard](batches-and-memory.md#the-whiteboard-approving-editing-and-replanning-a-plan)),
    and the bookshelf's the Floor's memory (see
    [The bookshelf](batches-and-memory.md#the-bookshelf-a-floors-memory)).
    The Manager's bookshelf's is the Floor's
    [Available Skills](notices-and-skills.md#available-skills), with a link
    to the Manager chat.
    The others are for their types' own issues to replace; until then each
    says what it will show and links to the 2D page that shows it today,
    such as the Notice Board.
  - **Moving and resizing a panel** (`scene/inspector.tsx`,
    `scene/panel-layout.ts`): where the Office's view has room (39rem or
    more), every panel moves and resizes within it, and never leaves it.
    Drag it by its header (its title bar), or focus its **Move panel** grip
    and use the arrow keys, 16 px a press; with Shift they resize it. Drag
    its right edge, bottom edge or bottom-right corner to resize it, from
    280 by 200 px up to the view's size (1400 by 1200 px at most). Given
    a height, its content scrolls inside it, and a chat (the Manager chat,
    a direct chat, a Grilling Session's) or a monitor's live view grows to
    fill it. A screen reader hears where it went or how big it is.
  - **Full screen**: the panel's **Full screen** button fills the whole
    page to the right of the navigation menu, over the page's header too,
    keeping step as the menu is collapsed or resized (the whole width on a
    narrow screen, where the menu is above the page). **Restore panel**, or
    Escape, puts it back where it was; the next Escape closes it.
  - **Kept in this browser**: each kind of panel (an Agent's, a monitor's,
    a Grilling Session's…) keeps where it was moved, its size and whether
    it fills the screen, in local storage under
    `ai-office:inspector-panels` (`{ "agent": { "x", "y", "width",
    "height", "full" }, … }`, in pixels from the view's top left corner).
    Each kind has its own because their contents differ: a chat wants to
    be tall, the Notice Board's link small. A kept layout is fitted to the
    view as it is now; without storage, the panel opens where it always
    has. A panel never moved opens beside the controls, as before.
  - **From the keyboard**, **Inspect** lists every object where the lift
    is; the arrow keys, Home and End move through it, focusing one
    highlights it in the scene, and Enter opens the same panel. Focus moves
    into the panel, and back to the list when it closes.
  - **From an address**, `/?floor=web-shop&inspect=monitor:ada` (or
    `/?inspect=notice-board:office` in the lobby) rides the lift to the
    Floor and opens the object once it is there (`inspectHref`). The
    address follows what opens and closes.
- **Panels are HTML**, over the canvas but outside it: the camera views
  (Overview, Plan, Close up), the floor picker, **Inspect** and the open
  object's panel, **Scene settings**, the Notice Board's summary and the
  frame rate. Each is a button, a link or a form control, so it works from
  the keyboard.
- **Camera.** The camera flies between named views, eased
  (`scene/camera-rig.ts`). On a touch screen, fingers move it too (see
  [Phones and tablets](#phones-and-tablets)). Picking a view drops moves still queued and
  turns from wherever the camera is; queued moves (`queueView`) fly one
  after another. Rooms add their own views with `registerView`.
- **Scene settings** belong to the browser, in its local storage:
  - **Quality**: Low, Medium (the default) or High, setting shadows,
    post-processing and the pixel ratio (`scene/quality.ts`, from the art
    direction's tables, which a test compares them with).
  - **Reduce motion**: camera moves cut straight to their view. It starts
    as the browser's `prefers-reduced-motion` says.
  - **Show frame rate**: frames a second and milliseconds a frame, read
    twice a second.
  - **Show Context Usage and tokens above Agents**: on by default; off
    hides every Agent's Context Usage bar and tokens label together (see
    [Above the Agents' heads](#above-the-agents-heads)).
  - **Sound**: muted by default; the ambience's and the music's volumes,
    and on a Floor its ambience (see
    [Ambient sound and music](#ambient-sound-and-music)).
- **State** is in Zustand stores: the camera (`useCameraStore`), the lift
  and where it is (`useLiftStore`), what is selected or pointed at and the
  view to go back to (`useSelectionStore`) and the settings
  (`useSceneSettings`, `useSoundSettings`).
- **Layouts are data.** `scene/pieces.ts` and the layouts built from it
  load no three.js, so the Office's HTML can use them (the inspectable
  objects come from a Floor's layout) while three.js stays in the scene's
  own chunk; `scene/piece-geometry.ts` turns pieces into geometry.
- **Tests** render scene components without WebGL with
  `@react-three/test-renderer`. The key scenes are also compared with
  reference pictures, drawn by real WebGL in software (see
  [Scene screenshot tests](../../README.md#scene-screenshot-tests)).
- A browser without WebGL 2 is told so; every other page works as usual.

### Seasonal events

In season the Office dresses up (`scene/season.ts`, `scene/seasonal-*.ts`),
by each viewer's own clock. The Owner turns each event on or off, moves
its first and last day (a day box and a month box each, every year),
turns each of its Actors and extras on or off, and writes what each Actor
says, separated by commas, in **General Settings → Seasonal events**
(`GET`/`PUT /api/office/seasonal-events`), where each Actor stands on a
turntable to drag round, as in the Avatar Editor.

| Event | Days | Decorations | Extras | Actors |
| --- | --- | --- | --- | --- |
| Christmas | 1–26 December | A big, wide tree in the lobby by the lift, a smaller one on each Floor, with baubles, lights, a star and presents; tinsel round every wall and across every ceiling, with baubles, stars and snowflakes hanging everywhere | Each on or off: the trees, the lights, the decorations; party food on the meeting room table (turkey, pudding, mince pies, a Yule log, crackers) | Santa, who gives the Agents presents and leaves more under the tree; an Elf; the Grinch |
| Halloween | 19–31 October | Gravestones, bats overhead and orange and purple lights; pumpkins | Each on or off: the decorations, the pumpkins; Halloween food on the meeting room table (a cauldron of green punch, pumpkin pie, eyeball cupcakes, sweets, meringue ghosts); the Agents wear costumes (a witch's hat, devil's horns, cat's ears or a cape) | A skeleton, a vampire, a slasher, a night stalker, a creepy clown, a werewolf, a witch, a mummy, a zombie, a monster and the Grim Reaper, who run round scaring the Agents; a ghost, who floats |
| Easter | 20–30 March | Baskets of eggs | Easter eggs, on or off: loads of them all over the lobby's and every Floor's floor, clear of every path | The Easter Bunny, who hops round |
| New Year | 26 December–7 January | Balloons, streamers and lights, on or off | Party hats; nibbles on the meeting room table | A drunk man and a drunk woman, who stagger round and sway, glass raised |

Every event strings fairy lights round the walls, in its own colours, that
twinkle. Now and then (the first within a minute, then every few minutes)
one Actor steps out of the lift and goes round a different way each time:
on a Floor to three stops in a random order, by the Agents' desks and at
the things there are to play (darts, pool, table tennis, the punchbag,
the basketball hoop…), which it has a go at as the Agents do, now and
then by way of somewhere else on the Floor; in the lobby to one to three
of reception, the Notice Board, the water cooler, the entrance and the
sofa. It says one of its lines at each stop, and goes back. Everyone
walks, runs, hops or staggers on their feet; only the ghost floats. In season the 3D view's **Call Actor** button, at its foot on
the right, calls one out at once; while one visits it reads **Remove
Actor** and sends it back to the lift and away (on a Floor by the
shortest way). Only one Actor is ever out at a time. On 26 December,
when both are on, Christmas's party food takes the meeting room table
from New Year's nibbles. Costumes and hats are added as the Agents are
drawn, never saved to their Avatars. With reduced motion the lights hold
still and nobody visits.

### Agents' states in the Office

Each Agent's state shows on its Floor at a glance (PRD FR-62), from its
monitor, its pause and the Floor's wall board. `agentLook` in
`scene/agent-state.ts` says how each state looks, and
`scene/state-visuals.tsx` draws it:

- **Working:** the Agent types, its monitor lit. Work wins: a paused
  Agent finishing its task still types, under its marker.
- **Waiting on review:** while an issue it handed to review waits on the
  reviewers' verdicts (and it is not working on something else), it
  leans back in its chair with its hands behind its head and its elbows
  out, glancing over now and then. An Agent with nothing to do sits back,
  its hands in its lap.
- **Paused or capped:** a marker floats over its head, facing the camera,
  in `state-critical` (it glows, so it blooms): a disc with a pause's two
  bars while the Owner has paused it in the Agent editor, an octagon with
  a bar across, like a no-entry sign, while it is paused at a Token Cap.
  Each kind is its own shape, so neither is told by colour alone. A cap
  is shown over a pause, and a capped Agent never types.
- **Its queue:** a pile of A4 tickets, 5 mm each, lies on its desk's
  left, one for each task that waits for it, ten at most however long
  the queue (the art direction's).
- **An action Notice:** a red light over the Manager's office door,
  facing the open plan, lights while the Floor has an action Notice open,
  pulsing gently between the spec's emissive 1.2 and 2.0 (steady with
  reduced motion); it is a dark lens otherwise.

The piles are one instanced mesh, each kind of marker two (its signs and
their symbols), and the light one more, so a Floor shows every state for
six draw calls; a test keeps a Floor of 12 Agents, each with a marker and
a full pile, within Medium's budgets. The Office reads the Floor's wall
board (`GET /api/floors/:floorId/wall-board`) for the queues, the issues
at review and the Token Cap pauses, and reads it again at each event that
changes them (`agent.queue_changed`, `agent.status_changed`,
`issue.assigned`, `issue.label_changed`, `handoff`), on the stream that
keeps its Agents live. The red light follows the open Notices the Office already
reads.

### Above the Agents' heads

One small display floats above each Agent on a Floor (PRD FR-62, FR-85;
`scene/above-head.ts` says what it shows, `scene/above-head.tsx` draws
it). It is HTML (drei's `Html`), so its text stays sharp: a fixed size on
screen, readable at the overview, facing the camera. It is a child of the
Agent's own figure, so it goes with the Agent on a Handoff walk, to a
meeting or an idle activity, 2.2 m over where it stands, clear of a
standing head and of the paused or capped marker.

- **Context Usage bar**, while the Agent has a session going: filled and
  coloured by its Context Usage (green below 60%, amber from 60%, red
  from 85%, as the 2D gauge), with the percentage, or `Unknown` without a
  context window. An idle Agent has none. A reviewer never has one: its
  calls are stateless (FR-84).
- **Fresh Start:** the bar empties from where it was over 1.2 s, saying
  "Fresh Start", then hides until the new session's first call is
  counted. With reduced motion it does not animate. A Fresh Start from
  before the display was drawn is not played.
- **Tokens today**, idle or not, such as `128k today` (`compactTokens`:
  `999`, `1.2k`, `128k`, `3.4M`, rounded down): on paper below 80% of the
  daily Token Cap in force for the Agent, amber from 80%, red at 100%;
  neutral when it has no cap. Hovering it shows this month's tokens
  against the monthly cap (`3.4M of 100M this month`).
- **Where from:** Context Usage from `GET
  /api/floors/:floorId/context-usage`, kept live by `agent.context_usage`
  events, with `agent.fresh_start` events for the animation, on a stream
  of their own (so a busy Agent's Context Usage never pushes the Floor's
  Handoffs and meetings out of the team's stream), read again whenever
  it reconnects. Tokens from `GET /api/floors/:floorId/token-usage`, read
  every minute, as the Agent card's are.
- **Switched off** with **Show Context Usage and tokens above Agents** in
  **Scene settings**: nothing is drawn, and nothing of it is read or
  streamed. Like the scene's other labels it is hidden from assistive
  technology; the Agent card and the live view say the same in 2D.

### Handoff walks

At each Handoff (PRD FR-59), the Agent handing over gets up, carries a
ticket along the Floor's waypoints to the next Agent's desk, hands it over,
walks back and sits down; the receiving monitor lights up as the ticket
arrives. `scene/handoff-walks.ts` plans and times it as data, and
`scene/handoff-tickets.tsx` plays it:

- **The way** (`handoffRoute`): from its seat the Agent steps 0.55 m aside
  (towards where it is going), back to the walkway behind its chair, then
  along the waypoint graph's shortest way (`walk()`) to the receiver's
  walkway, and in to beside the receiver's chair, where it turns to face
  it. It joins and leaves the walkway towards where it is going, so it
  never doubles back past its own desk. Back is the same way, reversed.
- **The walk**: stand up (1.2 s), carry the ticket at 1.25 m/s, hand it
  over (1 s, reaching it out), walk back, sit down (1.2 s), as the
  `stand-up`, `carry`, `hand-over`, `walk` and `sit-down` animations.
- **The ticket** is labelled with the issue's number (`#14`) in HTML over
  the canvas (drei's `Html`; no text is drawn in the scene), in the colour
  of the stage it goes to (`stage-review`, `stage-qa`…), and follows the
  ticket in the Agent's hands until it is handed over.
- **The receiving monitor** glows `screen-glow` at its brightest as the
  ticket arrives: a working one pulses brighter, an idle one lights up on
  its own and fades back to dark over 3 s.
- **The pipeline never waits.** A `handoff` event is published once the
  work has moved on; the walk only catches up. Each Agent walks one
  Handoff at a time and the next waits for it, the walk under way playing
  at twice the pace while one does. A Handoff that falls further behind
  (a newer one arrives while it waits, as after a reconnection's replay)
  is skipped: its ticket is handed over at once and its receiver's monitor
  lights. Only Handoffs that arrive while the Floor is shown are walked.
- **With reduced motion** no one walks: each ticket is handed over at once,
  and the receiving monitor holds a steady glow for 3 s.

The Office takes the Floor's `handoff` events from the stream that keeps
its Agents and wall board live, and reads the wall board again at each (a
Handoff to review says who waits on it).

### Contractors arriving and leaving

A [Contractor](floors-and-agents.md#contractors) the Manager adds steps
out of the lift and walks along the Floor's waypoints to its new desk,
then sits down (PRD FR-57). One that leaves gets up and walks back to the
lift, and only then is its desk taken away, the rest of the open plan
settling around the gap. The walks are planned as the Handoff walks are,
from the Floor's `agent.created` and `agent.removed` (with
`contractor.added` and `contractor.left`) events, and only for those that
arrive while the Floor is shown. The work never waits for them: a
Contractor's work can start while it is still walking. With reduced
motion, no one walks: the Contractor is at its desk at once, and its desk
goes as it leaves.

### Kickoffs and Wrap-ups in the meeting room

The Kickoff and the Wrap-up (PRD FR-60; [Batches](batches-and-memory.md#the-kickoff))
are shown as the Agents gathering in the meeting room while the
whiteboard fills in. `scene/meeting-walks.ts` plans and times it as data,
and `scene/meeting-room.tsx` plays it:

- **Who goes where** (`meetingPlaces`): the Manager stands at the
  whiteboard, facing the table; the Agents the Plan assigns take the
  table's seats, the front row (facing the whiteboard) first, nearest the
  door first, then the ends, then the back row, each facing the table.
  Beyond the ten seats, Agents stay at their desks.
- **The way** (`meetingRoute`): off the chair as for a Handoff, along the
  waypoint graph to the meeting room, onto the walkway in front of the
  table's chairs (or behind them, for the back row), along it level with
  the seat, and in to it. Back is the same way, reversed.
- **The meeting**: stand up, walk at 1.25 m/s, sit down, and stay seated
  until the meeting ends; then stand up, walk back and sit at the desk.
  A **Kickoff** starts at `batch.kickoff_started` and ends at
  `batch.kickoff_ended`; a **Wrap-up** starts at `batch.finished` and
  ends by itself 20 s after its Agents are seated. Either keeps them at
  the table for at least 6 s, so a Kickoff answered at once is still seen.
  An Agent still in the room when the next meeting begins stays for it.
- **Work never waits** (FR-59). An Agent on a Handoff walk finishes it
  before it sets off; a Handoff from an Agent in the meeting room is
  handed over at once. Only meetings that begin while the Floor is shown
  are walked.
- **A meeting wins over everything else an Agent does away from its
  chair** (`scene/away-pose.ts`): over a Handoff walk, if the two ever
  meet, and over an idle activity, which stops at once when the Agent is
  gathered, as a new task stops it.
- **With reduced motion** no one walks to a meeting.
- **The whiteboard** in the meeting room opens the Floor's whiteboard
  panel, which fills in live as each acknowledgement and the Wrap-up
  arrive.

The Office takes the Floor's meeting events from the stream that keeps its
Agents and wall board live.

### The Status update

A Floor's Status update (PRD FR-23a) is its stand-up. **Status update**,
before **Meeting Room** at the bottom of a Floor in the Office (and in each
Floor's section of the 2D Office), gives one now; and the first time the
Owner opens a Floor each day AI Office gives the day's own by itself, once
the lift is there (in the 2D Office, when the address opens the Floor).
While the Floor's Agents are working, AI Office also gives one every hour,
saying what each did in the last hour.

- **In the meeting room**: `status_update.given` gathers the whole Floor
  as a Wrap-up does (`scene/meeting-walks.ts`), the Manager at the
  whiteboard and every other Agent at the table, and ends by itself once
  each has had a turn (5 s each, 20 s to 90 s in all, once seated). Then
  everyone walks back and sits at their desk. With reduced motion no one
  walks, as for any meeting.
- **What each says** (`status-update.tsx`): a panel over the Office, at
  its top right where the other panels open, lists each Agent's part, the
  Manager first. Like the inspector's panels (`scene/movable-panel.tsx`)
  it is moved by its header or grip, resized by its edges and corner,
  fills the screen from its button (Escape puts it back), keeps its
  layout in this browser (`ai-office:inspector-panels`, as
  `status-update`), and stays within the view, scrolling inside itself
  when it is taller. It marks whose turn it is as each
  speaks (none with reduced motion), and says it to screen readers. It is
  kept in the Manager chat too, as a report of the Manager's own; the
  daily status report is not counted as written by it. One given without
  this page asking (an hourly one, or one asked for in another browser)
  is read from its `status_update.given` event (`useGivenStatusUpdates`)
  and shown the same way.
- **How it is written** (`manager/status-update.ts`), in plain code, with
  no model: what each Agent did on the day reported on, from the event log
  (pull requests opened, reviews, QA and design reports, Handoffs, commits
  pushed, issues worked; the Manager's triage, the issues it filed, its
  Kickoffs and Wrap-ups, and the pull requests merged), and what it plans
  today, from its running and queued work and the Floor's Batches. The day
  reported on is yesterday; when nothing happened then, the latest day
  with work in the week before (Friday, on a Monday after a quiet
  weekend); with no work all week, the last weekday. Days are the Owner's,
  in their profile's time zone.
- **Once a day**: `POST /api/floors/:floorId/status-update/daily` gives the
  day's own unless `status_updates` holds one for the Floor and day,
  keyed by both, so two browsers opening the Floor at once give one. It
  answers `{ "statusUpdate": null }` after. `POST
  /api/floors/:floorId/status-update` gives one whenever it is pressed.
- **Every hour while the Agents work** (`createHourlyStatusUpdates` in
  `@ai-office/orchestrator`): each hour, each Floor in use with a Manager,
  its **Hourly Status updates while Agents work** setting on
  (`hourlyStatusUpdates`, on by default) and work running on the queue
  (work at `ready-to-merge` only waits on GitHub, so it does not count)
  gives one with the trigger `hourly`. It says what each Agent did in the
  last hour, from the same events, and what it does next, as the day's
  does; its chat message and panel say "in the last hour" rather than
  naming a day. It is not kept in `status_updates`, so the day's own still
  comes. A quiet Floor gives none. The setting is in Floor Settings, and
  `HourlyStatusUpdatesSwitch` (`hourly-status-setting.tsx`) saves it on
  its own wherever else it is offered.
- **The latest given**: `GET /api/floors/:floorId/status-update/latest`
  answers the latest Status update given on the Floor since the server
  started, whatever gave it, or `{ "statusUpdate": null }`. It is kept in
  memory, not the database.

### A Grilling Session in the meeting room

For the whole of a Grilling Session (PRD FR-83;
[Grilling Sessions](events-and-chat.md#grilling-sessions)) the whole
Floor meets in the meeting room: the Manager sits at the table with the
whiteboard behind it, and every other Agent of the Floor (Contractors
too, and those at work, whose work carries on in their sandboxes) takes
a seat round it. `scene/grilling-walks.ts` plans and times it as data,
reusing the meetings' waypoints, walkways and timing, and
`scene/grilling-room.tsx` plays it:

- **The Manager's seat**: in the back row beside the table's middle,
  facing the table, so the whiteboard is behind it.
- **Everyone else's** (`gatheringPlaces`): the table's other nine chairs,
  in the meetings' order; then, for a team larger than the table seats,
  up to two spare chairs set out along the room's left wall behind the
  back row (they are there only for such a team, reached along a lane
  clear of the table's chairs); then standing room on the walkway in
  front of the table, then on the one behind it, seven places each,
  facing the table. Anyone beyond those 25 stays at its desk.
- **Walking there and back**: everyone walks there when the session
  starts or is resumed, and sits; they walk back and sit at their desks
  when it is paused or ends. Resumed before they got up, they stay;
  resumed on the way back, they walk back to the table once home. An
  Agent who joins the Floor during a session walks to its place; one who
  leaves walks home.
- **Already running**: a session running when the Floor is shown has
  everyone seated there already, with no walk, and they get up at once
  when the session ends.
- **Fact-finding**: an Agent the Manager sends to find a fact (FR-79)
  shows it when it sets off (`grilling.fact_finding_started`) and again
  when it comes back with what it found (`grilling.fact_finding_stopped`).
  One seated at the table stands up behind its chair for 8 s, then sits
  again. One that is not there (beyond the room's places) walks to the
  walkway in front of the table, stands across it from the Manager for
  8 s, and walks back to its desk; up to five such visitors stand side by
  side, 0.8 m apart. The Manager finding a fact itself stays at the table.
- **The whiteboard** (`scene/grilling-board.ts`) shows, without text, the
  current round on the left (a heading with a tally of the round's number
  over a sticky note for each of its questions: amber while open, green
  once answered, grey when withdrawn) and the decisions on the right (a
  ticked line for each, the latest twelve). Its words are in its panel,
  which shows the round's questions with their status, the live outline
  and the decisions.
- **The door**: a lamp over the meeting room's door is lit while a session
  runs, with **In session** in HTML over the canvas.
- **Clicking** the Manager, the table or the whiteboard opens **The
  Grilling Session**: the Manager chat, with the session's bar and its
  round's question cards, and buttons to the whiteboard and the Manager's
  card. The table is in the **Inspect** list while a session runs; there
  the whiteboard and the Manager still open their own panels.
- **Work never waits** (FR-59). A walk to the table waits while its Agent
  is on a Handoff walk, gathered for a Kickoff or Wrap-up, or walking in
  as a new Contractor; a Kickoff waits for its Agents to be back from the
  table; a Handoff from an Agent at the table is handed over at once; an
  Agent there is never idle.
- **With reduced motion** no one walks: everyone is simply at the table
  while a session runs, and at their desks otherwise; no one stands up or
  visits.

#### The Meeting Room and Return to desks

Over a Floor's view (never the lobby's), bottom right, three buttons sit
side by side (`scene/office-view.tsx`):

- **Meeting Room** calls the whole Floor to the meeting room
  (`scene/meeting-room-call.ts`): the Manager and every Agent, those at
  work in their sandboxes too, walk to the table and sit round it as for
  a Grilling Session, and stay there until the Owner presses **Return to
  desks** or the lift leaves the Floor; nothing is sent or kept, and work
  never waits for it. The **Meeting Room** panel opens with the day's
  work, each a card that sends what the Owner would type in the Manager
  chat and opens the chat on its answer (`meeting-room.tsx`):
  - **Write a PRD**: **One feature** sends `/grill-with-docs <what it
    is>`, **A large effort** `/wayfinder <what it is>`; each starts a
    Grilling Session (its panel opens once it runs), whose PRD goes in
    `docs/product-requirements-document` and ADRs in
    `docs/architectural-decision-record`, in one pull request. A paused
    session can be resumed from here, and a running one carried on.
  - **File GitHub issues** (PRDs and ADRs are listed by file name alone,
    cut short with an ellipsis when the panel is narrow; the whole path
    is the tooltip): the three latest ended sessions, each with
    **Draft issues** (`draft the issues of session 3`), or **Review and
    file** and **Read** once drafted or filed, in the Manager chat; or
    PRDs and ADRs on the default branch (read with the chat's `@` file
    search) to break into issues with `/to-tickets <paths>`.
  - **Complete issues**: a range or list (`1 to 10`, `3, 5 and 8`) and
    **In one pull request** (on by default) send `complete issues 1 to 10
    in one PR`. Issues a session filed are offered here once filed.
  - **Status update**: **Status update** now, and the Floor's **Hourly
    Status updates while Agents work** switch.
  - **Stop everything** stops every Agent on the Floor at once
    (`floor-stop.tsx`; `POST /api/floors/:floorId/stop`): its running
    work is interrupted and goes back in the queue for the same Agent, and
    no work starts on the Floor, even after a restart, until the Owner
    presses **Continue working** (`POST /api/floors/:floorId/continue`),
    when each piece starts again from its issue's label and branch. Both
    are events (`floor.stopped`, `floor.continued`), so every open browser
    follows.
  - **Something else**: **Chat with the Manager**.

  Closing the panel leaves the Floor at the table; **Meeting Room** opens
  it again. While a session runs the button reads **Meeting Room (in
  session)**.
- **Chat with the Manager**, as before.
- **Fast forward** (the ⏩ button) shows to the right of **Status update**
  or **Meeting Room** once the Owner presses it, while the Floor walks to the
  meeting room. Pressing it puts the Manager and every Agent on the way
  in their places at once, the whole meeting still ahead of them
  (`scene/meeting-fast-forward.ts`); pressed before anyone has set off
  (the server is still answering), it spins until they do. It goes once
  everyone is there, or when the request comes to nothing, and never
  shows with reduced motion, as no one walks then.
- **Return to desks** shows only while someone is away from their desk
  for something the Owner may call off, so it never sits there doing
  nothing: while the Floor is in the Meeting Room, while a session runs,
  or while an Agent is away on an idle activity. It ends the Meeting
  Room, pauses a running session (`pause the session`, as the session's
  **Pause session** does), so the Meeting Room resumes it later, and
  everyone walks back from the meeting room; every Agent away on an idle
  activity (the Manager and Contractors too) stops it where it is and
  walks back to its desk, then rests a full 60 s before it idles again
  (`recall` in `scene/idle-behaviours.ts`, asked through
  `scene/desk-return.ts`). Kickoffs, Wrap-ups, Handoff walks and
  fact-finding are work, and carry on. With reduced motion everyone is
  back in their chairs at once.

The Office reads the Floor's running session from its Grilling Sessions
(`GET /api/floors/:floorId/grilling-sessions`), again at each
`grilling.session_changed` on the stream that keeps the Floor's Agents
live. That event is published each time the Manager chat keeps a session
that started, was paused or resumed, asked a round, settled answers or
decisions, or ended, with counts only; the Activity Feed lists it under
**Manager**.

### Idle behaviours

An Agent with nothing to do (PRD FR-61) sits for a rest of 20 to 60 s, then
gets up for a weighted-random activity and comes back to its chair.
`scene/idle-behaviours.ts` holds the activities and plans them as data, and
`scene/idle-activities.tsx` plays them:

- **Listed, and switched per Floor.** Agent Settings' **Agent activities**
  card (`apps/web/src/activities-card.tsx`), for the Floor chosen there,
  lists every activity an Agent's Avatar may do: what it is, where, when it
  may be chosen and its bubble. Turn any off; the Floor's Agents never do
  those, and the 3D Floor starts its idling afresh
  with the rest. The switches are kept in `office_settings.floor_activities`
  (`GET /api/office/activities`, `PUT /api/floors/:floorId/activities` with
  `{"disabled": [names]}`; `config.changed` names `activities`).

| Activity | When | Where | Animation | For | Weight | At once |
| --- | --- | --- | --- | --- | --- | --- |
| Stretch | Once, as it finishes its work | Beside its desk | `stretch` | 6.4 s | 1 | Its own |
| Coffee | Idle | The canteen's coffee machine | `drink`, with a mug | 16 s | 3 | 2 |
| Workout | Idle | The gym's mat | `work-out` | 20 s | 2 | 2 |
| Chat | Idle | Round the water cooler | `chat` | 18 s | 3 | 3 |
| Doze, "zzz" over its head | Idle for 3 minutes | Leaning back in its chair | `sleep` | 44 s | 4 | Its own |

Beyond the PRD's five, 67 more, each with a bubble over the Agent's head
saying what it is doing:

- **At its desk**: rubber-duck debugging 🦆, music on headphones 🎧,
  daydreaming 💭, scrolling the phone 📱, a snack 🍪 and the crossword 📰
  in its chair; a phone call 📞, juggling 🤹, tidying the desk 🧹, air
  guitar 🎸, touching its toes 🙆 and flying a paper plane ✈ (`throw`)
  beside it.
- **In the canteen**: an espresso chat ☕ at the coffee machine; tea 🍵 at
  the kettle; lunch heated up ⏲ at the microwave; a fridge raid 🥪; lunch
  🍝 or a tea break 🍵 at the café table; watering the plant 💧. A water
  bottle refilled 💧 at the water cooler.
- **In the lounge** along the left wall: a nap (zzz, after a long idle),
  reading 📖, a handheld game 🎮 or feet up 😌 on the sofa; feeding 🐟 or
  watching 🐠 the fish in the fish tank; a game of darts 🎯 for two, or
  darts practice 🎯, at the oche before a real dartboard (round, its
  twenty segments black and cream, red and green doubles and trebles, a
  green outer bull and a red bull), thrown with `throw`, a dart in hand.
- **In the gym** beside the aisle, every piece of fitness equipment
  together on one mat: yoga 🧘 and skipping 🏃 on the mat, kettlebell
  swings 🏋, catching the breath 💦 on the weight bench, and jogging on the
  treadmill 🏃; sun salutations 🌅, meditation 🕉 or partner stretches 🤸 on
  the yoga mats; the exercise bike 🚴 (`pedal`) and the rowing machine 🚣
  (`row`), their riders facing the front; the punchbag 🥊 (`punch`); and
  dumbbell curls 💪, alone or with a spotter 🏋 (`lift`, a dumbbell in
  hand), at the weights rack.
- **Round the Floor**: collecting printouts 📄 or unjamming the printer 🖨
  by the aisle, doodling on the whiteboard ✏, reading the wall board 📌
  and browsing the bookshelf 📚.
- **In the games hall** across the Floor's front: shooting hoops 🏀 or a
  game of horse 🏀 for two at the basketball hoop on the left wall
  (`shoot`); putting practice ⛳ on the putting green (`putt`, a putter in
  hand); then the table games side by side: pool 🎱 for two, or trick
  shots, at the pool table (`pool`, a cue in hand); table tennis 🏓 (two
  playing each other, one each end, swinging bats with `swing`, the ball
  flying between them and bouncing on the far half); foosball ⚽ for two,
  or foosball doubles for four, at the foosball table (`foosball`); chess
  ♟ or a card game 🃏 for two, or a jigsaw 🧩, at the chess table; a
  console game for two 🎮, the match together 📺, a film 🍿, a book 📗, the
  guitar 🎸 or a nap (zzz, after a long idle) on the bean bags before their
  television; the piano 🎹, alone or as a duet 🎶; and at the far end a
  snack from the vending machine 🍫 and the arcade machine 🕹.

The Floor always reaches far enough forward for the gym and the games
hall, for any team: the hall starts in front of the gym and the theme's
zone, or in front of the desks once a large team's rows reach further,
and its places are measured from its walkway
(`idlePlaceOn`). Seated activities (the chair, the sofa, the café table,
the weight bench, the chess table, the bean bags, the piano, the
exercise bike and the rowing machine) are listed in `seatedLocations`,
and the treadmill, stepped up onto, in `mountedLocations`; an
`IdlePlace` with `via` points is walked to through them, square on to a
seat or round a table to its far side.

- **Games for two or more** (`together`): table tennis, darts, foosball
  (and doubles for four), pool, chess, cards, the console game, the match
  together, horse, the piano duet, lifting with a spotter and partner
  stretches. An Agent chooses one only while enough others are free to
  play (idle, and idle for at least `settleSeconds` since their work or
  joining the Floor); they set off together, each to its own place, wait
  for each other there and begin together, playing out of step (each
  place's `phase`) so they take turns. When one is called away, the game
  is called off for the rest, who head back from wherever they are.
- **Every Agent starts seated.** As a Floor loads, or an Agent joins it,
  each Avatar is made already posed in its look's animation (sitting
  back, typing or waiting), so none is ever seen standing at its desk;
  each rests in its chair before its first activity. Walks are only for
  what happens once the Floor is shown: events the stream brings back on a
  return to a Floor, missed while the Owner was elsewhere (a Handoff, a
  Kickoff, a Contractor arriving), are left out (`useFloorTeam`, with 15 s
  allowed for the clocks), and a Grilling Session found running as the
  Floor's sessions load has everyone already seated at the table.

- **Activities are data**: one entry each in `idleActivities` (where, which
  animation, how long, how likely, how many at once, and an optional
  bubble such as "zzz"), so a new one is one more entry.
- **Each spot has an occupancy limit**: an activity is only on offer while
  fewer Agents than its limit are at its spot, whatever they are doing
  there, and each Agent there has a place of its own (`idlePlaces`). An
  Agent turned away rests again.
- **The trip** is a Handoff walk's (stand up, off the chair to its walkway,
  along the waypoints, at 1.25 m/s) to the spot's waypoint and on to its
  place, and back the same way. A doze happens in the chair, a stretch a
  step aside from it.
- **A new task interrupts any activity at once.** An Agent is idle only
  while it sits back with no tickets on its desk, no marker over its head,
  no Handoff to walk and no meeting to go to; the moment its look changes,
  or a Kickoff or Wrap-up gathers it, it is back in its chair, whatever it
  was doing and wherever it was, with no walk back (a meeting then walks
  it from there).
  Idling is only the scene's: the pipeline never waits for it.
- **The bubbles** ("zzz", "🏓") are HTML over the canvas, like a ticket's
  number, and hidden from assistive technology.
- **With reduced motion** no one idles about: every Agent stays in its
  chair.

### Ambient sound and music

The Office can play ambient office sound and music (PRD FR-64). It is
optional and **muted by default**: nothing plays, and no audio is even set
up, until the Owner clears **Mute office sound** in **Scene settings**.
Like the other scene settings, the sound settings belong to the browser
they were set in, and are kept in its local storage.

- **Volumes:** **Ambience volume** and **Music volume**, each 0 to 100%.
- **Per-Floor ambience:** on a Floor, **This Floor's ambience** chooses
  its sound: open plan (the default), quiet, café or server room. The
  lobby has its own. The lift takes the ambience with it, easing from one
  place's to the next.

  | Ambience | Room tone | Hum | Voices | Keys a second, all at work |
  | --- | --- | --- | --- | --- |
  | Open plan | 0.5 | 0.3 | 0.2 | 6 |
  | Quiet | 0.35 | 0.15 | — | 2 |
  | Café | 0.4 | 0.1 | 0.5 | 3 |
  | Server room | 0.3 | 0.8 | — | 4 |
  | Lobby | 0.45 | 0.15 | 0.3 | — |

- **What plays** (`scene/sound-settings.ts` says what, as data;
  `scene/sound-player.ts` plays it): a room's tone, an air conditioning
  hum and far-off voices, shaped from noise; keyboard clicks at random, as
  often as the Floor's Agents are typing; and, under them, music: a slow
  progression of soft chords (Cmaj7, Am7, Fmaj7, G6, 8 s each). It is all
  synthesised in the browser with the Web Audio API, so there are no
  sound files and no third-party recordings to license
  ([`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md) says so).
- **Browsers** play sound only once the page has had a click or a key
  press: sound unmuted in an earlier visit starts at the Owner's first
  click or key. Muted again, it fades out and the audio rests.

The Notice sound of browser notifications is separate, in General Settings'
**Browser notifications** card.

### Agent cards and flying to an Agent

Clicking an Agent where it sits in the Office (or picking it in
**Inspect**) flies the camera to it and opens its card (PRD FR-63;
`scene/agent-card.tsx`), kept live by its Floor's events:

- **Who it is:** its name, Role, AI Provider and Model (with "(default)"
  when it uses its AI Provider's default).
- **Current issue:** the issue it is working, or else the oldest waiting
  for it, from the Floor's wall board (`GET
  /api/floors/:floorId/wall-board`), with its stage, whether it is being
  worked, and its issue and pull request on GitHub. A review round's issue
  is each of its reviewers'.
- **Tokens against caps:** today's and this month's, against the cap in
  force for it, coloured as the Office colours tokens (FR-62): neutral
  below 80%, amber from 80%, red at 100%.
- **Its monitor:** **Open Ada's monitor** flies on to its desk monitor and
  opens its live view there.
- **Its config:** **Open Ada's config** opens Floor Settings with its
  Agent editor open (`/floor-settings/<floor>?agent=<agent>`).
- **Its Avatar Editor:** **Open Ada's Avatar Editor** shows the editor in
  the card's place; **Back to Ada's card** returns.
- **A Contractor** is marked as one on its card, with its one-off Role's
  name and description where it has one, and the Batch it is there for.
  **Keep on the team** (also on Floor Settings' Agents card) keeps it:
  it becomes an ordinary Agent that never leaves on its own, and its
  one-off Role joins the library
  ([Contractors](floors-and-agents.md#contractors)). The button is not
  offered while it is already leaving.
- **Its chat:** **Chat with Ada**, first on the card, opens a chat with
  the Agent in the card's place; **Back to Ada's card** returns. In the
  card, what can be typed in the Manager chat folds under **What you can
  type**, and the Skills list for `/` is shorter and wraps, so the box
  always fits. The
  Manager's is the [Manager chat](events-and-chat.md#the-manager-chat),
  with its commands, and works as Claude Code does
  ([how](events-and-chat.md#a-read-only-session-as-claude-code-is)): its
  header chooses the Manager's Model and effort; each reply's tools fold
  under "Used 3 tools"; a task list of the work its requests spun off
  (folded at first in the card) opens each Agent's live view; the clip,
  pasting or dropping attaches images and text files, shown as chips
  before sending; `@` lists the repository's files to mention, as `/`
  lists Skills; and **Send** reads **Interrupt and send** while the
  Manager writes. Any other Agent's is its
  [direct chat](events-and-chat.md#direct-chats-and-the-terminal). Each
  Agent's chat also has its own page,
  `/floors/<floor>/agents/<agent>/chat`, which the 2D Office's **Chat**
  opens.

**Every Agent's name flies to it.** Anywhere in the 2D UI (the Notice
Board, the Activity Feed, the request history, Analytics, the Floor
admin's Agents table and Token Caps, the live view's and the Manager
chat's headings) an Agent's name links to `/?floor=<floor>&inspect=agent:<agent>`:
the Office rides the lift to its Floor, flies the camera to the Agent and
opens its card (§5 scenario 2). In the Office's own panels, such as the
wall board, a name flies there at once.

### Screenshot tests of the 3D scenes

PRD §9's screenshot tests draw 3D scenes at fixed seeds in headless
Chromium with no GPU, and compare them with the screenshots kept beside
the spec. They cover a Floor in each 3D theme
(`e2e/scenes/floor-themes.spec.ts`): each added from the built-in
template the theme is first for, with that template's starting team, so
each desk is dressed as its Role is, drawn at Medium. Each is taken twice:
from the default overview, as the Owner first sees the Floor, and close
up on the theme along its left wall, in front of the lounge, where each prop is enough of the
picture to count.

- **The fixture page**, `apps/web/scene-fixtures.html`
  (`src/scene/scene-fixture.tsx`), is the scene alone: no server, no
  database, no sign-in. It reads the template's `template.yaml` and Role
  files from `templates/` with the shared parsers, seeds each Avatar from
  its Agent's id, turns no monitor on, and holds the Agents and the
  camera still with reduced motion, so a template draws the same picture
  every time. `?template=online-store&quality=medium&view=theme` picks
  what it draws (`view` is the overview unless it is `theme`); it marks
  its body `data-ready` once the models have loaded and it has drawn. It is served by Vite for the tests and never built into
  the app.
- **`pnpm scenes`** runs them (`e2e/playwright.scenes.config.ts`, its
  `chromium` project; `--project=chromium` runs them alone, without the
  3D Office's key scenes, the `key-scenes` project, described in
  [Scene screenshot tests](../../README.md#scene-screenshot-tests)):
  Chromium is forced onto SwiftShader whatever the machine has, as CI
  draws it, and a screenshot may differ from its baseline in at most
  0.2% of its pixels, a pixel counting as changed at a small difference
  of colour (`threshold` 0.1: birch parcels on an oak floor are close).
  CI's end-to-end job runs them in a step of their own after the
  end-to-end tests, even when one of those failed. They need Chromium
  (`pnpm --filter @ai-office/e2e exec playwright install chromium`), and
  no Docker.
- **After a change to how a scene looks**, take them again with `pnpm
  scenes --update-snapshots=all`, look at each one, and commit them with
  the change. A screenshot taken on another platform than Linux gets its
  own file, never compared with CI's.

How a theme looks to the eye, and the frame rate on real hardware, are
checked on the host: the screenshots hold a scene to how it was, not to
how good it is.

### Phones and tablets

The Office is fully usable on a tablet, and phones get it in 2D (PRD §7;
3D on phones is a non-goal).

- **A phone gets the Office in 2D** (`office-2d.tsx`), never the canvas,
  and three.js is not loaded. A phone's screen is one under 600 CSS pixels
  wide, or, on its side, under 480 high with a finger for a pointer
  (`phoneQuery` in `phone-view.ts`). A desktop window that narrow gets the
  2D view too. The view follows the screen as it turns or is resized. One
  page, with a list at the top that brings each section into view:
  - **Notice Board**: every open Notice, with its links, its actions and
    **Dismiss**, as on the Notice Board's own page.
  - **Activity**: the latest 10 events of the Activity Feed, newest
    first, with new ones streaming in at the top.
  - **Floors**: each Floor's health, as its wall board says, with links to
    its Notices, its Manager chat and its settings. Under it, its Agents,
    each with its Role, AI Provider and Model, and its state in words as
    the Office shows it at its desk ("Working · 2 tasks wait", "Waiting on
    review", "Idle · paused at a Token Cap"). Each also shows the issue it
    is on, and links to its live view and its config. Last come the
    Floor's issues in progress, with their stages, pull requests and
    rounds.
  - **General Settings**: Admin, each Floor's settings, the request history and
    Analytics.

  It is kept live on one stream of events for the Notices and the Floors,
  and one for the activity. An Agent's name links to
  `/?floor=…&inspect=agent:…` everywhere. On a phone that brings the
  Agent's entry into view and focuses it. A monitor does the same, a
  Floor's other objects bring the Floor into view, and the lobby's Notice
  Board brings the Notice Board.
- **A tablet gets the 3D Office**, with the camera by touch
  (`scene/touch-camera.ts`, `scene/camera-gestures.ts`):
  - one finger drags the camera around what it looks at (the screen's
    height is half a turn), from straight down to 80° from it;
  - two fingers pinch it closer or further (1 m to 60 m) and slide it
    across the Floor, keeping its height and angle.

  The camera rests where the fingers leave it, so closing a panel flies
  back there; a view from the picker flies on from there. A touch that
  moves less than 8 px is a tap, which opens what is under it; a drag is
  never a tap. Only fingers count, so a mouse and a pen work as before,
  and the lift's ride is left alone. The canvas takes the touches, so the
  page does not scroll or zoom under them.
- **Panels fit the view.** Where the Office's view is too narrow for an
  open object's panel beside the controls (under 39rem, as on a tablet
  held upright), the panel lies across the view, scrolling, over the
  controls, until it is closed. There it neither moves, resizes nor fills
  the screen, and a layout kept for a wider view waits for one.
- **A fingertip's size.** On a touch screen (a coarse pointer), every
  button, field, select and navigation link is at least 44 px high, and
  every button 44 px wide.
- **Nothing scrolls sideways** on a phone: the Office, the Notice Board,
  the Activity Feed, AI Settings, Admin, Floor Settings, the request history and
  Analytics fit its width; wide tables scroll within their cards.
