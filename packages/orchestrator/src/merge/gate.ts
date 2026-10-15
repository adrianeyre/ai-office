import type { CheckRun, CheckRunConclusion } from "@ai-office/github";

import { overallRoundCap, qaRoundCap, roundsSoFar } from "../qa/caps.ts";
import type { QaReportRecord, VerdictRecord } from "../review/store.ts";

// The Merge Policy's gate (PRD FR-29; ADR 0002): a pull request at
// `ready-to-merge` on an auto-merge Floor is merged by the GitHub App only
// when every required reviewer approved it, at the head it merges, no
// blocking comments remain, its required CI checks passed and no cap was
// exceeded. GitHub's own
// approval count decides nothing: the App cannot approve its own pull
// request. These are plain rules; each condition that fails is a reason,
// in words the Owner reads on the Notice that hands it to them instead.

/** A check's conclusions that let a pull request merge. */
const passing: readonly CheckRunConclusion[] = [
  "success",
  "neutral",
  "skipped",
];

/** Where CI is on a pull request's head commit. */
export type CiState =
  /** Every check that ran passed, and so did every required one. */
  | { readonly state: "passed"; readonly runs: readonly CheckRun[] }
  /** A check failed: the first that did. */
  | { readonly state: "failed"; readonly failed: CheckRun }
  /** Checks still running, or required ones that have not started. */
  | {
      readonly state: "pending";
      readonly running: readonly CheckRun[];
      /** Required checks with no run yet, by name. */
      readonly missing: readonly string[];
    }
  /** No check ran, and none is required. */
  | { readonly state: "none" };

/**
 * Where CI is, from the check runs on the head commit and the checks the
 * base branch requires (by name). A check run again counts by its latest
 * run. Every check that ran must pass, required or not.
 */
export function ciOf(
  runs: readonly CheckRun[],
  required: readonly string[],
): CiState {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const known = latest.get(run.name);
    if (known === undefined || known.id < run.id) {
      latest.set(run.name, run);
    }
  }
  const checks = [...latest.values()].sort((a, b) => a.id - b.id);
  const failed = checks.find(
    ({ status, conclusion }) =>
      status === "completed" &&
      (conclusion === null || !passing.includes(conclusion)),
  );
  if (failed !== undefined) {
    return { state: "failed", failed };
  }
  const running = checks.filter(({ status }) => status !== "completed");
  const missing = required.filter((name) => !latest.has(name));
  if (running.length > 0 || missing.length > 0) {
    return { state: "pending", running, missing };
  }
  return checks.length === 0
    ? { state: "none" }
    : { state: "passed", runs: checks };
}

/** A Token Cap reached on the issue's work (a `cap.reached` event). */
export interface CapReachedOnIssue {
  /** The Agent that reached it, by name, if it was an Agent's. */
  readonly agentName?: string;
  readonly period: "daily" | "monthly";
}

export interface GateInput {
  /**
   * The head commit it would merge: an approval counts only for this
   * head, never for an earlier one that commits were pushed on since.
   */
  readonly head: string;
  /** The Floor's required reviewers, by id and name. */
  readonly reviewers: readonly { readonly id: string; readonly name: string }[];
  /** Every verdict of the issue's Review Loop. */
  readonly verdicts: readonly VerdictRecord[];
  /** Every round of QA on it. */
  readonly reports: readonly QaReportRecord[];
  /** The Floor's Round Cap. */
  readonly roundCap: number;
  /** Token Caps reached on its work. */
  readonly capsReached: readonly CapReachedOnIssue[];
}

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

const names = (all: readonly string[]): string =>
  all.length <= 1
    ? (all[0] ?? "")
    : `${all.slice(0, -1).join(", ")} and ${all.at(-1) ?? ""}`;

/** The verdicts of the latest round of the Review Loop, and its number. */
const latestRound = (
  verdicts: readonly VerdictRecord[],
): { readonly last: number; readonly latest: VerdictRecord[] } => {
  const last = Math.max(0, ...verdicts.map(({ round }) => round));
  return { last, latest: verdicts.filter(({ round }) => round === last) };
};

/**
 * The required reviewers who approved in the latest round, but a head
 * other than `head`: commits were pushed after they approved it (QA's
 * tests, the designer's fixes, the docs Agent's changes), which none of
 * them was shown (P1-1).
 */
export function approvedBefore(input: GateInput): string[] {
  const { latest } = latestRound(input.verdicts);
  return input.reviewers
    .filter(({ id }) => {
      const approvals = latest.filter(
        ({ agentId, verdict }) =>
          agentId === id && verdict.verdict === "approve",
      );
      return (
        approvals.length > 0 &&
        !approvals.some(({ headSha }) => headSha === input.head)
      );
    })
    .map(({ name }) => name);
}

/**
 * Whether the Review Loop has a round left: one more within the Floor's
 * Round Cap, and within the overall cap of review and QA together.
 */
export function roundLeft(input: GateInput): boolean {
  const rounds = new Set(input.verdicts.map(({ round }) => round)).size;
  return (
    rounds < input.roundCap &&
    roundsSoFar(input.verdicts, input.reports) < overallRoundCap(input.roundCap)
  );
}

/**
 * Why the pull request may not merge automatically, CI aside: each
 * condition of the gate that fails, as a phrase. Empty when every one
 * holds.
 */
export function heldBack(input: GateInput): string[] {
  const reasons: string[] = [];
  const rounds = [...new Set(input.verdicts.map(({ round }) => round))];
  const { last, latest } = latestRound(input.verdicts);

  // Every required reviewer approved, in the latest round.
  if (input.reviewers.length === 0) {
    reasons.push("the Floor has no required reviewer to approve it");
  } else {
    const unapproved = input.reviewers.filter(
      ({ id }) =>
        !latest.some(
          ({ agentId, verdict }) =>
            agentId === id && verdict.verdict === "approve",
        ),
    );
    if (unapproved.length > 0) {
      reasons.push(
        `${names(unapproved.map(({ name }) => name))} ${unapproved.length === 1 ? "has" : "have"} not approved it`,
      );
    }
    // And approved the head it merges, not an earlier one.
    const before = approvedBefore(input);
    if (before.length > 0) {
      reasons.push(`commits were pushed after ${names(before)} approved it`);
    }
  }

  // No blocking comments remain.
  const blocking = latest.reduce(
    (count, { verdict }) =>
      count +
      verdict.comments.filter(({ severity }) => severity === "blocking").length,
    0,
  );
  if (blocking > 0) {
    reasons.push(
      `${plural(blocking, "blocking comment")} from round ${String(last)} ${blocking === 1 ? "remains" : "remain"}`,
    );
  }

  // Every cap was respected.
  if (rounds.length > input.roundCap) {
    reasons.push(
      `its Review Loop ran ${plural(rounds.length, "round")}, past the Round Cap of ${String(input.roundCap)}`,
    );
  }
  if (input.reports.length > qaRoundCap) {
    reasons.push(
      `QA ran ${plural(input.reports.length, "round")}, past QA's Round Cap of ${String(qaRoundCap)}`,
    );
  }
  const overall = overallRoundCap(input.roundCap);
  const total = roundsSoFar(input.verdicts, input.reports);
  if (total > overall) {
    reasons.push(
      `it had ${plural(total, "round")} of review and QA, past the overall cap of ${String(overall)}`,
    );
  }
  for (const reached of input.capsReached) {
    reasons.push(
      reached.agentName === undefined
        ? `a ${reached.period} Token Cap was reached on its work`
        : `${reached.agentName} reached a ${reached.period} Token Cap working on it`,
    );
  }
  return [...new Set(reasons)];
}

/** How a conclusion reads: "failed", "timed out"… */
const outcome = (conclusion: CheckRunConclusion | null): string => {
  switch (conclusion) {
    case "failure":
    case null:
      return "failed";
    case "timed_out":
      return "timed out";
    case "cancelled":
      return "was cancelled";
    case "action_required":
      return "needs action";
    case "stale":
      return "went stale";
    default:
      return conclusion;
  }
};

/** Why CI keeps the pull request from merging automatically, if it does. */
export function ciHeldBack(
  ci: CiState,
  waitedMinutes: number,
): string | undefined {
  switch (ci.state) {
    case "passed":
      return undefined;
    case "failed":
      return `CI check "${ci.failed.name}" ${outcome(ci.failed.conclusion)}`;
    case "none":
      return "no CI check ran on it";
    case "pending":
      return ci.running.length > 0
        ? `CI had not finished after ${plural(waitedMinutes, "minute")} (${names(ci.running.map(({ name }) => `"${name}"`))})`
        : `the required ${ci.missing.length === 1 ? "check" : "checks"} ${names(ci.missing.map((name) => `"${name}"`))} never ran`;
  }
}

/** The check run a Notice links as its CI run: a failed one, or the first. */
export function ciRunOf(ci: CiState): CheckRun | undefined {
  switch (ci.state) {
    case "failed":
      return ci.failed;
    case "passed":
      return ci.runs[0];
    case "pending":
      return ci.running[0];
    case "none":
      return undefined;
  }
}
