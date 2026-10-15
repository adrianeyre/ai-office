import {
  DirectChatError,
  type DirectChatMessageRecord,
  type DirectChatRef,
  type DirectChats,
  type DirectChatUpdate,
} from "@ai-office/orchestrator";
import { lastEventIdSchema } from "@ai-office/events/stream";
import {
  directChatErrorCodes,
  directChatSendRequestSchema,
  managerChatStreamQuerySchema,
  type ApiError,
  type DirectChat,
  type DirectChatErrorCode,
  type DirectChatFrame,
  type DirectChatMessage,
  type DirectChatSendResponse,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";
import { openSse } from "../gateway-requests/sse.ts";
import type { DirectChatUsageOf } from "./usage.ts";

// Direct chats: the Owner's one-to-one chat with any of a Floor's Agents
// (`/api/floors/:floorId/agents/:agentId/chat`), and with the AI itself in
// the Terminal (`/api/terminal`). Messages are sent over REST; the chat's
// messages and the Model's replies, a piece at a time as it writes them,
// come over server-sent events, resuming after the last message a client
// has (`Last-Event-ID`). Every route needs a signed-in session. The
// Owner's words are never logged.

export interface DirectChatRoutesOptions {
  readonly chats: DirectChats;
  /** How often a stream sends a heartbeat (and re-checks the session). */
  readonly heartbeatMs: number;
  readonly signedIn: (request: FastifyRequest) => Promise<boolean>;
  /**
   * The chat's Context Usage and serving AI Account, from its latest
   * answered model call (`usage.ts`); without it, none.
   */
  readonly usage?: DirectChatUsageOf | undefined;
}

const statusFor: Record<DirectChatErrorCode, number> = {
  [directChatErrorCodes.agentNotFound]: 404,
  [directChatErrorCodes.replyInProgress]: 409,
  [directChatErrorCodes.modelNotOffered]: 400,
};

/** How many stored messages are read at a time while catching up. */
const replayPageSize = 200;

const messageBody = (message: DirectChatMessageRecord): DirectChatMessage => ({
  id: message.id,
  kind: message.kind,
  text: message.text,
  replyTo: message.replyTo,
  model: message.model,
  createdAt: message.createdAt.toISOString(),
});

/** Answers a `DirectChatError` or a `FloorError`; anything else is rethrown. */
const sendChatError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof DirectChatError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface AgentParams {
  readonly floorId: string;
  readonly agentId: string;
}

const agentRef = ({ floorId, agentId }: AgentParams): DirectChatRef => ({
  kind: "agent",
  floorId,
  agentId,
});

const terminalRef: DirectChatRef = { kind: "terminal" };

export function registerDirectChatRoutes(
  app: FastifyInstance,
  options: DirectChatRoutesOptions,
): void {
  const { chats } = options;
  /** Ends every open stream: the server is shutting down. */
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of [...open]) {
      end();
    }
    // Replies being written are stopped, and why is kept.
    await chats.stop();
  });

  const history = async (
    ref: DirectChatRef,
    reply: FastifyReply,
  ): Promise<DirectChat | FastifyReply> => {
    try {
      const found = await chats.history(ref);
      let usage: DirectChat["usage"] = null;
      try {
        usage = (await options.usage?.(ref, found)) ?? null;
      } catch (error) {
        // The chat reads without its status line rather than not at all.
        reply.log.warn({ err: error }, "A direct chat's usage was not read.");
      }
      const body: DirectChat = {
        name: found.name,
        aiProvider: found.aiProvider,
        model: found.model ?? "",
        messages: found.messages.map(messageBody),
        pending: found.pending,
        models: found.models,
        usage,
      };
      return body;
    } catch (error) {
      return sendChatError(reply, error);
    }
  };

  const send = async (
    ref: DirectChatRef,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const parsed = directChatSendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendInvalidRequest(reply, parsed.error);
    }
    try {
      const sent = await chats.send(ref, parsed.data.text, parsed.data.model);
      // Which chat, never the Owner's words.
      request.log.info(
        ref.kind === "agent"
          ? { floorId: ref.floorId, agentId: ref.agentId }
          : { chat: "terminal" },
        "The Owner wrote in a direct chat.",
      );
      const body: DirectChatSendResponse = {
        message: messageBody(sent.message),
        reply: sent.reply === undefined ? null : messageBody(sent.reply),
      };
      return await reply.code(201).send(body);
    } catch (error) {
      return sendChatError(reply, error);
    }
  };

  const stream = async (
    ref: DirectChatRef,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const query = managerChatStreamQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendInvalidRequest(reply, query.error);
    }
    const header = request.headers["last-event-id"];
    const after =
      header === undefined
        ? { success: true as const, data: query.data.lastEventId }
        : lastEventIdSchema.safeParse(header);
    if (!after.success) {
      return sendInvalidRequest(reply, after.error);
    }
    try {
      // The chat must exist: its Floor and Agent.
      await chats.history(ref, 1);
    } catch (error) {
      return sendChatError(reply, error);
    }

    // Subscribe first and hold what arrives while catching up, so nothing
    // is lost or sent twice.
    let lastSent = after.data ?? 0;
    let live = false;
    const held: DirectChatUpdate[] = [];
    const sendFrame = (frame: DirectChatFrame): void => {
      if (frame.type !== "message") {
        sse.sendData(frame);
      } else if (frame.message.id > lastSent) {
        lastSent = frame.message.id;
        sse.send(frame.message.id, frame);
      }
    };
    const forward = (update: DirectChatUpdate): void => {
      sendFrame(
        update.type === "message"
          ? { type: "message", message: messageBody(update.message) }
          : update,
      );
    };
    const subscription = chats.subscribe(ref, (update) => {
      if (live) {
        forward(update);
      } else {
        held.push(update);
      }
    });
    const sse = openSse(request, reply, {
      heartbeatMs: options.heartbeatMs,
      signedIn: options.signedIn,
      open,
      onEnd: () => {
        subscription.unsubscribe();
      },
    });
    try {
      const answered = new Set<number>();
      if (after.data !== undefined) {
        for (;;) {
          const page = await chats.after(ref, lastSent);
          for (const message of page) {
            if (message.replyTo !== null) {
              answered.add(message.replyTo);
            }
            forward({ type: "message", message });
          }
          if (page.length < replayPageSize || sse.ended) {
            break;
          }
        }
      }
      // A reply being written, from its text so far.
      for (const { replyTo, text } of subscription.pending) {
        if (!answered.has(replyTo)) {
          sendFrame({ type: "pending", replyTo, text });
        }
      }
      for (const update of held) {
        forward(update);
      }
      held.length = 0;
      live = true;
    } catch (error) {
      request.log.error(
        { err: error },
        "A direct chat stream failed to catch up.",
      );
      sse.end();
    }
    return undefined;
  };

  app.get<{ Params: AgentParams }>(
    "/api/floors/:floorId/agents/:agentId/chat",
    { config: { access: "owner" } },
    (request, reply) => history(agentRef(request.params), reply),
  );
  app.post<{ Params: AgentParams }>(
    "/api/floors/:floorId/agents/:agentId/chat/messages",
    { config: { access: "owner" } },
    (request, reply) => send(agentRef(request.params), request, reply),
  );
  app.get<{ Params: AgentParams }>(
    "/api/floors/:floorId/agents/:agentId/chat/stream",
    { config: { access: "owner" } },
    (request, reply) => stream(agentRef(request.params), request, reply),
  );

  app.get("/api/terminal", { config: { access: "owner" } }, (_request, reply) =>
    history(terminalRef, reply),
  );
  app.post(
    "/api/terminal/messages",
    { config: { access: "owner" } },
    (request, reply) => send(terminalRef, request, reply),
  );
  app.get(
    "/api/terminal/stream",
    { config: { access: "owner" } },
    (request, reply) => stream(terminalRef, request, reply),
  );
}
