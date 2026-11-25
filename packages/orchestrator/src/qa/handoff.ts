import { maxHandoffPart } from "../review/handoff.ts";
import type { HandoffSummary } from "../review/store.ts";
import type { QaReport } from "./report.ts";

// QA's Handoffs (PRD FR-26, FR-28): back to the coder when its checks
// fail, with what fails and how to reproduce it; on to the next stage when
// they pass. Each is a short structured summary, never a transcript. For
// an issue filed from a Spec, the Handoff back names each Acceptance
// Criterion that failed, and each with no test (Guidelines, Specs and
// Hooks PRD, FR-116).

const part = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxHandoffPart
    ? trimmed
    : `${trimmed.slice(0, maxHandoffPart - 1)}…`;
};

const tests = (commits: number): string =>
  commits === 0
    ? ""
    : ` QA added ${String(commits)} ${commits === 1 ? "commit" : "commits"} of tests on the branch.`;

/** The criteria that failed their tests, and those with no test, by id. */
const failedCriteria = (report: QaReport): string => {
  const failed = (report.criteria ?? []).filter(
    ({ result }) => result === "fail",
  );
  if (failed.length === 0) {
    return "";
  }
  const tested = failed.filter(({ untested }) => !untested).map(({ id }) => id);
  const untested = failed
    .filter(({ untested: none }) => none)
    .map(({ id }) => id);
  return [
    ...(tested.length === 0
      ? []
      : [`Acceptance Criteria failing their tests: ${tested.join(", ")}.`]),
    ...(untested.length === 0
      ? []
      : [
          `Acceptance Criteria with no test: ${untested.join(", ")}; each needs a test of its own that passes.`,
        ]),
  ]
    .map((sentence) => ` ${sentence}`)
    .join("");
};

/** QA's Handoff back to the coder, when its checks fail. */
export function qaFailedHandoff(input: {
  readonly round: number;
  readonly roundCap: number;
  readonly qa: string;
  readonly report: QaReport;
  /** Commits of tests QA added. */
  readonly added: number;
}): HandoffSummary {
  const { round, roundCap, qa, report, added } = input;
  const left = roundCap - round;
  return {
    changed: part(
      `QA round ${String(round)} of ${String(roundCap)}: ${qa} found it failing. ${report.summary}`,
    ),
    check: part(
      `Fix what fails, and only that.${failedCriteria(report)} To reproduce: ${report.steps === "" ? "see what QA found." : report.steps}`,
    ),
    risks: part(
      `${left === 1 ? "One round of QA is left: if it still fails, the pull request goes to the Owner." : `${String(left)} rounds of QA are left before the pull request goes to the Owner.`}${tests(added)}${added === 0 ? "" : " Keep them."}`,
    ),
  };
}

/** QA's Handoff on to the next stage, when its checks pass. */
export function qaPassedHandoff(input: {
  readonly round: number;
  readonly qa: string;
  readonly report: QaReport;
  readonly added: number;
  /** The reviewers' Handoff that QA took. */
  readonly reviewers: HandoffSummary | undefined;
}): HandoffSummary {
  const { round, qa, report, added, reviewers } = input;
  return {
    changed: part(
      `${qa} passed QA in round ${String(round)}: ${report.summary}${tests(added)}${
        reviewers === undefined ? "" : ` ${reviewers.changed}`
      }`,
    ),
    check: part(
      reviewers?.check ?? "That the change does what its issue asks.",
    ),
    risks: part(reviewers?.risks ?? "None reported."),
  };
}
