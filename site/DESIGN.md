---
name: AI Office
description: The project website as the Floor's planning wall, with every word pinned to it on card stock, tape or a screen.
colors:
  felt: "#24494d"
  felt-deep: "#1a3739"
  felt-high: "#2d585c"
  paper: "#fbf8f2"
  paper-2: "#f4eee3"
  paper-3: "#e9e1d2"
  rule-red: "#d98a76"
  rule-blue: "#cddcea"
  tape: "rgb(238 222 170 / 94%)"
  sticky-yellow: "#f6e58d"
  sticky-blue: "#c9e1ec"
  ink: "#23272c"
  ink-2: "#474e56"
  ink-3: "#626a72"
  stage-work: "#2f6fc4"
  stage-review: "#7a4fc4"
  stage-qa: "#137576"
  stage-docs: "#b04a78"
  stage-ok: "#2b8150"
  stage-neutral: "#8b9096"
  pin: "#d03b3b"
  link: "#255da8"
  on-stage: "#fdfbf7"
  screen: "#2a3037"
  screen-2: "#343b44"
  screen-text: "#ece7dd"
  screen-dim: "#a5aeb8"
  screen-glow: "#9fd3ff"
typography:
  display:
    fontFamily: "Archivo, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.3rem, 1.5rem + 2.2vw, 3.4rem)"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Archivo, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.6rem, 1.1rem + 1.6vw, 2.35rem)"
    fontWeight: 900
    lineHeight: 1.08
  title:
    fontFamily: "Archivo, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  marker:
    fontFamily: "Kalam, Segoe Print, Bradley Hand, cursive"
    fontSize: "clamp(1.75rem, 1.2rem + 1.9vw, 2.6rem)"
    fontWeight: 700
    lineHeight: 1.15
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: '"cv11", "ss01"'
  lead:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.03rem, 1rem + 0.2vw, 1.12rem)"
    fontWeight: 400
    lineHeight: 1.58
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  paper: "2px"
  card: "3px"
  mount: "4px"
  stamp: "6px"
  chip: "999px"
spacing:
  gutter: "clamp(16px, 4vw, 48px)"
  container: "1320px"
  card-gap: "18px"
  card-pad: "clamp(26px, 3vw, 38px)"
  section: "clamp(64px, 8vw, 120px)"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.card}"
    padding: "0.6em 1.15em"
    height: "44px"
  button-primary-large:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.card}"
    padding: "0.75em 1.4em"
    height: "52px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "0.6em 1.15em"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-2}"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad}"
  index-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "26px 22px 22px"
  tape-label:
    backgroundColor: "{colors.tape}"
    textColor: "{colors.ink}"
    typography: "{typography.marker}"
    padding: "0.18em 0.75em 0.12em"
  stage-chip:
    backgroundColor: "{colors.stage-work}"
    textColor: "{colors.on-stage}"
    rounded: "{rounded.chip}"
    padding: "0.28em 0.75em"
  screen:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.screen-text}"
    typography: "{typography.label}"
    rounded: "{rounded.card}"
    padding: "16px 18px"
  nav-strip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    height: "64px"
---

# Design System: AI Office

## Overview

**Creative North Star: "The Planning Wall"**

The site is the Floor's planning wall: a full-bleed ground of deep teal acoustic felt, and everything a visitor reads is pinned to it. Card stock carries the copy, masking tape carries the labels in marker, monitors carry the commands, taped prints carry the screenshots, and a rubber stamp marks what has merged. The felt itself never carries a word. Colour comes from the 3D Office's own palette: ink and paper for nearly everything, the felt taken from the chairs' teal, and the four Stage colours kept for what means a Stage.

The wall is calm and handmade but exact. Cards sit at small, varied tilts (between about -1.2deg and 0.8deg), take a push pin or a strip of tape, and cast a felt-tinted shadow; nothing is glossy, gradient-filled or glowing. One card format repeats like an edition: the index card with its red header rule, where only the sticker, the stamp and the column change. Density is generous on the felt and tight on the cards, the way a real board is read: sweep across, then lean in.

Dark mode dims the room's lights rather than inverting the wall. The felt goes deeper, the paper goes a shade warmer and greyer, shadows turn neutral and heavier; ink stays ink and text never goes light-on-dark except on a screen.

**Key Characteristics:**

- Full-bleed felt ground with a static fibre-noise texture and a soft overhead light.
- Every word sits on a pinned material: card, tape, sticky note, print or screen.
- Ink buttons and ink text; colour is reserved for Stages and states.
- Small hand-placed tilts, push pins and tape corners; felt-tinted shadows.
- Three voices: Archivo for print, Kalam marker for tape, Inter for reading, plus JetBrains Mono on screens.
- Motion is physical: cards lift, travel and settle; stamps thunk once.

## Colors

A muted, warm-paper palette on deep teal felt, with saturated colour held back for the Stages and states.

### Primary

- **Card-Stock Ink** (ink): every heading, body line and the primary button's fill. The page's primary action is ink on paper, not a brand hue.
- **Chair-Teal Felt** (felt, with felt-deep and felt-high): the wall itself, behind everything. felt-high and felt-deep only drive the scrollbar and the felt's tonal variation.

### Secondary

- **The Stage Colours** (stage-work blue, stage-review violet, stage-qa teal, stage-docs magenta): dot stickers, Stage chips, Agent avatars and the Stage rail under the header. Each appears only where it names that Stage, set through a `data-stage` attribute that resolves to `--stage-colour`.
- **Merged Green** (stage-ok): the rubber stamp, ticked checkboxes and ready-to-merge. stage-neutral is the fallback dot.

### Tertiary

- **Masking Tape** (tape): every marker-written label: section headings, Stage column heads, captions, the wall toggle. Also the text selection colour.
- **Pin Red** (pin): push-pin heads only.
- **Index Rules** (rule-red, rule-blue): the index card's header rule and dialog head rule; rule-blue for faint card lines.
- **Sticky Notes** (sticky-yellow, sticky-blue): sticky-yellow is the focus halo; sticky-blue fills status boxes.

### Neutral

- **Card Stock** (paper, paper-2, paper-3): paper is every card's face; paper-2 is hover fills, the Stage rail and the mount behind screenshots; paper-3 is inline code and small wells.
- **Ink Strengths** (ink-2, ink-3): ink-2 for leads, supporting copy and secondary meta; ink-3 for the quietest notes only.
- **Monitor** (screen, screen-2, screen-text, screen-dim, screen-glow): the palette's `screen-off`, lit. Code blocks and the install command; screen-2 is a code block's title band, screen-glow the prompt and selection.
- **Link Blue** (link): inline links on card stock.

### Named Rules

**The Text-On-Card Rule.** No copy sits directly on the felt. If something must be read, it is on paper, tape or a screen.

**The Stage Colour Rule.** A Stage colour appears only where it means that Stage or state, and never as decoration or as a brand accent. Colour never carries meaning alone: every dot or chip sits beside its Stage label.

**The Dimmed Lights Rule.** Dark mode lowers the room's light: felt deepens to #173235, paper drops to #ebe5d9, shadows go neutral. Ink is unchanged; the wall is never inverted.

## Typography

**Display Font:** Archivo (with Inter, system sans)
**Body Font:** Inter (with system sans)
**Marker Font:** Kalam 700 (with Segoe Print, Bradley Hand, cursive)
**Mono Font:** JetBrains Mono (with ui-monospace, Menlo, Consolas)

**Character:** Archivo at 800 to 900 is the wall's printed voice: tight, heavy, poster-like. Kalam is the felt-tip marker written on tape. Inter does the reading. Each face lives on its own material.

### Hierarchy

- **Display** (Archivo 900, clamp 2.3rem to 3.4rem, line-height 1, -0.025em): the hero card's headline. The closing ticket's headline runs the same voice larger (up to 4rem, -0.03em).
- **Headline** (Archivo 900, clamp 1.6rem to 2.35rem, 1.08): statements on sticky notes. Feature headings use Archivo at clamp 1.4rem to 1.9rem.
- **Title** (Archivo 800, 1.3rem, 1.2, -0.01em): every h3; card titles, doc links and table heads use Archivo 700 to 800 at 0.86 to 1.2rem.
- **Marker** (Kalam 700, clamp 1.75rem to 2.6rem, 1.15): section headings on tape, rotated -1.2deg. Smaller marker (0.84 to 1.3rem) for Stage column heads, captions, step marks and footer headings.
- **Body** (Inter 400, 1rem, 1.6, features cv11 and ss01): all running copy; leads at up to 1.12rem in ink-2, capped at about 34em.
- **Label** (JetBrains Mono, 0.78 to 0.85rem, 1.75): commands on screens, issue numbers (tabular), Stage chips and inline code.

### Named Rules

**The One Material, One Voice Rule.** Archivo is printed on card, Kalam is written on tape, Mono is shown on a screen. Marker never sets body copy, and Archivo never appears on tape.

## Layout

A single centred container (max 1320px) with a fluid gutter of clamp(16px, 4vw, 48px). Sections open with clamp(64px, 8vw, 120px) of felt above them, and each begins with a tape heading stuck across its intro card. Within sections, content is set as grids of pinned things: the hero splits 5.6 to 6.4 between the hero card and the live wall; the pipeline is five index cards in a row (alternate cards dropped 14px); features alternate card and mounted screen; the "rest" is a 12-column board of notes; screenshots are a gallery of prints.

The header is a sticky paper strip (64px) with the Stage rail beneath it: five Stage-coloured segments that fill as the reader scrolls, so the page reads as one issue's journey.

Breakpoints are 64rem (multi-column grids collapse to one or two columns, text cards cap at 680 to 760px), 52rem (the nav becomes a paper dropdown), and 36rem (phone: some tilts are removed, stamps shrink). At narrow widths the hero wall turns its five Stage columns into five rows, with a column's cards side by side.

## Elevation & Depth

Depth is physical: things are pinned to felt, so they cast shadows tinted by the felt (rgb 8 24 26), never grey. Three levels cover the whole page, plus small bespoke shadows for pins and tape. Depth changes only with physical state: a card lifted off the wall grows its shadow; a pressed button sinks.

### Shadow Vocabulary

- **Flat** (`0 1px 1px rgb(8 24 26 / 22%), 0 3px 8px -2px rgb(8 24 26 / 30%)`): small things lying close to the wall.
- **Pinned** (`0 1px 1px rgb(8 24 26 / 24%), 0 10px 22px -8px rgb(8 24 26 / 55%)`): the default for every card, print, note and mount.
- **Lifted** (`0 2px 3px rgb(8 24 26 / 20%), 0 24px 40px -14px rgb(8 24 26 / 65%)`): a card in the hand: wall cards mid-travel, dialogs, the mobile nav.
- **Tape** (`0 1px 1px rgb(8 24 26 / 18%), inset 0 0 0 1px` tape-edge): tape lies almost flat.

### Named Rules

**The Felt-Tinted Shadow Rule.** Shadows are soft, offset downward, and tinted by the felt. In dark mode they turn neutral black and heavier, as the room's light drops.

## Shapes

Paper corners: barely rounded (3px on cards and buttons, 2px on wall tickets and prints, 4px on mounts and dialogs). Rounding beyond that is reserved for things that are round in life: push pins, dot stickers and Agent avatars are circles; Stage chips are full pills; the stamp has a 6px inked border. Shapes are tilted rather than curved: each pinned element carries its own small rotation, set per instance so neighbours never match. Index cards carry a 1.5px rule-red line across their header. Tape is a straight strip with no radius.

## Components

### Buttons

Ink-heavy and tactile, like a printed tab.

- **Shape:** paper corners (3px), 2px ink border, min-height 44px (38px small, 52px large).
- **Primary:** ink fill, paper text, Archivo 700 at 1rem, small felt shadow.
- **Hover / Focus:** rises 1px with a deeper shadow; pressed sinks 1px. Focus everywhere is a 3px ink outline with a 6px sticky-yellow halo.
- **Secondary:** transparent with the ink border and ink text; hover fills paper-2.

### Chips

- **Stage chip:** a full pill in the Stage's colour with on-stage text, mono at 0.84rem, weight 600. Used for Stage labels named in code.
- **Notice kind:** a paper-3 pill with mono 0.74rem.

### Cards / Containers

- **Corner Style:** 3px (2px for wall tickets and prints).
- **Background:** paper.
- **Shadow Strategy:** Pinned at rest, Lifted when carried or opened.
- **Border:** none; an index card has its rule-red header line instead.
- **Internal Padding:** clamp(26px, 3vw, 38px) for text cards; 26px 22px 22px for index cards.
- **Fixings:** one push pin top centre, two at the corners for a wide card, or tape across the top for prints and two taped corners for a mounted screen.

### Navigation

A sticky paper strip: logo left, Inter links at 0.95rem weight 560 in ink, hover fills paper-2 with a 2px underline, and the primary action is a small ink button. Below 52rem it collapses behind a menu button into a paper dropdown with the Lifted shadow and 48px rows.

### Screens

Commands and code are shown on a monitor: screen background, screen-text, JetBrains Mono at 0.85rem, an inset top glow, and with a copy button a 36px screen-2 title band holding a 30px copy control.

### The Planning Wall (signature)

The hero's live demonstration. Five Stage columns under tape heads with dot stickers; tickets are index cards with an issue number, a three-line title and an Agent avatar in the Stage colour. Cards travel between columns over 900ms on cubic-bezier(0.22, 1, 0.36, 1), lifting to the Lifted shadow mid-travel and settling back to Pinned. A merged ticket takes a MERGED stamp (240ms scale-down thunk, uneven ink mask, multiply blend), then a Notice slip appears under the wall. Under reduced motion the wall is still, and a tape button pauses it.

### The Stamp

A rubber-stamp impression in stage-ok: 3px border, Archivo 900 uppercase, 0.08em tracking, rotated about -11deg, with a noise mask for uneven ink. It marks merged work only.

## Do's and Don'ts

### Do:

- **Do** put every word on a pinned material (card, tape, sticky note, print or screen), never on the felt.
- **Do** reuse the index-card format as an edition: change only the sticker, stamp or column, not the card.
- **Do** give each pinned element its own small tilt (within about -1.2deg to 0.8deg) and a fixing: a pin, tape or taped corners.
- **Do** use the Pinned shadow at rest and the Lifted shadow only for a card in the hand.
- **Do** keep the primary action in ink on paper; let Stage colours mean Stages.
- **Do** write labels in Kalam on tape, and set headlines in Archivo 800 to 900.
- **Do** honour reduced motion with a still wall, and pair every Stage colour with its label.

### Don't:

- **Don't** set copy directly on the felt.
- **Don't** use a Stage colour as decoration, a brand accent or a button fill.
- **Don't** use grey or black drop shadows in light mode; shadows are felt-tinted.
- **Don't** round cards past paper corners (4px); only pins, dots, avatars and chips are round.
- **Don't** invert the wall for dark mode; dim the felt and the paper, and keep ink as ink.
- **Don't** use the stamp for anything but merged work.
