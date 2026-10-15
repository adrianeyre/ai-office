import type { ComparedFile } from "@ai-office/github";
import type { NoticePosition } from "@ai-office/shared";

import { blockingComments, describeComment } from "./handoff.ts";
import { commentSimilarity, repeatShare, repeatSimilarity } from "./stall.ts";
import type { QaReportRecord, VerdictRecord } from "./store.ts";

// Conflicts between Roles (PRD FR-30): when the reviewers and QA hold
// opposite positions on a pull request, sending the work round again only
// bounces the coder between them, so it goes to the Owner instead, as at a
// cap: `needs-human`, and an action Notice with both positions side by
// side. Two shapes, each a deterministic rule (FR-17: the Decision Model is
// not used for them yet):
//
// - QA against the reviewers: QA fails, as it failed the round before,
//   what every reviewer approved twice in a row. A QA failure that is new
//   each round is the coder's to fix, up to QA's Round Cap.
// - The reviewers against QA: the reviewers' blocking comments on the
//   coder's fix for a QA failure are mostly on what that fix changed.
//
// The caps come first: a round that reaches one is reported as the cap.

/** Why the reviewers and QA are in conflict. */
export type Conflict =
  /** QA failed again, as before, what every reviewer approved twice in a row. */
  | {
      readonly kind: "qa_against_reviewers";
      /** The two review rounds that approved, oldest first. */
      readonly reviewRounds: readonly [number, number];
      /** The two rounds of QA that failed, oldest first. */
      readonly qaRounds: readonly [number, number];
    }
  /** The reviewers rejected the coder's fix for what QA required. */
  | {
      readonly kind: "reviewers_against_qa";
      /** The review round that rejected it. */
      readonly round: number;
      /** The round of QA whose failure the coder fixed. */
      readonly qaRound: number;
      /** How many of its blocking comments are on what the fix changed, of how many. */
      readonly rejected: number;
      readonly of: number;
    };

/** The longest text a position carries. */
const maxPositionText = 1500;

const approvedByEvery = (verdicts: readonly VerdictRecord[]): boolean =>
  verdicts.length > 0 &&
  verdicts.every(
    ({ verdict }) =>
      verdict.verdict === "approve" &&
      verdict.comments.every(({ severity }) => severity !== "blocking"),
  );

const findingOf = (report: QaReportRecord): string =>
  `${report.summary}\n${report.steps}`;

const inRound = (
  verdicts: readonly VerdictRecord[],
  number: number,
): VerdictRecord[] => verdicts.filter(({ round }) => round === number);

/**
 * Whether QA's latest round, a failure, is in conflict with the reviewers:
 * its finding repeats the previous round of QA's, which also failed, and
 * every reviewer approved in both of the last two review rounds, the ones
 * before each of those rounds of QA.
 */
export function qaConflictOf(input: {
  readonly verdicts: readonly VerdictRecord[];
  readonly reports: readonly QaReportRecord[];
}): Conflict | undefined {
  const [previous, latest] = input.reports.slice(-2);
  if (
    previous === undefined ||
    latest === undefined ||
    previous.result !== "fail" ||
    latest.result !== "fail"
  ) {
    return undefined;
  }
  const rounds = [...new Set(input.verdicts.map(({ round }) => round))].sort(
    (a, b) => a - b,
  );
  const [before, last] = rounds.slice(-2);
  if (
    before === undefined ||
    last === undefined ||
    !approvedByEvery(inRound(input.verdicts, before)) ||
    !approvedByEvery(inRound(input.verdicts, last))
  ) {
    return undefined;
  }
  if (
    commentSimilarity(findingOf(previous), findingOf(latest)) < repeatSimilarity
  ) {
    return undefined;
  }
  return {
    kind: "qa_against_reviewers",
    reviewRounds: [before, last],
    qaRounds: [previous.round, latest.round],
  };
}

/**
 * Whether a review round with blocking comments is in conflict with QA: the
 * previous round was approved by every reviewer and then failed by QA, and
 * more than half of this round's blocking comments are on files the coder
 * changed since QA checked it, that is on the fix QA required.
 */
export function reviewConflictOf(input: {
  /** This round's verdicts. */
  readonly current: readonly VerdictRecord[];
  /** The previous round's. */
  readonly previous: readonly VerdictRecord[];
  /** QA's latest round, if it has had one. */
  readonly qa: QaReportRecord | undefined;
  /** What the coder changed since that round of QA checked the branch. */
  readonly fixed: readonly ComparedFile[];
}): Conflict | undefined {
  const { qa } = input;
  const [first] = input.current;
  if (
    first === undefined ||
    qa?.result !== "fail" ||
    !approvedByEvery(input.previous)
  ) {
    return undefined;
  }
  const blocking = blockingComments(input.current, () => "");
  if (blocking.length === 0) {
    return undefined;
  }
  const changed = new Set(input.fixed.map(({ path }) => path));
  const rejected = blocking.filter(({ path }) => changed.has(path)).length;
  if (rejected / blocking.length <= repeatShare) {
    return undefined;
  }
  return {
    kind: "reviewers_against_qa",
    round: first.round,
    qaRound: qa.round,
    rejected,
    of: blocking.length,
  };
}

/** The Notice's title: the conflict, on `pr` ("PR #2 (#1)"). */
export function describeConflict(conflict: Conflict, pr: string): string {
  if (conflict.kind === "qa_against_reviewers") {
    const [first, second] = conflict.qaRounds;
    return `Review Loop conflict between Roles: QA failed ${pr} in QA round ${String(second)} as in round ${String(first)}, though every reviewer approved it twice in a row.`;
  }
  return `Review Loop conflict between Roles: in round ${String(conflict.round)}, the reviewers rejected the fix QA required of ${pr} in QA round ${String(conflict.qaRound)}.`;
}

const said = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "Nothing said.";
  }
  return trimmed.length <= maxPositionText
    ? trimmed
    : `${trimmed.slice(0, maxPositionText - 1)}…`;
};

const qaPosition = (report: QaReportRecord, label: string): NoticePosition => ({
  label,
  text: said(
    report.steps.trim() === ""
      ? report.summary
      : `${report.summary}\n\nSteps to reproduce:\n${report.steps}`,
  ),
  url: report.commentUrl,
});

/**
 * Both positions, in the order they arose, for the Notice to show side by
 * side: what each side said, and where.
 */
export function conflictPositions(input: {
  readonly conflict: Conflict;
  /** Every verdict on the issue. */
  readonly verdicts: readonly VerdictRecord[];
  /** Every round of QA on the issue. */
  readonly reports: readonly QaReportRecord[];
  readonly nameOf: (agentId: string) => string;
}): NoticePosition[] {
  const { conflict, nameOf } = input;
  const report = (round: number) =>
    input.reports.find((known) => known.round === round);
  const summaries = (verdicts: readonly VerdictRecord[]) =>
    verdicts.map(
      ({ agentId, verdict }) => `${nameOf(agentId)}: ${verdict.summary}`,
    );

  if (conflict.kind === "qa_against_reviewers") {
    const [firstReview, lastReview] = conflict.reviewRounds;
    const [firstQa, lastQa] = conflict.qaRounds;
    const approved = inRound(input.verdicts, lastReview);
    const failed = report(lastQa);
    return [
      {
        label: `Reviewers: approved in rounds ${String(firstReview)} and ${String(lastReview)}`,
        text: said(summaries(approved).join("\n")),
        ...(approved[0] === undefined ? {} : { url: approved[0].reviewUrl }),
      },
      ...(failed === undefined
        ? []
        : [
            qaPosition(
              failed,
              `QA: failed in QA rounds ${String(firstQa)} and ${String(lastQa)}`,
            ),
          ]),
    ];
  }

  const failed = report(conflict.qaRound);
  const rejecting = inRound(input.verdicts, conflict.round).filter(
    ({ verdict }) => verdict.verdict === "changes_requested",
  );
  const comments = blockingComments(rejecting, nameOf).map(
    (comment) => `- ${describeComment(comment)}`,
  );
  return [
    ...(failed === undefined
      ? []
      : [qaPosition(failed, `QA: failed in QA round ${String(failed.round)}`)]),
    {
      label: `Reviewers: changes requested in round ${String(conflict.round)}`,
      text: said([...summaries(rejecting), "", ...comments].join("\n")),
      ...(rejecting[0] === undefined ? {} : { url: rejecting[0].reviewUrl }),
    },
  ];
}
