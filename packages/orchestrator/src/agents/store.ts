import { agents, roles, schemaMeta, type Database } from "@ai-office/db";
import {
  avatarSchema,
  contractorKinds,
  sameAvatar,
  stages,
  type Avatar,
  type ContractorKind,
  type Role,
  type Stage,
} from "@ai-office/shared";
import { and, asc, count, eq, isNull } from "drizzle-orm";

import { stageIn } from "../roles/roles.ts";
import { memoryRoleStore, type MemoryRoleStore } from "../roles/store.ts";

/**
 * What makes an Agent a Contractor (ADR 0004): one its Floor's Manager
 * added for a Batch, or to research a chat request.
 */
export interface ContractorRecord {
  readonly kind: ContractorKind;
  /** The Batch a `work` Contractor was added for; null until it is made, and for research. */
  readonly batchId: number | null;
  /**
   * Whether its Role is a one-off the Manager wrote for its task, as the
   * library has it when the Agent is read: its Agents take only the work
   * given to that Role.
   */
  readonly oneOffRole: boolean;
}

/** An Agent as the orchestrator holds it (PRD FR-11). */
export interface AgentRecord {
  readonly id: string;
  readonly floorId: string;
  readonly name: string;
  /** A library Role's id, or `manager`. */
  readonly role: Role;
  /**
   * Its Role's Stage (FR-98), as the library has it when the Agent is
   * read: what the pipeline and dispatch go by. Null for the Manager.
   */
  readonly stage: Stage | null;
  /** Such as `Claude`. */
  readonly aiProvider: string;
  /** Its own Model; null uses its AI Provider's default. */
  readonly modelOverride: string | null;
  /** Its effort or reasoning level; null uses its AI Provider's default. */
  readonly effort: string | null;
  readonly extraInstructions: string;
  /** False while it is paused. */
  readonly enabled: boolean;
  readonly avatar: Avatar;
  /** Overrides of its Floor's Token Caps; null uses the Floor's. */
  readonly tokenCaps: {
    readonly daily: number | null;
    readonly monthly: number | null;
  };
  /**
   * The Context Usage, in percent, at which it makes a Fresh Start
   * (FR-86); null uses its Floor's.
   */
  readonly freshStartThreshold: number | null;
  readonly createdAt: Date;
  /**
   * Since when it has been leaving (FR-10): the Owner removed it in the
   * middle of a task, which it finishes before it is removed. It takes no
   * new work. Null while it stays.
   */
  readonly leavingAt: Date | null;
  /**
   * Null for an ordinary Agent; for a Contractor (ADR 0004), what it was
   * added for. It leaves once no running Batch needs it, unless the Owner
   * keeps it on the team, which makes it an ordinary Agent.
   */
  readonly contractor: ContractorRecord | null;
}

/** What adding an Agent did: added it, or found what was in the way. */
export type CreateAgentResult = "created" | "manager_taken" | "name_taken";

/** What changing an Agent did: changed it, or found what was in the way. */
export type UpdateAgentResult = "updated" | "not_found" | "name_taken";

/** An Agent a data migration changed. */
export type MigratedAgent = Pick<AgentRecord, "id" | "floorId">;

/** Where Agents live. A removed Agent is kept, but listed nowhere. */
export interface AgentStore {
  /** A Floor's Agents, oldest first, leaving ones too; never removed ones. */
  list(floorId: string): Promise<AgentRecord[]>;
  /** Adds an Agent to a Floor that exists. */
  create(agent: AgentRecord): Promise<CreateAgentResult>;
  /**
   * Stores an Agent's new config (FR-11): its name, AI Provider, Model
   * override, effort, extra instructions, whether it is enabled, its Token
   * Caps, its Fresh Start threshold, and its Avatar (FR-13).
   */
  update(agent: AgentRecord): Promise<UpdateAgentResult>;
  /**
   * Marks an Agent as leaving from `at`, unless it is already; false when
   * the Floor has no such Agent.
   */
  leave(floorId: string, agentId: string, at: Date): Promise<boolean>;
  /**
   * Removes an Agent from its Floor at `at`; false when the Floor has no
   * such Agent (perhaps removed already). Its name is free again.
   */
  remove(floorId: string, agentId: string, at: Date): Promise<boolean>;
  /**
   * Sets what a Contractor is there for, or with null makes it an ordinary
   * Agent; false when the Floor has no such Agent.
   */
  setContractor(
    floorId: string,
    agentId: string,
    contractor: Omit<ContractorRecord, "oneOffRole"> | null,
  ): Promise<boolean>;
  /**
   * How many Agents fill each Role, on every Floor (archived ones too),
   * leaving ones included and removed ones not; the Manager too.
   */
  countByRole(): Promise<Map<string, number>>;
  /**
   * The data migration `name`, once in the store's life: gives each Agent
   * on every Floor (leaving ones too, never removed ones) the Avatar
   * `avatarOf` has for it, if any, and records that `name` ran. The Agents
   * whose Avatar it changed; none once `name` has run, so an Avatar the
   * Owner changes afterwards is kept.
   */
  migrateAvatars(
    name: string,
    avatarOf: (agent: Pick<AgentRecord, "name" | "role">) => Avatar | undefined,
  ): Promise<MigratedAgent[]>;
}

/** Keeps Agents in memory: for tests, with `memoryFloorStore`. */
export interface MemoryAgentStore extends AgentStore {
  readonly agents: Map<string, AgentRecord>;
  /** Adds a new Floor's team, unchecked (the Floor store has checked it). */
  insert(team: readonly AgentRecord[]): void;
}

/** What the Agent and Avatar Editors change; the rest is the Agent's own. */
const configOf = (agent: AgentRecord) => ({
  name: agent.name,
  aiProvider: agent.aiProvider,
  modelOverride: agent.modelOverride,
  effort: agent.effort,
  extraInstructions: agent.extraInstructions,
  enabled: agent.enabled,
  tokenCaps: agent.tokenCaps,
  freshStartThreshold: agent.freshStartThreshold,
  avatar: agent.avatar,
});

/** `configOf` as `agents` columns. */
const columnsOf = (agent: AgentRecord) => {
  const { tokenCaps, ...config } = configOf(agent);
  return {
    ...config,
    dailyTokenCap: tokenCaps.daily,
    monthlyTokenCap: tokenCaps.monthly,
  };
};

const byAge = (a: AgentRecord, b: AgentRecord): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/**
 * Agents in memory, each with its Role's Stage as `library` has it when
 * the Agent is read (the built-in Roles unless given a library).
 */
export function memoryAgentStore(
  library: Pick<MemoryRoleStore, "roles" | "oneOffFloors"> = memoryRoleStore(),
): MemoryAgentStore {
  const all = new Map<string, AgentRecord>();
  /** Removed Agents' ids: kept in `agents`, listed nowhere. */
  const removed = new Set<string>();
  /** The data migrations that have run. */
  const migrated = new Set<string>();
  const onFloor = (floorId: string): AgentRecord[] =>
    [...all.values()].filter(
      (agent) => agent.floorId === floorId && !removed.has(agent.id),
    );
  const copy = (agent: AgentRecord): AgentRecord => ({
    ...agent,
    stage: stageIn([...library.roles.values()], agent.role),
    avatar: structuredClone(agent.avatar),
    tokenCaps: { ...agent.tokenCaps },
    contractor:
      agent.contractor === null
        ? null
        : {
            kind: agent.contractor.kind,
            batchId: agent.contractor.batchId,
            oneOffRole: library.oneOffFloors.has(agent.role),
          },
  });
  return {
    agents: all,
    list: (floorId) => Promise.resolve(onFloor(floorId).sort(byAge).map(copy)),
    create(agent) {
      const team = onFloor(agent.floorId);
      if (
        agent.role === "manager" &&
        team.some(({ role }) => role === "manager")
      ) {
        return Promise.resolve("manager_taken");
      }
      if (team.some(({ name }) => name === agent.name)) {
        return Promise.resolve("name_taken");
      }
      all.set(agent.id, copy(agent));
      return Promise.resolve("created");
    },
    update(agent) {
      const current = all.get(agent.id);
      if (current?.floorId !== agent.floorId || removed.has(agent.id)) {
        return Promise.resolve("not_found");
      }
      if (
        onFloor(agent.floorId).some(
          ({ id, name }) => id !== agent.id && name === agent.name,
        )
      ) {
        return Promise.resolve("name_taken");
      }
      all.set(agent.id, copy({ ...current, ...configOf(agent) }));
      return Promise.resolve("updated");
    },
    leave(floorId, agentId, at) {
      const current = all.get(agentId);
      if (current?.floorId !== floorId || removed.has(agentId)) {
        return Promise.resolve(false);
      }
      all.set(agentId, { ...current, leavingAt: current.leavingAt ?? at });
      return Promise.resolve(true);
    },
    remove(floorId, agentId) {
      if (all.get(agentId)?.floorId !== floorId || removed.has(agentId)) {
        return Promise.resolve(false);
      }
      removed.add(agentId);
      return Promise.resolve(true);
    },
    setContractor(floorId, agentId, contractor) {
      const current = all.get(agentId);
      if (current?.floorId !== floorId || removed.has(agentId)) {
        return Promise.resolve(false);
      }
      all.set(
        agentId,
        copy({
          ...current,
          contractor:
            contractor === null ? null : { ...contractor, oneOffRole: false },
        }),
      );
      return Promise.resolve(true);
    },
    countByRole() {
      const counts = new Map<string, number>();
      for (const agent of all.values()) {
        if (!removed.has(agent.id)) {
          counts.set(agent.role, (counts.get(agent.role) ?? 0) + 1);
        }
      }
      return Promise.resolve(counts);
    },
    migrateAvatars(name, avatarOf) {
      if (migrated.has(name)) {
        return Promise.resolve([]);
      }
      migrated.add(name);
      const changed: MigratedAgent[] = [];
      for (const agent of all.values()) {
        const avatar = removed.has(agent.id) ? undefined : avatarOf(agent);
        if (avatar !== undefined && !sameAvatar(avatar, agent.avatar)) {
          all.set(agent.id, { ...agent, avatar: structuredClone(avatar) });
          changed.push({ id: agent.id, floorId: agent.floorId });
        }
      }
      return Promise.resolve(changed);
    },
    insert(team) {
      for (const agent of team) {
        all.set(agent.id, copy(agent));
      }
    },
  };
}

type AgentRow = typeof agents.$inferSelect;

/** A Contractor's record from its columns; null for an ordinary Agent. */
const contractorOf = (
  kind: string | null,
  batchId: number | null,
  oneOffRole: boolean,
): ContractorRecord | null => {
  const known = contractorKinds.find((each) => each === kind);
  return known === undefined ? null : { kind: known, batchId, oneOffRole };
};

const toRecord = (
  row: AgentRow,
  stage: string | null,
  oneOffRole: boolean,
): AgentRecord => ({
  id: row.id,
  floorId: row.floorId,
  name: row.name,
  role: row.role,
  stage:
    stage !== null && (stages as readonly string[]).includes(stage)
      ? (stage as Stage)
      : null,
  aiProvider: row.aiProvider,
  modelOverride: row.modelOverride,
  effort: row.effort,
  extraInstructions: row.extraInstructions,
  enabled: row.enabled,
  avatar: avatarSchema.parse(row.avatar),
  tokenCaps: { daily: row.dailyTokenCap, monthly: row.monthlyTokenCap },
  freshStartThreshold: row.freshStartThreshold,
  createdAt: row.createdAt,
  leavingAt: row.leavingAt,
  contractor: contractorOf(
    row.contractorKind,
    row.contractorBatchId,
    oneOffRole,
  ),
});

/** The `agents` row for an Agent. */
export const agentRow = (agent: AgentRecord): typeof agents.$inferInsert => ({
  id: agent.id,
  floorId: agent.floorId,
  name: agent.name,
  role: agent.role,
  aiProvider: agent.aiProvider,
  modelOverride: agent.modelOverride,
  effort: agent.effort,
  extraInstructions: agent.extraInstructions,
  enabled: agent.enabled,
  avatar: agent.avatar,
  dailyTokenCap: agent.tokenCaps.daily,
  monthlyTokenCap: agent.tokenCaps.monthly,
  freshStartThreshold: agent.freshStartThreshold,
  createdAt: agent.createdAt,
  leavingAt: agent.leavingAt,
  contractorKind: agent.contractor?.kind ?? null,
  contractorBatchId: agent.contractor?.batchId ?? null,
});

/** Whether `error` is Postgres refusing a second Agent of one name. */
const isNameTaken = (error: unknown): boolean => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, constraint } = cause as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && constraint === "agents_floor_name_unique") {
      return true;
    }
  }
  return false;
};

/** An Agent on a Floor, not removed. */
const onFloor = (floorId: string, agentId: string) =>
  and(
    eq(agents.id, agentId),
    eq(agents.floorId, floorId),
    isNull(agents.removedAt),
  );

/** Keeps Agents in the `agents` table. */
export function databaseAgentStore(db: Database): AgentStore {
  return {
    async list(floorId) {
      // Each with its Role's Stage as the library has it now.
      const rows = await db
        .select({
          agent: agents,
          stage: roles.stage,
          oneOffFloorId: roles.floorId,
        })
        .from(agents)
        .leftJoin(roles, eq(roles.id, agents.roleId))
        .where(and(eq(agents.floorId, floorId), isNull(agents.removedAt)))
        .orderBy(asc(agents.createdAt), asc(agents.id));
      return rows.map(({ agent, stage, oneOffFloorId }) =>
        toRecord(agent, stage, oneOffFloorId !== null),
      );
    },

    async create(agent) {
      const inserted = await db
        .insert(agents)
        .values(agentRow(agent))
        .onConflictDoNothing()
        .returning({ id: agents.id });
      if (inserted.length > 0) {
        return "created";
      }
      // Refused by the one-Manager index or by the name.
      const [manager] =
        agent.role === "manager"
          ? await db
              .select({ id: agents.id })
              .from(agents)
              .where(
                and(
                  eq(agents.floorId, agent.floorId),
                  eq(agents.role, "manager"),
                ),
              )
          : [];
      return manager === undefined ? "name_taken" : "manager_taken";
    },

    async update(agent) {
      try {
        const updated = await db
          .update(agents)
          .set(columnsOf(agent))
          .where(onFloor(agent.floorId, agent.id))
          .returning({ id: agents.id });
        return updated.length > 0 ? "updated" : "not_found";
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },

    async leave(floorId, agentId, at) {
      const [row] = await db
        .select({ leavingAt: agents.leavingAt })
        .from(agents)
        .where(onFloor(floorId, agentId));
      if (row === undefined) {
        return false;
      }
      if (row.leavingAt === null) {
        await db
          .update(agents)
          .set({ leavingAt: at })
          .where(and(onFloor(floorId, agentId), isNull(agents.leavingAt)));
      }
      return true;
    },

    async remove(floorId, agentId, at) {
      const removed = await db
        .update(agents)
        .set({ removedAt: at })
        .where(onFloor(floorId, agentId))
        .returning({ id: agents.id });
      return removed.length > 0;
    },

    async setContractor(floorId, agentId, contractor) {
      const changed = await db
        .update(agents)
        .set({
          contractorKind: contractor?.kind ?? null,
          contractorBatchId: contractor?.batchId ?? null,
        })
        .where(onFloor(floorId, agentId))
        .returning({ id: agents.id });
      return changed.length > 0;
    },

    async countByRole() {
      const rows = await db
        .select({ role: agents.role, agents: count() })
        .from(agents)
        .where(isNull(agents.removedAt))
        .groupBy(agents.role);
      return new Map(rows.map(({ role, agents }) => [role, agents]));
    },

    migrateAvatars(name, avatarOf) {
      // Recorded in `schema_meta` with the change itself, so it runs once
      // however many times AI Office starts, and once of two at a time.
      return db.transaction(async (tx) => {
        const recorded = await tx
          .insert(schemaMeta)
          .values({ key: `data-migration:${name}`, value: "applied" })
          .onConflictDoNothing()
          .returning({ key: schemaMeta.key });
        if (recorded.length === 0) {
          return [];
        }
        const rows = await tx
          .select({
            id: agents.id,
            floorId: agents.floorId,
            name: agents.name,
            role: agents.role,
            avatar: agents.avatar,
          })
          .from(agents)
          .where(isNull(agents.removedAt));
        const changed: MigratedAgent[] = [];
        for (const row of rows) {
          const avatar = avatarOf(row);
          if (
            avatar !== undefined &&
            !sameAvatar(avatar, avatarSchema.parse(row.avatar))
          ) {
            await tx
              .update(agents)
              .set({ avatar })
              .where(eq(agents.id, row.id));
            changed.push({ id: row.id, floorId: row.floorId });
          }
        }
        return changed;
      });
    },
  };
}
