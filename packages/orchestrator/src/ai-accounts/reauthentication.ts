import type { EventBus, EventOfType } from "@ai-office/events";
import { reauthenticatePath } from "@ai-office/shared";

import type { Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";

// "AI Account needs re-authentication" (PRD FR-36, FR-49): when an OAuth
// AI Account's token can no longer be refreshed, an action Notice asks the
// Owner to sign in to it again. Its "Re-authenticate" action opens the
// sign-in in the admin (its `href`); once the account has signed in again
// the Notice is closed as acted on. Taking the action before signing in
// fails, and the Notice stays. It follows the Gateway's
// `ai_account.token_health` events, so there is one Notice per account
// however often its health is told.

/** The action that opens an AI Account's sign-in. */
export const reauthenticateAction = "reauthenticate_ai_account";

export interface ReauthenticationNoticesOptions {
  readonly notices: Notices;
  readonly events: EventBus;
  /**
   * Whether the AI Account still needs the Owner to sign in again; false
   * for one that no longer exists.
   */
  readonly needsReauthentication: (aiAccountId: string) => Promise<boolean>;
  /** Told when a Notice could not be raised or closed. */
  readonly onError?: (error: unknown) => void;
}

export interface ReauthenticationNotices {
  /** Stops following the events. */
  stop(): void;
}

/** The AI Account a re-authentication Notice is about, from its action. */
const accountOf = (notice: NoticeRecord): string | undefined => {
  const href = notice.actions.find(
    ({ id }) => id === reauthenticateAction,
  )?.href;
  return href === undefined
    ? undefined
    : (new URL(href, "http://ai-office.invalid").searchParams.get(
        "reauthenticate",
      ) ?? undefined);
};

export function createReauthenticationNotices(
  options: ReauthenticationNoticesOptions,
): ReauthenticationNotices {
  const { notices, events, needsReauthentication } = options;

  const unregister = notices.registerAction(
    reauthenticateAction,
    async (notice) => {
      const accountId = accountOf(notice);
      if (accountId !== undefined && (await needsReauthentication(accountId))) {
        throw new Error(
          "Sign in to the AI Account again first: open Re-authenticate.",
        );
      }
    },
  );

  const openFor = async (aiAccountId: string): Promise<NoticeRecord[]> =>
    (await notices.open()).filter(
      (notice) => accountOf(notice) === aiAccountId,
    );

  const follow = async (
    event: EventOfType<"ai_account.token_health">,
  ): Promise<void> => {
    const open = await openFor(event.aiAccountId);
    if (event.reauthenticationNeeded) {
      if (open.length === 0) {
        await notices.raise({
          kind: "action",
          title: `Re-authentication needed: ${event.name}`,
          actions: [
            {
              id: reauthenticateAction,
              label: "Re-authenticate",
              href: reauthenticatePath(event.aiAccountId),
            },
          ],
        });
      }
      return;
    }
    // Signed in again: the Notice's action has been taken.
    for (const notice of open) {
      await notices.act(notice.id, reauthenticateAction);
    }
  };

  // One event at a time, so one account never gets two Notices.
  let previous: Promise<void> = Promise.resolve();
  const unsubscribe = events.subscribe(
    ({ event }) => {
      if (event.type !== "ai_account.token_health") {
        return;
      }
      previous = previous
        .then(() => follow(event))
        .catch((error: unknown) => {
          options.onError?.(error);
        });
    },
    { types: ["ai_account.token_health"] },
  );

  return {
    stop() {
      unsubscribe();
      unregister();
    },
  };
}
