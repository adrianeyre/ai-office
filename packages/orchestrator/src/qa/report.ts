import type { QaResult } from "@ai-office/shared";

import { withoutMemory } from "../memory/memory.ts";
import { maxHandoffPart } from "../review/handoff.ts";

// The QA Agent's report (PRD FR-28): it ends its run with a `<qa-report>`
// block, saying whether its checks pass, what it found, and for a failure
// the steps that reproduce it. It is the Agent's own text, so untrusted:
// only the block's parts are read, and each is cut to length. Entries it
// proposes for the repository's memory, between `<memory>` markers, are
// not part of it (`proposedMemory` reads them).

/** What QA found in one round. */
export interface QaReport {
  readonly result: QaResult;
  readonly summary: string;
  /** The steps that reproduce a failure; empty for a pass, or none given. */
  readonly steps: string;
}

const part = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxHandoffPart
    ? trimmed
    : `${trimmed.slice(0, maxHandoffPart - 1)}…`;
};

/**
 * The last `<qa-report>` block in an Agent's text, from its `Result:`,
 * `Summary:` and `Steps:` lines (each running to the next); undefined when
 * there is none, or its result is neither pass nor fail.
 */
export function parseQaReport(text: string | null): QaReport | undefined {
  const blocks = [
    ...(text ?? "").matchAll(/<qa-report>([\s\S]*?)<\/qa-report>/gi),
  ];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) {
    return undefined;
  }
  const block = withoutMemory(last);
  const found: Partial<Record<"result" | "summary" | "steps", string>> = {};
  let current: keyof typeof found | undefined;
  for (const line of block.split("\n")) {
    const start = /^\s*[-*]?\s*(result|summary|steps)\s*:\s*(.*)$/i.exec(line);
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
  const steps = part(found.steps ?? "");
  return {
    result: verdict,
    summary: part(found.summary ?? "") || "No summary given.",
    steps: verdict === "pass" || /^none\.?$/i.test(steps) ? "" : steps,
  };
}
