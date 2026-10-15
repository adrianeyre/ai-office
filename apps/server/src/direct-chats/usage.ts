import type { RequestHistory } from "@ai-office/gateway";
import {
  callInputTokens,
  type DirectChatHistory,
  type DirectChatRef,
} from "@ai-office/orchestrator";
import {
  contextUsageOf,
  directChatSession,
  terminalKeyName,
  type DirectChatUsage,
} from "@ai-office/shared";

// A direct chat's Context Usage and serving AI Account (PRD FR-84, FR-85),
// for its status line. A direct chat (or the Terminal) is a conversation
// of its own, apart from the Agent's sandbox session, so it is measured
// from the AI Gateway's request history: the chat's latest answered call,
// found by its attribution (the Agent and its Floor, or the Terminal's
// Owner tool) and the session every direct chat names. Its whole prompt
// (cached tokens included) over its Model's context window is the chat's
// Context Usage; a `/clear` since leaves none.

/** How many of the chat's latest calls are looked through for one answered. */
const looked = 5;

/** The Gateway's endpoints a chat's conversation goes to. */
const conversationEndpoints: ReadonlySet<string> = new Set([
  "messages",
  "chat_completions",
  "responses",
]);

export type DirectChatUsageOf = (
  ref: DirectChatRef,
  chat: Pick<DirectChatHistory, "aiProvider" | "models" | "messages">,
) => Promise<DirectChatUsage | null>;

export function directChatUsageOf(options: {
  readonly history: Pick<RequestHistory, "list">;
  /** A Model's context window from the catalogue; null if unknown. */
  readonly contextWindow: (
    aiProvider: string,
    model: string,
  ) => Promise<number | null>;
}): DirectChatUsageOf {
  return async (ref, chat) => {
    const { requests } = await options.history.list({
      ...(ref.kind === "terminal"
        ? { ownerTool: terminalKeyName }
        : { floorId: ref.floorId, agentId: ref.agentId }),
      session: directChatSession,
      status: "2xx",
      limit: looked,
    });
    const latest = requests.find(
      (request) =>
        request.keepAlive !== true &&
        request.model !== null &&
        conversationEndpoints.has(request.endpoint) &&
        callInputTokens(request) !== null,
    );
    const tokens = latest === undefined ? null : callInputTokens(latest);
    if (latest?.model == null || tokens === null) {
      return null;
    }
    const cleared = chat.messages.findLast(({ kind }) => kind === "clear");
    if (cleared !== undefined && latest.startedAt < cleared.createdAt) {
      return null;
    }
    // The Terminal may have asked any AI Provider's default Model.
    const aiProvider =
      chat.models.find(({ model }) => model === latest.model)?.aiProvider ??
      chat.aiProvider;
    const contextWindow =
      aiProvider === null
        ? null
        : await options.contextWindow(aiProvider, latest.model);
    return {
      model: latest.model,
      inputTokens: tokens,
      contextWindow,
      contextUsage: contextUsageOf(tokens, contextWindow),
      aiAccountId: latest.accountId,
      updatedAt: latest.startedAt.toISOString(),
    };
  };
}
