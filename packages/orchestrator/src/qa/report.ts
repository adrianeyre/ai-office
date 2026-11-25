import { specCriterionId, type QaResult } from "@ai-office/shared";

import { withoutProposals } from "../memory/memory.ts";
import { maxHandoffPart } from "../review/handoff.ts";

// The QA Agent's report (PRD FR-28): it ends its run with a `<qa-report>`
// block, saying whether its checks pass, what it found, and for a failure
// the steps that reproduce it. It is the Agent's own text, so untrusted:
// only the block's parts are read, and each is cut to length. Entries it
// proposes for the repository's memory, between `<memory>` markers, and a
// Guideline it proposes, in a `<guideline>` block, are not part of it
// (`proposedMemory` and `proposedGuideline` read them).
//
// For an issue filed from a Spec (Guidelines, Specs and Hooks PRD,
// FR-116), the report also lists each of the issue's Acceptance Criteria
// by its id, passed or failed, under `Criteria:`. Every criterion the
// issue has is read from it, in the issue's order: one the report does
// not list, or lists with neither pass nor fail, has no test, so fails.
// Any criterion failed fails the round, whatever its `Result:` says. Ids
// the issue does not have are ignored.

/** How one Acceptance Criterion fared in QA. */
export interface QaCriterion {
  /** Its id, such as "R2.3". */
  readonly id: string;
  readonly result: QaResult;
  /** Whether it failed for having no test: not in the report, or neither passed nor failed. */
  readonly untested: boolean;
}

/** What QA found in one round. */
export interface QaReport {
  readonly result: QaResult;
  readonly summary: string;
  /** The steps that reproduce a failure; empty for a pass, or none given. */
  readonly steps: string;
  /**
   * Each of the issue's Acceptance Criteria, for an issue filed from a
   * Spec, in the issue's order; none for an issue from no Spec.
   */
  readonly criteria?: readonly QaCriterion[];
}

const part = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxHandoffPart
    ? trimmed
    : `${trimmed.slice(0, maxHandoffPart - 1)}…`;
};

/** An id in a report, and what follows it up to the next id. */
const mentions = /\b(R\d+\.\d+)\b([\s\S]*?)(?=\bR\d+\.\d+\b|$)/gi;
/** Passed or failed, as the first word after an id. */
const outcome =
  /^[\s:*_`~=>|()[\]\-\u2013\u2014]*(pass|fail)(?:ed|es|s|ing)?\b/i;

/**
 * Each of `ids` as a report's `Criteria:` part has it (FR-116): passed
 * only when it is listed as passed, and never as failed; failed when
 * listed as failed, or untested when it is not listed, or with neither.
 */
export function criteriaOf(
  part: string,
  ids: readonly string[],
): QaCriterion[] {
  const said = new Map<string, QaResult | "neither">();
  for (const [, id = "", after = ""] of part.matchAll(mentions)) {
    const key = id.toUpperCase();
    const found = outcome.exec(after)?.[1]?.toLowerCase();
    const result =
      found === "pass" ? "pass" : found === "fail" ? "fail" : "neither";
    const before = said.get(key);
    // A failure, said anywhere, outweighs a pass.
    said.set(
      key,
      before === "fail" || result === "fail"
        ? "fail"
        : before === "pass" || result === "pass"
          ? "pass"
          : "neither",
    );
  }
  const wanted = [...new Set(ids.map((id) => id.trim().toUpperCase()))];
  return wanted.map((id) => {
    const result = said.get(id);
    return result === "pass" || result === "fail"
      ? { id, result, untested: false }
      : { id, result: "fail", untested: true };
  });
}

/**
 * The last `<qa-report>` block in an Agent's text, from its `Result:`,
 * `Summary:` and `Steps:` lines (each running to the next); undefined when
 * there is none, or its result is neither pass nor fail. Given the issue's
 * Acceptance Criteria (for an issue filed from a Spec), it reads each from
 * the `Criteria:` part too, and fails the report if any fails.
 */
export function parseQaReport(
  text: string | null,
  criteria?: readonly string[],
): QaReport | undefined {
  const blocks = [
    ...(text ?? "").matchAll(/<qa-report>([\s\S]*?)<\/qa-report>/gi),
  ];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) {
    return undefined;
  }
  const block = withoutProposals(last);
  const found: Partial<
    Record<"result" | "summary" | "criteria" | "steps", string>
  > = {};
  let current: keyof typeof found | undefined;
  // `Criteria:` is a part only of the report on an issue from a Spec.
  const parts =
    criteria === undefined
      ? /^\s*[-*]?\s*(result|summary|steps)\s*:\s*(.*)$/i
      : /^\s*[-*]?\s*(result|summary|criteria|steps)\s*:\s*(.*)$/i;
  for (const line of block.split("\n")) {
    const start = parts.exec(line);
    if (start !== null) {
      current = start[1]?.toLowerCase() as keyof typeof found;
      found[current] = start[2] ?? "";
    } else if (current !== undefined) {
      found[current] = `${found[current] ?? ""}\n${line}`;
    }
  }
  const verdict = /^\W*(pass|fail)(?:ed|es|ing)?\b/i
    .exec(found.result?.trim() ?? "")?.[1]
    ?.toLowerCase();
  if (verdict !== "pass" && verdict !== "fail") {
    return undefined;
  }
  const ids = criteria?.flatMap((criterion) => {
    const id = specCriterionId(criterion);
    return id === undefined ? [] : [id];
  });
  const fared =
    ids === undefined ? undefined : criteriaOf(found.criteria ?? "", ids);
  // Any criterion failed, or untested, fails the round.
  const result =
    fared?.some(({ result: one }) => one === "fail") === true
      ? "fail"
      : verdict;
  const steps = part(found.steps ?? "");
  return {
    result,
    summary: part(found.summary ?? "") || "No summary given.",
    steps: result === "pass" || /^none\.?$/i.test(steps) ? "" : steps,
    ...(fared === undefined ? {} : { criteria: fared }),
  };
}
