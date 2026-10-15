import { managerChatMessages, type Database } from "@ai-office/db";
import {
  managerChatToolUseSchema,
  type ChatAttachment,
  type ManagerChatToolUse,
  grillingMessageRefSchema,
  managerChatCompactionSchema,
  managerChatMessageKinds,
  managerChatSkillSchema,
  managerCommandSchema,
  statusUpdateHeading,
  type GrillingMessageRef,
  type ManagerChatCompaction,
  type ManagerChatMessageKind,
  type ManagerChatSkill,
  type ManagerCommand,
} from "@ai-office/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  notLike,
} from "drizzle-orm";

import {
  attachmentsOfMessages,
  bindChatAttachments,
  ChatAttachmentsTakenError,
} from "./attachments.ts";

// Where each Floor's Manager chat is kept (PRD FR-24): the
// `manager_chat_messages` table, or memory for tests. Messages are kept in
// the order they were written; their ids grow with it.

/** One message in a Floor's Manager chat. */
export interface ChatMessageRecord {
  readonly id: number;
  readonly floorId: string;
  readonly kind: ManagerChatMessageKind;
  readonly text: string;
  /** What a `command` message understood; null otherwise. */
  readonly command: ManagerCommand | null;
  /**
   * The Owner's message the Manager answers; null for the Owner's own, and
   * for a daily status report.
   */
  readonly replyTo: number | null;
  /** The Manager who answered; null for the Owner's own. */
  readonly agentId: string | null;
  /** The Model that answered (or was asked). */
  readonly model: string | null;
  /** The Skill it ran (FR-74): the Owner's `/name`, or the Manager's choice. */
  readonly skill: ManagerChatSkill | null;
  /** The Grilling Session it belongs to (FR-77), and the round it asks. */
  readonly grilling: GrillingMessageRef | null;
  /** What a `summary` replaced (FR-87); null for every other message. */
  readonly compaction: ManagerChatCompaction | null;
  /** The tools the Manager's session used for a `reply` (FR-24); empty otherwise. */
  readonly tools: readonly ManagerChatToolUse[];
  /** The files and images the Owner attached to their message. */
  readonly attachments: readonly ChatAttachment[];
  readonly createdAt: Date;
}

/** A message to keep; one that ran a Skill keeps the instructions it loaded. */
export type NewChatMessage = Omit<
  ChatMessageRecord,
  "id" | "skill" | "grilling" | "compaction" | "tools" | "attachments"
> & {
  readonly skill?: ManagerChatSkill | null;
  readonly grilling?: GrillingMessageRef | null;
  readonly compaction?: ManagerChatCompaction | null;
  readonly tools?: readonly ManagerChatToolUse[];
  /** The attachments it sends, uploaded first; none if absent. */
  readonly attachments?: readonly ChatAttachment[];
  /** The instructions the Skill loaded: with `skill` and only with it. */
  readonly skillInstructions?: string;
};

/** A Skill loaded in the conversation, as it was loaded. */
export interface LoadedSkill {
  readonly name: string;
  readonly source: ManagerChatSkill["source"];
  readonly instructions: string;
  /** The message that loaded it. */
  readonly messageId: number;
}

/**
 * Where a Floor's conversation starts (FR-87): after its latest `/clear`,
 * or after the messages its latest compaction replaced.
 */
export interface ConversationStart {
  /** The conversation is the messages after this id; 0 for all of them. */
  readonly after: number;
  /** The latest `clear` message's id; 0 for none. */
  readonly cleared: number;
  /** The summary the conversation starts with, if it was compacted since. */
  readonly summary: ChatMessageRecord | undefined;
  /** The `clear` or `summary` message it starts from, if any. */
  readonly marker: ChatMessageRecord | undefined;
}

/** Where a conversation starts, from its latest `clear` or `summary`. */
export function startOf(
  marker: ChatMessageRecord | undefined,
  cleared: number,
): ConversationStart {
  if (marker?.kind === "summary") {
    return {
      after: marker.compaction?.upTo ?? marker.id,
      cleared,
      summary: marker,
      marker,
    };
  }
  return { after: marker?.id ?? 0, cleared, summary: undefined, marker };
}

export interface ManagerChatStore {
  /** Keeps a message, giving it the next id. */
  append(message: NewChatMessage): Promise<ChatMessageRecord>;
  /**
   * A Floor's latest `limit` messages, oldest first; with `after`, only
   * those after that id.
   */
  latest(
    floorId: string,
    limit: number,
    after?: number,
  ): Promise<ChatMessageRecord[]>;
  /** Where the Floor's conversation starts: after its latest clear or compaction. */
  conversationStart(floorId: string): Promise<ConversationStart>;
  /** A Floor's messages after `id`, oldest first, at most `limit`. */
  after(
    floorId: string,
    id: number,
    limit: number,
  ): Promise<ChatMessageRecord[]>;
  /**
   * The Floor's latest daily status report: the latest `report` message
   * that answers nothing, but for a Status update's (FR-23a), which is
   * one too but tells of something else.
   */
  latestDailyReport(floorId: string): Promise<ChatMessageRecord | undefined>;
  /**
   * The Skills loaded by the Floor's messages from `sinceId` on, oldest
   * first: each time one was loaded.
   */
  loadedSkills(floorId: string, sinceId: number): Promise<LoadedSkill[]>;
  /** Every message of one of the Floor's Grilling Sessions, oldest first. */
  ofGrillingSession(
    floorId: string,
    sessionId: number,
  ): Promise<ChatMessageRecord[]>;
}

const copy = (message: ChatMessageRecord): ChatMessageRecord => ({
  ...message,
  command:
    message.command === null
      ? null
      : managerCommandSchema.parse(message.command),
  skill:
    message.skill === null ? null : managerChatSkillSchema.parse(message.skill),
  grilling:
    message.grilling === null
      ? null
      : grillingMessageRefSchema.parse(message.grilling),
  compaction:
    message.compaction === null
      ? null
      : managerChatCompactionSchema.parse(message.compaction),
  tools: message.tools.map((tool) => ({ ...tool })),
  attachments: message.attachments.map((attachment) => ({ ...attachment })),
});

/** The record of a message to keep, and the instructions its Skill loaded. */
const split = ({
  skill,
  skillInstructions,
  grilling,
  compaction,
  tools,
  attachments,
  ...rest
}: NewChatMessage): {
  record: Omit<ChatMessageRecord, "id">;
  instructions: string | null;
} => ({
  record: {
    ...rest,
    skill: skill ?? null,
    grilling: grilling ?? null,
    compaction: compaction ?? null,
    tools: tools ?? [],
    attachments: attachments ?? [],
  },
  instructions: skill == null ? null : (skillInstructions ?? ""),
});

/**
 * Keeps the chat in memory: for tests. With `attachments`, a message's
 * attachments are bound to it as it is kept, all or none, as the database
 * store binds them (FR-24).
 */
export function memoryManagerChatStore(
  options: {
    readonly attachments?: {
      bind(floorId: string, ids: readonly string[], messageId: number): boolean;
    };
  } = {},
): ManagerChatStore & {
  readonly messages: ChatMessageRecord[];
} {
  const messages: ChatMessageRecord[] = [];
  const instructions = new Map<number, string>();
  return {
    messages,
    append(message) {
      const kept = split(message);
      const record = copy({ ...kept.record, id: messages.length + 1 });
      if (
        record.attachments.length > 0 &&
        options.attachments?.bind(
          record.floorId,
          record.attachments.map(({ id }) => id),
          record.id,
        ) === false
      ) {
        return Promise.reject(new ChatAttachmentsTakenError());
      }
      messages.push(record);
      if (kept.instructions !== null) {
        instructions.set(record.id, kept.instructions);
      }
      return Promise.resolve(copy(record));
    },
    loadedSkills: (floorId, sinceId) =>
      Promise.resolve(
        messages
          .filter(
            (message) =>
              message.floorId === floorId &&
              message.id >= sinceId &&
              message.skill !== null,
          )
          .map((message) => ({
            name: message.skill?.name ?? "",
            source: message.skill?.source ?? "office",
            instructions: instructions.get(message.id) ?? "",
            messageId: message.id,
          })),
      ),
    ofGrillingSession: (floorId, sessionId) =>
      Promise.resolve(
        messages
          .filter(
            (message) =>
              message.floorId === floorId &&
              message.grilling?.sessionId === sessionId,
          )
          .map(copy),
      ),
    latest: (floorId, limit, after = 0) =>
      Promise.resolve(
        messages
          .filter(
            (message) => message.floorId === floorId && message.id > after,
          )
          .slice(-limit)
          .map(copy),
      ),
    conversationStart(floorId) {
      const ofFloor = messages.filter((message) => message.floorId === floorId);
      const marker = ofFloor.findLast(
        ({ kind }) => kind === "clear" || kind === "summary",
      );
      const cleared = ofFloor.findLast(({ kind }) => kind === "clear");
      return Promise.resolve(
        startOf(
          marker === undefined ? undefined : copy(marker),
          cleared?.id ?? 0,
        ),
      );
    },
    after: (floorId, id, limit) =>
      Promise.resolve(
        messages
          .filter((message) => message.floorId === floorId && message.id > id)
          .slice(0, limit)
          .map(copy),
      ),
    latestDailyReport(floorId) {
      const report = messages.findLast(
        (message) =>
          message.floorId === floorId &&
          message.kind === "report" &&
          message.replyTo === null &&
          !message.text.startsWith(`${statusUpdateHeading} `),
      );
      return Promise.resolve(report === undefined ? undefined : copy(report));
    },
  };
}

type Row = typeof managerChatMessages.$inferSelect;

const kindOf = (kind: string): ManagerChatMessageKind => {
  const known = managerChatMessageKinds.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new Error(`A Manager chat message has an unknown kind, ${kind}.`);
  }
  return known;
};

const recordOf = (row: Row): ChatMessageRecord => ({
  id: row.id,
  floorId: row.floorId,
  kind: kindOf(row.kind),
  text: row.text,
  command:
    row.command === null ? null : managerCommandSchema.parse(row.command),
  replyTo: row.replyTo,
  agentId: row.agentId,
  model: row.model,
  skill: row.skill === null ? null : managerChatSkillSchema.parse(row.skill),
  grilling:
    row.grillingSessionId === null
      ? null
      : { sessionId: row.grillingSessionId, round: row.grillingRound },
  compaction:
    row.compaction === null
      ? null
      : managerChatCompactionSchema.parse(row.compaction),
  tools: managerChatToolUseSchema.array().catch([]).parse(row.tools),
  // Read beside it, from `manager_chat_attachments`.
  attachments: [],
  createdAt: row.createdAt,
});

/** Keeps the chat in `manager_chat_messages`. */
export function databaseManagerChatStore(db: Database): ManagerChatStore {
  /** Each record with the attachments its message sent (FR-24). */
  const withAttachments = async (
    records: ChatMessageRecord[],
  ): Promise<ChatMessageRecord[]> => {
    const owners = records.filter(({ kind }) => kind === "owner");
    const sent = await attachmentsOfMessages(
      db,
      owners.map(({ id }) => id),
    );
    return sent.size === 0
      ? records
      : records.map((record) => ({
          ...record,
          attachments: sent.get(record.id) ?? [],
        }));
  };
  return {
    async append(message) {
      const { record, instructions } = split(message);
      // The message and its attachments are kept together, or neither.
      const row = await db.transaction(async (tx) => {
        const [kept] = await tx
          .insert(managerChatMessages)
          .values({
            floorId: record.floorId,
            kind: record.kind,
            text: record.text,
            command: record.command,
            replyTo: record.replyTo,
            agentId: record.agentId,
            model: record.model,
            skill: record.skill,
            skillInstructions: instructions,
            grillingSessionId: record.grilling?.sessionId ?? null,
            grillingRound: record.grilling?.round ?? null,
            compaction: record.compaction,
            tools: [...record.tools],
            createdAt: record.createdAt,
          })
          .returning();
        if (kept === undefined) {
          throw new Error("The Manager chat message was not stored.");
        }
        await bindChatAttachments(
          tx,
          record.floorId,
          record.attachments.map(({ id }) => id),
          kept.id,
        );
        return kept;
      });
      return {
        ...recordOf(row),
        attachments: record.attachments.map((attachment) => ({
          ...attachment,
        })),
      };
    },

    async latest(floorId, limit, after = 0) {
      const rows = await db
        .select()
        .from(managerChatMessages)
        .where(
          and(
            eq(managerChatMessages.floorId, floorId),
            gt(managerChatMessages.id, after),
          ),
        )
        .orderBy(desc(managerChatMessages.id))
        .limit(limit);
      return withAttachments(rows.reverse().map(recordOf));
    },

    async conversationStart(floorId) {
      const latestOf = async (kinds: string[]) => {
        const [row] = await db
          .select()
          .from(managerChatMessages)
          .where(
            and(
              eq(managerChatMessages.floorId, floorId),
              inArray(managerChatMessages.kind, kinds),
            ),
          )
          .orderBy(desc(managerChatMessages.id))
          .limit(1);
        return row === undefined ? undefined : recordOf(row);
      };
      const [marker, cleared] = await Promise.all([
        latestOf(["clear", "summary"]),
        latestOf(["clear"]),
      ]);
      return startOf(marker, cleared?.id ?? 0);
    },

    async after(floorId, id, limit) {
      const rows = await db
        .select()
        .from(managerChatMessages)
        .where(
          and(
            eq(managerChatMessages.floorId, floorId),
            gt(managerChatMessages.id, id),
          ),
        )
        .orderBy(asc(managerChatMessages.id))
        .limit(limit);
      return withAttachments(rows.map(recordOf));
    },

    async ofGrillingSession(floorId, sessionId) {
      const rows = await db
        .select()
        .from(managerChatMessages)
        .where(
          and(
            eq(managerChatMessages.floorId, floorId),
            eq(managerChatMessages.grillingSessionId, sessionId),
          ),
        )
        .orderBy(asc(managerChatMessages.id));
      return withAttachments(rows.map(recordOf));
    },

    async loadedSkills(floorId, sinceId) {
      const rows = await db
        .select({
          id: managerChatMessages.id,
          skill: managerChatMessages.skill,
          instructions: managerChatMessages.skillInstructions,
        })
        .from(managerChatMessages)
        .where(
          and(
            eq(managerChatMessages.floorId, floorId),
            gte(managerChatMessages.id, sinceId),
            isNotNull(managerChatMessages.skill),
          ),
        )
        .orderBy(asc(managerChatMessages.id));
      return rows.map(({ id, skill, instructions }) => {
        const { name, source } = managerChatSkillSchema.parse(skill);
        return {
          name,
          source,
          instructions: instructions ?? "",
          messageId: id,
        };
      });
    },

    async latestDailyReport(floorId) {
      const [row] = await db
        .select()
        .from(managerChatMessages)
        .where(
          and(
            eq(managerChatMessages.floorId, floorId),
            eq(managerChatMessages.kind, "report"),
            isNull(managerChatMessages.replyTo),
            notLike(managerChatMessages.text, `${statusUpdateHeading} %`),
          ),
        )
        .orderBy(desc(managerChatMessages.id))
        .limit(1);
      return row === undefined ? undefined : recordOf(row);
    },
  };
}
