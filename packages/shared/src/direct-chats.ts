import { z } from "zod";

import { maxManagerChatMessageLength } from "./manager-chat.ts";

// Direct chats: the Owner talks one to one with any of a Floor's Agents
// (clicking its Avatar in the Office), or with the AI itself in the
// Terminal. Unlike the Manager chat there are no commands, Skills or
// Grilling Sessions: every message goes to a Model through the AI Gateway,
// and its reply streams back over server-sent events, as the Manager's
// does. An Agent's chat presents the Agent's own Gateway Key, so it counts
// against its Token Caps; the Terminal presents an Owner tool key of its
// own, "Terminal". `/clear` starts the conversation afresh. The server,
// the web app and the orchestrator share these.

/** The Owner tool key the Terminal's model calls present. */
export const terminalKeyName = "Terminal";

/**
 * The session every direct chat's model calls name (`aiOfficeHeaders.
 * session`): the Gateway keeps it on one AI Account per Gateway Key, the
 * request history finds the chat's own calls by it, and the Agent's
 * sandbox Context Usage leaves them out.
 */
export const directChatSession = "direct-chat";

/** The longest message the Owner may send. */
export const maxDirectChatMessageLength = maxManagerChatMessageLength;

/**
 * What a direct chat message is: the Owner's (`owner`), a Model's reply
 * (`reply`), why there was none (`error`), or where the Owner cleared the
 * conversation (`clear`).
 */
export const directChatMessageKinds = [
  "owner",
  "reply",
  "error",
  "clear",
] as const;
export type DirectChatMessageKind = (typeof directChatMessageKinds)[number];

export const directChatMessageSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(directChatMessageKinds),
  text: z.string(),
  /** The Owner's message this answers; null for the Owner's own. */
  replyTo: z.number().int().positive().nullable(),
  /** The Model that answered (or was asked). */
  model: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type DirectChatMessage = z.infer<typeof directChatMessageSchema>;

/** A reply being written, with its text so far. */
export const directChatPendingSchema = z.object({
  replyTo: z.number().int().positive(),
  text: z.string(),
});

/** A Model the Terminal can talk to: an AI Provider's default Model. */
export const terminalModelSchema = z.object({
  aiProvider: z.string(),
  model: z.string(),
});
export type TerminalModel = z.infer<typeof terminalModelSchema>;

/**
 * A direct chat's latest answered model call, as the AI Gateway recorded
 * it: its Context Usage (that call's whole prompt against its Model's
 * context window) and the AI Account that served it. None before the
 * first reply, or since a `/clear`.
 */
export const directChatUsageSchema = z.object({
  /** The Model it asked. */
  model: z.string(),
  /** Its input tokens, cached ones included. */
  inputTokens: z.number().int().min(0),
  /** The Model's context window from the catalogue; null when unknown. */
  contextWindow: z.number().int().positive().nullable(),
  /** From 0 to 1; null when the context window is unknown. */
  contextUsage: z.number().min(0).max(1).nullable(),
  /** The AI Account that served it, while it exists. */
  aiAccountId: z.string().nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type DirectChatUsage = z.infer<typeof directChatUsageSchema>;

/**
 * `GET /api/floors/:floorId/agents/:agentId/chat` and `GET
 * /api/terminal`: who answers, the latest messages, and any reply being
 * written. The Terminal's `models` are what it can be asked with.
 */
export const directChatSchema = z.object({
  /** Who answers: the Agent's name, or "the AI" for the Terminal. */
  name: z.string(),
  aiProvider: z.string().nullable(),
  /** The Model asked when the Owner names none; "" for none. */
  model: z.string(),
  messages: z.array(directChatMessageSchema),
  pending: z.array(directChatPendingSchema),
  models: z.array(terminalModelSchema),
  /** Its latest answered model call; null for none (absent from older servers). */
  usage: directChatUsageSchema.nullable().optional(),
});
export type DirectChat = z.infer<typeof directChatSchema>;

/** The body of a message to a direct chat. */
export const directChatSendRequestSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1, "Write a message.")
    .max(
      maxDirectChatMessageLength,
      `A message is at most ${maxDirectChatMessageLength.toLocaleString("en-GB")} characters.`,
    ),
  /** The Terminal only: the Model to ask, one of its `models`. */
  model: z.string().trim().min(1).max(200).optional(),
});
export type DirectChatSendRequest = z.infer<typeof directChatSendRequestSchema>;

/** `201` to a message: it, and the answer when it is answered at once. */
export const directChatSendResponseSchema = z.object({
  message: directChatMessageSchema,
  reply: directChatMessageSchema.nullable(),
});
export type DirectChatSendResponse = z.infer<
  typeof directChatSendResponseSchema
>;

/** One frame of a direct chat's stream. */
export const directChatFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: directChatMessageSchema }),
  z.object({
    type: z.literal("pending"),
    replyTo: z.number().int().positive(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("delta"),
    replyTo: z.number().int().positive(),
    text: z.string(),
  }),
]);
export type DirectChatFrame = z.infer<typeof directChatFrameSchema>;

export const directChatErrorCodes = {
  /** There is no such Agent on the Floor. */
  agentNotFound: "agent_not_found",
  /** The Model is still answering the Owner's last message. */
  replyInProgress: "reply_in_progress",
  /** The Terminal was asked with a Model it does not offer. */
  modelNotOffered: "model_not_offered",
} as const;
export type DirectChatErrorCode =
  (typeof directChatErrorCodes)[keyof typeof directChatErrorCodes];
