import type { GitHubApp, Issue, PullRequest } from "@ai-office/github";
import type { NoticeLink, NoticePosition } from "@ai-office/shared";

import type { FloorRecord } from "../floors/store.ts";
import type { Notices } from "../notices/notices.ts";
import type { Pipeline } from "../pipeline/pipeline.ts";
import type { VerdictRecord } from "./store.ts";

// Escalation to the Owner (PRD FR-28, FR-30): reaching any cap, a Review
// Loop that stalls before it, or a conflict between Roles labels the issue
// and its pull request `needs-human` and raises an action Notice saying
// why, with links to each round, and a conflict's two positions.

/** The most links a Notice carries. */
const maxLinks = 10;

const title = (text: string): string =>
  text.length <= 200 ? text : `${text.slice(0, 199)}…`;

/**
 * A link to each round of review, the latest ten: a review from it,
 * preferring one that asked for changes.
 */
export function reviewRoundLinks(
  history: readonly VerdictRecord[],
  fallbackUrl: string,
): NoticeLink[] {
  return [...new Set(history.map(({ round }) => round))]
    .slice(-maxLinks)
    .map((number) => {
      const inRound = history.filter(({ round }) => round === number);
      const shown =
        inRound.find(
          ({ verdict }) => verdict.verdict === "changes_requested",
        ) ?? inRound[0];
      return {
        label: `Round ${String(number)}`,
        url: shown?.reviewUrl ?? fallbackUrl,
      };
    });
}

export interface EscalationOptions {
  readonly github: GitHubApp;
  readonly pipeline: Pipeline;
  readonly notices: Notices;
}

/** Hands an issue and its pull request to the Owner, saying why. */
export type Escalate = (input: {
  readonly floor: FloorRecord;
  readonly issue: Issue;
  readonly pullRequest: PullRequest;
  /** The Notice's title: why. */
  readonly reason: string;
  readonly links: readonly NoticeLink[];
  /** A conflict's two positions, to show side by side. */
  readonly positions?: readonly NoticePosition[];
  /** The Agent whose work escalated it, for the label's move. */
  readonly agentId?: string;
}) => Promise<void>;

export function createEscalation(options: EscalationOptions): Escalate {
  const { github, pipeline, notices } = options;
  return async ({
    floor,
    issue,
    pullRequest,
    reason,
    links,
    positions = [],
    agentId,
  }) => {
    await pipeline.move(
      floor,
      issue.number,
      "needs-human",
      agentId === undefined ? {} : { agentId },
    );
    await github
      .repository(floor.repository)
      .addLabels(pullRequest.number, ["needs-human"]);
    await notices.raise({
      kind: "action",
      title: title(reason),
      floorId: floor.id,
      issue: { number: issue.number, url: issue.htmlUrl },
      pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
      links: links.slice(-maxLinks),
      positions: [...positions],
    });
  };
}
