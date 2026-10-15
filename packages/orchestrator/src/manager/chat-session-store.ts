import { managerChatSessions, type Database } from "@ai-office/db";
import { and, eq } from "drizzle-orm";

import type { CallingTool } from "../models/agent-tool-client.ts";

// Where each Manager chat conversation's agent session is kept (PRD FR-24,
// ADR 0004): the `manager_chat_sessions` table, or memory for tests. The
// Manager answers in a continuing session of its agent tool, resumed turn
// to turn by the tool's own session id, so a conversation goes on after a
// restart. A conversation is the chat since its latest clear or compaction,
// named as its model calls name their session (FR-84).

export interface ManagerChatSessionRecord {
  readonly floorId: string;
  /** The conversation, such as `manager-chat:web-shop:41`. */
  readonly conversation: string;
  readonly tool: CallingTool;
  /** The agent tool's own session id, which it resumes. */
  readonly toolSessionId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ManagerChatSessionStore {
  get(
    floorId: string,
    conversation: string,
  ): Promise<ManagerChatSessionRecord | undefined>;
  /**
   * Keeps the conversation's session, in place of any before it: a
   * conversation keeps when it was first given one.
   */
  put(
    session: Omit<ManagerChatSessionRecord, "createdAt" | "updatedAt">,
    at: Date,
  ): Promise<void>;
}

const keyOf = (floorId: string, conversation: string): string =>
  `${floorId}\n${conversation}`;

/** Keeps the sessions in memory: for tests. */
export function memoryManagerChatSessionStore(): ManagerChatSessionStore & {
  readonly records: Map<string, ManagerChatSessionRecord>;
} {
  const records = new Map<string, ManagerChatSessionRecord>();
  return {
    records,
    get: (floorId, conversation) => {
      const record = records.get(keyOf(floorId, conversation));
      return Promise.resolve(record === undefined ? undefined : { ...record });
    },
    put(session, at) {
      const key = keyOf(session.floorId, session.conversation);
      records.set(key, {
        ...session,
        createdAt: records.get(key)?.createdAt ?? at,
        updatedAt: at,
      });
      return Promise.resolve();
    },
  };
}

/** Keeps the sessions in the `manager_chat_sessions` table. */
export function databaseManagerChatSessionStore(
  db: Database,
): ManagerChatSessionStore {
  return {
    async get(floorId, conversation) {
      const [row] = await db
        .select()
        .from(managerChatSessions)
        .where(
          and(
            eq(managerChatSessions.floorId, floorId),
            eq(managerChatSessions.conversation, conversation),
          ),
        );
      return row === undefined
        ? undefined
        : {
            floorId: row.floorId,
            conversation: row.conversation,
            tool: row.tool === "Codex" ? "Codex" : "Claude Code",
            toolSessionId: row.toolSessionId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
    },

    async put(session, at) {
      await db
        .insert(managerChatSessions)
        .values({ ...session, createdAt: at, updatedAt: at })
        .onConflictDoUpdate({
          target: [
            managerChatSessions.floorId,
            managerChatSessions.conversation,
          ],
          set: {
            tool: session.tool,
            toolSessionId: session.toolSessionId,
            updatedAt: at,
          },
        });
    },
  };
}
