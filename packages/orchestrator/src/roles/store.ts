import { roles, type Database } from "@ai-office/db";
import {
  builtInRoleIds,
  builtInRoles,
  deskDressings,
  stages,
  type RoleDefinition,
} from "@ai-office/shared";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

// The office Role library (PRD FR-98, ADR 0003): every Role an Agent can
// fill but the Manager's, as data. It starts with the built-in Roles;
// editing one changes every Agent with it, from the Agent's next task,
// since the flows read an Agent's Role when its task starts.
//
// Beside the library it keeps one-off Roles (ADR 0004): each written by a
// Floor's Manager for one Contractor's task, always in the work Stage. A
// one-off Role is in no library, so it is never listed, offered to a Floor
// Template or edited there; its name may be a library Role's. It goes when
// its Contractor leaves, or joins the library if the Owner keeps the
// Contractor on the team.

/** A Role in the library. */
export type RoleRecord = RoleDefinition;

/** A Role as `get` finds it: a one-off names the Floor it was written on. */
export type StoredRole = RoleRecord & {
  /** A one-off Role's Floor; absent for a library Role. */
  readonly oneOffFloorId?: string;
};

/** Where the Role library lives. */
export interface RoleStore {
  /** Every Role in the library: the built-in ones in their order, then the rest by name. */
  list(): Promise<RoleRecord[]>;
  /** A library Role or a one-off one, by id. */
  get(id: string): Promise<StoredRole | undefined>;
  /** A Floor's one-off Roles, by name (ADR 0004). */
  oneOffs(floorId: string): Promise<RoleRecord[]>;
  /** Adds a one-off Role on a Floor; false when its id is taken. */
  createOneOff(role: RoleRecord, floorId: string, at: Date): Promise<boolean>;
  /**
   * Moves a one-off Role into the library as `name`; false when there is
   * no such one-off Role, or a library Role has that name.
   */
  adopt(id: string, name: string, at: Date): Promise<boolean>;
  /** Adds a Role; false when the library has its id or name already. */
  create(role: RoleRecord, at: Date): Promise<boolean>;
  /**
   * Stores a Role's new definition; false when there is no such Role, or
   * another has its name.
   */
  update(role: RoleRecord, at: Date): Promise<boolean>;
  /**
   * Deletes a Role, and its Role memory on every Floor: the Role it was,
   * undefined when there is none, or `in_use` (and kept) while an Agent
   * that is not removed fills it.
   */
  remove(id: string): Promise<RoleRecord | undefined | "in_use">;
}

/** Keeps the Role library in memory: for tests. */
export interface MemoryRoleStore extends RoleStore {
  /** Every Role, one-off ones too. */
  readonly roles: Map<string, RoleRecord>;
  /** The one-off Roles' Floors, by Role id. */
  readonly oneOffFloors: Map<string, string>;
}

const copy = (role: RoleRecord): RoleRecord => ({
  ...role,
  skills: [...role.skills],
});

/** Built-in Roles first, in their order; then the rest by name. */
const inOrder = (a: RoleRecord, b: RoleRecord): number => {
  const rank = (role: RoleRecord) => {
    const index = builtInRoleIds.indexOf(role.id);
    return index === -1 ? builtInRoleIds.length : index;
  };
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
};

/** What a library in memory asks of the Agents and Role memory beside it. */
export interface MemoryRoleStoreOptions {
  /** Whether an Agent that is not removed fills the Role; none does without it. */
  readonly inUse?: (id: string) => Promise<boolean>;
  /** Deletes the Role's Role memory, as the database's foreign key does. */
  readonly onRemove?: (id: string) => void;
}

/** A library holding `initial`: the built-in Roles unless given others. */
export function memoryRoleStore(
  initial: readonly RoleRecord[] = builtInRoles,
  options: MemoryRoleStoreOptions = {},
): MemoryRoleStore {
  const all = new Map(initial.map((role) => [role.id, copy(role)]));
  const oneOffFloors = new Map<string, string>();
  const library = () =>
    [...all.values()].filter(({ id }) => !oneOffFloors.has(id));
  return {
    roles: all,
    oneOffFloors,
    list: () => Promise.resolve(library().sort(inOrder).map(copy)),
    get(id) {
      const role = all.get(id);
      const floorId = oneOffFloors.get(id);
      return Promise.resolve(
        role === undefined
          ? undefined
          : {
              ...copy(role),
              ...(floorId === undefined ? {} : { oneOffFloorId: floorId }),
            },
      );
    },
    oneOffs(floorId) {
      return Promise.resolve(
        [...all.values()]
          .filter(({ id }) => oneOffFloors.get(id) === floorId)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(copy),
      );
    },
    createOneOff(role, floorId) {
      if (all.has(role.id)) {
        return Promise.resolve(false);
      }
      all.set(role.id, copy({ ...role, stage: "work" }));
      oneOffFloors.set(role.id, floorId);
      return Promise.resolve(true);
    },
    adopt(id, name) {
      const role = all.get(id);
      if (
        role === undefined ||
        !oneOffFloors.has(id) ||
        library().some((other) => other.name === name)
      ) {
        return Promise.resolve(false);
      }
      oneOffFloors.delete(id);
      all.set(id, { ...role, name });
      return Promise.resolve(true);
    },
    create(role) {
      if (
        all.has(role.id) ||
        library().some(({ name }) => name === role.name)
      ) {
        return Promise.resolve(false);
      }
      all.set(role.id, copy(role));
      return Promise.resolve(true);
    },
    update(role) {
      if (
        !all.has(role.id) ||
        oneOffFloors.has(role.id) ||
        library().some(({ id, name }) => id !== role.id && name === role.name)
      ) {
        return Promise.resolve(false);
      }
      all.set(role.id, copy(role));
      return Promise.resolve(true);
    },
    async remove(id) {
      const role = all.get(id);
      if (role === undefined) {
        return undefined;
      }
      if ((await options.inUse?.(id)) === true) {
        return "in_use";
      }
      all.delete(id);
      oneOffFloors.delete(id);
      options.onRemove?.(id);
      return copy(role);
    },
  };
}

type RoleRow = typeof roles.$inferSelect;

const known = <Value extends string>(
  values: readonly Value[],
  value: string,
  what: string,
): Value => {
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`A Role has an unknown ${what}, ${value}.`);
  }
  return value as Value;
};

const toRecord = (row: RoleRow): RoleRecord => ({
  id: row.id,
  name: row.name,
  stage: known(stages, row.stage, "Stage"),
  description: row.description,
  instructions: row.instructions,
  skills: Array.isArray(row.skills)
    ? row.skills.filter((skill): skill is string => typeof skill === "string")
    : [],
  deskDressing: known(deskDressings, row.deskDressing, "desk dressing"),
  aiProvider: row.aiProvider,
  model: row.model,
});

const columnsOf = (role: RoleRecord) => ({
  name: role.name,
  stage: role.stage,
  description: role.description,
  instructions: role.instructions,
  skills: [...role.skills],
  deskDressing: role.deskDressing,
  aiProvider: role.aiProvider,
  model: role.model,
});

/** Whether `error` is Postgres refusing `constraint` with `code`. */
const isRefusedBy = (
  error: unknown,
  code: string,
  constraint: string,
): boolean => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const found = cause as { code?: unknown; constraint?: unknown };
    if (found.code === code && found.constraint === constraint) {
      return true;
    }
  }
  return false;
};

/** Whether `error` is Postgres refusing a Role whose name is taken. */
const isNameTaken = (error: unknown): boolean =>
  isRefusedBy(error, "23505", "roles_name_unique");

/** Whether `error` is Postgres refusing to delete a Role an Agent fills. */
const isFilled = (error: unknown): boolean =>
  isRefusedBy(error, "23503", "agents_role_id_roles_id_fk");

/** Keeps the Role library in the `roles` table. */
export function databaseRoleStore(db: Database): RoleStore {
  return {
    async list() {
      return (await db.select().from(roles).where(isNull(roles.floorId)))
        .map(toRecord)
        .sort(inOrder);
    },

    async get(id) {
      const [row] = await db.select().from(roles).where(eq(roles.id, id));
      return row === undefined
        ? undefined
        : {
            ...toRecord(row),
            ...(row.floorId === null ? {} : { oneOffFloorId: row.floorId }),
          };
    },

    async oneOffs(floorId) {
      return (await db.select().from(roles).where(eq(roles.floorId, floorId)))
        .map(toRecord)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async createOneOff(role, floorId, at) {
      const inserted = await db
        .insert(roles)
        .values({
          id: role.id,
          ...columnsOf({ ...role, stage: "work" }),
          floorId,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: roles.id });
      return inserted.length > 0;
    },

    async adopt(id, name, at) {
      try {
        const adopted = await db
          .update(roles)
          .set({ floorId: null, name, updatedAt: at })
          .where(and(eq(roles.id, id), isNotNull(roles.floorId)))
          .returning({ id: roles.id });
        return adopted.length > 0;
      } catch (error) {
        if (isNameTaken(error)) {
          return false;
        }
        throw error;
      }
    },

    async create(role, at) {
      const inserted = await db
        .insert(roles)
        .values({
          id: role.id,
          ...columnsOf(role),
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: roles.id });
      return inserted.length > 0;
    },

    async update(role, at) {
      try {
        const updated = await db
          .update(roles)
          .set({ ...columnsOf(role), updatedAt: at })
          .where(and(eq(roles.id, role.id), isNull(roles.floorId)))
          .returning({ id: roles.id });
        return updated.length > 0;
      } catch (error) {
        if (isNameTaken(error)) {
          return false;
        }
        throw error;
      }
    },

    async remove(id) {
      try {
        // Its Role memory goes with it (`role_memory`'s foreign key); a
        // removed Agent no longer references it (`agents.role_id`).
        const [row] = await db
          .delete(roles)
          .where(eq(roles.id, id))
          .returning();
        return row === undefined ? undefined : toRecord(row);
      } catch (error) {
        if (isFilled(error)) {
          return "in_use";
        }
        throw error;
      }
    },
  };
}
