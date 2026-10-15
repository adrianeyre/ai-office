import type { NoticeLink } from "@ai-office/shared";

import type {
  DesignReviewRecord,
  QaReportRecord,
  VerdictRecord,
} from "../review/store.ts";

// The caps on a pull request beyond the Review Loop's Round Cap (PRD
// FR-28): QA has its own Round Cap, and an overall cap counts the rounds of
// every stage (review and QA) on one pull request, so work that bounces
// between them cannot loop without bound. Reaching either hands the pull
// request to the Owner, as the Round Cap does.

/** The most rounds of QA on one pull request. */
export const qaRoundCap = 3;

/**
 * The most rounds, of review and QA together, on one pull request: one
 * fewer than the Floor's Round Cap and QA's together (5 by default), so a
 * pull request that comes close to both goes to the Owner. It is checked
 * when QA fails: a round of review sends work back only below the Round
 * Cap, and QA has failed at most twice before then, so a review can never
 * reach it first.
 */
export const overallRoundCap = (roundCap: number): number =>
  roundCap + qaRoundCap - 1;

/** The rounds of review and QA an issue's pull request has had. */
export const roundsSoFar = (
  verdicts: readonly VerdictRecord[],
  reports: readonly QaReportRecord[],
): number => new Set(verdicts.map(({ round }) => round)).size + reports.length;

/**
 * A link to each round of review and QA, oldest first, the latest ten: a
 * review from each round of review (preferring one that asked for
 * changes), QA's comment for each round of QA, and the designer's for each
 * round of design review in `designs`.
 */
export function everyRoundLinks(
  verdicts: readonly VerdictRecord[],
  reports: readonly QaReportRecord[],
  fallbackUrl: string,
  designs: readonly DesignReviewRecord[] = [],
): NoticeLink[] {
  const reviews = [...new Set(verdicts.map(({ round }) => round))].map(
    (number) => {
      const inRound = verdicts.filter(({ round }) => round === number);
      const shown =
        inRound.find(
          ({ verdict }) => verdict.verdict === "changes_requested",
        ) ?? inRound[0];
      return {
        at: inRound[0]?.createdAt.getTime() ?? 0,
        link: {
          label: `Review round ${String(number)}`,
          url: shown?.reviewUrl ?? fallbackUrl,
        },
      };
    },
  );
  const checks = reports.map((report) => ({
    at: report.createdAt.getTime(),
    link: { label: `QA round ${String(report.round)}`, url: report.commentUrl },
  }));
  const looks = designs.map((design) => ({
    at: design.createdAt.getTime(),
    link: {
      label: `Design round ${String(design.round)}`,
      url: design.commentUrl,
    },
  }));
  return [...reviews, ...checks, ...looks]
    .sort((a, b) => a.at - b.at)
    .map(({ link }) => link)
    .slice(-10);
}
