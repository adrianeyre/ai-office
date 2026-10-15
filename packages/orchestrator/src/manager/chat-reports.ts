import type { EventBus, OfficeEvent } from "@ai-office/events";
import { whiteboardPath, wrapUpOutcomeLabels } from "@ai-office/shared";

import type { BatchRecord, BatchStore } from "../batches/store.ts";
import { wrapUpLine } from "../batches/wrap-up.ts";
import type { ManagerChat } from "./chat.ts";

// The Manager reporting back on the Owner's chat requests (PRD FR-24, ADR
// 0004), as a sub-agent's completion is told to the agent that spun it
// off. Each chat request's Batch is followed through the event log, and
// the Manager posts a short message into its chat, in answer to the
// request: when one of its issues is done (its pull request merged) or
// blocked (handed to the Owner at `needs-human`, which raises its Notice
// as ever), when one of its Contractors leaves, and its Wrap-up's summary
// once it finishes. A Contractor's arrival is said as it is added. This is
// plain code: no model is asked.

export interface ChatReportsOptions {
  readonly events: EventBus;
  readonly batches: Pick<BatchStore, "get" | "list" | "latestPlan">;
  readonly chat: Pick<ManagerChat, "postProgress">;
  /** Where AI Office is reached, for the Wrap-up's link to the whiteboard. */
  readonly publicUrl?: string;
  /** Told of a report that could not be posted. */
  readonly onError?: (error: unknown) => void;
}

export interface ChatReports {
  /** Starts following the event log; idempotent. */
  start(): void;
  stop(): void;
  /** Reports on one event, as following the log does: for tests. */
  handle(event: OfficeEvent): Promise<void>;
}

/** "#12 Add the status column". */
const named = (issue: number, title: string | undefined): string =>
  title === undefined || title === ""
    ? `#${String(issue)}`
    : `#${String(issue)} ${title}`;

/** How many of a Floor's latest Batches an issue is looked for in. */
const recentBatches = 50;

export function createChatReports(options: ChatReportsOptions): ChatReports {
  const { batches, chat } = options;
  const base = options.publicUrl?.replace(/\/$/, "");
  let unsubscribe: (() => void) | undefined;

  /** The newest chat request's Batch on the Floor whose Plan holds `issue`. */
  const batchOfIssue = async (
    floorId: string,
    issue: number,
  ): Promise<{ batch: BatchRecord; title: string } | undefined> => {
    for (const batch of await batches.list(floorId, recentBatches)) {
      if (batch.chatMessageId === null) {
        continue;
      }
      const item = (await batches.latestPlan(batch.id))?.items.find(
        (candidate) => candidate.issue === issue,
      );
      if (item !== undefined) {
        return { batch, title: item.title };
      }
    }
    return undefined;
  };

  const post = async (
    batch: BatchRecord | undefined,
    text: string,
  ): Promise<void> => {
    if (batch?.chatMessageId == null) {
      return;
    }
    await chat.postProgress(batch.floorId, text, batch.chatMessageId);
  };

  const handle = async (event: OfficeEvent): Promise<void> => {
    switch (event.type) {
      case "pull_request.merged": {
        const found = await batchOfIssue(event.floorId, event.issue);
        await post(
          found?.batch,
          `${named(event.issue, found?.title)} is done: pull request #${String(event.pullRequest)} was merged (${event.url}).`,
        );
        return;
      }
      case "issue.label_changed": {
        if (event.to !== "needs-human") {
          return;
        }
        const found = await batchOfIssue(event.floorId, event.issue);
        await post(
          found?.batch,
          `${named(event.issue, found?.title)} is blocked and waits for you: its Notice is on the Notice Board.`,
        );
        return;
      }
      case "contractor.left": {
        if (event.batchId === undefined) {
          return;
        }
        const batch = await batches.get(event.batchId);
        await post(
          batch,
          `${event.name} left: Batch ${String(event.batchId)} needs it no more, and its desk went with it.`,
        );
        return;
      }
      case "batch.finished": {
        const batch = await batches.get(event.batchId);
        const wrapUp = batch?.wrapUp;
        if (batch === undefined || wrapUp == null) {
          return;
        }
        await post(
          batch,
          [
            `Batch ${String(batch.id)} wrapped up: ${wrapUpLine(wrapUp)}.`,
            "",
            ...wrapUp.issues.map(
              ({ issue, title, outcome, pullRequest }) =>
                `- #${String(issue)} ${title}: ${wrapUpOutcomeLabels[outcome].toLowerCase()}${pullRequest === null ? "" : ` (pull request #${String(pullRequest.number)})`}`,
            ),
            ...(base === undefined
              ? []
              : [
                  "",
                  `The Wrap-up is on the whiteboard: ${base}${whiteboardPath(batch.floorId, batch.id)}`,
                ]),
          ].join("\n"),
        );
        return;
      }
      default:
        return;
    }
  };

  return {
    handle,
    start() {
      if (unsubscribe !== undefined) {
        return;
      }
      unsubscribe = options.events.subscribe(
        ({ event }) => {
          void handle(event).catch((error: unknown) => {
            options.onError?.(error);
          });
        },
        {
          types: [
            "pull_request.merged",
            "issue.label_changed",
            "contractor.left",
            "batch.finished",
          ],
        },
      );
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
