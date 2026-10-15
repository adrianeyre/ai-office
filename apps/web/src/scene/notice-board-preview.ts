import type { Notice, NoticeKind } from "@ai-office/shared";
import type { PaletteToken } from "@ai-office/shared/palette";

// What the lobby's 3D Notice Board shows (PRD FR-50, FR-57): a stylised
// preview of the latest Notices, as cards pinned to the board. The scene
// renders no text (PRD §7), so a card's title becomes a few lines of
// "writing", as long as the title is long; the kind is told apart by
// colour and by shape (an action card has two pins, an info card one).
// The words are on the 2D Notice Board, which the lobby links to.

/** The board, in metres (docs/reference/art-direction.md, Agents and rooms). */
export const boardSize = { width: 1.6, height: 0.9 } as const;

/** Cards are pinned in a grid of this many columns and rows. */
export const boardGrid = { columns: 3, rows: 2 } as const;

/** The most cards shown; Notices beyond them are a stack of sheets. */
export const maxCards = boardGrid.columns * boardGrid.rows;

/** The most sheets the stack shows, however many Notices are hidden. */
export const maxStackedSheets = 3;

/** A card's size: a postcard on a 1.6 m board, in metres. */
export const cardSize = { width: 0.42, height: 0.3 } as const;

/** How many characters of a title one line of "writing" stands for. */
export const charactersPerLine = 28;

/** The most lines of "writing" on a card. */
export const maxLines = 3;

/** The most a card is turned on the board, either way, in radians. */
export const maxTilt = (3 * Math.PI) / 180;

const columnSpacing = 0.5;
const rowSpacing = 0.38;

/** The colour of each kind of Notice (docs/reference/art-direction.md). */
export const kindTokens: Readonly<Record<NoticeKind, PaletteToken>> = {
  action: "state-critical",
  info: "state-info",
};

export interface BoardCard {
  /** The Notice's id. */
  readonly id: string;
  readonly kind: NoticeKind;
  /** Its stripe and its pins. */
  readonly token: PaletteToken;
  readonly column: number;
  readonly row: number;
  /** Its centre on the board, in metres from the board's centre: x right, y up. */
  readonly position: readonly [number, number];
  /** Turned about the board's normal, in radians. */
  readonly tilt: number;
  /** Where its pins are, in metres from the card's centre. */
  readonly pins: readonly (readonly [number, number])[];
  /** Each line of "writing", as a share of the card's writing width. */
  readonly lines: readonly number[];
}

export interface BoardPreview {
  /** The latest Notices, newest first, in reading order on the board. */
  readonly cards: readonly BoardCard[];
  /** How many open Notices are not shown as cards. */
  readonly hidden: number;
  /** How many sheets are stacked behind the last card for them. */
  readonly stackedSheets: number;
  /** Every open Notice, by kind. */
  readonly counts: Readonly<Record<NoticeKind, number>>;
  /** What the board shows, in words, for the HTML beside the scene. */
  readonly summary: string;
}

/** A small, stable hash of a string, from 0 to 1 (FNV-1a). */
export function unitHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * A title as lines of "writing": a full line for each `charactersPerLine`
 * characters, then what is left, at most `maxLines`. A title too long for
 * them fills them all.
 */
export function writingLines(title: string): number[] {
  const length = Math.max(1, title.trim().length);
  const full = Math.floor(length / charactersPerLine);
  const rest = (length % charactersPerLine) / charactersPerLine;
  const lines = [
    ...Array<number>(Math.min(full, maxLines)).fill(1),
    ...(rest > 0 ? [rest] : []),
  ].slice(0, maxLines);
  // A very short last line still reads as a word, not a dot.
  return lines.map((line) => Math.max(line, 0.2));
}

function cardPosition(column: number, row: number): [number, number] {
  const x = (column - (boardGrid.columns - 1) / 2) * columnSpacing;
  const y = ((boardGrid.rows - 1) / 2 - row) * rowSpacing;
  return [x, y];
}

const pinHeight = cardSize.height / 2 - 0.035;
const pinsByKind: Readonly<
  Record<NoticeKind, readonly (readonly [number, number])[]>
> = {
  action: [
    [-cardSize.width / 2 + 0.05, pinHeight],
    [cardSize.width / 2 - 0.05, pinHeight],
  ],
  info: [[0, pinHeight]],
};

const newestFirst = (a: Notice, b: Notice) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

const plural = (count: number, one: string) =>
  `${String(count)} ${one}${count === 1 ? "" : "s"}`;

function summarise(
  counts: Readonly<Record<NoticeKind, number>>,
  shown: number,
): string {
  const total = counts.action + counts.info;
  if (total === 0) {
    return "The Notice Board is empty: nothing needs you right now.";
  }
  const kinds = [
    ...(counts.action > 0 ? [plural(counts.action, "action Notice")] : []),
    ...(counts.info > 0 ? [plural(counts.info, "info Notice")] : []),
  ].join(" and ");
  return shown < total
    ? `The Notice Board has ${kinds}; the latest ${String(shown)} are pinned up.`
    : `The Notice Board has ${kinds}.`;
}

/**
 * The board's preview of the open Notices: the latest `maxCards` as cards,
 * newest first, filling the grid row by row from the top left, and the
 * rest as a stack. Each card's tilt comes from its Notice's id, so a card
 * keeps its look as others come and go.
 */
export function boardPreview(notices: readonly Notice[]): BoardPreview {
  const open = notices
    .filter(
      ({ dismissedAt, actedAt }) => dismissedAt === null && actedAt === null,
    )
    .toSorted(newestFirst);
  const shown = open.slice(0, maxCards);
  const hidden = open.length - shown.length;
  const counts = {
    action: open.filter(({ kind }) => kind === "action").length,
    info: open.filter(({ kind }) => kind === "info").length,
  };
  return {
    cards: shown.map((notice, index) => {
      const column = index % boardGrid.columns;
      const row = Math.floor(index / boardGrid.columns);
      return {
        id: notice.id,
        kind: notice.kind,
        token: kindTokens[notice.kind],
        column,
        row,
        position: cardPosition(column, row),
        tilt: (unitHash(notice.id) * 2 - 1) * maxTilt,
        pins: pinsByKind[notice.kind],
        lines: writingLines(notice.title),
      };
    }),
    hidden,
    stackedSheets: Math.min(hidden, maxStackedSheets),
    counts,
    summary: summarise(counts, shown.length),
  };
}
