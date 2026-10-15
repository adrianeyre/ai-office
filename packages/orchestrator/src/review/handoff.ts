import type { Rebase } from "../git/publish.ts";
import { withoutMemory } from "../memory/memory.ts";
import type { HandoffSummary, VerdictRecord } from "./store.ts";

// Handoffs in the Review Loop (PRD FR-26, FR-27): each carries a short
// structured summary (what changed, what to check, known risks), never a
// transcript. The coder writes its own at the end of its run, in a
// `<handoff>` block; whatever it leaves out is filled in from its commits.
// The reviewers' is written from their verdicts. Entries proposed for the
// repository's memory, between `<memory>` markers in the block, are not
// part of the summary (`proposedMemory` reads them).

/** The longest each part of a summary may be. */
export const maxHandoffPart = 2000;

const part = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= maxHandoffPart
    ? trimmed
    : `${trimmed.slice(0, maxHandoffPart - 1)}…`;
};

const labels = { changed: "changed", check: "check", risks: "risks" } as const;

/**
 * The parts of the last `<handoff>` block in an Agent's text, each from a
 * `Changed:`, `Check:` or `Risks:` line to the next, leaving out its
 * `<memory>` block.
 */
export function parseHandoff(text: string | null): Partial<HandoffSummary> {
  const blocks = [...(text ?? "").matchAll(/<handoff>([\s\S]*?)<\/handoff>/gi)];
  const last = blocks.at(-1)?.[1];
  const block = last === undefined ? undefined : withoutMemory(last);
  if (block === undefined) {
    return {};
  }
  const found: Partial<Record<keyof HandoffSummary, string>> = {};
  let current: keyof HandoffSummary | undefined;
  for (const line of block.split("\n")) {
    const start = /^\s*[-*]?\s*(changed|check|risks)\s*:\s*(.*)$/i.exec(line);
    if (start !== null) {
      current = labels[start[1]?.toLowerCase() as keyof typeof labels];
      found[current] = start[2] ?? "";
    } else if (current !== undefined) {
      found[current] = `${found[current] ?? ""}\n${line}`;
    }
  }
  return Object.fromEntries(
    Object.entries(found)
      .map(([key, value]) => [key, part(value)])
      .filter(([, value]) => value !== ""),
  ) as Partial<HandoffSummary>;
}

/** A blocking comment, with the reviewer who made it. */
export interface BlockingComment {
  readonly reviewer: string;
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** The blocking comments of a round's verdicts, in order. */
export const blockingComments = (
  verdicts: readonly VerdictRecord[],
  nameOf: (agentId: string) => string,
): BlockingComment[] =>
  verdicts.flatMap(({ agentId, verdict }) =>
    verdict.comments
      .filter(({ severity }) => severity === "blocking")
      .map(({ path, line, body }) => ({
        reviewer: nameOf(agentId),
        path,
        line,
        body,
      })),
  );

/** One blocking comment on one line. */
export const describeComment = (comment: BlockingComment): string =>
  `${comment.path} line ${String(comment.line)} (${comment.reviewer}): ${comment.body}`;

const names = (list: readonly string[]): string =>
  list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list.at(-1) ?? ""}`;

/** The coder's Handoff to the reviewers: its own words, or its commits'. */
export function coderHandoff(input: {
  /** The coder's last text, with its `<handoff>` block if it wrote one. */
  readonly text: string | null;
  /** The subjects of the commits it made. */
  readonly subjects: readonly string[];
  readonly issue: { readonly number: number; readonly title: string };
  /** The blocking comments it was asked to fix, on a later round. */
  readonly fixing: readonly BlockingComment[];
  /** What QA found failing, when it was fixing that instead. */
  readonly fixingQa?: string;
  /** What the designer asked to change, when it was making that instead. */
  readonly fixingDesign?: string;
  /** What rebasing it onto the default branch did, before review. */
  readonly rebase?: Rebase;
}): HandoffSummary {
  const own = parseHandoff(input.text);
  const { rebase } = input;
  const conflict =
    rebase?.outcome === "conflict"
      ? `It could not be rebased onto ${rebase.onto}, which has changed since the work began: ${rebase.files.join(", ")} conflict. It is reviewed as it is, and needs ${rebase.onto} merged in before it can merge.`
      : undefined;
  const commits = input.subjects.filter((subject) => subject !== "");
  return {
    changed:
      own.changed ??
      part(
        `${String(commits.length)} new ${commits.length === 1 ? "commit" : "commits"}${
          commits.length === 0 ? "." : `: ${commits.join("; ")}.`
        }`,
      ),
    check:
      own.check ??
      part(
        input.fixing.length > 0
          ? `That these blocking comments are fixed: ${input.fixing.map(describeComment).join("; ")}`
          : input.fixingQa !== undefined
            ? `That what QA found failing is fixed: ${input.fixingQa}`
            : input.fixingDesign !== undefined
              ? `That the design changes the designer asked for are made: ${input.fixingDesign}`
              : `That it does what #${String(input.issue.number)} asks: ${input.issue.title}`,
      ),
    risks:
      conflict === undefined
        ? (own.risks ?? "None reported.")
        : part(own.risks === undefined ? conflict : `${conflict} ${own.risks}`),
  };
}

/** The reviewers' Handoff back to the coder, after a round with blocking comments. */
export function reviewersHandoff(input: {
  readonly round: number;
  readonly roundCap: number;
  readonly verdicts: readonly VerdictRecord[];
  readonly nameOf: (agentId: string) => string;
}): HandoffSummary {
  const { round, roundCap, verdicts, nameOf } = input;
  const by = (kind: "approve" | "changes_requested") =>
    verdicts
      .filter(({ verdict }) => verdict.verdict === kind)
      .map(({ agentId }) => nameOf(agentId));
  const approvers = by("approve");
  const blocking = blockingComments(verdicts, nameOf);
  const nits = verdicts.reduce(
    (count, { verdict }) =>
      count +
      verdict.comments.filter(({ severity }) => severity === "nit").length,
    0,
  );
  const left = roundCap - round;
  return {
    changed: part(
      `Round ${String(round)} of ${String(roundCap)}: ${names(by("changes_requested"))} requested changes${
        approvers.length === 0 ? "" : `; ${names(approvers)} approved`
      }.`,
    ),
    check: part(
      `Fix ${blocking.length === 1 ? "this blocking comment" : `these ${String(blocking.length)} blocking comments`}, and only ${blocking.length === 1 ? "it" : "them"}: ${blocking
        .map(describeComment)
        .join("; ")}`,
    ),
    risks: part(
      `${nits === 0 ? "No nits were made." : `${String(nits)} ${nits === 1 ? "nit was" : "nits were"} left aside.`} ${
        left === 1
          ? "One round is left: if it still has blocking comments, the pull request goes to the Owner."
          : `${String(left)} rounds are left before the pull request goes to the Owner.`
      }`,
    ),
  };
}

/** The reviewers' Handoff on to the next stage, once every one approved. */
export function approvalHandoff(input: {
  readonly round: number;
  readonly verdicts: readonly VerdictRecord[];
  readonly nameOf: (agentId: string) => string;
  /** The coder's Handoff that the reviewers approved. */
  readonly coder: HandoffSummary | undefined;
}): HandoffSummary {
  const nits = input.verdicts.flatMap(({ agentId, verdict }) =>
    verdict.comments.map((comment) => ({
      ...comment,
      reviewer: input.nameOf(agentId),
    })),
  );
  return {
    changed: part(
      `Approved by ${names(input.verdicts.map(({ agentId }) => input.nameOf(agentId)))} in round ${String(input.round)} of the Review Loop.${
        input.coder === undefined ? "" : ` ${input.coder.changed}`
      }`,
    ),
    check: part(
      input.coder?.check ?? "That the change does what its issue asks.",
    ),
    risks: part(
      `${input.coder?.risks ?? "None reported."}${
        nits.length === 0
          ? ""
          : ` Nits left aside: ${nits.map(describeComment).join("; ")}`
      }`,
    ),
  };
}
