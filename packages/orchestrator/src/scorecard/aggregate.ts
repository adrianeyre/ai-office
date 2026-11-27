import {
  issueSizeLabels,
  issueSizes,
  type AgentScorecard,
  type Scorecard,
  type ScorecardDimension,
  type ScorecardReviewItem,
  type ScorecardWorkItem,
} from "@ai-office/shared";

import type { ScorecardEntry } from "./store.ts";

// The Scorecard (Scorecards PRD, FR-128 to FR-131, FR-135), added up from
// its records: pure functions, so the routes and their tests share them.
//
// - **Work, QA and docs** (FR-128): the issues merged, the mean Review Loop
//   rounds until approval, the QA rounds that failed, the stalls and
//   failures charged to the group's Agents, the issues handed to the
//   Owner, and the tokens and estimated cost per merged issue. An issue's
//   own course (its outcome, rounds and QA) counts once in a group however
//   many of its rows the group holds: two coders on one issue, or one
//   coder's requests served by two Models.
// - **Reviewers** (FR-129): the rounds reviewed and the blocking comments
//   per round.
//
// Work counts toward the Model that actually served it: each row is one
// Model's share of an Agent's requests.

/** How the Scorecard names what it counts. */
export interface ScorecardNames {
  floor(floorId: string): string;
  role(roleId: string): string;
}

interface Group {
  key: string;
  label: string;
  floorId: string | null;
  rows: ScorecardEntry[];
}

const issueKey = (entry: ScorecardEntry): string =>
  `${entry.floorId}#${String(entry.issue)}`;

const sizeKey = (entry: ScorecardEntry): string => entry.size ?? "none";

/** What a row is, by a dimension: its key, label and Floor. */
const groupOf: Record<
  ScorecardDimension,
  (entry: ScorecardEntry, names: ScorecardNames) => Omit<Group, "rows">
> = {
  agent: (entry) => ({
    key: entry.agentId,
    label: entry.agentName,
    floorId: entry.floorId,
  }),
  role: (entry, names) => ({
    key: entry.role,
    label: names.role(entry.role),
    floorId: null,
  }),
  model: (entry) => ({
    key: entry.model,
    label: entry.model === "" ? "No Model" : entry.model,
    floorId: null,
  }),
  floor: (entry, names) => ({
    key: entry.floorId,
    label: names.floor(entry.floorId),
    floorId: entry.floorId,
  }),
  size: (entry) => ({
    key: sizeKey(entry),
    label: entry.size === null ? "No Size" : issueSizeLabels[entry.size],
    floorId: null,
  }),
};

const groupBy = (
  entries: readonly ScorecardEntry[],
  by: ScorecardDimension,
  names: ScorecardNames,
): Group[] => {
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const group = groupOf[by](entry, names);
    const id = JSON.stringify([group.key, group.floorId]);
    const current = groups.get(id) ?? { ...group, rows: [] };
    // An Agent is named as it was last.
    current.label = group.label;
    current.rows.push(entry);
    groups.set(id, current);
  }
  return [...groups.values()];
};

/** Each issue once: its latest row stands for its own course. */
const issuesOf = (rows: readonly ScorecardEntry[]): ScorecardEntry[] => [
  ...new Map(rows.map((row) => [issueKey(row), row])).values(),
];

/** Dollars to a ten-thousandth of a cent, so sums do not drift. */
const dollars = (value: number): number => Math.round(value * 1e6) / 1e6;

const tokensOf = (rows: readonly ScorecardEntry[]): number =>
  rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);

const costOf = (rows: readonly ScorecardEntry[]): number =>
  dollars(rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0));

const sum = (
  rows: readonly ScorecardEntry[],
  field: "stalls" | "failures" | "roundsReviewed" | "blockingComments",
): number => rows.reduce((total, row) => total + row[field], 0);

const mean = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : Math.round(
        (values.reduce((total, value) => total + value, 0) / values.length) *
          100,
      ) / 100;

/** A group's Scorecard for work, QA and docs (FR-128). */
export function workItemOf(
  group: Omit<Group, "rows">,
  rows: readonly ScorecardEntry[],
): ScorecardWorkItem {
  const issues = issuesOf(rows);
  const merged = issues.filter(({ outcome }) => outcome === "merged").length;
  const tokens = tokensOf(rows);
  const cost = costOf(rows);
  return {
    key: group.key,
    label: group.label,
    floorId: group.floorId,
    issues: issues.length,
    issuesMerged: merged,
    meanRoundsToApproval: mean(
      issues.flatMap(({ roundsToApproval }) =>
        roundsToApproval === null ? [] : [roundsToApproval],
      ),
    ),
    qaRoundsFailed: issues.reduce(
      (total, { qaRoundsFailed }) => total + qaRoundsFailed,
      0,
    ),
    stalls: sum(rows, "stalls"),
    failures: sum(rows, "failures"),
    handedToOwner: issues.filter(({ outcome }) => outcome === "handed_to_owner")
      .length,
    tokens,
    estimatedCostUsd: cost,
    tokensPerMergedIssue: merged === 0 ? null : Math.round(tokens / merged),
    costPerMergedIssue: merged === 0 ? null : dollars(cost / merged),
  };
}

/** A group's Scorecard for reviewers (FR-129). */
export function reviewItemOf(
  group: Omit<Group, "rows">,
  rows: readonly ScorecardEntry[],
): ScorecardReviewItem {
  const rounds = sum(rows, "roundsReviewed");
  const blocking = sum(rows, "blockingComments");
  return {
    key: group.key,
    label: group.label,
    floorId: group.floorId,
    issues: issuesOf(rows).length,
    roundsReviewed: rounds,
    blockingComments: blocking,
    blockingPerRound:
      rounds === 0 ? null : Math.round((blocking / rounds) * 100) / 100,
    tokens: tokensOf(rows),
    estimatedCostUsd: costOf(rows),
  };
}

/** The order Sizes are listed in, smallest first, then none. */
const sizeOrder = (key: string): number => {
  const index = issueSizes.findIndex((size) => size === key);
  return index === -1 ? issueSizes.length : index;
};

/**
 * The Scorecard of `entries` broken down `by` a dimension: work, QA and
 * docs Agents' records, most issues merged first, and reviewers', most
 * rounds reviewed first; by Size, smallest first.
 */
export function scorecardOf(
  entries: readonly ScorecardEntry[],
  by: ScorecardDimension,
  names: ScorecardNames,
): Scorecard {
  const work = groupBy(
    entries.filter(({ stage }) => stage !== "review"),
    by,
    names,
  ).map(({ rows, ...group }) => workItemOf(group, rows));
  const review = groupBy(
    entries.filter(({ stage }) => stage === "review"),
    by,
    names,
  ).map(({ rows, ...group }) => reviewItemOf(group, rows));
  if (by === "size") {
    work.sort((a, b) => sizeOrder(a.key) - sizeOrder(b.key));
    review.sort((a, b) => sizeOrder(a.key) - sizeOrder(b.key));
  } else {
    work.sort(
      (a, b) =>
        b.issuesMerged - a.issuesMerged ||
        b.issues - a.issues ||
        a.label.localeCompare(b.label),
    );
    review.sort(
      (a, b) =>
        b.roundsReviewed - a.roundsReviewed ||
        b.issues - a.issues ||
        a.label.localeCompare(b.label),
    );
  }
  return { by, work, review };
}

/**
 * An Agent's one-line Scorecard (FR-131), from its own records over the
 * days it covers.
 */
export function agentScorecardOf(
  agentId: string,
  entries: readonly ScorecardEntry[],
  days: number,
): AgentScorecard {
  const rows = entries.filter((entry) => entry.agentId === agentId);
  const group = { key: agentId, label: agentId, floorId: null };
  const reviewing = rows.filter(({ stage }) => stage === "review");
  const working = rows.filter(({ stage }) => stage !== "review");
  const work = workItemOf(group, working);
  const review = reviewItemOf(group, reviewing);
  return {
    agentId,
    days,
    stage: rows.at(-1)?.stage ?? null,
    issues: issuesOf(rows).length,
    issuesMerged: work.issuesMerged,
    meanRoundsToApproval: work.meanRoundsToApproval,
    costPerMergedIssue: work.costPerMergedIssue,
    roundsReviewed: review.roundsReviewed,
    blockingPerRound: review.blockingPerRound,
  };
}
