import type { ComparedFile } from "@ai-office/github";

import type { LoopJudgement } from "../decision-model/decision-model.ts";
import { blockingComments } from "./handoff.ts";
import type { VerdictRecord } from "./store.ts";

// Early escalation of a stalled Review Loop (PRD FR-28): a round that still
// has blocking comments goes to the Owner before the Round Cap, as reaching
// the cap does, when the loop is not converging. Either its blocking
// comments mostly repeat the previous round's, or the coder's fix since the
// previous round barely changed the diff. These are deterministic rules;
// while the Owner has the Decision Model on (FR-17), Jev judges in their
// place, and they judge only when it cannot be asked.

/**
 * How alike two blocking comments' words must be (their Jaccard
 * similarity, from 0 to 1) for one to repeat the other. Both must also be
 * on the same file.
 */
export const repeatSimilarity = 0.6;

/** A round repeats the previous one when more than this share of its blocking comments do. */
export const repeatShare = 0.5;

/**
 * A fix that changes fewer lines than this (added plus deleted, so a
 * one-line edit counts 2) barely changes the diff.
 */
export const minFixLines = 3;

/** Why a round escalates early. */
export type Stall =
  /** Its blocking comments mostly repeat the previous round's. */
  | {
      readonly reason: "repeated";
      /** How many of its blocking comments repeat one, of how many. */
      readonly repeated: number;
      readonly of: number;
    }
  /** The fix since the previous round barely changed the diff. */
  | { readonly reason: "tiny_fix"; readonly lines: number }
  /** The Decision Model judged the round repeating, or stalled (FR-17). */
  | {
      readonly reason: "judged";
      readonly progress: Exclude<LoopJudgement["progress"], "converging">;
    };

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== ""),
  );

/** How alike two comments' words are: shared words over all their words. */
export function commentSimilarity(a: string, b: string): number {
  const [left, right] = [words(a), words(b)];
  const all = new Set([...left, ...right]);
  if (all.size === 0) {
    return 1;
  }
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / all.size;
}

/** How many lines the fix added and deleted, over every file. */
export const changedLines = (files: readonly ComparedFile[]): number =>
  files.reduce((sum, file) => sum + file.additions + file.deletions, 0);

/**
 * Whether a round with blocking comments has stalled, against the previous
 * round: its verdicts, and the lines changed between their head commits.
 * Repeats are checked first.
 */
export function stallOf(input: {
  readonly current: readonly VerdictRecord[];
  readonly previous: readonly VerdictRecord[];
  readonly fixLines: number;
}): Stall | undefined {
  const anyone = () => "";
  const current = blockingComments(input.current, anyone);
  const previous = blockingComments(input.previous, anyone);
  if (current.length === 0) {
    return undefined;
  }
  const repeated = current.filter((comment) =>
    previous.some(
      (earlier) =>
        earlier.path === comment.path &&
        commentSimilarity(earlier.body, comment.body) >= repeatSimilarity,
    ),
  ).length;
  if (repeated / current.length > repeatShare) {
    return { reason: "repeated", repeated, of: current.length };
  }
  if (input.fixLines < minFixLines) {
    return { reason: "tiny_fix", lines: input.fixLines };
  }
  return undefined;
}

/** A round's blocking comments, each as the Decision Model reads it. */
export const describedBlocking = (
  verdicts: readonly VerdictRecord[],
): string[] =>
  blockingComments(verdicts, () => "").map(
    ({ path, line, body }) => `${path} line ${String(line)}: ${body}`,
  );

/** The stall the Decision Model judged, if it judged one (FR-17). */
export const judgedStall = (judgement: LoopJudgement): Stall | undefined =>
  judgement.progress === "converging"
    ? undefined
    : { reason: "judged", progress: judgement.progress };

/** Why it stalled, for the Owner, after "escalated at round N of M:". */
export function describeStall(stall: Stall, previousRound: number): string {
  const previous = `round ${String(previousRound)}`;
  if (stall.reason === "judged") {
    return stall.progress === "repeating"
      ? `the Decision Model judged that its blocking comments repeat ${previous}'s`
      : `the Decision Model judged that the fix since ${previous} made no real progress on its blocking comments`;
  }
  if (stall.reason === "repeated") {
    return stall.of === 1
      ? `its blocking comment repeats ${previous}'s`
      : `${String(stall.repeated)} of its ${String(stall.of)} blocking comments repeat ${previous}'s`;
  }
  return `the fix since ${previous} changed only ${String(stall.lines)} ${stall.lines === 1 ? "line" : "lines"}, and blocking comments remain`;
}
