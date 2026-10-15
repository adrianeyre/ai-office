import type { EventType, StoredEvent } from "@ai-office/events";
import {
  whiteboardPath,
  type ConnectionRules,
  type DetailLevel,
  type MessageKind,
  type NoticeKind,
  type OutboundMessage,
} from "@ai-office/shared";

// The deterministic templates (PRD FR-90, FR-92): every ordinary message
// is made from an event and what AI Office knows of it, never by a model.
// Each has a title, a Floor, a kind, and links to it in AI Office and on
// GitHub; never a credential, code, a diff or an issue's body (FR-95).

/** A Notice, as much as a message tells of it. */
export interface NoticeView {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly floorId: string | null;
  readonly issue: { readonly url: string } | null;
  readonly pullRequest: { readonly url: string } | null;
  readonly ciRunUrl: string | null;
  readonly links: readonly { readonly label: string; readonly url: string }[];
}

/** What the templates read beyond the event. */
export interface MessageSources {
  /** Where AI Office is reached (PUBLIC_URL). */
  readonly publicUrl: string;
  /** A Floor's name; undefined when it has none. */
  floorName(floorId: string): Promise<string | undefined>;
  notice(noticeId: string): Promise<NoticeView | undefined>;
}

/** Which rule lets a message through (FR-92). */
export type Trigger = keyof Pick<
  ConnectionRules,
  "actionNotices" | "infoNotices" | "workComplete"
>;

/** The events a message is ever made from. */
export const triggerEventTypes: readonly EventType[] = [
  "notice.raised",
  "pull_request.merged",
  "batch.finished",
];

/** A message made from an event, and what decides who is sent it. */
export interface EventMessage {
  readonly trigger: Trigger;
  /**
   * What came of it, for a Digest: `merged` (a pull request) or `finished`
   * (a Batch), for work complete; `raised`, for a Notice.
   */
  readonly outcome: "raised" | "merged" | "finished";
  /** The Floor it is about, for each Connection's Floor filter. */
  readonly floorId: string | null;
  /**
   * The Connection a "Connection failing" Notice is about, which is never
   * sent it (FR-94).
   */
  readonly aboutConnectionId: string | null;
  readonly message: Omit<OutboundMessage, "occurredAt">;
}

/** An address in AI Office. */
export const officeUrl = (publicUrl: string, path: string): string =>
  `${publicUrl.replace(/\/+$/, "")}${path}`;

/** A Connection's place on the Connections page. */
export const connectionPath = (connectionId: string): string =>
  `/general-settings/connections?connection=${encodeURIComponent(connectionId)}`;

/** The Connection a Notice is about, from its link to the Connections page. */
export function connectionOfNotice(notice: NoticeView): string | undefined {
  for (const { url } of notice.links) {
    try {
      const parsed = new URL(url);
      const connectionId = parsed.searchParams.get("connection");
      // `/admin/connections` is where Notices raised before General
      // Settings had its own address link to.
      if (
        (parsed.pathname === "/general-settings/connections" ||
          parsed.pathname === "/admin/connections") &&
        connectionId !== null
      ) {
        return connectionId;
      }
    } catch {
      // Not an address: not a Connection's.
    }
  }
  return undefined;
}

const titled = (title: string): string =>
  title.length <= 300 ? title : `${title.slice(0, 299)}…`;

const floorOf = async (
  sources: MessageSources,
  floorId: string | null,
): Promise<OutboundMessage["floor"]> =>
  floorId === null
    ? null
    : { id: floorId, name: (await sources.floorName(floorId)) ?? floorId };

/** The message `stored` makes, if it makes one. */
export async function messageFor(
  stored: StoredEvent,
  sources: MessageSources,
): Promise<EventMessage | undefined> {
  const { event } = stored;
  switch (event.type) {
    case "notice.raised": {
      const notice = await sources.notice(event.noticeId);
      const floorId = notice?.floorId ?? event.floorId ?? null;
      return {
        trigger: event.kind === "action" ? "actionNotices" : "infoNotices",
        outcome: "raised",
        floorId,
        aboutConnectionId:
          notice === undefined ? null : (connectionOfNotice(notice) ?? null),
        message: {
          kind: event.kind === "action" ? "action_notice" : "info_notice",
          title: titled(event.title),
          floor: await floorOf(sources, floorId),
          aiOfficeUrl: officeUrl(
            sources.publicUrl,
            `/notices?notice=${encodeURIComponent(event.noticeId)}`,
          ),
          githubUrl:
            notice?.pullRequest?.url ??
            notice?.issue?.url ??
            notice?.ciRunUrl ??
            null,
        },
      };
    }
    case "pull_request.merged": {
      // Merging its pull request closes the issue (`Closes #N`, FR-21).
      const closes =
        event.issue === event.pullRequest
          ? ""
          : `, closing issue #${String(event.issue)}`;
      return {
        trigger: "workComplete",
        outcome: "merged",
        floorId: event.floorId,
        aboutConnectionId: null,
        message: {
          kind: "work_complete",
          title: titled(
            `Pull request #${String(event.pullRequest)} merged${closes}`,
          ),
          floor: await floorOf(sources, event.floorId),
          aiOfficeUrl: officeUrl(
            sources.publicUrl,
            `/activity?floorId=${encodeURIComponent(event.floorId)}&issue=${String(event.issue)}`,
          ),
          githubUrl: event.url,
        },
      };
    }
    case "batch.finished": {
      // The Wrap-up's results, in counts (FR-25.6, FR-92).
      const all = event.issues.length;
      const parts = [
        `${String(event.merged)} of ${String(all)} issue${all === 1 ? "" : "s"} merged`,
        ...(event.closed > 0 ? [`${String(event.closed)} closed`] : []),
        ...(event.blocked > 0 ? [`${String(event.blocked)} blocked`] : []),
        ...(event.notStarted > 0
          ? [`${String(event.notStarted)} not started`]
          : []),
      ];
      return {
        trigger: "workComplete",
        outcome: "finished",
        floorId: event.floorId,
        aboutConnectionId: null,
        message: {
          kind: "work_complete",
          title: titled(
            `Batch ${String(event.batchId)} finished: ${parts.join(", ")}`,
          ),
          floor: await floorOf(sources, event.floorId),
          aiOfficeUrl: officeUrl(
            sources.publicUrl,
            whiteboardPath(event.floorId, event.batchId),
          ),
          githubUrl: null,
        },
      };
    }
    default:
      return undefined;
  }
}

/** Whether `made` is about a Floor a Connection with `rules` is told of. */
export const passesFloors = (
  rules: ConnectionRules,
  made: Pick<EventMessage, "floorId">,
): boolean =>
  made.floorId === null ||
  rules.floorIds.length === 0 ||
  rules.floorIds.includes(made.floorId);

/** Whether a Connection with `rules` is sent `made`. */
export const passesRules = (
  rules: ConnectionRules,
  made: Pick<EventMessage, "trigger" | "floorId">,
): boolean => rules[made.trigger] && passesFloors(rules, made);

/** What a "links only" message says in place of its title. */
const linksOnlyTitles: Record<MessageKind, string> = {
  action_notice: "New action Notice",
  info_notice: "New info Notice",
  work_complete: "Work complete",
  digest: "Digest",
  test: "Test message from AI Office: this Connection works",
  report: "Wrap-up report",
  changelog: "Pull request merged",
  work_log: "Issue completed",
  batch_started: "Batch started",
  batch_finished: "Batch finished",
};

/**
 * `message` at a Connection's detail level (FR-95). "Titles and
 * summaries" sends it whole; "links only" sends its kind and its links,
 * without its title, its Floor's name or a summary; a work log's row keeps
 * its links and numbers, without the issue's title or the Agents' names.
 */
export function atDetailLevel(
  message: OutboundMessage,
  detailLevel: DetailLevel,
): OutboundMessage {
  if (detailLevel === "titles_and_summaries") {
    return message;
  }
  return {
    kind: message.kind,
    title: linksOnlyTitles[message.kind],
    floor: null,
    aiOfficeUrl: message.aiOfficeUrl,
    githubUrl: message.githubUrl,
    occurredAt: message.occurredAt,
    ...(message.workLog === undefined
      ? {}
      : {
          workLog: {
            issue: message.workLog.issue,
            pullRequest: message.workLog.pullRequest,
            agents: [],
            reviewRounds: message.workLog.reviewRounds,
            tokens: message.workLog.tokens,
            estimatedCostUsd: message.workLog.estimatedCostUsd,
          },
        }),
  };
}

/** The message "Send test" sends. */
export const testMessage = (
  publicUrl: string,
  connectionId: string,
  at: Date,
): OutboundMessage => ({
  kind: "test",
  title: "Test message from AI Office: this Connection works",
  floor: null,
  aiOfficeUrl: officeUrl(publicUrl, connectionPath(connectionId)),
  githubUrl: null,
  occurredAt: at.toISOString(),
});
