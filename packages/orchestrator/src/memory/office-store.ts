import { officeMemory, roleMemory, type Database } from "@ai-office/db";
import {
  roleMemoryDeciders,
  roleMemoryStatuses,
  type RoleMemoryDecider,
  type Role,
  type RoleMemoryStatus,
} from "@ai-office/shared";
import { and, asc, eq, inArray } from "drizzle-orm";

// Where office-wide and Role memory live (PRD FR-54, FR-55): the
// `office_memory` and `role_memory` tables, or memory for tests. Role
// memory entries are kept whatever becomes of them; only a proposal is
// decided, and only an accepted entry is removed.

export interface OfficeMemoryRecord {
  readonly content: string;
  readonly updatedAt: Date;
}

export interface NewRoleEntry {
  readonly floorId: string;
  readonly role: Role;
  /** One line, never a credential. */
  readonly text: string;
  readonly issue: number;
  readonly agentId: string;
  readonly createdAt: Date;
}

export interface RoleEntryRecord extends NewRoleEntry {
  readonly id: number;
  readonly status: RoleMemoryStatus;
  readonly decidedBy: RoleMemoryDecider | null;
  readonly decidedAt: Date | null;
  readonly reason: string | null;
}

export interface RoleEntryChange {
  readonly status: Exclude<RoleMemoryStatus, "proposed">;
  readonly decidedBy: RoleMemoryDecider;
  readonly decidedAt: Date;
  readonly reason: string | null;
}

export interface OfficeMemoryStore {
  /** The office-wide memory; undefined until the Owner saves it. */
  office(): Promise<OfficeMemoryRecord | undefined>;
  setOffice(content: string, at: Date): Promise<OfficeMemoryRecord>;
  /** Keeps new Role memory proposals. */
  propose(entries: readonly NewRoleEntry[]): Promise<RoleEntryRecord[]>;
  /** A Floor's entries with one of `statuses`, oldest first. */
  entries(
    floorId: string,
    statuses: readonly RoleMemoryStatus[],
  ): Promise<RoleEntryRecord[]>;
  entry(id: number): Promise<RoleEntryRecord | undefined>;
  /**
   * Changes an entry whose status is `from`; undefined, changing nothing,
   * when it is not (it was decided meanwhile).
   */
  change(
    id: number,
    from: RoleMemoryStatus,
    to: RoleEntryChange,
  ): Promise<RoleEntryRecord | undefined>;
  /** The Floors with proposals waiting for a decision. */
  floorsWithProposals(): Promise<string[]>;
}

/** Keeps office-wide and Role memory in memory: for tests. */
export function memoryOfficeMemoryStore(): OfficeMemoryStore & {
  readonly roleEntries: RoleEntryRecord[];
} {
  let office: OfficeMemoryRecord | undefined;
  const roleEntries: RoleEntryRecord[] = [];
  return {
    roleEntries,
    office: () =>
      Promise.resolve(office === undefined ? undefined : { ...office }),
    setOffice(content, at) {
      office = { content, updatedAt: at };
      return Promise.resolve({ ...office });
    },
    propose(news) {
      const kept = news.map((entry, index) => ({
        ...entry,
        id: roleEntries.length + index + 1,
        status: "proposed" as const,
        decidedBy: null,
        decidedAt: null,
        reason: null,
      }));
      roleEntries.push(...kept);
      return Promise.resolve(kept.map((record) => ({ ...record })));
    },
    entries: (floorId, statuses) =>
      Promise.resolve(
        roleEntries
          .filter(
            (entry) =>
              entry.floorId === floorId && statuses.includes(entry.status),
          )
          .map((entry) => ({ ...entry })),
      ),
    entry: (id) => {
      const found = roleEntries.find((entry) => entry.id === id);
      return Promise.resolve(found === undefined ? undefined : { ...found });
    },
    change(id, from, to) {
      const index = roleEntries.findIndex(
        (entry) => entry.id === id && entry.status === from,
      );
      const current = roleEntries[index];
      if (current === undefined) {
        return Promise.resolve(undefined);
      }
      const changed = { ...current, ...to };
      roleEntries[index] = changed;
      return Promise.resolve({ ...changed });
    },
    floorsWithProposals: () =>
      Promise.resolve([
        ...new Set(
          roleEntries
            .filter(({ status }) => status === "proposed")
            .map(({ floorId }) => floorId),
        ),
      ]),
  };
}

type RoleRow = typeof roleMemory.$inferSelect;

const known = <Value extends string>(
  values: readonly Value[],
  value: string | null,
  what: string,
): Value => {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(
      `A Role memory entry has an unknown ${what}, ${String(value)}.`,
    );
  }
  return found;
};

const entryOf = (row: RoleRow): RoleEntryRecord => ({
  id: row.id,
  floorId: row.floorId,
  role: row.role,
  text: row.text,
  issue: row.issue,
  agentId: row.agentId,
  createdAt: row.createdAt,
  status: known(roleMemoryStatuses, row.status, "status"),
  decidedBy:
    row.decidedBy === null
      ? null
      : known(roleMemoryDeciders, row.decidedBy, "decider"),
  decidedAt: row.decidedAt,
  reason: row.reason,
});

/** Keeps office-wide and Role memory in `office_memory` and `role_memory`. */
export function databaseOfficeMemoryStore(db: Database): OfficeMemoryStore {
  return {
    async office() {
      const [row] = await db
        .select()
        .from(officeMemory)
        .where(eq(officeMemory.id, 1));
      return row === undefined
        ? undefined
        : { content: row.content, updatedAt: row.updatedAt };
    },

    async setOffice(content, at) {
      const [row] = await db
        .insert(officeMemory)
        .values({ id: 1, content, updatedAt: at })
        .onConflictDoUpdate({
          target: officeMemory.id,
          set: { content, updatedAt: at },
        })
        .returning();
      if (row === undefined) {
        throw new Error("The office-wide memory was not kept.");
      }
      return { content: row.content, updatedAt: row.updatedAt };
    },

    async propose(news) {
      if (news.length === 0) {
        return [];
      }
      const rows = await db
        .insert(roleMemory)
        .values(news.map((entry) => ({ ...entry })))
        .returning();
      return rows.map(entryOf).sort((a, b) => a.id - b.id);
    },

    async entries(floorId, statuses) {
      if (statuses.length === 0) {
        return [];
      }
      const rows = await db
        .select()
        .from(roleMemory)
        .where(
          and(
            eq(roleMemory.floorId, floorId),
            inArray(roleMemory.status, [...statuses]),
          ),
        )
        .orderBy(asc(roleMemory.id));
      return rows.map(entryOf);
    },

    async entry(id) {
      const [row] = await db
        .select()
        .from(roleMemory)
        .where(eq(roleMemory.id, id));
      return row === undefined ? undefined : entryOf(row);
    },

    async change(id, from, to) {
      const [row] = await db
        .update(roleMemory)
        .set({ ...to })
        .where(and(eq(roleMemory.id, id), eq(roleMemory.status, from)))
        .returning();
      return row === undefined ? undefined : entryOf(row);
    },

    async floorsWithProposals() {
      const rows = await db
        .selectDistinct({ floorId: roleMemory.floorId })
        .from(roleMemory)
        .where(eq(roleMemory.status, "proposed"))
        .orderBy(asc(roleMemory.floorId));
      return rows.map(({ floorId }) => floorId);
    },
  };
}
