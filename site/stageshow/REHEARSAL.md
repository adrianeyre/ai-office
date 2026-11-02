# Rehearsal: the website's demos

Filmed with the Stageshow skill's `scripts/film.mjs` (headless Chrome, a
scratch copy of the skill, never in this repository) against `pnpm site:dev`
and the built page (`pnpm site:preview`), beside stills of the gold examples.

## Hero, `demos/hero.tsx` (loop, about 14s)

Gold: `hero-demo` (pinned window in a well, a terminal coming forward), with
`subscriptions`' value changing on its own row. Changed: a system story with
no cursor; the app's Floor issue list; Ada's live view as the terminal.
Beats: issue arrives … `needs-work`, live view runs four lines … `needs-review`
… `needs-qa` … Merged and a Notice (payoff, held 2.6s); the merged issue
leaving the queue is the reset. Poster: Merged with the Notice.
Captured: 1440 and 390, light; posters light and dark at 1440 and 390.
Film: `--gate` passed at both widths. Fixed on the way: the Notice covered
the payoff (moved over filler rows), the compact window was taller than wide
(stage shortened), the live view landed on a transform (layer kept).

## AI Gateway, `demos/gateway.tsx` (once, about 9s)

Gold: `subscriptions` (window, satellite over its sidebar, rows opening at
the top). Beats: Work … Pro … Work passes 90% and pauses … Personal serves
the next call (payoff, held). Poster: the payoff.
Film: gate passes on the poster after the satellite was made to bleed past a
filler account (it floated with uneven gutters) and filler bars were spaced.

## Manager chat, `demos/chat.tsx` (once, about 11s)

Gold: `ai-chat`, with `ai-cards`' card answered from its own button.
Beats: typed and sent … Thinking … reply streams … Plan … Approve pressed
(payoff). Fixed: the cursor covered the button's label; the earlier turn
was cut by the thread's edge (it now fades first); the tick sat on a half
pixel. Stands: `uneven inset` on the kit's centred title bar, which the gold
`ai-chat` is flagged for too.

## Floor Templates, `demos/templates.tsx` (still)

Gold: `many-of-one`. The template icons are the app's own (Lucide, as each
`templates/*/template.yaml` names). Fixed: the Roles row now sits at each
card's foot. On the built page film reports `kit override` for the kit's own
phone rules (the bundler merges the kit's CSS with the page's); no demo
draws a phone, and in dev the line does not appear.

## Bento, `demos/bento.tsx` (one beat each, once)

Gold: `bento`. Six tiles: Notices (hero UI, the grid's only window), the
12 AI Providers stat, Token Caps, the local-models statement, Merge Policy,
Connections (collection), plus the sandbox statement. Fixed: the Notices
window's gutter (top and left now one gutter), the narrow notice's action
(under its words), cards and marks a gutter from the foot, type tiles
without a void on phones.

## Second pass (review of the built page)

- No plates: the hero, Gateway and chat windows sit on the page's own
  ground, a full gutter in from the stage's top and sides, running off its
  foot inside a fading mask (the `fade-crop` gold's wrapper), so they fill
  their column with no hard cut. The Gateway's card straddles the page's
  left edge, whole.
- The Notice tile's poster is one state: the Notice reads merged when its
  button does (both cross-fade together).
- The stat's number is sized to its tile, so the tile has no empty band;
  the local-models statement carries one line of detail and the row's
  tiles are as tall as their content.
- Gate on posters at 1440 and 390: hero and Gateway (wide) pass but for
  the bundled-CSS `kit override` lines above. Stand: the compact Gateway
  and chat windows show narrower than tall (a phone column holds a list
  and a thread, not a desktop window's proportions); the hero's filler
  rows run past its padding (they run off into the fade on purpose); the
  chat's centred title bar (`uneven inset`, as the gold).

Not checked: a separate fresh-eye reviewer (`review.md`) was not run; touch
on a real phone; Safari and Firefox; a pause, offscreen return or reduced
motion toggled mid-play; every look but light and dark.
