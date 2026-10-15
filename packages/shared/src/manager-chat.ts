import { z } from "zod";

import { grillingMessageRefSchema, grillingSessionSchema } from "./grilling.ts";
import {
  chatAttachmentSchema,
  managerChatToolUseSchema,
  maxChatAttachments,
} from "./manager-chat-session.ts";
import {
  floorSkillSources,
  maxSkillNameLength,
  skillNamePattern,
} from "./skills.ts";

// The Manager chat (PRD FR-24): the Owner talks with each Floor's Manager.
// Commands such as "complete issues 1 to 5" (or "complete issues 1 to 5 in
// one PR", ADR 0010), "skip 4", "move 5 up", "pause", "resume" and
// "status" are read by plain code, which says what
// it understood; anything else goes to the Manager's Model through the AI
// Gateway, and its reply streams back over server-sent events (§8). The
// server, the web app and the orchestrator share these.

/** The highest issue number GitHub (and Postgres' `integer`) can hold. */
export const maxIssueNumber = 2_147_483_647;

/** The most issues one command may name. */
export const maxCommandIssues = 50;

/** The longest message the Owner may send. */
export const maxManagerChatMessageLength = 8000;

const issueNumberSchema = z.number().int().positive().max(maxIssueNumber);

/** A command the chat read in plain code, before any model saw it. */
export const managerCommandSchema = z.discriminatedUnion("kind", [
  /**
   * "complete issues 1 to 5": hand the Manager a Batch. With "in one PR",
   * its issues are worked one after another on one branch, in one pull
   * request (ADR 0010).
   */
  z.object({
    kind: z.literal("complete"),
    issues: z.array(issueNumberSchema).min(1).max(maxCommandIssues),
    onePullRequest: z.boolean().optional(),
  }),
  /** "skip 4": leave issues out of the Batch. */
  z.object({
    kind: z.literal("skip"),
    issues: z.array(issueNumberSchema).min(1).max(maxCommandIssues),
  }),
  /** "move 5 up": one place earlier (or later) in the Plan. */
  z.object({
    kind: z.literal("move"),
    issue: issueNumberSchema,
    direction: z.enum(["up", "down"]),
  }),
  /** "pause": stop starting the Floor's work. */
  z.object({ kind: z.literal("pause") }),
  /** "resume": start it again. */
  z.object({ kind: z.literal("resume") }),
  /** "status": the Manager's status report on the Floor (FR-23). */
  z.object({ kind: z.literal("report") }),
]);
export type ManagerCommand = z.infer<typeof managerCommandSchema>;
export type ManagerCommandKind = ManagerCommand["kind"];

/** The commands, as the Owner types them: shown beside the chat. */
export const managerCommandExamples: readonly string[] = [
  "complete issues 1 to 5",
  "complete issues 1 to 5 in one PR",
  "skip 4",
  "move 5 up",
  "pause",
  "resume",
  "status",
];

// Skills in the chat (PRD FR-74): `/skill-name [arguments]` loads that
// Skill's instructions into the Manager's session for the conversation,
// and the Manager may choose one itself when a request matches its
// description, saying which.

/** `/name` or `/name arguments`: the Skill's name, and what follows it. */
export function readSkillCommand(
  text: string,
): { readonly name: string; readonly arguments: string | null } | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (
    name === undefined ||
    name.length > maxSkillNameLength ||
    !skillNamePattern.test(name)
  ) {
    return undefined;
  }
  const rest = match?.[2]?.trim() ?? "";
  return { name, arguments: rest === "" ? null : rest };
}

/** What the Manager's reply starts with when it chose a Skill itself. */
export const skillAnnouncement = (name: string): string =>
  `Using the Skill /${name}.`;

// Clearing and compacting the chat (PRD FR-87, FR-88): `/clear` wipes the
// conversation the Manager's Model is given, keeping what is stored apart
// from it (decisions, Plans, Batches, a Grilling Session's data);
// `/compact [what to keep]` replaces the older history with a summary the
// Manager's Model writes. The chat also compacts itself when the
// Manager's Context Usage reaches its threshold. Both are read before any
// Skill of their name.

export const clearCommand = "/clear";
export const compactCommand = "/compact";

/** `/clear`, or `/compact` with what to keep, if anything; undefined otherwise. */
export function readChatControl(
  text: string,
):
  | { readonly kind: "clear" }
  | { readonly kind: "compact"; readonly focus: string | null }
  | undefined {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === clearCommand) {
    return { kind: "clear" };
  }
  const compact = /^\/compact(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (compact === null) {
    return undefined;
  }
  const focus = compact[1]?.trim() ?? "";
  return { kind: "compact", focus: focus === "" ? null : focus };
}

/** Who compacted the conversation: the Owner, or AI Office at the threshold. */
export const managerChatCompactionTriggers = ["owner", "auto"] as const;

/** What a `summary` message replaced. */
export const managerChatCompactionSchema = z.object({
  trigger: z.enum(managerChatCompactionTriggers),
  /** The Manager's Context Usage when it was compacted, 0 to 1; null if unknown. */
  contextUsage: z.number().min(0).max(1).nullable(),
  /** The last message it replaced: the conversation goes on after it. */
  upTo: z.number().int().positive(),
  /** How many messages it replaced. */
  messages: z.number().int().nonnegative(),
});
export type ManagerChatCompaction = z.infer<typeof managerChatCompactionSchema>;

/** A Skill a message ran: the Owner's `/name`, or the Manager's choice. */
export const managerChatSkillSchema = z.object({
  name: z.string(),
  source: z.enum(floorSkillSources),
  /** What the Owner wrote after `/name`; null for none, and for the Manager's choice. */
  arguments: z.string().nullable(),
  /** The Owner, who typed `/name`, or the Manager, who chose it from its description. */
  chosenBy: z.enum(["owner", "manager"]),
});
export type ManagerChatSkill = z.infer<typeof managerChatSkillSchema>;

/**
 * What a chat message is:
 * - `owner`: the Owner's own words;
 * - `command`: the Manager's plain-code answer to a command, saying what it
 *   understood;
 * - `hint`: a command refused (a typo, or a range or list it cannot
 *   read), with what to type instead; no model saw it;
 * - `reply`: the Manager's Model's answer;
 * - `error`: why the Manager's Model did not answer;
 * - `report`: the Manager's status report on the Floor (FR-23), written in
 *   plain code, in answer to "status" or, answering nothing, once a day;
 * - `grilling`: what AI Office says of a Grilling Session in plain code
 *   (FR-78, FR-82): answers noted, the session paused, resumed or ended;
 * - `clear`: the conversation was cleared (`/clear`, FR-87): the Manager's
 *   Model is given nothing before it;
 * - `summary`: the conversation was compacted (`/compact`, or on its own at
 *   the Context Usage threshold; FR-87): the Manager's Model is given this
 *   summary in place of the messages it replaced;
 * - `plan`: the Manager's Plan for a request the Owner made in the chat
 *   (FR-24, ADR 0004): the issues it files and the Contractors it adds,
 *   which it then carries out at once;
 * - `progress`: the Manager reporting back on a chat request, in plain
 *   code, as a sub-agent's completion is: an issue done or blocked, a
 *   Contractor arriving or leaving, research found, the Batch's Wrap-up.
 */
export const managerChatMessageKinds = [
  "owner",
  "command",
  "hint",
  "reply",
  "error",
  "report",
  "grilling",
  "clear",
  "summary",
  "plan",
  "progress",
] as const;
export type ManagerChatMessageKind = (typeof managerChatMessageKinds)[number];

export const managerChatMessageSchema = z.object({
  id: z.number().int().positive(),
  floorId: z.string(),
  kind: z.enum(managerChatMessageKinds),
  text: z.string(),
  /** What a `command` message understood; null otherwise. */
  command: managerCommandSchema.nullable(),
  /**
   * The Owner's message the Manager answers; null for the Owner's own, and
   * for a daily status report.
   */
  replyTo: z.number().int().positive().nullable(),
  /** The Manager who answered; null for the Owner's own. */
  agentId: z.string().nullable(),
  /** The Model that wrote a `reply` (or was asked, for an `error`). */
  model: z.string().nullable(),
  /**
   * The Skill it ran (FR-74): on the Owner's `/name` message, or on the
   * Manager's reply when it chose one; null otherwise.
   */
  skill: managerChatSkillSchema.nullable(),
  /**
   * The Grilling Session it belongs to (FR-77), and the round it asks, if
   * any; null outside a session.
   */
  grilling: grillingMessageRefSchema.nullable(),
  /** What a `summary` replaced; null for every other message. */
  compaction: managerChatCompactionSchema.nullable(),
  /**
   * The tools the Manager's session used for a `reply` (files read,
   * searches, fetches), shown collapsed; empty for every other message.
   */
  tools: z.array(managerChatToolUseSchema),
  /** The files and images the Owner attached to their message. */
  attachments: z.array(chatAttachmentSchema),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ManagerChatMessage = z.infer<typeof managerChatMessageSchema>;

/** A reply the Manager's Model is still writing: the text so far. */
export const pendingManagerReplySchema = z.object({
  replyTo: z.number().int().positive(),
  text: z.string(),
});
export type PendingManagerReply = z.infer<typeof pendingManagerReplySchema>;

/** `POST /api/floors/:floorId/manager-chat/messages`. */
export const managerChatSendRequestSchema = z
  .strictObject({
    text: z
      .string()
      .trim()
      .max(
        maxManagerChatMessageLength,
        `A message is at most ${maxManagerChatMessageLength.toLocaleString("en-GB")} characters.`,
      ),
    /** Attachments uploaded first, by id, sent with it. */
    attachments: z
      .array(z.string().min(1))
      .max(maxChatAttachments, {
        error: `Attach at most ${String(maxChatAttachments)} files to a message.`,
      })
      .default([]),
  })
  .refine(({ text, attachments }) => text !== "" || attachments.length > 0, {
    error: "Write a message.",
    path: ["text"],
  });
export type ManagerChatSendRequest = z.infer<
  typeof managerChatSendRequestSchema
>;

/**
 * What sending answers: the Owner's message as stored and, for a command
 * (or a refused one), the Manager's answer at once. Otherwise `reply` is
 * null and the Model's reply streams in.
 */
export const managerChatSendResponseSchema = z.object({
  message: managerChatMessageSchema,
  reply: managerChatMessageSchema.nullable(),
});
export type ManagerChatSendResponse = z.infer<
  typeof managerChatSendResponseSchema
>;

/** `GET /api/floors/:floorId/manager-chat`: the Floor's chat so far. */
export const managerChatSchema = z.object({
  /** The Floor's Manager. */
  manager: z.object({
    id: z.string(),
    name: z.string(),
    aiProvider: z.string(),
    model: z.string(),
  }),
  /** The latest messages, oldest first. */
  messages: z.array(managerChatMessageSchema),
  /** Replies still being written. */
  pending: z.array(pendingManagerReplySchema),
});
export type ManagerChat = z.infer<typeof managerChatSchema>;

/**
 * One frame of `GET /api/floors/:floorId/manager-chat/stream`:
 * - `message`: a message as stored (its SSE id is the message's id, so a
 *   reconnection resumes after it);
 * - `pending`: a reply being written, with its text so far, sent as the
 *   stream opens;
 * - `delta`: more of a reply being written;
 * - `tool`: a tool the Manager's session used for that reply;
 * - `tasks`: the work the chat's requests spun off changed (an issue moved
 *   on, a Contractor came or went): fetch the task list again.
 */
export const managerChatFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: managerChatMessageSchema }),
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
  /** A tool the Manager's session used for the reply being written. */
  z.object({
    type: z.literal("tool"),
    replyTo: z.number().int().positive(),
    tool: managerChatToolUseSchema,
  }),
  /** The chat's task list changed: `GET …/manager-chat/tasks` again. */
  z.object({ type: z.literal("tasks") }),
]);
export type ManagerChatFrame = z.infer<typeof managerChatFrameSchema>;

/** `lastEventId` on the stream: the last message id the client has. */
export const managerChatStreamQuerySchema = z.strictObject({
  lastEventId: z.coerce.number().int().nonnegative().optional(),
});

export const managerChatErrorCodes = {
  /** The Floor has no Manager. */
  managerNotFound: "manager_not_found",
  /**
   * The Manager is carrying out the Owner's last request (filing its
   * issues, starting its Batch): a message waits until it has. While it is
   * only writing, a new message interrupts it instead.
   */
  replyInProgress: "reply_in_progress",
  /** An attachment named is not this Floor's, or was sent already. */
  attachmentNotFound: "attachment_not_found",
} as const;
export type ManagerChatErrorCode =
  (typeof managerChatErrorCodes)[keyof typeof managerChatErrorCodes];

/**
 * `GET /api/floors/:floorId/grilling-sessions/:sessionId`: a Grilling
 * Session in full, with every chat message it holds, oldest first (FR-82).
 */
export const grillingSessionDetailSchema = z.object({
  session: grillingSessionSchema,
  messages: z.array(managerChatMessageSchema),
});
export type GrillingSessionDetail = z.infer<typeof grillingSessionDetailSchema>;
