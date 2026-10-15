import type { StoredEvent } from "@ai-office/events";
import {
  whiteboardPath,
  type DetailLevel,
  type OutboundMessage,
} from "@ai-office/shared";

import { atDetailLevel, officeUrl } from "./messages.ts";
import {
  reportCounts,
  reportMarkdown,
  reportTitle,
  type BatchReport,
} from "./report.ts";

// What publishing destinations are sent (PRD FR-92): each finished
// Batch's Wrap-up report, from `batch.finished` and the Batch's Wrap-up
// as AI Office keeps it; and, for a running changelog, an entry for each
// pull request AI Office merged, from `pull_request.merged`. A work log
// (Google Sheets) is sent a row for each completed issue instead, from
// `pull_request.merged` (merging its pull request closes the issue) and
// what AI Office recorded of the issue. Like every message, each is made
// at its Connection's detail level and redacted (FR-95).

/** What publications are made from, beyond the event. */
export interface PublicationSources {
  /** Where AI Office is reached (PUBLIC_URL). */
  readonly publicUrl: string;
  readonly floorName: (floorId: string) => Promise<string | undefined>;
  /** A finished Batch, for its Wrap-up report; undefined when it has none. */
  readonly batchReport?: (
    floorId: string,
    batchId: number,
  ) => Promise<BatchReport | undefined>;
  /** An issue's title as AI Office knows it (redacted), for a changelog entry. */
  readonly issueTitle?: (
    floorId: string,
    issue: number,
  ) => Promise<string | undefined>;
  /** What AI Office recorded of a completed issue, for its work log row. */
  readonly completedIssue?: (
    floorId: string,
    issue: number,
  ) => Promise<CompletedIssue | undefined>;
}

/**
 * A completed issue, as its work log row tells it (FR-92), from AI
 * Office's own records: never GitHub, which the Communications Agent has
 * no access to.
 */
export interface CompletedIssue {
  /** Its title, as intake read it (redacted); null when unknown. */
  readonly title: string | null;
  /** The names of the Agents that worked it, in the order they began. */
  readonly agents: readonly string[];
  /** Its Review Loop's rounds. */
  readonly reviewRounds: number;
  /** The tokens its model calls used, and their estimated cost. */
  readonly tokens: number;
  readonly estimatedCostUsd: number;
}

/** What an event publishes, before any Connection's detail level. */
export type Publication =
  | {
      readonly kind: "report";
      readonly floorId: string;
      readonly report: BatchReport;
      /** The Wrap-up on the Floor's whiteboard. */
      readonly aiOfficeUrl: string;
    }
  | {
      readonly kind: "changelog";
      readonly floorId: string;
      /** The entry, with titles. */
      readonly message: Omit<OutboundMessage, "occurredAt">;
    };

/** The events a publication is ever made from. */
export const publicationEventTypes = [
  "batch.finished",
  "pull_request.merged",
] as const;

/** A completed issue's row, before any Connection's detail level. */
export interface WorkLogPublication {
  readonly floorId: string;
  readonly message: Omit<OutboundMessage, "occurredAt">;
}

/** The issue a pull request closes, on GitHub, from the pull request's address. */
const issueUrlOf = (pullRequestUrl: string, issue: number): string =>
  pullRequestUrl.replace(/\/pull\/\d+\/?$/, `/issues/${String(issue)}`);

/** The work log row `stored` makes, if it makes one: a completed issue's. */
export async function workLogFor(
  stored: StoredEvent,
  sources: PublicationSources,
): Promise<WorkLogPublication | undefined> {
  const { event } = stored;
  if (event.type !== "pull_request.merged") {
    return undefined;
  }
  const record = await sources.completedIssue?.(event.floorId, event.issue);
  const title = record?.title ?? null;
  return {
    floorId: event.floorId,
    message: {
      kind: "work_log",
      title: `Issue #${String(event.issue)} completed${
        title === null ? "" : `: ${title}`
      }`.slice(0, 300),
      floor: {
        id: event.floorId,
        name: (await sources.floorName(event.floorId)) ?? event.floorId,
      },
      aiOfficeUrl: officeUrl(
        sources.publicUrl,
        `/activity?floorId=${encodeURIComponent(event.floorId)}&issue=${String(event.issue)}`,
      ),
      githubUrl: event.url,
      workLog: {
        issue: { number: event.issue, url: issueUrlOf(event.url, event.issue) },
        ...(title === null ? {} : { title: title.slice(0, 300) }),
        pullRequest: { number: event.pullRequest, url: event.url },
        agents: (record?.agents ?? []).slice(0, 50),
        reviewRounds: record?.reviewRounds ?? 0,
        tokens: record?.tokens ?? 0,
        estimatedCostUsd: record?.estimatedCostUsd ?? 0,
      },
    },
  };
}

/** What `stored` publishes, if anything. */
export async function publicationFor(
  stored: StoredEvent,
  sources: PublicationSources,
): Promise<Publication | undefined> {
  const { event } = stored;
  switch (event.type) {
    case "batch.finished": {
      const report = await sources.batchReport?.(event.floorId, event.batchId);
      return report === undefined
        ? undefined
        : {
            kind: "report",
            floorId: event.floorId,
            report,
            aiOfficeUrl: officeUrl(
              sources.publicUrl,
              whiteboardPath(event.floorId, event.batchId),
            ),
          };
    }
    case "pull_request.merged": {
      const title = await sources.issueTitle?.(event.floorId, event.issue);
      const closes =
        event.issue === event.pullRequest
          ? ""
          : `, closing issue #${String(event.issue)}`;
      return {
        kind: "changelog",
        floorId: event.floorId,
        message: {
          kind: "changelog",
          title: `Pull request #${String(event.pullRequest)} merged${closes}${
            title === undefined ? "" : `: ${title}`
          }`.slice(0, 300),
          floor: {
            id: event.floorId,
            name: (await sources.floorName(event.floorId)) ?? event.floorId,
          },
          aiOfficeUrl: officeUrl(
            sources.publicUrl,
            `/activity?floorId=${encodeURIComponent(event.floorId)}&issue=${String(event.issue)}`,
          ),
          githubUrl: event.url,
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * A Wrap-up report's message at `detailLevel`: its title (without the
 * Floor's name at "links only"), its counts, and its Markdown with
 * `summary`. `report` and `summary` are redacted already, so nothing
 * escaping the Markdown splits a credential the redactor would match.
 */
export function reportMessage(
  report: BatchReport,
  detailLevel: DetailLevel,
  summary: string,
  aiOfficeUrl: string,
  occurredAt: Date,
): OutboundMessage {
  return {
    kind: "report",
    title: reportTitle(report, detailLevel),
    summary: `Batch ${String(report.batchId)} finished: ${reportCounts(report)}`,
    floor:
      detailLevel === "links_only"
        ? null
        : { id: report.floor.id, name: report.floor.name },
    aiOfficeUrl,
    githubUrl: null,
    occurredAt: occurredAt.toISOString(),
    document: reportMarkdown(report, detailLevel, summary, aiOfficeUrl),
  };
}

/** A changelog entry's message at `detailLevel`. */
export const changelogMessage = (
  message: Omit<OutboundMessage, "occurredAt">,
  detailLevel: DetailLevel,
  occurredAt: Date,
): OutboundMessage =>
  atDetailLevel(
    { ...message, occurredAt: occurredAt.toISOString() },
    detailLevel,
  );
