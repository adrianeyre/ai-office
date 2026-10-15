import { agentCapPauses, type Database } from "@ai-office/db";
import type { CapLevel, CapPeriod } from "@ai-office/shared";
import { eq } from "drizzle-orm";

// Where Agents paused at a Token Cap live (PRD FR-33): the
// `agent_cap_pauses` table, so a pause outlasts a restart, or memory for
// tests. One per paused Agent.

/** An Agent paused at a Token Cap, and the cap it reached. */
export interface CapPause {
  readonly floorId: string;
  readonly agentId: string;
  /** The issue its calls named when it reached the cap; null for none. */
  readonly issue: number | null;
  readonly period: CapPeriod;
  readonly level: CapLevel;
  readonly cap: number;
  /** Tokens counted against the cap when it was reached. */
  readonly used: number;
  /** The "Token Cap reached" Notice; null until it is raised. */
  readonly noticeId: string | null;
  readonly pausedAt: Date;
  /** When it resumes by itself; null until the Owner chooses. */
  readonly resumeAt: Date | null;
}

export interface CapPauseStore {
  /** Every paused Agent. */
  list(): Promise<CapPause[]>;
  /** Pauses an Agent, or replaces its pause. */
  put(pause: CapPause): Promise<void>;
  /** Resumes an Agent; nothing if it is not paused. */
  remove(agentId: string): Promise<void>;
}

/** Keeps pauses in memory: for tests. */
export function memoryCapPauseStore(): CapPauseStore & {
  readonly pauses: Map<string, CapPause>;
} {
  const pauses = new Map<string, CapPause>();
  return {
    pauses,
    list: () => Promise.resolve([...pauses.values()].map((p) => ({ ...p }))),
    put(pause) {
      pauses.set(pause.agentId, { ...pause });
      return Promise.resolve();
    },
    remove(agentId) {
      pauses.delete(agentId);
      return Promise.resolve();
    },
  };
}

/** Keeps pauses in `agent_cap_pauses`. */
export function databaseCapPauseStore(db: Database): CapPauseStore {
  return {
    async list() {
      const rows = await db.select().from(agentCapPauses);
      return rows.map((row) => ({
        floorId: row.floorId,
        agentId: row.agentId,
        issue: row.issue,
        period: row.period as CapPeriod,
        level: row.level as CapLevel,
        cap: row.cap,
        used: row.used,
        noticeId: row.noticeId,
        pausedAt: row.pausedAt,
        resumeAt: row.resumeAt,
      }));
    },
    async put(pause) {
      const { agentId, ...values } = pause;
      await db
        .insert(agentCapPauses)
        .values({ agentId, ...values })
        .onConflictDoUpdate({ target: agentCapPauses.agentId, set: values });
    },
    async remove(agentId) {
      await db
        .delete(agentCapPauses)
        .where(eq(agentCapPauses.agentId, agentId));
    },
  };
}
