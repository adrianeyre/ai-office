import {
  createRedactor,
  directChatErrorCodes,
  directChatSession,
  floorErrorCodes,
  type DirectChatErrorCode,
  type Redactor,
  type TerminalModel,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { ModelClient, ModelMessage } from "../models/client.ts";
import type { RoleStore } from "../roles/store.ts";
import {
  agentChat,
  terminalChat,
  type DirectChatMessageRecord,
  type DirectChatStore,
  type NewDirectChatMessage,
} from "./store.ts";

// Direct chats: the Owner talks one to one with any of a Floor's Agents,
// as clicking its Avatar in the Office offers, or with the AI itself in
// the Terminal. There are no commands, Skills or Grilling Sessions (the
// Manager chat has those): every message but `/clear` goes to a Model
// through the AI Gateway, and its reply is told to listeners a piece at a
// time as it is written, and kept once it is finished. An Agent's chat
// asks the Agent's own Model with its own Gateway Key, so it is attributed
// to the Agent and its Floor and counts against its Token Caps (FR-33,
// FR-42); its prompt says who the Agent is and how its Role works. The
// Terminal asks any AI Provider's default Model with its own Owner tool
// key, "Terminal". Each chat answers one message at a time. `/clear`
// starts the conversation the Model is given afresh; the page keeps every
// message.

/** Why a direct chat refused a message; `code` is one of `directChatErrorCodes`. */
export class DirectChatError extends Error {
  readonly code: DirectChatErrorCode;

  constructor(code: DirectChatErrorCode, message: string) {
    super(message);
    this.name = "DirectChatError";
    this.code = code;
  }
}

/** Which chat: one of a Floor's Agents', or the Terminal. */
export type DirectChatRef =
  | {
      readonly kind: "agent";
      readonly floorId: string;
      readonly agentId: string;
    }
  | { readonly kind: "terminal" };

/** What a chat's listeners are told. */
export type DirectChatUpdate =
  | { readonly type: "message"; readonly message: DirectChatMessageRecord }
  | { readonly type: "delta"; readonly replyTo: number; readonly text: string };

export interface DirectChatHistory {
  /** Who answers: the Agent's name, or "the AI". */
  readonly name: string;
  readonly aiProvider: string | null;
  /** The Model asked when the Owner names none; undefined for none. */
  readonly model: string | undefined;
  readonly messages: DirectChatMessageRecord[];
  readonly pending: { readonly replyTo: number; readonly text: string }[];
  /** The Terminal's Models; none for an Agent. */
  readonly models: TerminalModel[];
}

export interface DirectChats {
  /** Who answers, the chat's latest messages, and a reply being written. */
  history(ref: DirectChatRef, limit?: number): Promise<DirectChatHistory>;
  /** The chat's messages after `id`, oldest first. */
  after(ref: DirectChatRef, id: number): Promise<DirectChatMessageRecord[]>;
  /**
   * Sends the Owner's message: `/clear` is answered at once (`message` is
   * the clear itself); anything else is kept, `reply` is undefined, and
   * the Model's reply is told to listeners as it is written. The Terminal
   * may name one of its Models.
   */
  send(
    ref: DirectChatRef,
    text: string,
    model?: string,
  ): Promise<{
    readonly message: DirectChatMessageRecord;
    readonly reply: DirectChatMessageRecord | undefined;
  }>;
  /** Listens to a chat, answering the reply being written now, if any. */
  subscribe(
    ref: DirectChatRef,
    listener: (update: DirectChatUpdate) => void,
  ): {
    readonly pending: { readonly replyTo: number; readonly text: string }[];
    unsubscribe(): void;
  };
  /** Stops the replies being written, keeping why, and waits for them. */
  stop(): Promise<void>;
}

export interface DirectChatsOptions {
  readonly store: DirectChatStore;
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  /** The Role library, for what an Agent's Role is and how it works. */
  readonly roles?: Pick<RoleStore, "get">;
  /** Makes Agents' model calls, each with its own Gateway Key. */
  readonly models: ModelClient;
  /**
   * Makes the Terminal's model calls, with its own key. Its requests name
   * `terminalAgentId` as the Agent, which the client may ignore.
   */
  readonly terminalModels: ModelClient;
  /** Each AI Provider's default Model. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /** Removes credentials from what is kept and sent. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** Told of a listener that failed. */
  readonly onError?: (error: unknown) => void;
}

/** Who the Terminal's model calls say they are for. */
export const terminalAgentId = "terminal";

/** How many messages the history (and the Model) is given. */
const historySize = 200;
const conversationSize = 50;
/** The most tokens one reply may use. */
const maxReplyTokens = 4096;

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

/** "the AI" at the start of a sentence. */
const capitalised = (name: string): string =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/** Whether the Owner asked to clear the conversation. */
const isClear = (text: string): boolean => /^\/clear\s*$/i.test(text.trim());

const chatOf = (ref: DirectChatRef): string =>
  ref.kind === "terminal" ? terminalChat : agentChat(ref.agentId);

/**
 * The conversation the Model is given: the Owner's messages and the
 * replies, oldest first, starting with the Owner's and alternating, as
 * Messages asks. An unanswered message runs on into the next.
 */
export function directConversation(
  messages: readonly DirectChatMessageRecord[],
): ModelMessage[] {
  const turns: { role: ModelMessage["role"]; content: string }[] = [];
  for (const message of messages) {
    if (message.kind !== "owner" && message.kind !== "reply") {
      continue;
    }
    const role = message.kind === "owner" ? "user" : "assistant";
    const last = turns.at(-1);
    if (last === undefined && role === "assistant") {
      continue;
    }
    if (last?.role === role) {
      last.content = `${last.content}\n\n${message.text}`;
    } else {
      turns.push({ role, content: message.text });
    }
  }
  return turns;
}

/** The Terminal's system prompt. */
export const terminalSystemPrompt = (): string =>
  [
    "You are the AI in AI Office's Terminal.",
    "AI Office is a 3D office where AI Agents work the Owner's GitHub issues: each repository is a Floor with a Manager and a team of Agents (coder, reviewer, QA, docs, designer), and a built-in AI Gateway spreads their model calls across the Owner's AI accounts.",
    'The Owner is talking with you directly, as they would in a terminal. Answer their questions, explain, draft and review code and text, and help them think. You cannot run commands, read their repositories or change AI Office from here: say so when asked, and tell them where in AI Office to do it (the Manager chat runs commands like "complete issues 1 to 5").',
    "Be concise and direct. Use Markdown, with fenced code blocks for code.",
  ].join("\n\n");

/** An Agent's system prompt in its direct chat. */
export function agentChatSystemPrompt({
  floor,
  agent,
  role,
}: {
  floor: Pick<FloorRecord, "name" | "repository">;
  agent: Pick<AgentRecord, "name" | "role" | "extraInstructions">;
  role?:
    | {
        readonly name: string;
        readonly description: string;
        readonly instructions: string;
        /** Set for a Contractor's one-off Role: the Floor it was written on. */
        readonly oneOffFloorId?: string | undefined;
      }
    | undefined;
}): string {
  const roleName =
    agent.role === "manager" ? "Manager" : (role?.name ?? agent.role);
  return [
    `You are ${agent.name}, the ${roleName} on the ${floor.name} Floor of AI Office, which works on the GitHub repository ${floor.repository}.`,
    ...(role === undefined
      ? []
      : [
          // A one-off Role's description is the Manager's Model's, written
          // as it read the repository and the web, so it is no part of
          // what this Agent is told it is (P2-4).
          role.oneOffFloorId === undefined
            ? `Your Role: ${role.description}`
            : `Your Role: a one-off Role, ${role.name}, the Floor's Manager added you in for one Batch.`,
          ...(role.instructions.trim() === ""
            ? []
            : [`How you work:\n${role.instructions.trim()}`]),
        ]),
    ...(agent.extraInstructions.trim() === ""
      ? []
      : [
          `The Owner's instructions for you:\n${agent.extraInstructions.trim()}`,
        ]),
    "The Owner of AI Office clicked your Avatar in the Office and is talking with you directly. Answer as yourself, about your work, your Role and the repository, and help them with what they ask. You cannot run tools, read files or change the repository from this chat: say so when asked, and suggest filing an issue or asking the Manager to take work on.",
    "Be concise and direct. Use Markdown, with fenced code blocks for code.",
  ].join("\n\n");
}

/** Whom a chat's model call is made as, and with what. */
interface Target {
  readonly chat: string;
  readonly floorId: string | null;
  readonly agentId: string | null;
  readonly name: string;
  readonly aiProvider: string | null;
  readonly model: string | undefined;
  readonly models: TerminalModel[];
  readonly system: string;
  readonly client: ModelClient;
  readonly callAs: string;
  /** Why it cannot answer now, if it cannot. */
  readonly cannot: string | undefined;
}

export function createDirectChats(options: DirectChatsOptions): DirectChats {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const redactor = options.redactor ?? createRedactor();
  const listeners = new Map<string, Set<(update: DirectChatUpdate) => void>>();
  /** Chats whose Model is answering, and the reply so far. */
  const busy = new Map<
    string,
    { replyTo: number; text: string; controller: AbortController } | null
  >();
  const replies = new Set<Promise<void>>();
  let stopped = false;

  const publish = (chat: string, update: DirectChatUpdate): void => {
    for (const listener of listeners.get(chat) ?? []) {
      try {
        listener(update);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const terminalModels = async (): Promise<TerminalModel[]> =>
    Object.entries((await options.defaultModels?.()) ?? {}).flatMap(
      ([aiProvider, model]) =>
        model === undefined || model === "" ? [] : [{ aiProvider, model }],
    );

  const targetOf = async (
    ref: DirectChatRef,
    asked?: string,
  ): Promise<Target> => {
    if (ref.kind === "terminal") {
      const models = await terminalModels();
      const chosen =
        asked === undefined
          ? (models.find(({ aiProvider }) => aiProvider === "Claude") ??
            models[0])
          : models.find(({ model }) => model === asked);
      if (asked !== undefined && chosen === undefined) {
        throw new DirectChatError(
          directChatErrorCodes.modelNotOffered,
          `The Terminal does not offer the Model "${asked}": choose one of the AI Providers' default Models.`,
        );
      }
      return {
        chat: terminalChat,
        floorId: null,
        agentId: null,
        name: "the AI",
        aiProvider: chosen?.aiProvider ?? null,
        model: chosen?.model,
        models,
        system: terminalSystemPrompt(),
        client: options.terminalModels,
        callAs: terminalAgentId,
        cannot:
          chosen === undefined
            ? "No AI Provider has a default Model yet: choose one in AI Settings."
            : undefined,
      };
    }
    const floor = await options.floors.get(ref.floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${ref.floorId}".`,
      );
    }
    const agent = (await options.agents.list(floor.id)).find(
      ({ id }) => id === ref.agentId,
    );
    if (agent === undefined) {
      throw new DirectChatError(
        directChatErrorCodes.agentNotFound,
        `There is no Agent "${ref.agentId}" on the Floor "${floor.name}".`,
      );
    }
    const model = modelOf(agent, await options.defaultModels?.());
    const role =
      agent.role === "manager"
        ? undefined
        : await options.roles?.get(agent.role);
    return {
      chat: agentChat(agent.id),
      floorId: floor.id,
      agentId: agent.id,
      name: agent.name,
      aiProvider: agent.aiProvider,
      model,
      models: [],
      system: agentChatSystemPrompt({ floor, agent, role }),
      client: options.models,
      callAs: agent.id,
      cannot: !agent.enabled
        ? `${agent.name} is paused, so does not answer. Turn ${agent.name} back on in Agent Settings.`
        : model === undefined
          ? `${agent.name} has no Model: choose a default Model for ${agent.aiProvider} in AI Settings.`
          : undefined,
    };
  };

  const keep = async (
    target: Target,
    message: Pick<NewDirectChatMessage, "kind" | "text" | "replyTo" | "model">,
  ): Promise<DirectChatMessageRecord> =>
    store.append({
      chat: target.chat,
      floorId: target.floorId,
      agentId: target.agentId,
      ...message,
      text: redactor.redactText(message.text),
      createdAt: now(),
    });

  const answer = async (
    target: Target,
    asked: DirectChatMessageRecord,
    controller: AbortController,
  ): Promise<void> => {
    const emit = (text: string): void => {
      const replying = busy.get(target.chat);
      if (replying != null && !controller.signal.aborted && text !== "") {
        replying.text += text;
        publish(target.chat, { type: "delta", replyTo: asked.id, text });
      }
    };
    let kind: "reply" | "error";
    let text: string;
    try {
      if (target.cannot !== undefined || target.model === undefined) {
        kind = "error";
        text = target.cannot ?? "";
      } else {
        const cleared = await store.clearedAt(target.chat);
        const window = await store.latest(
          target.chat,
          conversationSize,
          cleared,
        );
        const reply = await target.client.stream(
          {
            agentId: target.callAs,
            // The chat's own session: its calls are found by it, and are
            // never the Agent's sandbox context.
            session: directChatSession,
            model: target.model,
            system: target.system,
            messages: directConversation(window),
            maxTokens: maxReplyTokens,
          },
          { signal: controller.signal, onText: emit },
        );
        [kind, text] =
          reply.text.trim() === ""
            ? ["error", `${capitalised(target.name)} gave no answer.`]
            : ["reply", reply.text];
      }
    } catch (error) {
      kind = "error";
      text = controller.signal.aborted
        ? `AI Office stopped before ${target.name} finished answering.`
        : `${capitalised(target.name)} could not answer: ${reasonOf(error)}`;
    }
    const reply = await keep(target, {
      kind,
      text,
      replyTo: asked.id,
      model: target.model ?? null,
    });
    // The reply is no longer being written once it is kept.
    busy.delete(target.chat);
    publish(target.chat, { type: "message", message: reply });
  };

  return {
    async history(ref, limit = historySize) {
      const target = await targetOf(ref);
      const replying = busy.get(target.chat);
      return {
        name: target.name,
        aiProvider: target.aiProvider,
        model: target.model,
        messages: await store.latest(target.chat, limit),
        pending:
          replying == null
            ? []
            : [{ replyTo: replying.replyTo, text: replying.text }],
        models: target.models,
      };
    },

    async after(ref, id) {
      return store.latest(chatOf(ref), historySize, id);
    },

    async send(ref, text, model) {
      const target = await targetOf(ref, model);
      if (busy.has(target.chat)) {
        throw new DirectChatError(
          directChatErrorCodes.replyInProgress,
          `${capitalised(target.name)} is still answering your last message.`,
        );
      }
      if (isClear(text)) {
        const cleared = await keep(target, {
          kind: "clear",
          text: `Conversation cleared: ${target.name} starts afresh from here.`,
          replyTo: null,
          model: null,
        });
        publish(target.chat, { type: "message", message: cleared });
        return { message: cleared, reply: undefined };
      }
      // Held while the message is kept, so a second cannot slip in.
      busy.set(target.chat, null);
      let message: DirectChatMessageRecord;
      try {
        message = await keep(target, {
          kind: "owner",
          text,
          replyTo: null,
          model: target.model ?? null,
        });
      } catch (error) {
        busy.delete(target.chat);
        throw error;
      }
      publish(target.chat, { type: "message", message });
      const controller = new AbortController();
      if (stopped) {
        controller.abort();
      }
      busy.set(target.chat, { replyTo: message.id, text: "", controller });
      const reply = answer(target, message, controller).catch(
        (error: unknown) => {
          busy.delete(target.chat);
          options.onError?.(error);
        },
      );
      replies.add(reply);
      void reply.finally(() => replies.delete(reply));
      return { message, reply: undefined };
    },

    subscribe(ref, listener) {
      const chat = chatOf(ref);
      let chatListeners = listeners.get(chat);
      if (chatListeners === undefined) {
        chatListeners = new Set();
        listeners.set(chat, chatListeners);
      }
      chatListeners.add(listener);
      const replying = busy.get(chat);
      return {
        pending:
          replying == null
            ? []
            : [{ replyTo: replying.replyTo, text: replying.text }],
        unsubscribe() {
          chatListeners.delete(listener);
          if (chatListeners.size === 0) {
            listeners.delete(chat);
          }
        },
      };
    },

    async stop() {
      stopped = true;
      for (const replying of busy.values()) {
        replying?.controller.abort();
      }
      await Promise.all([...replies]);
    },
  };
}
