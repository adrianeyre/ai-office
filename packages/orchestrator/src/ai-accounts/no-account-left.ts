import type { EventBus, EventOfType } from "@ai-office/events";
import { aiProviderAccountsPath } from "@ai-office/shared";

import type { Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";

// "AI Account rate-limited with no fallback left" (PRD FR-39, FR-49): when
// the AI Gateway holds back the last AI Account of an AI Provider (rate-
// limited, overloaded or failing), an action Notice tells the Owner that
// nothing is left to serve that AI Provider. Its "Open AI Accounts" action
// opens the admin on that AI Provider's accounts, where the Owner can add
// or resume one; taking it while still nothing serves fails, and the
// Notice stays. Once an account of that AI Provider serves again, the
// Notice is closed as acted on. It follows the Gateway's
// `ai_account.limit_changed` events, so there is one Notice per AI
// Provider however many accounts it has.

/** The action that opens an AI Provider's AI Accounts. */
export const openAiAccountsAction = "open_ai_accounts";

export interface NoAccountLeftNoticesOptions {
  readonly notices: Notices;
  readonly events: EventBus;
  /** Whether any AI Account of the AI Provider can serve now. */
  readonly providerAvailable: (aiProvider: string) => Promise<boolean>;
  /** Told when a Notice could not be raised or closed. */
  readonly onError?: (error: unknown) => void;
}

export interface NoAccountLeftNotices {
  /** Stops following the events. */
  stop(): void;
}

/** The AI Provider a Notice is about, from its action. */
const providerOf = (notice: NoticeRecord): string | undefined => {
  const href = notice.actions.find(
    ({ id }) => id === openAiAccountsAction,
  )?.href;
  return href === undefined
    ? undefined
    : (new URL(href, "http://ai-office.invalid").searchParams.get(
        "aiProvider",
      ) ?? undefined);
};

export function createNoAccountLeftNotices(
  options: NoAccountLeftNoticesOptions,
): NoAccountLeftNotices {
  const { notices, events, providerAvailable } = options;

  const unregister = notices.registerAction(
    openAiAccountsAction,
    async (notice) => {
      const aiProvider = providerOf(notice);
      if (aiProvider !== undefined && !(await providerAvailable(aiProvider))) {
        throw new Error(
          `No ${aiProvider} AI Account can serve yet: add one, resume one, or wait for a limit to reset.`,
        );
      }
    },
  );

  const openFor = async (aiProvider: string): Promise<NoticeRecord[]> =>
    (await notices.open()).filter(
      (notice) => providerOf(notice) === aiProvider,
    );

  const follow = async (
    event: EventOfType<"ai_account.limit_changed">,
  ): Promise<void> => {
    const open = await openFor(event.aiProvider);
    if (!event.providerAvailable) {
      if (open.length === 0) {
        await notices.raise({
          kind: "action",
          title: `No ${event.aiProvider} AI Account left: ${event.name} was the last`,
          actions: [
            {
              id: openAiAccountsAction,
              label: "Open AI Accounts",
              href: aiProviderAccountsPath(event.aiProvider),
            },
          ],
        });
      }
      return;
    }
    // An account serves again: the Notice's action has been taken.
    for (const notice of open) {
      await notices.act(notice.id, openAiAccountsAction);
    }
  };

  // One event at a time, so one AI Provider never gets two Notices.
  let previous: Promise<void> = Promise.resolve();
  const unsubscribe = events.subscribe(
    ({ event }) => {
      if (event.type !== "ai_account.limit_changed") {
        return;
      }
      previous = previous
        .then(() => follow(event))
        .catch((error: unknown) => {
          options.onError?.(error);
        });
    },
    { types: ["ai_account.limit_changed"] },
  );

  return {
    stop() {
      unsubscribe();
      unregister();
    },
  };
}
