import type { EventBus } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import {
  grillingAdrDirectory,
  grillingIssuesTurnSchema,
  grillingPrdDirectory,
  grillingWritesDocuments,
  intakeLabel,
  issueFilingOrder,
  maxGrillingIssues,
  pipelineLabels,
  type GrillingFiledIssue,
  type GrillingIssueDraft,
  type GrillingIssues,
  type GrillingIssuesTurn,
} from "@ai-office/shared";

import type { FloorRecord } from "../floors/store.ts";
import { parseAnswer, type ParsedAnswer } from "../review/verdict.ts";
import { sessionTitle, slugOf } from "./documents.ts";
import { numbersInWords, type GrillingSessionRecord } from "./session.ts";
import type { GrillingStore } from "./store.ts";

// A Grilling Session's issues (PRD FR-81, §5 scenario 8). Once the session
// has ended and its documents' pull request is open, the Manager's Model
// drafts the GitHub issues that build what it settled: vertical slices,
// each with "What to build", acceptance criteria, the earlier issues it is
// blocked by, and the PRD sections and ADRs it cites, as one JSON object.
// Plain code keeps them as drafts with the session (`draftIssues`): only
// citations of the session's own sections and ADRs, and only earlier
// issues as blockers, so they can always be filed in order. The Owner
// edits, reorders, merges and drops the drafts, then approves them; AI
// Office, as the GitHub App, then files them (`createGrillingIssues`):
// each after the drafts it is blocked by, labelled `ai-office`, its
// "Blocked by" naming the issue numbers filed for them. Each issue filed
// is recorded with its draft at once, and a `grilling.issue_filed` event
// records it, so filing again after a failure files only the rest. Nothing
// starts on its own: intake leaves issues the App opened alone, and the
// Owner hands them to the Manager as a Batch ("complete issues 5 to 7"),
// which takes them as the Owner's (`approvedIssues`).

/** Reads the Manager's answer as its draft issues. */
export const parseGrillingIssues = (
  answer: string,
): ParsedAnswer<GrillingIssuesTurn> =>
  parseAnswer(answer, grillingIssuesTurnSchema);

/** `"Problem", "Requirements"`. */
const quoted = (items: readonly string[]): string =>
  items.length === 0 ? "" : items.map((item) => `"${item}"`).join(", ");

/** What the Model is asked for to draft the issues, after the session section. */
export function grillingIssuesInstructions(
  session: GrillingSessionRecord,
): string[] {
  const pullRequest = session.documents?.pullRequest;
  const breakdown = !grillingWritesDocuments(session.skill);
  return [
    "## Draft the issues",
    "",
    breakdown
      ? "The Grilling Session has ended: the Owner approved the breakdown it settled. Now draft exactly those issues, from the plan to break down and the settled decisions. The Owner reviews them first: they can edit, reorder, merge or drop them, and AI Office files them once approved, labelled `ai-office`, ready to become a Batch."
      : `The Grilling Session has ended${pullRequest == null ? "" : `, and pull request #${String(pullRequest.number)} proposes its documents`}. Now draft the GitHub issues that build what it settled. The Owner reviews them first: they can edit, reorder, merge or drop them, and AI Office files them once approved, labelled \`ai-office\`, ready to become a Batch.`,
    "",
    "- Each issue is a vertical slice: a thin piece of the feature that works end to end, through every layer it needs, and can be built, reviewed and merged on its own. Never one layer of the system on its own.",
    "- List them in the order they should be built, each after the issues it is blocked by.",
    breakdown
      ? "- Build only what the plan and the settled decisions say; what they leave out stays out. Avoid specific file paths and code snippets: they go stale fast."
      : "- Build only what the settled decisions and the PRD's outline say; what they leave out stays out.",
    "",
    "Answer with only one JSON object, in this form:",
    "",
    "```json",
    JSON.stringify(
      {
        message: "A sentence or two to the Owner, or empty.",
        issues: [
          {
            title: "Short and imperative",
            whatToBuild: "What this slice builds, end to end.",
            acceptanceCriteria: ["A check that says when it is done."],
            blockedBy: [],
            prdSections: [session.outline[0]?.heading ?? "A section"],
            adrs: [],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    `- \`issues\`: at most ${String(maxGrillingIssues)}, each with a \`title\`, \`whatToBuild\` and at least one acceptance criterion, each one something a reviewer can check.`,
    "- `blockedBy`: the positions in your list (1 for the first) of earlier issues that must be merged before this one can start. Leave it empty when it can start at once; only earlier issues count.",
    session.outline.length === 0
      ? "- `prdSections`: the PRD has no sections yet, so leave it empty."
      : `- \`prdSections\`: the headings of the PRD's sections it builds, from: ${quoted(session.outline.map(({ heading }) => heading))}.`,
    session.adrs.length === 0
      ? "- `adrs`: the session wrote no ADRs, so leave it empty."
      : `- \`adrs\`: the titles of the ADRs it follows, from: ${quoted(session.adrs.map(({ title }) => title))}.`,
    "- Never put a credential, a token or a secret in your answer.",
  ];
}

/** `items` once each, case aside, as `known` spells them; unknown ones left out. */
const citations = (
  items: readonly string[],
  known: readonly string[],
): string[] => {
  const byKey = new Map(known.map((name) => [name.trim().toLowerCase(), name]));
  return [
    ...new Set(
      items.flatMap((item) => {
        const name = byKey.get(item.trim().toLowerCase());
        return name === undefined ? [] : [name];
      }),
    ),
  ];
};

/**
 * The Manager's draft, kept as the session's issues: numbered 1 on in its
 * order, each blocked only by earlier ones, citing only the session's own
 * PRD sections and ADRs.
 */
export function draftIssues(
  turn: GrillingIssuesTurn,
  session: Pick<GrillingSessionRecord, "outline" | "adrs">,
  at: Date,
): GrillingIssues {
  const headings = session.outline.map(({ heading }) => heading);
  const titles = session.adrs.map(({ title }) => title);
  return {
    drafts: turn.issues.map((issue, index) => ({
      id: index + 1,
      title: issue.title,
      whatToBuild: issue.whatToBuild,
      acceptanceCriteria: [...issue.acceptanceCriteria],
      blockedBy: [...new Set(issue.blockedBy)]
        .filter((other) => other <= index)
        .sort((a, b) => a - b),
      prdSections: citations(issue.prdSections, headings),
      adrs: citations(issue.adrs, titles),
      filed: null,
    })),
    draftedAt: at.toISOString(),
    approvedAt: null,
    problem: null,
  };
}

/** "Export button (blocked by 1 and 2)". */
const draftLine = (
  draft: GrillingIssueDraft,
  drafts: readonly GrillingIssueDraft[],
) => {
  const position = (id: number) =>
    drafts.findIndex((other) => other.id === id) + 1;
  return `${draft.title}${draft.blockedBy.length === 0 ? "" : ` (blocked by ${numbersInWords(draft.blockedBy.map(position).sort((a, b) => a - b))})`}`;
};

/** What the chat says once the Manager has drafted the issues. */
export function issuesDraftedText(
  message: string,
  session: Pick<GrillingSessionRecord, "id" | "topic">,
  issues: GrillingIssues,
): string {
  const count = issues.drafts.length;
  return [
    ...(message.trim() === "" ? [] : [message.trim(), ""]),
    `Drafted ${String(count)} ${count === 1 ? "issue" : "issues"} from the ${sessionTitle(session)}:`,
    "",
    ...issues.drafts.map(
      (draft, index) =>
        `${String(index + 1)}. ${draftLine(draft, issues.drafts)}`,
    ),
    "",
    `Edit, reorder, merge or drop them under Issues when you read the session in the Grilling Sessions list. When they are right, approve them there, or reply "file the issues of session ${String(session.id)}": the GitHub App files them in order, labelled ${intakeLabel}, ready to become a Batch.`,
  ].join("\n");
}

/** "complete issues 5 to 7", or "complete issues 5, 7 and 9". */
export const batchCommand = (numbers: readonly number[]): string => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const first = sorted[0] ?? 0;
  const last = sorted.at(-1) ?? 0;
  if (sorted.length === 1) {
    return `complete issue ${String(first)}`;
  }
  return sorted.every((number, index) => number === first + index)
    ? `complete issues ${String(first)} to ${String(last)}`
    : `complete issues ${numbersInWords(sorted)}`;
};

/** What the chat says once the issues are filed, or why some are not. */
export function issuesFiledText(
  session: Pick<GrillingSessionRecord, "id" | "topic">,
  issues: GrillingIssues,
): string {
  const filed = issues.drafts.flatMap((draft) =>
    draft.filed === null ? [] : [{ draft, filed: draft.filed }],
  );
  const byId = new Map(issues.drafts.map((draft) => [draft.id, draft]));
  const lines = filed
    .sort((a, b) => a.filed.number - b.filed.number)
    .map(({ draft, filed: issue }) => {
      const blockers = draft.blockedBy
        .flatMap((id) => {
          const number = byId.get(id)?.filed?.number;
          return number === undefined ? [] : [number];
        })
        .sort((a, b) => a - b)
        .map((number) => `#${String(number)}`);
      return `- #${String(issue.number)} ${draft.title}${blockers.length === 0 ? "" : ` (blocked by ${blockers.join(", ")})`}: ${issue.url}`;
    });
  const all = issues.drafts.length;
  if (issues.problem !== null) {
    return [
      `Filed ${String(filed.length)} of the ${String(all)} issues of the ${sessionTitle(session)}, then filing stopped: ${issues.problem}`,
      ...(lines.length === 0 ? [] : ["", ...lines]),
      "",
      `Reply "file the issues of session ${String(session.id)}" to file the rest; those filed are not filed again.`,
    ].join("\n");
  }
  return [
    `Filed the ${String(all)} ${all === 1 ? "issue" : "issues"} of the ${sessionTitle(session)} on GitHub, labelled ${intakeLabel}, each after those it is blocked by:`,
    "",
    ...lines,
    "",
    `${all === 1 ? "It is" : "They are"} ready to become a Batch: say "${batchCommand(filed.map(({ filed: issue }) => issue.number))}".`,
  ].join("\n");
}

/** Where the session's documents are, to cite: its PRD, and each ADR by title. */
const citedPaths = (session: GrillingSessionRecord) => {
  const files = session.documents?.files ?? [];
  return {
    prd: files.find((path) => path.startsWith(`${grillingPrdDirectory}/`)),
    adr: (title: string) =>
      files.find(
        (path) =>
          path.startsWith(`${grillingAdrDirectory}/`) &&
          path.endsWith(`-${slugOf(title) || "decision"}.md`),
      ),
  };
};

/**
 * An issue's body, in the form the Floor's issues take: its context, what
 * to build, acceptance criteria as a checklist, "Blocked by" with the
 * issues filed for the drafts it waits on, and the documents it cites.
 */
export function issueBody(
  draft: GrillingIssueDraft,
  context: {
    readonly session: GrillingSessionRecord;
    readonly manager: string;
    /** The issue filed for each draft it is blocked by. */
    readonly blockedBy: readonly number[];
  },
): string {
  const { session } = context;
  const pullRequest = session.documents?.pullRequest;
  const paths = citedPaths(session);
  const cites = [
    ...(draft.prdSections.length === 0
      ? []
      : [
          `- PRD${paths.prd === undefined ? "" : ` \`${paths.prd}\``}: ${draft.prdSections.map((heading) => `§ ${heading}`).join(", ")}`,
        ]),
    ...draft.adrs.map((title) => {
      const path = paths.adr(title);
      return `- ADR${path === undefined ? "" : ` \`${path}\``}: ${title}`;
    }),
    // What `/to-tickets` broke down.
    ...session.sources.flatMap(({ path, content }) =>
      content === null ? [] : [`- \`${path}\``],
    ),
  ];
  return [
    "## Context",
    "",
    `Drafted by ${context.manager}, the Floor's Manager, from the ${sessionTitle(session)}, and approved by the Owner.${pullRequest == null ? "" : ` Its documents are in pull request #${String(pullRequest.number)}.`}`,
    "",
    "## What to build",
    "",
    draft.whatToBuild.trim(),
    "",
    "## Acceptance criteria",
    "",
    ...draft.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Blocked by",
    "",
    ...(context.blockedBy.length === 0
      ? ["None: it can start at once."]
      : context.blockedBy.map((number) => `- #${String(number)}`)),
    ...(cites.length === 0 ? [] : ["", "## Cites", "", ...cites]),
    "",
  ].join("\n");
}

export interface GrillingIssuesOptions {
  /** The GitHub App: it files the issues. */
  readonly github: GitHubApp;
  readonly events: EventBus;
  readonly now?: () => Date;
}

export interface FileIssuesInput {
  readonly floor: Pick<FloorRecord, "id" | "repository">;
  /** The Manager, who drafted them. */
  readonly manager: { readonly id: string; readonly name: string };
  /** The session, with the drafts the Owner approved. */
  readonly session: GrillingSessionRecord;
  /** Keeps the issues as they stand, after each one is filed. */
  readonly record: (issues: GrillingIssues) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface GrillingIssuesFiler {
  /**
   * Files the session's drafts not filed yet, each after the drafts it is
   * blocked by, labelled `ai-office`. It never rejects for GitHub: when an
   * issue cannot be filed it stops, answering the issues as they stand
   * with `problem` saying why, and filing again files only the rest.
   */
  file(input: FileIssuesInput): Promise<GrillingIssues>;
}

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

export function createGrillingIssues(
  options: GrillingIssuesOptions,
): GrillingIssuesFiler {
  const { github, events } = options;
  const now = options.now ?? (() => new Date());
  const label = pipelineLabels.find(({ name }) => name === intakeLabel);
  return {
    async file({ floor, manager, session, record, signal }) {
      const issues = session.issues;
      const order =
        issues === null ? undefined : issueFilingOrder(issues.drafts);
      if (issues === null || order === undefined) {
        throw new Error(
          `The ${sessionTitle(session)} has no issues that can be filed.`,
        );
      }
      let current: GrillingIssues = {
        ...issues,
        approvedAt: issues.approvedAt ?? now().toISOString(),
        problem: null,
      };
      const client = github.repository(floor.repository);
      try {
        if (label !== undefined) {
          await client.ensureLabel(label);
        }
        for (const { id } of order) {
          const draft = current.drafts.find((each) => each.id === id);
          if (draft?.filed !== null) {
            continue;
          }
          signal?.throwIfAborted();
          const filedFor = new Map(
            current.drafts.map((each) => [each.id, each.filed]),
          );
          const blockedBy = draft.blockedBy
            .flatMap((other) => {
              const number = filedFor.get(other)?.number;
              return number === undefined ? [] : [number];
            })
            .sort((a, b) => a - b);
          const issue = await client.createIssue({
            title: draft.title,
            body: issueBody(draft, {
              session,
              manager: manager.name,
              blockedBy,
            }),
            labels: [intakeLabel],
          });
          const filed: GrillingFiledIssue = {
            number: issue.number,
            url: issue.htmlUrl,
          };
          current = {
            ...current,
            drafts: current.drafts.map((each) =>
              each.id === id ? { ...each, filed } : each,
            ),
          };
          // Kept at once, so filing again never files it twice.
          await record(current);
          await events.publish({
            type: "grilling.issue_filed",
            version: 1,
            floorId: floor.id,
            agentId: manager.id,
            sessionId: session.id,
            issue: issue.number,
            title: draft.title,
            url: issue.htmlUrl,
            blockedBy,
          });
        }
      } catch (error) {
        signal?.throwIfAborted();
        current = { ...current, problem: reasonOf(error).slice(0, 500) };
      }
      await record(current);
      return current;
    },
  };
}

/**
 * The issues the GitHub App filed on the Floor as the Owner approved them
 * in its Grilling Sessions (FR-81): a Batch takes them as the Owner's,
 * though the App opened them.
 */
export async function approvedIssues(
  store: Pick<GrillingStore, "list">,
  floorId: string,
): Promise<ReadonlySet<number>> {
  return new Set(
    (await store.list(floorId)).flatMap(
      ({ issues }) =>
        issues?.drafts.flatMap(({ filed }) =>
          filed === null ? [] : [filed.number],
        ) ?? [],
    ),
  );
}
