import type { EventBus } from "@ai-office/events";
import {
  createRoleRequestSchema,
  defaultTeamRoles,
  maxRoleNameLength,
  roleErrorCodes,
  roleIdOf,
  updateRoleRequestSchema,
  type CreateRoleRequest,
  type FloorTemplate,
  type RoleErrorCode,
  type UpdateRoleRequest,
} from "@ai-office/shared";

import type { AgentStore } from "../agents/store.ts";
import type { SkillStore } from "../skills/store.ts";
import type { RoleRecord, RoleStore } from "./store.ts";

// The Role library's admin (PRD FR-98, FR-65): the office's Roles, each
// with how many Agents fill it; making one, or duplicating one, then
// editing it; and deleting one no Agent fills. Every Agent reads its Role
// as its task starts, so an edit reaches every Agent with the Role from
// its next task, and an Agent's own extra instructions still apply on
// top. Every change is an event, for the Activity Feed: which fields
// changed, never what they say.
//
// A Role's Stage is what its Agents' work goes by (ADR 0003), so it
// changes only while no Agent fills the Role: the Owner duplicates a Role
// to try it in another Stage. The Roles every new Floor starts with stay
// in the library, so a new Floor always has its team.

/** A Role in the library, with what the admin shows beside it. */
export interface RoleWithUsage extends RoleRecord {
  /** How many Agents fill it, on every Floor: whom a change reaches. */
  readonly agents: number;
  /** Whether a Floor Template starts Floors with an Agent in it. */
  readonly inStartingTeam: boolean;
}

/** Why a Role library change was refused; `code` is one of `roleErrorCodes`. */
export class RoleError extends Error {
  readonly code: RoleErrorCode;
  /** What was wrong, one line each, when there is a list to give. */
  readonly problems: readonly string[] | undefined;

  constructor(code: RoleErrorCode, message: string, problems?: string[]) {
    super(message);
    this.name = "RoleError";
    this.code = code;
    this.problems = problems;
  }
}

export interface RoleLibrary {
  /** Every Role, in the library's order, with its Agents. */
  list(): Promise<RoleWithUsage[]>;
  get(id: string): Promise<RoleWithUsage>;
  /** Makes a Role; its id is made from its name. */
  create(request: CreateRoleRequest): Promise<RoleWithUsage>;
  /** Copies a Role under `name`, or "<its name> copy". */
  duplicate(id: string, name?: string): Promise<RoleWithUsage>;
  /** Changes a Role, and so every Agent with it from its next task. */
  update(id: string, changes: UpdateRoleRequest): Promise<RoleWithUsage>;
  /** Deletes a Role no Agent fills, with its Role memory. */
  remove(id: string): Promise<void>;
}

export interface RoleLibraryOptions {
  readonly store: RoleStore;
  /** Who fills each Role. */
  readonly agents: Pick<AgentStore, "countByRole">;
  /** The office Skill library a Role's Skills come from. */
  readonly skills: Pick<SkillStore, "list">;
  /**
   * The Models in an AI Provider's catalogue, which a suggested Model is
   * chosen from; none when absent, so no Model can be suggested.
   */
  readonly catalogue?: (aiProvider: string) => Promise<readonly string[]>;
  readonly events: Pick<EventBus, "publish">;
  /**
   * The Floor Templates a Floor is added from (FR-97): a Role one starts
   * Floors with Agents in stays in the library. Without them, the Roles
   * Development has always started Floors with.
   */
  readonly templates?: readonly Pick<FloorTemplate, "name" | "roles">[];
  readonly now?: () => Date;
}

/** A Role's fields, in the order `role.changed` names them. */
const fields = [
  "name",
  "stage",
  "description",
  "instructions",
  "skills",
  "deskDressing",
  "aiProvider",
  "model",
] as const satisfies readonly (keyof RoleRecord)[];

const same = (
  a: RoleRecord[keyof RoleRecord],
  b: RoleRecord[keyof RoleRecord],
) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, index) => item === b[index])
    : a === b;

/** `name`, cut so that `suffix` fits after it in a Role's name. */
const withSuffix = (name: string, suffix: string): string =>
  `${name.slice(0, maxRoleNameLength - suffix.length).trimEnd()}${suffix}`;

/** `id` with `-n` after it, within a Role id's 40 characters. */
const numbered = (id: string, n: number): string => {
  const suffix = `-${String(n)}`;
  return `${id.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
};

export function createRoleLibrary(options: RoleLibraryOptions): RoleLibrary {
  const { store, events } = options;
  /** The names of the templates that start Floors with an Agent in `id`. */
  const startingWith = (id: string): string[] =>
    options.templates === undefined
      ? defaultTeamRoles.includes(id)
        ? ["Development"]
        : []
      : options.templates
          .filter(({ roles }) =>
            roles.some(({ role, count }) => role.id === id && count > 0),
          )
          .map(({ name }) => name);
  const now = options.now ?? (() => new Date());
  const catalogue = options.catalogue ?? (() => Promise.resolve([]));

  const notFound = (id: string) =>
    new RoleError(
      roleErrorCodes.roleNotFound,
      `The office Role library has no Role "${id}".`,
    );
  const nameTaken = (name: string) =>
    new RoleError(
      roleErrorCodes.roleNameTaken,
      `The Role library already has a Role called "${name}".`,
    );

  const usage = async (): Promise<Map<string, number>> =>
    options.agents.countByRole();

  const withUsage = (
    role: RoleRecord,
    counts: ReadonlyMap<string, number>,
  ): RoleWithUsage => ({
    ...role,
    skills: [...role.skills],
    agents: counts.get(role.id) ?? 0,
    inStartingTeam: startingWith(role.id).length > 0,
  });

  const find = async (id: string): Promise<RoleRecord> => {
    const role = await store.get(id);
    // A one-off Role is in no library (ADR 0004).
    if (role === undefined || role.oneOffFloorId !== undefined) {
      throw notFound(id);
    }
    return role;
  };

  /** Whether another Role than `except` is called `name`, in any case. */
  const isNamed = (
    library: readonly RoleRecord[],
    name: string,
    except?: string,
  ): boolean =>
    library.some(
      (role) =>
        role.id !== except && role.name.toLowerCase() === name.toLowerCase(),
    );

  /** Refuses Skills the office Skill library does not have. */
  const checkSkills = async (skills: readonly string[]): Promise<void> => {
    if (skills.length === 0) {
      return;
    }
    const known = new Set(
      (await options.skills.list()).map(({ name }) => name),
    );
    const missing = skills.filter((skill) => !known.has(skill));
    if (missing.length > 0) {
      throw new RoleError(
        roleErrorCodes.skillNotFound,
        `The office Skill library has no ${missing.length === 1 ? "Skill" : "Skills"} ${missing.map((skill) => `"${skill}"`).join(", ")}.`,
      );
    }
  };

  /** Refuses a Model not in its AI Provider's catalogue. */
  const checkModel = async (
    aiProvider: string | null,
    model: string | null,
  ): Promise<void> => {
    if (
      aiProvider !== null &&
      model !== null &&
      !(await catalogue(aiProvider)).includes(model)
    ) {
      throw new RoleError(
        roleErrorCodes.modelNotInCatalogue,
        `${aiProvider}'s model catalogue has no "${model}": refresh the catalogue, or add an AI Account that lists it.`,
      );
    }
  };

  /** Stores `role` as new under a free id made from its name. */
  const add = async (
    role: Omit<RoleRecord, "id">,
    duplicatedFrom: string | null,
  ): Promise<RoleWithUsage> => {
    const library = await store.list();
    if (isNamed(library, role.name)) {
      throw nameTaken(role.name);
    }
    const base = roleIdOf(role.name);
    const taken = new Set(library.map(({ id }) => id));
    let id = base;
    for (let n = 2; taken.has(id); n += 1) {
      id = numbered(base, n);
    }
    const record: RoleRecord = { id, ...role, skills: [...role.skills] };
    if (!(await store.create(record, now()))) {
      throw nameTaken(role.name);
    }
    await events.publish({
      type: "role.created",
      version: 1,
      roleId: id,
      name: record.name,
      stage: record.stage,
      duplicatedFrom,
    });
    return withUsage(record, new Map());
  };

  const invalid = (problems: string[]) =>
    new RoleError(
      roleErrorCodes.invalidRole,
      "That is not a valid Role.",
      problems,
    );

  return {
    async list() {
      const [library, counts] = await Promise.all([store.list(), usage()]);
      return library.map((role) => withUsage(role, counts));
    },

    async get(id) {
      return withUsage(await find(id), await usage());
    },

    async create(request) {
      const parsed = createRoleRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw invalid(parsed.error.issues.map(({ message }) => message));
      }
      const role = parsed.data;
      await checkSkills(role.skills);
      await checkModel(role.aiProvider, role.model);
      return add(role, null);
    },

    async duplicate(id, name) {
      const { id: from, ...source } = await find(id);
      let copyName = name?.trim();
      if (copyName === undefined || copyName === "") {
        const library = await store.list();
        copyName = withSuffix(source.name, " copy");
        for (let n = 2; isNamed(library, copyName); n += 1) {
          copyName = withSuffix(source.name, ` copy ${String(n)}`);
        }
      }
      return add({ ...source, name: copyName }, from);
    },

    async update(id, changes) {
      const parsed = updateRoleRequestSchema.safeParse(changes);
      if (!parsed.success) {
        throw invalid(parsed.error.issues.map(({ message }) => message));
      }
      const current = await find(id);
      const { data } = parsed;
      const aiProvider =
        data.aiProvider === undefined ? current.aiProvider : data.aiProvider;
      const next: RoleRecord = {
        id,
        name: data.name ?? current.name,
        stage: data.stage ?? current.stage,
        description: data.description ?? current.description,
        instructions: data.instructions ?? current.instructions,
        skills: data.skills ?? current.skills,
        deskDressing: data.deskDressing ?? current.deskDressing,
        aiProvider,
        // A new AI Provider without a Model of its own suggests its default.
        model:
          data.model !== undefined
            ? data.model
            : aiProvider !== current.aiProvider
              ? null
              : current.model,
      };
      if (next.model !== null && next.aiProvider === null) {
        throw invalid(["Suggest an AI Provider for the Model."]);
      }
      const keys = fields.filter((key) => !same(current[key], next[key]));
      if (keys.length === 0) {
        return withUsage(current, await usage());
      }
      const counts = await usage();
      const agents = counts.get(id) ?? 0;
      if (keys.includes("name") && isNamed(await store.list(), next.name, id)) {
        throw nameTaken(next.name);
      }
      if (keys.includes("stage") && agents > 0) {
        throw new RoleError(
          roleErrorCodes.stageInUse,
          `${String(agents)} ${agents === 1 ? "Agent fills" : "Agents fill"} ${current.name}, and ${agents === 1 ? "its" : "their"} work goes by its Stage: duplicate the Role to give the copy another Stage.`,
        );
      }
      await checkSkills(
        next.skills.filter((skill) => !current.skills.includes(skill)),
      );
      if (keys.includes("aiProvider") || keys.includes("model")) {
        await checkModel(next.aiProvider, next.model);
      }
      if (!(await store.update(next, now()))) {
        // Deleted, or another took its name, since it was read.
        if ((await store.get(id)) === undefined) {
          throw notFound(id);
        }
        throw nameTaken(next.name);
      }
      await events.publish({
        type: "role.changed",
        version: 1,
        roleId: id,
        name: next.name,
        keys: [...keys],
        agents,
      });
      return withUsage(next, counts);
    },

    async remove(id) {
      const role = await find(id);
      const templates = startingWith(id);
      if (templates.length > 0) {
        throw new RoleError(
          roleErrorCodes.roleInStartingTeam,
          `The ${templates.join(" and ")} Floor ${templates.length === 1 ? "Template starts" : "Templates start"} Floors with a ${role.name} Agent, so ${role.name} stays in the library.`,
        );
      }
      const inUse = (agents: number) =>
        new RoleError(
          roleErrorCodes.roleInUse,
          `${String(agents)} ${agents === 1 ? "Agent fills" : "Agents fill"} ${role.name}: remove ${agents === 1 ? "it" : "them"} from ${agents === 1 ? "its Floor" : "their Floors"} before deleting the Role.`,
        );
      const agents = (await usage()).get(id) ?? 0;
      if (agents > 0) {
        throw inUse(agents);
      }
      const removed = await store.remove(id);
      if (removed === undefined) {
        throw notFound(id);
      }
      if (removed === "in_use") {
        // An Agent was added to it since it was counted.
        throw inUse(Math.max((await usage()).get(id) ?? 0, 1));
      }
      await events.publish({
        type: "role.removed",
        version: 1,
        roleId: id,
        name: removed.name,
      });
    },
  };
}
