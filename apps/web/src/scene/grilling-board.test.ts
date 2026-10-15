import type { GrillingQuestionStatus } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { whiteboard } from "./floor-layout.ts";
import {
  boardMarks,
  decisionLines,
  grillingBoard,
  maxTally,
  noteTokens,
  notes,
  type BoardMark,
  type GrillingBoard,
} from "./grilling-board.ts";

// What the meeting room's whiteboard shows during a Grilling Session (PRD
// FR-83), without text: the current round's questions as sticky notes
// coloured by their status, a tally of the round's number, and a ticked
// line for each decision settled so far.

const question = (
  number: number,
  round: number | null,
  status: GrillingQuestionStatus,
) => ({
  number,
  round,
  text: `Question ${String(number)}?`,
  recommended: "Yes.",
  dependsOn: [],
  status,
  answer: status === "answered" ? "Yes." : null,
  acceptedRecommended: status === "answered",
  answeredAt: null,
});

const decision = (number: number) => ({
  number,
  text: `Decision ${String(number)}.`,
  questions: [number],
  round: 1,
  settledAt: "2026-10-10T12:00:00.000Z",
});

const isNote = ({ size: [width, height] }: BoardMark) =>
  width === notes.width && height === notes.height;
const ticks = (marks: readonly BoardMark[]) =>
  marks.filter(({ token, centre: [x] }) => token === "state-ok" && x > 0);
const tally = (marks: readonly BoardMark[]) =>
  marks.filter(
    ({ size: [width, height] }) => width === 0.012 && height === 0.06,
  );

describe("a session on the whiteboard", () => {
  it("takes the current round's questions, in order, and counts the decisions", () => {
    expect(
      grillingBoard({
        round: 2,
        questions: [
          question(1, 1, "answered"),
          question(2, 2, "answered"),
          question(3, 2, "open"),
          question(4, null, "open"),
          question(5, 2, "withdrawn"),
        ],
        decisions: [decision(1), decision(2)],
      }),
    ).toEqual({
      round: 2,
      questions: ["answered", "open", "withdrawn"],
      decisions: 2,
    });
    // Before the first round, nothing is asked.
    expect(
      grillingBoard({
        round: 0,
        questions: [question(1, null, "open")],
        decisions: [],
      }),
    ).toEqual({ round: 0, questions: [], decisions: 0 });
  });

  it("puts a note for each question, coloured by its status, a tally of the round, and a ticked line for each decision, all on the board", () => {
    const board: GrillingBoard = {
      round: 3,
      questions: ["open", "answered", "withdrawn", "open"],
      decisions: 5,
    };
    const marks = boardMarks(board);
    expect(marks.filter(isNote).map(({ token }) => token)).toEqual(
      board.questions.map((status) => noteTokens[status]),
    );
    expect(noteTokens).toEqual({
      open: "state-warning",
      answered: "state-ok",
      withdrawn: "state-neutral",
    });
    expect(tally(marks)).toHaveLength(3);
    expect(ticks(marks)).toHaveLength(5);
    for (const { centre, size } of marks) {
      expect(Math.abs(centre[0]) + size[0] / 2).toBeLessThanOrEqual(
        whiteboard.width / 2,
      );
      expect(Math.abs(centre[1]) + size[1] / 2).toBeLessThanOrEqual(
        whiteboard.height / 2,
      );
    }
    // The round on the left; the decisions on the right.
    for (const note of marks.filter(isNote)) {
      expect(note.centre[0] + note.size[0] / 2).toBeLessThan(0);
    }
    for (const tick of ticks(marks)) {
      expect(tick.centre[0]).toBeGreaterThan(0);
    }
  });

  it("holds fifteen notes, a tally of eight and the latest twelve decisions at most", () => {
    const marks = boardMarks({
      round: 11,
      questions: Array.from({ length: 20 }, () => "open"),
      decisions: 30,
    });
    expect(marks.filter(isNote)).toHaveLength(notes.columns * notes.rows);
    expect(tally(marks)).toHaveLength(maxTally);
    expect(ticks(marks)).toHaveLength(decisionLines.rows);
    for (const { centre, size } of marks) {
      expect(Math.abs(centre[1]) + size[1] / 2).toBeLessThanOrEqual(
        whiteboard.height / 2,
      );
    }
  });

  it("shows only its headings before the first round", () => {
    const marks = boardMarks({ round: 0, questions: [], decisions: 0 });
    expect(marks).toHaveLength(2);
    expect(marks.every(({ token }) => token === "ink")).toBe(true);
  });
});
