import type { StoredEvent } from "@ai-office/events";
import type {
  PlanItem,
  PlanLeftOut,
  TokenUsageRow,
  WrapUp,
  WrapUpIssue,
  WrapUpOutcome,
} from "@ai-office/shared";

import { positionOf } from "../pipeline/pipeline.ts";

// The Wrap-up (PRD FR-25.6, FR-60): a Batch finishes once none of its
// issues can move on without the Owner: each is closed (by its merged pull
// request, or otherwise) or blocked at `needs-human`, or waits on an issue
// that is. An issue still being worked, waiting at `ready-to-merge` for the
// Owner's approval, or not yet started though it could be, keeps the Batch
// in progress. Its results are each issue's outcome, pull request, Review
// Loop and QA rounds, tokens and estimated cost, and the totals, all from
// what AI Office recorded: GitHub's issues, the event log and the AI
// Gateway's request history. Never an issue's text.

/** An issue as GitHub has it now, as much as the Wrap-up reads. */
export interface IssueNow {
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
}

/**
 * Each of the Plan's issues' outcome, if the Batch is finished; undefined
 * while any of them can still move on. `merged` says whether a closed
 * issue's pull request was merged.
 */
export function batchOutcomes(
  items: readonly Pick<PlanItem, "issue" | "dependsOn">[],
  issues: ReadonlyMap<number, IssueNow>,
  merged: (issue: number) => boolean,
): Map<number, WrapUpOutcome> | undefined {
  const outcomes = new Map<number, WrapUpOutcome>();
  for (const { issue } of items) {
    const now = issues.get(issue);
    if (now === undefined) {
      return undefined;
    }
    if (now.state === "closed") {
      outcomes.set(issue, merged(issue) ? "merged" : "closed");
      continue;
    }
    let stage: string | null;
    try {
      stage = positionOf(issue, now.labels).stage;
    } catch {
      // Conflicting stage labels: the Owner or the watchdog sorts it out.
      return undefined;
    }
    if (stage === "needs-human") {
      outcomes.set(issue, "blocked");
    }
  }
  // An open issue not yet worked that waits on a blocked issue (or on one
  // that never starts) never starts either.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { issue, dependsOn } of items) {
      if (outcomes.has(issue)) {
        continue;
      }
      const now = issues.get(issue);
      const waiting =
        now !== undefined &&
        positionOf(issue, now.labels).stage === null &&
        dependsOn.some((dependency) => {
          const outcome = outcomes.get(dependency);
          return outcome === "blocked" || outcome === "not_started";
        });
      if (waiting) {
        outcomes.set(issue, "not_started");
        changed = true;
      }
    }
  }
  return outcomes.size === items.length ? outcomes : undefined;
}

/** What the event log says of one issue since its Batch was made. */
export interface IssueRecord {
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
  } | null;
  /** Whether AI Office merged its pull request. */
  readonly merged: boolean;
  readonly rounds: { readonly review: number; readonly qa: number };
}

/** An issue's pull request, merge and rounds, from its events (any order). */
export function issueRecord(events: readonly StoredEvent[]): IssueRecord {
  let opened: { id: number; number: number; url: string } | undefined;
  let merged = false;
  let review = 0;
  let qa = 0;
  for (const { id, event } of events) {
    switch (event.type) {
      case "pull_request.opened":
        if (opened === undefined || id > opened.id) {
          opened = { id, number: event.pullRequest, url: event.url };
        }
        break;
      case "pull_request.merged":
        merged = true;
        if (opened === undefined || id > opened.id) {
          opened = { id, number: event.pullRequest, url: event.url };
        }
        break;
      case "review.posted":
        review = Math.max(review, event.round);
        break;
      case "qa.reported":
        qa = Math.max(qa, event.round);
        break;
      default:
        break;
    }
  }
  return {
    pullRequest:
      opened === undefined ? null : { number: opened.number, url: opened.url },
    merged,
    rounds: { review, qa },
  };
}

/** The event types an issue's record is read from. */
export const issueRecordTypes = [
  "pull_request.opened",
  "pull_request.merged",
  "review.posted",
  "qa.reported",
] as const;

/** Rounds `a` to cents' fractions, so sums of prices stay tidy. */
const priced = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/** A finished Batch's results, in its Plan's order. */
export function wrapUpOf(input: {
  readonly floorId: string;
  readonly planVersion: number;
  readonly items: readonly PlanItem[];
  readonly leftOut: readonly PlanLeftOut[];
  readonly outcomes: ReadonlyMap<number, WrapUpOutcome>;
  readonly records: ReadonlyMap<number, IssueRecord>;
  /** The AI Gateway's usage since the Batch was made. */
  readonly usage: readonly TokenUsageRow[];
}): WrapUp {
  const issues: WrapUpIssue[] = input.items.map((item) => {
    const record = input.records.get(item.issue);
    const rows = input.usage.filter(
      ({ floorId, issue }) => floorId === input.floorId && issue === item.issue,
    );
    return {
      issue: item.issue,
      title: item.title,
      outcome: input.outcomes.get(item.issue) ?? "not_started",
      pullRequest: record?.pullRequest ?? null,
      agentId: item.agentId,
      rounds: { ...(record?.rounds ?? { review: 0, qa: 0 }) },
      tokens: rows.reduce((sum, { totals }) => sum + totals.tokens, 0),
      estimatedCostUsd: priced(
        rows.reduce((sum, { totals }) => sum + totals.estimatedCostUsd, 0),
      ),
    };
  });
  const count = (outcome: WrapUpOutcome) =>
    issues.filter((issue) => issue.outcome === outcome).length;
  return {
    planVersion: input.planVersion,
    issues,
    leftOut: input.leftOut.map((left) => ({ ...left })),
    totals: {
      merged: count("merged"),
      closed: count("closed"),
      blocked: count("blocked"),
      notStarted: count("not_started"),
      tokens: issues.reduce((sum, { tokens }) => sum + tokens, 0),
      estimatedCostUsd: priced(
        issues.reduce((sum, { estimatedCostUsd }) => sum + estimatedCostUsd, 0),
      ),
    },
  };
}

/** Tokens in words: "412k tokens", "1.2M tokens", "900 tokens". */
export function tokensInWords(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tokens`;
  }
  if (tokens >= 1000) {
    return `${String(Math.round(tokens / 1000))}k tokens`;
  }
  return `${String(tokens)} token${tokens === 1 ? "" : "s"}`;
}

/** A Wrap-up's results in a line: "3 of 4 issues merged, 1 blocked; 412k tokens". */
export function wrapUpLine(wrapUp: WrapUp): string {
  const { merged, closed, blocked, notStarted, tokens } = wrapUp.totals;
  const all = wrapUp.issues.length;
  return [
    `${String(merged)} of ${String(all)} issue${all === 1 ? "" : "s"} merged`,
    ...(closed > 0 ? [`${String(closed)} closed`] : []),
    ...(blocked > 0 ? [`${String(blocked)} blocked`] : []),
    ...(notStarted > 0 ? [`${String(notStarted)} not started`] : []),
  ]
    .join(", ")
    .concat(`; ${tokensInWords(tokens)}`);
}
