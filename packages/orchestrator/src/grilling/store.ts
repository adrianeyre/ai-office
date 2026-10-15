import { grillingSessions, type Database } from "@ai-office/db";
import {
  grillingAdrSchema,
  grillingDecisionSchema,
  grillingDocumentsSchema,
  grillingFactSchema,
  grillingIssuesSchema,
  grillingProcessSchema,
  grillingQuestionSchema,
  grillingSectionSchema,
  grillingSessionStatuses,
  grillingSkillName,
  grillingSkillNames,
  grillingSourceSchema,
  grillingTermSchema,
  type GrillingSessionStatus,
  type GrillingSkillName,
} from "@ai-office/shared";
import { and, desc, eq } from "drizzle-orm";

import type { GrillingSessionRecord } from "./session.ts";

// Where each Floor's Grilling Sessions are kept (PRD FR-82): the
// `grilling_sessions` table, or memory for tests. A session's questions,
// decisions, terms, facts, documents and issues are kept as structured
// data with it (FR-80, FR-81, FR-88), and every session is kept, ended
// ones included. A Floor runs at most one
// session at a time.

export type NewGrillingSession = Omit<GrillingSessionRecord, "id">;

export interface GrillingStore {
  /** Keeps a new session, giving it the next id. */
  create(session: NewGrillingSession): Promise<GrillingSessionRecord>;
  /** Replaces a session with its new state. */
  save(session: GrillingSessionRecord): Promise<GrillingSessionRecord>;
  get(floorId: string, id: number): Promise<GrillingSessionRecord | undefined>;
  /** The Floor's active session, if one is running. */
  active(floorId: string): Promise<GrillingSessionRecord | undefined>;
  /** The Floor's sessions, newest first. */
  list(floorId: string): Promise<GrillingSessionRecord[]>;
}

/** A session read back, checked, so a stored one can never be malformed. */
const checked = (session: GrillingSessionRecord): GrillingSessionRecord => ({
  ...session,
  questions: session.questions.map((question) =>
    grillingQuestionSchema.parse(question),
  ),
  decisions: session.decisions.map((decision) =>
    grillingDecisionSchema.parse(decision),
  ),
  terms: session.terms.map((term) => grillingTermSchema.parse(term)),
  facts: session.facts.map((fact) => grillingFactSchema.parse(fact)),
  outline: session.outline.map((section) =>
    grillingSectionSchema.parse(section),
  ),
  adrs: session.adrs.map((adr) => grillingAdrSchema.parse(adr)),
  processes: session.processes.map((process) =>
    grillingProcessSchema.parse(process),
  ),
  documents:
    session.documents === null
      ? null
      : grillingDocumentsSchema.parse(session.documents),
  issues:
    session.issues === null ? null : grillingIssuesSchema.parse(session.issues),
  sources: session.sources.map((source) => grillingSourceSchema.parse(source)),
});

/** Keeps sessions in memory: for tests. */
export function memoryGrillingStore(): GrillingStore & {
  readonly sessions: GrillingSessionRecord[];
} {
  const sessions: GrillingSessionRecord[] = [];
  const find = (floorId: string, id: number) =>
    sessions.findIndex(
      (session) => session.floorId === floorId && session.id === id,
    );
  return {
    sessions,
    create(session) {
      if (
        session.status === "active" &&
        sessions.some(
          (other) =>
            other.floorId === session.floorId && other.status === "active",
        )
      ) {
        return Promise.reject(
          new Error("The Floor already runs a Grilling Session."),
        );
      }
      const record = checked({ ...session, id: sessions.length + 1 });
      sessions.push(record);
      return Promise.resolve(record);
    },
    save(session) {
      const index = find(session.floorId, session.id);
      if (index === -1) {
        return Promise.reject(
          new Error(`There is no Grilling Session ${String(session.id)}.`),
        );
      }
      if (
        session.status === "active" &&
        sessions.some(
          (other) =>
            other.floorId === session.floorId &&
            other.id !== session.id &&
            other.status === "active",
        )
      ) {
        return Promise.reject(
          new Error("The Floor already runs a Grilling Session."),
        );
      }
      const record = checked(session);
      sessions[index] = record;
      return Promise.resolve(record);
    },
    get: (floorId, id) => Promise.resolve(sessions[find(floorId, id)]),
    active: (floorId) =>
      Promise.resolve(
        sessions.find(
          (session) =>
            session.floorId === floorId && session.status === "active",
        ),
      ),
    list: (floorId) =>
      Promise.resolve(
        sessions
          .filter((session) => session.floorId === floorId)
          .sort((a, b) => b.id - a.id),
      ),
  };
}

type Row = typeof grillingSessions.$inferSelect;

const statusOf = (status: string): GrillingSessionStatus => {
  const known = grillingSessionStatuses.find(
    (candidate) => candidate === status,
  );
  if (known === undefined) {
    throw new Error(`A Grilling Session has an unknown status, ${status}.`);
  }
  return known;
};

/** A session kept before there were other Skills was started by `/grilling`. */
const skillOf = (skill: string): GrillingSkillName =>
  grillingSkillNames.find((candidate) => candidate === skill) ??
  grillingSkillName;

const arrayOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const recordOf = (row: Row): GrillingSessionRecord => ({
  id: row.id,
  floorId: row.floorId,
  topic: row.topic,
  skill: skillOf(row.skill),
  status: statusOf(row.status),
  round: row.round,
  awaitingConfirmation: row.awaitingConfirmation,
  questions: arrayOf(row.questions).map((question) =>
    grillingQuestionSchema.parse(question),
  ),
  decisions: arrayOf(row.decisions).map((decision) =>
    grillingDecisionSchema.parse(decision),
  ),
  terms: arrayOf(row.terms).map((term) => grillingTermSchema.parse(term)),
  facts: arrayOf(row.facts).map((fact) => grillingFactSchema.parse(fact)),
  outline: arrayOf(row.outline).map((section) =>
    grillingSectionSchema.parse(section),
  ),
  adrs: arrayOf(row.adrs).map((adr) => grillingAdrSchema.parse(adr)),
  processes: arrayOf(row.processes).map((process) =>
    grillingProcessSchema.parse(process),
  ),
  documents:
    row.documents === null
      ? null
      : grillingDocumentsSchema.parse(row.documents),
  issues: row.issues === null ? null : grillingIssuesSchema.parse(row.issues),
  sources: arrayOf(row.sources).map((source) =>
    grillingSourceSchema.parse(source),
  ),
  startedAt: row.startedAt,
  updatedAt: row.updatedAt,
  pausedAt: row.pausedAt,
  endedAt: row.endedAt,
});

const valuesOf = (session: NewGrillingSession) => ({
  floorId: session.floorId,
  topic: session.topic,
  skill: session.skill,
  status: session.status,
  round: session.round,
  awaitingConfirmation: session.awaitingConfirmation,
  questions: session.questions,
  decisions: session.decisions,
  terms: session.terms,
  facts: session.facts,
  outline: session.outline,
  adrs: session.adrs,
  processes: session.processes,
  documents: session.documents,
  issues: session.issues,
  sources: session.sources,
  startedAt: session.startedAt,
  updatedAt: session.updatedAt,
  pausedAt: session.pausedAt,
  endedAt: session.endedAt,
});

/** Keeps sessions in `grilling_sessions`. */
export function databaseGrillingStore(db: Database): GrillingStore {
  return {
    async create(session) {
      const [row] = await db
        .insert(grillingSessions)
        .values(valuesOf(checked({ ...session, id: 0 })))
        .returning();
      if (row === undefined) {
        throw new Error("The Grilling Session was not stored.");
      }
      return recordOf(row);
    },

    async save(session) {
      const [row] = await db
        .update(grillingSessions)
        .set(valuesOf(checked(session)))
        .where(
          and(
            eq(grillingSessions.floorId, session.floorId),
            eq(grillingSessions.id, session.id),
          ),
        )
        .returning();
      if (row === undefined) {
        throw new Error(`There is no Grilling Session ${String(session.id)}.`);
      }
      return recordOf(row);
    },

    async get(floorId, id) {
      const [row] = await db
        .select()
        .from(grillingSessions)
        .where(
          and(
            eq(grillingSessions.floorId, floorId),
            eq(grillingSessions.id, id),
          ),
        );
      return row === undefined ? undefined : recordOf(row);
    },

    async active(floorId) {
      const [row] = await db
        .select()
        .from(grillingSessions)
        .where(
          and(
            eq(grillingSessions.floorId, floorId),
            eq(grillingSessions.status, "active"),
          ),
        );
      return row === undefined ? undefined : recordOf(row);
    },

    async list(floorId) {
      const rows = await db
        .select()
        .from(grillingSessions)
        .where(eq(grillingSessions.floorId, floorId))
        .orderBy(desc(grillingSessions.id));
      return rows.map(recordOf);
    },
  };
}
