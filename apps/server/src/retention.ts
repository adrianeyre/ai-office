import type { CommunicationsStore } from "@ai-office/communications";
import type { EventStore } from "@ai-office/events";
import type { AiAccountStore, RequestHistoryStore } from "@ai-office/gateway";
import type {
  ChatAttachmentStore,
  NoticeStore,
  RetentionTargets,
} from "@ai-office/orchestrator";

import type { AuthStore } from "./auth/store.ts";

// What each retention rule deletes (PRD §7), from where AI Office keeps it.

/** Where the records retention deletes are kept. */
export interface RetentionStores {
  readonly requests: RequestHistoryStore;
  readonly aiAccounts: AiAccountStore;
  readonly events: EventStore;
  readonly notices: NoticeStore;
  readonly auth: AuthStore;
  readonly communications: CommunicationsStore;
  /** Manager chat attachments, whose unsent ones go after a day (FR-24). */
  readonly chatAttachments?: Pick<ChatAttachmentStore, "deleteUnsentBefore">;
}

export function retentionTargets(stores: RetentionStores): RetentionTargets {
  const attachments = stores.chatAttachments;
  return {
    // Bodies first, by their own (shorter) period; the requests stay.
    requestBodies: (before) => stores.requests.deleteBodiesBefore(before),
    // Requests' records, once what they used is kept a day at a time for
    // Token Caps, and AI Accounts' usage-window readings.
    async requestMetadata(before) {
      const requests = await stores.requests.deleteBefore(before);
      const readings = await stores.aiAccounts.deleteUsageBefore(before);
      return requests + readings;
    },
    // The Activity Feed, Notices closed before the cutoff (an open one stays
    // until the Owner closes it), and the sign-ins the feed records.
    async activity(before) {
      const events = await stores.events.deleteBefore(before);
      const notices = await stores.notices.deleteClosedBefore(before);
      const signIns = await stores.auth.deleteSignInEventsBefore(before);
      return events + notices + signIns;
    },
    // Connections' delivery logs; deliveries still waiting to go stay.
    connectionDeliveries: (before) =>
      stores.communications.deleteDeliveriesBefore(before),
    // Manager chat attachments never sent, after a day.
    ...(attachments === undefined
      ? {}
      : {
          unsentChatAttachments: (before: Date) =>
            attachments.deleteUnsentBefore(before),
        }),
  };
}
