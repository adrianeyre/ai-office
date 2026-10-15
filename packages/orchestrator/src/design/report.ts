import type { DesignResult } from "@ai-office/shared";

import { withoutMemory } from "../memory/memory.ts";
import { maxHandoffPart } from "../review/handoff.ts";

// The designer Agent's report (PRD FR-10, FR-18): it ends its run with a
// `<design-review>` block, saying whether the pull request's UI passes the
// repository's style guide, what it found in its screenshots, and, when it
// has changes for the coder, what to change. It is the Agent's own text,
// so untrusted: only the block's parts are read, and each is cut to
// length. Entries it proposes for the repository's memory, between
// `<memory>` markers, are not part of it (`proposedMemory` reads them).

/** What a designer found in one round of design review. */
export interface DesignReport {
  readonly result: DesignResult;
  readonly summary: string;
  /** The changes it asks the coder for; empty for a pass, or none given. */
  readonly findings: string;
}

const part = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxHandoffPart
    ? trimmed
    : `${trimmed.slice(0, maxHandoffPart - 1)}…`;
};

/**
 * The last `<design-review>` block in an Agent's text, from its `Result:`,
 * `Summary:` and `Findings:` lines (each running to the next); undefined
 * when there is none, or its result is neither pass nor changes.
 */
export function parseDesignReport(
  text: string | null,
): DesignReport | undefined {
  const blocks = [
    ...(text ?? "").matchAll(/<design-review>([\s\S]*?)<\/design-review>/gi),
  ];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) {
    return undefined;
  }
  const block = withoutMemory(last);
  const found: Partial<Record<"result" | "summary" | "findings", string>> = {};
  let current: keyof typeof found | undefined;
  for (const line of block.split("\n")) {
    const start = /^\s*[-*]?\s*(result|summary|findings)\s*:\s*(.*)$/i.exec(
      line,
    );
    if (start !== null) {
      current = start[1]?.toLowerCase() as keyof typeof found;
      found[current] = start[2] ?? "";
    } else if (current !== undefined) {
      found[current] = `${found[current] ?? ""}\n${line}`;
    }
  }
  const verdict = /^\W*(pass|changes)(?:ed|es)?\b/i
    .exec(found.result?.trim() ?? "")?.[1]
    ?.toLowerCase();
  if (verdict !== "pass" && verdict !== "changes") {
    return undefined;
  }
  const findings = part(found.findings ?? "");
  return {
    result: verdict,
    summary: part(found.summary ?? "") || "No summary given.",
    findings: verdict === "pass" || /^none\.?$/i.test(findings) ? "" : findings,
  };
}
