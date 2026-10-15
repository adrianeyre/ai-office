import {
  GrillingError,
  grillingSessionSummary,
  ManagerChatError,
  readChatAttachment,
  type ChatAttachmentStore,
  type ChatRepositoryFiles,
  type ChatTasks,
  type ChatMessageRecord,
  type GrillingSessionRecord,
  type ManagerChat,
  type ManagerChatUpdate,
} from "@ai-office/orchestrator";
import { lastEventIdSchema } from "@ai-office/events/stream";
import {
  apiErrorCodes,
  chatAttachmentUploadSchema,
  isChatImage,
  managerChatFilesQuerySchema,
  maxChatImageBytes,
  type ChatAttachment,
  type ManagerChatFileList,
  type ManagerChatTaskList,
  grillingErrorCodes,
  grillingIssueDraftsRequestSchema,
  managerChatErrorCodes,
  managerChatSendRequestSchema,
  managerChatStreamQuerySchema,
  type ApiError,
  type GrillingErrorCode,
  type GrillingSession,
  type GrillingSessionDetail,
  type GrillingSessionList,
  type ManagerChat as ManagerChatBody,
  type ManagerChatErrorCode,
  type ManagerChatFrame,
  type ManagerChatMessage,
  type ManagerChatSendResponse,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";
import { openSse } from "../gateway-requests/sse.ts";

// The Manager chat (PRD FR-24, §8): a Floor's conversation with its
// Manager. Messages are sent over REST; the chat's messages and the
// Manager's replies, a piece at a time as its Model writes them, come over
// server-sent events, resuming after the last message a client has
// (`Last-Event-ID`). A Floor's Grilling Sessions (FR-77, FR-82) are read
// here too, each with its questions, decisions, glossary terms, the issues
// drafted from it and every chat message it holds; they are started,
// answered, paused and resumed through the chat itself. The Owner's edits
// to an ended session's draft issues are kept here (FR-81); approving them
// is a chat message, "file the issues of session 3". Every route needs a signed-in session. The
// Owner's words are never logged.
//
// As Claude Code's (ADR 0004), the chat takes files and images: each is
// uploaded first (`POST …/manager-chat/attachments`), kept unsent for up
// to a day, and sent by id with a message, which keeps it; its content is
// served back as itself, never as a page (`GET …/attachments/:id`). Typing
// `@` offers the repository's files (`GET …/manager-chat/files`), and the
// chat's live task list, of the work its requests spun off, is read at
// `GET …/manager-chat/tasks`, fetched again on each `tasks` frame.

export interface ManagerChatRoutesOptions {
  readonly chat: ManagerChat;
  /** How often a stream sends a heartbeat (and re-checks the session). */
  readonly heartbeatMs: number;
  readonly signedIn: (request: FastifyRequest) => Promise<boolean>;
  /** Where attachments are kept (FR-24); without it, none can be uploaded. */
  readonly attachments?: ChatAttachmentStore;
  /** The repository's files for `@` mentions; without it, none are offered. */
  readonly files?: Pick<ChatRepositoryFiles, "search">;
  /** The chat's task list; without it, the list is empty. */
  readonly tasks?: Pick<ChatTasks, "list">;
  readonly now?: () => Date;
}

/**
 * The most an upload's body may be: the largest image, in base64 with its
 * JSON around it.
 */
const uploadBodyLimit = Math.ceil((maxChatImageBytes * 4) / 3) + 64 * 1024;

/** `Content-Disposition` for an attachment named `name`, safely quoted. */
const dispositionOf = (inline: boolean, name: string): string => {
  const plain = name.replaceAll(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const statusFor: Record<ManagerChatErrorCode, number> = {
  [managerChatErrorCodes.managerNotFound]: 404,
  [managerChatErrorCodes.replyInProgress]: 409,
  [managerChatErrorCodes.attachmentNotFound]: 404,
};

const grillingStatusFor: Record<GrillingErrorCode, number> = {
  [grillingErrorCodes.sessionNotFound]: 404,
  [grillingErrorCodes.issuesNotEditable]: 409,
  [grillingErrorCodes.issuesInvalid]: 400,
};

/** How many stored messages are read at a time while catching up. */
const replayPageSize = 200;

/** A message as the API sends it. */
export const messageBody = (
  message: ChatMessageRecord,
): ManagerChatMessage => ({
  ...message,
  tools: [...message.tools],
  attachments: [...message.attachments],
  createdAt: message.createdAt.toISOString(),
});

/** A Grilling Session as the API sends it. */
const sessionBody = (session: GrillingSessionRecord): GrillingSession => ({
  ...grillingSessionSummary(session),
  questions: [...session.questions],
  decisions: [...session.decisions],
  terms: [...session.terms],
  facts: [...session.facts],
  outline: [...session.outline],
  adrs: session.adrs.map((adr) => ({
    ...adr,
    options: [...adr.options],
    consequences: [...adr.consequences],
  })),
  processes: [...session.processes],
  documents: session.documents,
  issues: session.issues,
  sources: [...session.sources],
});

/**
 * Answers a `ManagerChatError`, a `GrillingError` or a `FloorError`;
 * anything else is rethrown.
 */
const sendChatError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof GrillingError) {
    const body: ApiError = { error: error.code, message: error.message };
    return reply.code(grillingStatusFor[error.code]).send(body);
  }
  if (!(error instanceof ManagerChatError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface FloorParams {
  readonly floorId: string;
}

export function registerManagerChatRoutes(
  app: FastifyInstance,
  options: ManagerChatRoutesOptions,
): void {
  const { chat } = options;
  /** Ends every open stream: the server is shutting down. */
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of [...open]) {
      end();
    }
    // Replies being written are stopped, and why is kept.
    await chat.stop();
  });

  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/manager-chat",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const history = await chat.history(request.params.floorId);
        const body: ManagerChatBody = {
          manager: {
            id: history.manager.id,
            name: history.manager.name,
            aiProvider: history.manager.aiProvider,
            model: history.model ?? "",
          },
          messages: history.messages.map(messageBody),
          pending: history.pending,
        };
        return body;
      } catch (error) {
        return sendChatError(reply, error);
      }
    },
  );

  app.post<{ Params: FloorParams }>(
    "/api/floors/:floorId/manager-chat/messages",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = managerChatSendRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { floorId } = request.params;
      try {
        const sent = await chat.send(
          floorId,
          parsed.data.text,
          parsed.data.attachments,
        );
        // What kind of answer, never the Owner's words.
        request.log.info(
          {
            floorId,
            answer: sent.reply?.kind ?? "model",
            attachments: parsed.data.attachments.length,
          },
          "The Owner wrote to a Floor's Manager.",
        );
        const body: ManagerChatSendResponse = {
          message: messageBody(sent.message),
          reply: sent.reply === undefined ? null : messageBody(sent.reply),
        };
        return await reply.code(201).send(body);
      } catch (error) {
        return sendChatError(reply, error);
      }
    },
  );

  // An attachment, kept unsent until a message sends it (FR-24).
  app.post<{ Params: FloorParams }>(
    "/api/floors/:floorId/manager-chat/attachments",
    { config: { access: "owner" }, bodyLimit: uploadBodyLimit },
    async (request, reply) => {
      const parsed = chatAttachmentUploadSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { floorId } = request.params;
      try {
        // The Floor must exist, with its Manager.
        await chat.history(floorId, 1);
      } catch (error) {
        return sendChatError(reply, error);
      }
      if (options.attachments === undefined) {
        const body: ApiError = {
          error: apiErrorCodes.invalidRequest,
          message: "Attachments are not kept here.",
        };
        return reply.code(400).send(body);
      }
      // Its real size and kind, from its bytes, not from what it says.
      const read = readChatAttachment(parsed.data);
      if (!read.ok) {
        const body: ApiError = {
          error: apiErrorCodes.invalidRequest,
          message: read.problem,
        };
        return reply.code(400).send(body);
      }
      const kept = await options.attachments.add({
        floorId,
        name: parsed.data.name,
        mediaType: parsed.data.mediaType,
        content: read.content,
        createdAt: (options.now ?? (() => new Date()))(),
      });
      // Its kind and size, never its name or content.
      request.log.info(
        { floorId, mediaType: kept.mediaType, size: kept.size },
        "The Owner attached a file to the Manager chat.",
      );
      const body: ChatAttachment = kept;
      return reply.code(201).send(body);
    },
  );

  // An attachment's content, as itself: an image inline, a text file as a
  // download, never run as a page.
  app.get<{ Params: FloorParams & { readonly attachmentId: string } }>(
    "/api/floors/:floorId/manager-chat/attachments/:attachmentId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId, attachmentId } = request.params;
      const found = await options.attachments?.get(floorId, attachmentId);
      if (found === undefined) {
        const body: ApiError = {
          error: managerChatErrorCodes.attachmentNotFound,
          message: "There is no such attachment on this Floor.",
        };
        return reply.code(404).send(body);
      }
      const image = isChatImage(found.mediaType);
      return reply
        .header(
          "content-type",
          image ? found.mediaType : `${found.mediaType}; charset=utf-8`,
        )
        .header("content-disposition", dispositionOf(image, found.name))
        .header("x-content-type-options", "nosniff")
        .header(
          "content-security-policy",
          "default-src 'none'; img-src 'self'; sandbox",
        )
        .header("cross-origin-resource-policy", "same-origin")
        .header("cache-control", "private, max-age=3600")
        .send(found.content);
    },
  );

  // The repository's files for `@` mentions (FR-24).
  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/manager-chat/files",
    { config: { access: "owner" } },
    async (request, reply) => {
      const query = managerChatFilesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const { floorId } = request.params;
      try {
        await chat.history(floorId, 1);
      } catch (error) {
        return sendChatError(reply, error);
      }
      let files: string[] = [];
      try {
        files = (await options.files?.search(floorId, query.data.query)) ?? [];
      } catch (error) {
        // Mentions are an aid: without GitHub, none are offered.
        request.log.warn(
          { err: error, floorId },
          "The repository's files could not be read for mentions.",
        );
      }
      const body: ManagerChatFileList = { files };
      return body;
    },
  );

  // The chat's live task list (FR-24), newest request first.
  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/manager-chat/tasks",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId } = request.params;
      try {
        await chat.history(floorId, 1);
        const body: ManagerChatTaskList = {
          tasks: (await options.tasks?.list(floorId)) ?? [],
        };
        return body;
      } catch (error) {
        return sendChatError(reply, error);
      }
    },
  );

  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/grilling-sessions",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const sessions = await chat.grillingSessions(request.params.floorId);
        const body: GrillingSessionList = {
          sessions: sessions.map(grillingSessionSummary),
        };
        return body;
      } catch (error) {
        return sendChatError(reply, error);
      }
    },
  );

  app.get<{ Params: FloorParams & { readonly sessionId: string } }>(
    "/api/floors/:floorId/grilling-sessions/:sessionId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const sessionId = Number(request.params.sessionId);
      try {
        if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
          throw new GrillingError(
            grillingErrorCodes.sessionNotFound,
            `There is no Grilling Session "${request.params.sessionId}" on this Floor.`,
          );
        }
        const found = await chat.grillingSession(
          request.params.floorId,
          sessionId,
        );
        const body: GrillingSessionDetail = {
          session: sessionBody(found.session),
          messages: found.messages.map(messageBody),
        };
        return body;
      } catch (error) {
        return sendChatError(reply, error);
      }
    },
  );

  app.put<{ Params: FloorParams & { readonly sessionId: string } }>(
    "/api/floors/:floorId/grilling-sessions/:sessionId/issues",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = grillingIssueDraftsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const sessionId = Number(request.params.sessionId);
      try {
        if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
          throw new GrillingError(
            grillingErrorCodes.sessionNotFound,
            `There is no Grilling Session "${request.params.sessionId}" on this Floor.`,
          );
        }
        const session = await chat.saveGrillingIssues(
          request.params.floorId,
          sessionId,
          parsed.data.drafts,
        );
        const body: GrillingSession = sessionBody(session);
        return body;
      } catch (error) {
        return sendChatError(reply, error);
      }
    },
  );

  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/manager-chat/stream",
    { config: { access: "owner" } },
    async (request, reply) => {
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
      const { floorId } = request.params;
      try {
        // The Floor must exist, with its Manager.
        await chat.history(floorId, 1);
      } catch (error) {
        return sendChatError(reply, error);
      }

      // Subscribe first and hold what arrives while catching up, so
      // nothing is lost or sent twice.
      let lastSent = after.data ?? 0;
      let live = false;
      const held: ManagerChatUpdate[] = [];
      const send = (frame: ManagerChatFrame): void => {
        if (frame.type !== "message") {
          stream.sendData(frame);
        } else if (frame.message.id > lastSent) {
          lastSent = frame.message.id;
          stream.send(frame.message.id, frame);
        }
      };
      const forward = (update: ManagerChatUpdate): void => {
        send(
          update.type === "message"
            ? { type: "message", message: messageBody(update.message) }
            : update,
        );
      };
      const subscription = chat.subscribe(floorId, (update) => {
        if (live) {
          forward(update);
        } else {
          held.push(update);
        }
      });
      const stream = openSse(request, reply, {
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
            const page = await chat.after(floorId, lastSent);
            for (const message of page) {
              if (message.replyTo !== null) {
                answered.add(message.replyTo);
              }
              forward({ type: "message", message });
            }
            if (page.length < replayPageSize || stream.ended) {
              break;
            }
          }
        }
        // A reply being written, from its text so far.
        for (const { replyTo, text } of subscription.pending) {
          if (!answered.has(replyTo)) {
            send({ type: "pending", replyTo, text });
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
          "A Manager chat stream failed to catch up.",
        );
        stream.end();
      }
    },
  );
}
