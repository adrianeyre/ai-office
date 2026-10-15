import { maxHandoffPart } from "../review/handoff.ts";
import type { HandoffSummary } from "../review/store.ts";
import type { DesignReport } from "./report.ts";

// The designer's Handoffs (PRD FR-26): back to the coder when the UI needs
// changes the designer did not make itself, with what to change; on to the
// next stage when it passes. Each is a short structured summary, never a
// transcript.

const part = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxHandoffPart
    ? trimmed
    : `${trimmed.slice(0, maxHandoffPart - 1)}…`;
};

const changes = (commits: number): string =>
  commits === 0
    ? ""
    : ` The designer committed ${String(commits)} ${commits === 1 ? "change" : "changes"} of its own on the branch.`;

/** The designer's Handoff back to the coder, with changes to make. */
export function designChangesHandoff(input: {
  readonly round: number;
  readonly roundCap: number;
  readonly designer: string;
  readonly report: DesignReport;
  /** Commits the designer made itself. */
  readonly committed: number;
}): HandoffSummary {
  const { round, roundCap, designer, report, committed } = input;
  const left = roundCap - round;
  return {
    changed: part(
      `Design round ${String(round)} of ${String(roundCap)}: ${designer} reviewed the UI against the style guide. ${report.summary}`,
    ),
    check: part(
      `Make the design changes asked for, and only those: ${report.findings === "" ? "see what the designer found." : report.findings}`,
    ),
    risks: part(
      `${left === 1 ? "One round of design review is left: if it still asks for changes, the pull request goes to the Owner." : `${String(left)} rounds of design review are left before the pull request goes to the Owner.`}${changes(committed)}${committed === 0 ? "" : " Keep them."}`,
    ),
  };
}

/** The designer's Handoff on to the next stage, when the UI passes. */
export function designPassedHandoff(input: {
  readonly round: number;
  readonly designer: string;
  readonly report: DesignReport;
  readonly committed: number;
  /** QA's Handoff, which the designer took. */
  readonly qa: HandoffSummary | undefined;
}): HandoffSummary {
  const { round, designer, report, committed, qa } = input;
  return {
    changed: part(
      `${designer} passed the design review in round ${String(round)}: ${report.summary}${changes(committed)}${
        qa === undefined ? "" : ` ${qa.changed}`
      }`,
    ),
    check: part(qa?.check ?? "That the change does what its issue asks."),
    risks: part(qa?.risks ?? "None reported."),
  };
}
