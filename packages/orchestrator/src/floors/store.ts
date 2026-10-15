import { agents, floors, type Database } from "@ai-office/db";
import {
  floorThemes,
  type FloorSettings,
  type FloorTemplateRef,
  type FloorTheme,
} from "@ai-office/shared";
import { and, asc, eq, isNull } from "drizzle-orm";

import {
  agentRow,
  memoryAgentStore,
  type AgentRecord,
  type MemoryAgentStore,
} from "../agents/store.ts";

/** A Floor as the orchestrator holds it. */
export interface FloorRecord extends FloorSettings {
  /** A slug from the repository's name, such as `web-shop`. */
  readonly id: string;
  /** GitHub's id for the repository: it survives a rename. */
  readonly githubRepositoryId: number;
  /** `owner/name` on GitHub. */
  readonly repository: string;
  /** The Floor Template it started from, as it was then (FR-97). */
  readonly template: FloorTemplateRef;
  /** The 3D theme it is dressed in: its template's when it was added. */
  readonly theme: FloorTheme;
  readonly createdAt: Date;
  /** When it was archived; null while it is in use. */
  readonly archivedAt: Date | null;
}

/** What creating a Floor did: created it, or found what was in the way. */
export type CreateFloorResult =
  /** The repository is already a Floor, archived or not. */
  "created" | "repository_taken" | "id_taken";

/** Where Floors live. */
export interface FloorStore {
  /** Oldest first; archived ones only when asked for. */
  list(options?: {
    readonly includeArchived?: boolean;
  }): Promise<FloorRecord[]>;
  get(id: string): Promise<FloorRecord | undefined>;
  /** Creates a Floor with its first Agents, all or nothing. */
  create(
    floor: FloorRecord,
    team: readonly AgentRecord[],
  ): Promise<CreateFloorResult>;
  /** Changes a Floor's settings; undefined if there is no such Floor. */
  update(
    id: string,
    changes: Partial<FloorSettings>,
  ): Promise<FloorRecord | undefined>;
  /**
   * Archives a Floor that is in use; undefined if there is none by that
   * id, or it is already archived.
   */
  archive(id: string, at: Date): Promise<FloorRecord | undefined>;
}

/** Keeps Floors in memory, and their Agents in `agentStore`: for tests. */
export function memoryFloorStore(
  agentStore: MemoryAgentStore = memoryAgentStore(),
): FloorStore & {
  readonly floors: Map<string, FloorRecord>;
  readonly agentStore: MemoryAgentStore;
} {
  const all = new Map<string, FloorRecord>();
  const copy = (floor: FloorRecord): FloorRecord => ({
    ...floor,
    template: { ...floor.template },
    tokenCaps: { ...floor.tokenCaps },
    gitIdentity: floor.gitIdentity === null ? null : { ...floor.gitIdentity },
    requiredReviewerAgentIds: [...floor.requiredReviewerAgentIds],
  });
  return {
    floors: all,
    agentStore,
    list: ({ includeArchived = false } = {}) =>
      Promise.resolve(
        [...all.values()]
          .filter((floor) => includeArchived || floor.archivedAt === null)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .map(copy),
      ),
    get: (id) => {
      const floor = all.get(id);
      return Promise.resolve(floor === undefined ? undefined : copy(floor));
    },
    create(floor, team) {
      if (
        [...all.values()].some(
          ({ githubRepositoryId }) =>
            githubRepositoryId === floor.githubRepositoryId,
        )
      ) {
        return Promise.resolve("repository_taken");
      }
      if (all.has(floor.id)) {
        return Promise.resolve("id_taken");
      }
      all.set(floor.id, copy(floor));
      agentStore.insert(team);
      return Promise.resolve("created");
    },
    update(id, changes) {
      const floor = all.get(id);
      if (floor === undefined) {
        return Promise.resolve(undefined);
      }
      const updated = copy({ ...floor, ...changes });
      all.set(id, updated);
      return Promise.resolve(copy(updated));
    },
    archive(id, at) {
      const floor = all.get(id);
      if (floor?.archivedAt !== null) {
        return Promise.resolve(undefined);
      }
      const archived = { ...floor, archivedAt: at };
      all.set(id, archived);
      return Promise.resolve(copy(archived));
    },
  };
}

type FloorRow = typeof floors.$inferSelect;

const toRecord = (row: FloorRow): FloorRecord => ({
  id: row.id,
  githubRepositoryId: row.githubRepositoryId,
  repository: row.repository,
  name: row.name,
  defaultBranch: row.defaultBranch,
  setupCommand: row.setupCommand,
  testCommand: row.testCommand,
  mergePolicy: row.mergePolicy === "auto_merge" ? "auto_merge" : "send_to_me",
  roundCap: row.roundCap,
  tokenCaps: { daily: row.dailyTokenCap, monthly: row.monthlyTokenCap },
  concurrencyLimit: row.concurrencyLimit,
  priority: row.priority,
  requiredReviewerAgentIds: row.requiredReviewerAgentIds,
  planApproval: row.planApproval,
  mostAgents: row.mostAgents,
  spinOffFromChat: row.spinOffFromChat,
  hourlyStatusUpdates: row.hourlyStatusUpdates,
  freshStartThreshold: row.freshStartThreshold,
  gitIdentity:
    row.gitName === null || row.gitEmail === null
      ? null
      : { name: row.gitName, email: row.gitEmail },
  template: { id: row.templateId, name: row.templateName },
  theme: floorThemes.find((theme) => theme === row.theme) ?? "office",
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
});

/** The columns for some settings, leaving out those not given. */
const settingsColumns = (
  settings: Partial<FloorSettings>,
): Partial<typeof floors.$inferInsert> => {
  const { tokenCaps, gitIdentity, ...rest } = settings;
  return {
    ...rest,
    ...(tokenCaps === undefined
      ? {}
      : { dailyTokenCap: tokenCaps.daily, monthlyTokenCap: tokenCaps.monthly }),
    ...(gitIdentity === undefined
      ? {}
      : {
          gitName: gitIdentity?.name ?? null,
          gitEmail: gitIdentity?.email ?? null,
        }),
  };
};

/** Keeps Floors in the `floors` table. */
export function databaseFloorStore(db: Database): FloorStore {
  return {
    async list({ includeArchived = false } = {}) {
      const rows = await db
        .select()
        .from(floors)
        .where(includeArchived ? undefined : isNull(floors.archivedAt))
        .orderBy(asc(floors.createdAt), asc(floors.id));
      return rows.map(toRecord);
    },

    async get(id) {
      const [row] = await db.select().from(floors).where(eq(floors.id, id));
      return row === undefined ? undefined : toRecord(row);
    },

    create: (floor, team) =>
      db.transaction(async (tx): Promise<CreateFloorResult> => {
        const inserted = await tx
          .insert(floors)
          .values({
            id: floor.id,
            githubRepositoryId: floor.githubRepositoryId,
            repository: floor.repository,
            name: floor.name,
            defaultBranch: floor.defaultBranch,
            ...settingsColumns(floor),
            templateId: floor.template.id,
            templateName: floor.template.name,
            theme: floor.theme,
            createdAt: floor.createdAt,
            archivedAt: floor.archivedAt,
          })
          .onConflictDoNothing()
          .returning({ id: floors.id });
        if (inserted.length === 0) {
          // Something was in the way: the repository, or only the id.
          const [taken] = await tx
            .select({ id: floors.id })
            .from(floors)
            .where(eq(floors.githubRepositoryId, floor.githubRepositoryId));
          return taken === undefined ? "id_taken" : "repository_taken";
        }
        if (team.length > 0) {
          await tx.insert(agents).values(team.map(agentRow));
        }
        return "created";
      }),

    async update(id, changes) {
      const columns = settingsColumns(changes);
      if (Object.keys(columns).length === 0) {
        return this.get(id);
      }
      const [row] = await db
        .update(floors)
        .set(columns)
        .where(eq(floors.id, id))
        .returning();
      return row === undefined ? undefined : toRecord(row);
    },

    async archive(id, at) {
      const [row] = await db
        .update(floors)
        .set({ archivedAt: at })
        .where(and(eq(floors.id, id), isNull(floors.archivedAt)))
        .returning();
      return row === undefined ? undefined : toRecord(row);
    },
  };
}
