import type {
  GrillingQuestionStatus,
  GrillingSession,
} from "@ai-office/shared";
import type { PaletteToken } from "@ai-office/shared/palette";

import { whiteboard } from "./floor-layout.ts";

// What the meeting room's whiteboard shows during a Grilling Session (PRD
// FR-83), drawn in the scene without text (§7): on the left, the current
// round, a heading with a tally of the round's number over a sticky note
// for each of its questions (amber while open, green once answered, grey
// when withdrawn); on the right, a heading over a line for each decision
// settled so far, each ticked. The words themselves are in the
// whiteboard's HTML panel, and in the session chat that clicking the
// whiteboard opens.

/** What the whiteboard needs of a running session. */
export interface GrillingBoard {
  /** The latest round asked; 0 before the first. */
  readonly round: number;
  /** That round's questions, in order. */
  readonly questions: readonly GrillingQuestionStatus[];
  /** The decisions settled so far. */
  readonly decisions: number;
}

/** What a session puts on the whiteboard. */
export const grillingBoard = (
  session: Pick<GrillingSession, "round" | "questions" | "decisions">,
): GrillingBoard => ({
  round: session.round,
  questions: session.questions
    .filter(({ round }) => round === session.round && session.round > 0)
    .map(({ status }) => status),
  decisions: session.decisions.length,
});

/** A mark on the whiteboard: its centre and size on the board's face, and its colour. */
export interface BoardMark {
  /** From the board's centre, in metres: right and up. */
  readonly centre: readonly [number, number];
  readonly size: readonly [number, number];
  readonly token: PaletteToken;
}

/** Each question's sticky note, by its status. */
export const noteTokens: Record<GrillingQuestionStatus, PaletteToken> = {
  open: "state-warning",
  answered: "state-ok",
  withdrawn: "state-neutral",
};

const margin = 0.08;
const top = whiteboard.height / 2 - margin;
const left = -whiteboard.width / 2 + margin;
const middle = 0.02;
const headingHeight = 0.03;

/** The notes: 0.2 m × 0.15 m, three to a row, five rows at most. */
export const notes = {
  width: 0.2,
  height: 0.15,
  gap: 0.05,
  columns: 3,
  rows: 5,
} as const;

/** The decisions' lines: a row each, the latest twelve at most. */
export const decisionLines = { spacing: 0.075, rows: 12 } as const;

/** The most tally strokes the round's heading has. */
export const maxTally = 8;

/** How long a decision's line is, as a share of the column: varied, as handwriting is. */
const lineShares = [0.92, 0.7, 0.84, 0.62, 0.78, 0.88, 0.66] as const;

/** The marks on the whiteboard for `board`. */
export function boardMarks(board: GrillingBoard): BoardMark[] {
  const marks: BoardMark[] = [];
  const ink = (
    centre: readonly [number, number],
    size: readonly [number, number],
  ) => {
    marks.push({ centre, size, token: "ink" });
  };

  // The round: a heading, and a tally of its number.
  const headingWidth = 0.3;
  ink([left + headingWidth / 2, top - headingHeight / 2], [headingWidth, 0.02]);
  for (let stroke = 0; stroke < Math.min(board.round, maxTally); stroke += 1) {
    ink(
      [left + headingWidth + 0.06 + stroke * 0.035, top - headingHeight / 2],
      [0.012, 0.06],
    );
  }
  const notesTop = top - headingHeight - 0.08;
  board.questions
    .slice(0, notes.columns * notes.rows)
    .forEach((status, index) => {
      const column = index % notes.columns;
      const row = Math.floor(index / notes.columns);
      const x = left + notes.width / 2 + column * (notes.width + notes.gap);
      const y = notesTop - notes.height / 2 - row * (notes.height + notes.gap);
      marks.push({
        centre: [x, y],
        size: [notes.width, notes.height],
        token: noteTokens[status],
      });
      // Two lines of writing on it.
      ink([x - 0.01, y + 0.025], [notes.width - 0.06, 0.012]);
      ink([x - 0.03, y - 0.02], [notes.width - 0.1, 0.012]);
    });

  // The decisions: a heading, then a ticked line for each, the latest last.
  const column = {
    left: middle + 0.04,
    width: whiteboard.width / 2 - margin - 0.06,
  };
  ink(
    [column.left + headingWidth / 2, top - headingHeight / 2],
    [headingWidth, 0.02],
  );
  const shown = Math.min(board.decisions, decisionLines.rows);
  const first = board.decisions - shown;
  for (let row = 0; row < shown; row += 1) {
    const y = top - headingHeight - 0.08 - row * decisionLines.spacing;
    marks.push({
      centre: [column.left + 0.02, y],
      size: [0.03, 0.03],
      token: "state-ok",
    });
    const share = lineShares[(first + row) % lineShares.length] ?? 1;
    const width = (column.width - 0.06) * share;
    ink([column.left + 0.06 + width / 2, y], [width, 0.014]);
  }
  return marks;
}
