import type { StoredEvent } from "@ai-office/events";
import {
  whiteboardPath,
  wrapUpOutcomeLabels,
  type DetailLevel,
  type OutboundMessage,
} from "@ai-office/shared";

import { escapeMarkdown } from "./markdown.ts";
import { officeUrl } from "./messages.ts";
import type { PublicationSources } from "./publications.ts";
import { reportCounts, type BatchReport } from "./report.ts";

// What a calendar (Google Calendar) is sent (PRD FR-92): an event per
// Batch, made when the Batch starts (`batch.started`) and changed to its
// finish when it finishes (`batch.finished`), from the Wrap-up as AI Office
// keeps it. Its description links to the Batch's Plan on the Floor's
// whiteboard and, once it has finished, says its outcome: its counts, and
// each issue's outcome and pull request. Like every message it is made at
// its Connection's detail level and redacted (FR-95): at "links only" it
// has no Floor name and no issue title. Events for Notices are not sent.

/** The events a calendar's event is made from. */
export const calendarEventTypes = ["batch.started", "batch.finished"] as const;

/** A Batch's event, before any Connection's detail level. */
export type CalendarPublication =
  | {
      readonly kind: "started";
      readonly floorId: string;
      readonly floorName: string;
      readonly batchId: number;
      /** The Plan on the Floor's whiteboard. */
      readonly planUrl: string;
      readonly startedAt: Date;
      /** The issues whose work started with it. */
      readonly issues: readonly number[];
    }
  | {
      readonly kind: "finished";
      readonly floorId: string;
      readonly floorName: string;
      readonly batchId: number;
      readonly planUrl: string;
      /** Null when AI Office does not know. */
      readonly startedAt: Date | null;
      readonly finishedAt: Date;
      /** Its counts in words: "1 of 3 issues merged, 1 blocked". */
      readonly counts: string;
      readonly tokens: number;
      /** Its Wrap-up; null when AI Office no longer has it. */
      readonly report: BatchReport | null;
    };

/** The most a description says before it points to the Plan for the rest. */
const descriptionLimit = 6000;

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const list = (issues: readonly number[]): string => {
  const named = issues.map((issue) => `#${String(issue)}`);
  return named.length <= 1
    ? (named[0] ?? "")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
};

/** The calendar's event `stored` makes or changes, if any. */
export async function calendarPublicationFor(
  stored: StoredEvent,
  sources: PublicationSources,
): Promise<CalendarPublication | undefined> {
  const { event } = stored;
  if (event.type !== "batch.started" && event.type !== "batch.finished") {
    return undefined;
  }
  const floorName = (await sources.floorName(event.floorId)) ?? event.floorId;
  const planUrl = officeUrl(
    sources.publicUrl,
    whiteboardPath(event.floorId, event.batchId),
  );
  if (event.type === "batch.started") {
    return {
      kind: "started",
      floorId: event.floorId,
      floorName,
      batchId: event.batchId,
      planUrl,
      startedAt: stored.occurredAt,
      issues: event.issues,
    };
  }
  const report =
    (await sources.batchReport?.(event.floorId, event.batchId)) ?? null;
  return {
    kind: "finished",
    floorId: event.floorId,
    floorName: report?.floor.name ?? floorName,
    batchId: event.batchId,
    planUrl,
    startedAt: report?.startedAt ?? null,
    finishedAt: report?.finishedAt ?? stored.occurredAt,
    counts: reportCounts(report ?? { issues: event.issues, totals: event }),
    tokens: report?.totals.tokens ?? event.tokens,
    report,
  };
}

/** Each issue's outcome and pull request, as the description lists them. */
function issueLines(report: BatchReport, detailLevel: DetailLevel): string[] {
  return report.issues.map((issue) => {
    const link = `[#${String(issue.issue)}](https://github.com/${report.floor.repository}/issues/${String(issue.issue)})`;
    const named =
      detailLevel === "titles_and_summaries"
        ? `${link} ${escapeMarkdown(issue.title)}`
        : link;
    const pullRequest =
      issue.pullRequest === null
        ? ""
        : `, [PR #${String(issue.pullRequest.number)}](${issue.pullRequest.url})`;
    return `- ${named}: ${wrapUpOutcomeLabels[issue.outcome]}${pullRequest}`;
  });
}

/**
 * A Batch's event at `detailLevel`: its title, and its description in
 * Markdown, with a link to its Plan; once it has finished, its outcome.
 * `publication` is redacted already, so nothing escaping the Markdown
 * splits a credential the redactor would match.
 */
export function calendarMessage(
  publication: CalendarPublication,
  detailLevel: DetailLevel,
  occurredAt: Date,
): OutboundMessage {
  const titled = detailLevel === "titles_and_summaries";
  const batch = `Batch ${String(publication.batchId)}`;
  const name = titled
    ? `AI Office: ${batch} (${publication.floorName})`
    : `AI Office: ${batch}`;
  const on = titled
    ? `${batch} on ${escapeMarkdown(publication.floorName)}`
    : batch;
  const plan = `[Open the Plan in AI Office](${publication.planUrl})`;
  let title: string;
  let lines: string[];
  if (publication.kind === "started") {
    title = `${name}, in progress`;
    lines = [
      `${on} is in progress: ${
        publication.issues.length === 0
          ? "no issue was ready to start yet"
          : `work started on ${list(publication.issues)}`
      }.`,
      "",
      plan,
    ];
  } else {
    const { report } = publication;
    title = `${name}: ${publication.counts}`;
    const cost =
      report === null
        ? ""
        : `, about $${report.totals.estimatedCostUsd.toFixed(2)} (estimated)`;
    const head = `${on} finished: ${escapeMarkdown(publication.counts)}. ${publication.tokens.toLocaleString("en-GB")} tokens${cost}.`;
    const issues = report === null ? [] : issueLines(report, detailLevel);
    // Each issue while there is room, then the Plan for the rest.
    const kept: string[] = [];
    let length = head.length + plan.length;
    for (const line of issues) {
      if (length + line.length + 1 > descriptionLimit) {
        kept.push(
          `- …and ${plural(issues.length - kept.length, "more issue", "more issues")}: see the Plan`,
        );
        break;
      }
      kept.push(line);
      length += line.length + 1;
    }
    lines = [head, "", ...(kept.length === 0 ? [] : [...kept, ""]), plan];
  }
  return {
    kind: publication.kind === "started" ? "batch_started" : "batch_finished",
    title: title.length <= 300 ? title : `${title.slice(0, 299)}…`,
    floor: titled
      ? { id: publication.floorId, name: publication.floorName }
      : null,
    aiOfficeUrl: publication.planUrl,
    githubUrl: null,
    occurredAt: occurredAt.toISOString(),
    document: `${lines.join("\n")}\n`,
    calendar: {
      floorId: publication.floorId,
      batchId: publication.batchId,
      startedAt: publication.startedAt?.toISOString() ?? null,
      finishedAt:
        publication.kind === "finished"
          ? publication.finishedAt.toISOString()
          : null,
    },
  };
}
