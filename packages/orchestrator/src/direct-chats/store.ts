import { directChatMessages, type Database } from "@ai-office/db";
import {
  directChatMessageKinds,
  type DirectChatMessageKind,
} from "@ai-office/shared";
import { and, desc, eq, gt } from "drizzle-orm";

// Where direct chats are kept: the `direct_chat_messages` table, or memory
// for tests. A chat is `agent:<id>` for one of a Floor's Agents, or
// `terminal` for the Terminal. Messages are kept in the order they were
// written; their ids grow with it.

/** The Terminal's chat. */
export const terminalChat = "terminal";

/** An Agent's chat. */
export const agentChat = (agentId: string): string => `agent:${agentId}`;

/** One message in a direct chat. */
export interface DirectChatMessageRecord {
  readonly id: number;
  readonly chat: string;
  /** The Agent's Floor and the Agent; null in the Terminal. */
  readonly floorId: string | null;
  readonly agentId: string | null;
  readonly kind: DirectChatMessageKind;
  readonly text: string;
  /** The Owner's message it answers; null for the Owner's own, and a clear. */
  readonly replyTo: number | null;
  /** The Model that answered (or was asked). */
  readonly model: string | null;
  readonly createdAt: Date;
}

export type NewDirectChatMessage = Omit<DirectChatMessageRecord, "id">;

export interface DirectChatStore {
  /** Keeps a message, giving it the next id. */
  append(message: NewDirectChatMessage): Promise<DirectChatMessageRecord>;
  /**
   * A chat's latest `limit` messages, oldest first; with `after`, only
   * those after that id.
   */
  latest(
    chat: string,
    limit: number,
    after?: number,
  ): Promise<DirectChatMessageRecord[]>;
  /** The chat's latest `clear`'s id; 0 for none. */
  clearedAt(chat: string): Promise<number>;
}

const copy = (message: DirectChatMessageRecord): DirectChatMessageRecord => ({
  ...message,
  createdAt: new Date(message.createdAt),
});

export function memoryDirectChatStore(): DirectChatStore & {
  readonly messages: DirectChatMessageRecord[];
} {
  const messages: DirectChatMessageRecord[] = [];
  return {
    messages,
    append(message) {
      const record = copy({ ...message, id: messages.length + 1 });
      messages.push(record);
      return Promise.resolve(copy(record));
    },
    latest: (chat, limit, after = 0) =>
      Promise.resolve(
        messages
          .filter((message) => message.chat === chat && message.id > after)
          .slice(-limit)
          .map(copy),
      ),
    clearedAt: (chat) =>
      Promise.resolve(
        messages.findLast(
          (message) => message.chat === chat && message.kind === "clear",
        )?.id ?? 0,
      ),
  };
}

type Row = typeof directChatMessages.$inferSelect;

const kindOf = (kind: string): DirectChatMessageKind => {
  const known = directChatMessageKinds.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new Error(`A direct chat message has an unknown kind, ${kind}.`);
  }
  return known;
};

const recordOf = (row: Row): DirectChatMessageRecord => ({
  id: row.id,
  chat: row.chat,
  floorId: row.floorId,
  agentId: row.agentId,
  kind: kindOf(row.kind),
  text: row.text,
  replyTo: row.replyTo,
  model: row.model,
  createdAt: row.createdAt,
});

/** Keeps direct chats in `direct_chat_messages`. */
export function databaseDirectChatStore(db: Database): DirectChatStore {
  return {
    async append(message) {
      const [row] = await db
        .insert(directChatMessages)
        .values(message)
        .returning();
      if (row === undefined) {
        throw new Error("The direct chat message was not stored.");
      }
      return recordOf(row);
    },

    async latest(chat, limit, after = 0) {
      const rows = await db
        .select()
        .from(directChatMessages)
        .where(
          and(
            eq(directChatMessages.chat, chat),
            gt(directChatMessages.id, after),
          ),
        )
        .orderBy(desc(directChatMessages.id))
        .limit(limit);
      return rows.reverse().map(recordOf);
    },

    async clearedAt(chat) {
      const [row] = await db
        .select({ id: directChatMessages.id })
        .from(directChatMessages)
        .where(
          and(
            eq(directChatMessages.chat, chat),
            eq(directChatMessages.kind, "clear"),
          ),
        )
        .orderBy(desc(directChatMessages.id))
        .limit(1);
      return row?.id ?? 0;
    },
  };
}
