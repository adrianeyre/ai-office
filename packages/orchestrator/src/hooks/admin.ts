import type { EventBus } from "@ai-office/events";
import {
  floorErrorCodes,
  hookErrorCodes,
  hookRecentRuns,
  managerRole,
  type Hook,
  type HookErrorCode,
  type HookInput,
  type HookList,
  type HookRun,
  type HookSkill,
  type StartedHookRun,
} from "@ai-office/shared";

import type { AgentStore } from "../agents/store.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { memoryRoleStore, type RoleStore } from "../roles/store.ts";
import { builtInOverridesAll } from "../skills/built-in.ts";
import type { FloorSkills } from "../skills/floor.ts";
import type { HookRunner } from "./runner.ts";
import type {
  HookFields,
  HookRecord,
  HookRunRecord,
  HookStore,
} from "./store.ts";

// A Floor's Hooks in its admin (Guidelines, Specs and Hooks PRD, FR-121;
// ADR 0016): listed with their latest runs and the Skills a Hook can run,
// added, changed (turning one off or on among them), deleted, and Run now.
// Only the Owner reaches these, through the Floor admin's Hooks card and
// its API. Each change is an event in the Activity Feed: `hook.added`,
// `hook.changed` naming the fields that changed, and `hook.removed`.
//
// What a Hook names is checked as it is set: an Agent of the Floor's (not
// its Manager), a Role in the library, and a Skill the Floor has that is
// not one starting a Grilling Session. What did not change is not checked
// again, so a Hook whose Skill has gone can still be turned off.

/** Why a Hooks request was refused; `code` is one of `hookErrorCodes`. */
export class HookError extends Error {
  readonly code: HookErrorCode;

  constructor(code: HookErrorCode, message: string) {
    super(message);
    this.name = "HookError";
    this.code = code;
  }
}

export interface HooksAdmin {
  list(floorId: string): Promise<HookList>;
  create(floorId: string, input: HookInput): Promise<HookList>;
  /** Changes a Hook to `input`, the whole of it. */
  update(floorId: string, id: number, input: HookInput): Promise<HookList>;
  remove(floorId: string, id: number): Promise<HookList>;
  /** Runs a Run now Hook that is on, at once. */
  runNow(floorId: string, id: number): Promise<StartedHookRun>;
}

export interface HooksAdminOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly agents: Pick<AgentStore, "list">;
  /** The Role library; the built-in Roles when absent. */
  readonly roles?: Pick<RoleStore, "get">;
  readonly store: HookStore;
  readonly skills: Pick<FloorSkills, "available">;
  readonly runner: Pick<HookRunner, "runNow">;
  readonly events: Pick<EventBus, "publish">;
  readonly now?: () => Date;
}

/** The fields of a Hook the Owner sets, in the order they are named. */
const hookFields = [
  "name",
  "trigger",
  "stage",
  "labels",
  "filePatterns",
  "agentId",
  "role",
  "skillName",
  "runsPerHour",
  "enabled",
] as const satisfies readonly (keyof HookFields)[];

/** The fields that differ between two versions of a Hook. */
export const changedHookFields = (
  before: HookFields,
  after: HookFields,
): (keyof HookFields)[] =>
  hookFields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );

/** A Hook as the Owner set it, from the API's input. */
export const hookFieldsOf = (input: HookInput): HookFields => ({
  name: input.name,
  trigger: input.trigger,
  stage: input.stage,
  labels: [...input.labels],
  filePatterns: [...input.filePatterns],
  agentId: input.agentId,
  role: input.role,
  skillName: input.skillName,
  runsPerHour: input.runsPerHour,
  enabled: input.enabled,
});

const runOf = (
  run: HookRunRecord,
  agentName: (id: string) => string | null,
): HookRun => ({
  id: run.id,
  agentId: run.agentId,
  agentName: run.agentId === null ? null : agentName(run.agentId),
  trigger: run.trigger,
  issue: run.issue,
  pullRequest: run.pullRequest,
  status: run.status,
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
  error: run.error,
  result: run.result,
  commentUrl: run.commentUrl,
});

export function createHooksAdmin(options: HooksAdminOptions): HooksAdmin {
  const { store, events } = options;
  const now = options.now ?? (() => new Date());
  const roles = options.roles ?? memoryRoleStore();

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await options.floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    return floor;
  };

  const changeable = async (floorId: string): Promise<FloorRecord> => {
    const floor = await floorOf(floorId);
    if (floor.archivedAt !== null) {
      throw new FloorError(
        floorErrorCodes.floorArchived,
        `${floor.name} is archived, so its Hooks do not change.`,
      );
    }
    return floor;
  };

  const hookOf = async (floorId: string, id: number): Promise<HookRecord> => {
    const hook = await store.get(floorId, id);
    if (hook === undefined) {
      throw new HookError(
        hookErrorCodes.hookNotFound,
        "The Floor has no such Hook.",
      );
    }
    return hook;
  };

  /** The Skills a Hook can run: all the Floor's but those starting a Grilling Session. */
  const skillsOf = async (
    floorId: string,
  ): Promise<{ skills: HookSkill[]; error: string | null }> => {
    const { skills, repositoryError } = await options.skills.available(floorId);
    return {
      skills: skills
        .filter(
          ({ name, source }) =>
            !(source === "built-in" && builtInOverridesAll(name)),
        )
        .map(({ name, description, source }) => ({
          name,
          description,
          source,
        })),
      error: repositoryError,
    };
  };

  const list = async (floorId: string): Promise<HookList> => {
    await floorOf(floorId);
    const [hooks, team, skills] = await Promise.all([
      store.list(floorId),
      options.agents.list(floorId),
      skillsOf(floorId).catch((error: unknown) => ({
        skills: [],
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
    const names = new Map(team.map(({ id, name }) => [id, name]));
    const agentName = (id: string) => names.get(id) ?? null;
    return {
      hooks: await Promise.all(
        hooks.map(async (hook): Promise<Hook> => ({
          id: hook.id,
          name: hook.name,
          trigger: hook.trigger,
          stage: hook.stage,
          labels: [...hook.labels],
          filePatterns: [...hook.filePatterns],
          agentId: hook.agentId,
          role: hook.role,
          skillName: hook.skillName,
          runsPerHour: hook.runsPerHour,
          enabled: hook.enabled,
          failures: hook.failures,
          createdAt: hook.createdAt.toISOString(),
          updatedAt: hook.updatedAt.toISOString(),
          runs: (await store.runs(hook.id, hookRecentRuns)).map((run) =>
            runOf(run, agentName),
          ),
        })),
      ),
      skills: skills.skills,
      skillsError: skills.error,
    };
  };

  /** Refuses a Hook naming an Agent, Role or Skill the Floor does not have. */
  const check = async (
    floor: FloorRecord,
    fields: HookFields,
    before?: HookFields,
  ): Promise<void> => {
    const invalid = (message: string) =>
      new HookError(hookErrorCodes.hookInvalid, message);
    if (fields.agentId !== null && fields.agentId !== before?.agentId) {
      const agent = (await options.agents.list(floor.id)).find(
        ({ id }) => id === fields.agentId,
      );
      if (agent === undefined) {
        throw invalid(`That Agent is not on ${floor.name}.`);
      }
      if (agent.role === managerRole) {
        throw invalid("The Manager does not run Hooks.");
      }
    }
    if (fields.role !== null && fields.role !== before?.role) {
      if ((await roles.get(fields.role)) === undefined) {
        throw invalid(`There is no ${fields.role} Role in the Role library.`);
      }
    }
    if (fields.skillName !== before?.skillName) {
      const { skills, error } = await skillsOf(floor.id);
      if (!skills.some(({ name }) => name === fields.skillName)) {
        throw invalid(
          `${floor.name} has no Skill /${fields.skillName} a Hook can run${
            error === null
              ? ""
              : ` (its repository's Skills could not be read: ${error})`
          }.`,
        );
      }
    }
  };

  const nameTaken = (floor: FloorRecord, name: string) =>
    new HookError(
      hookErrorCodes.hookNameTaken,
      `${floor.name} has a Hook named "${name}" already.`,
    );

  return {
    list,

    async create(floorId, input) {
      const floor = await changeable(floorId);
      const fields = hookFieldsOf(input);
      await check(floor, fields);
      const hook = await store.create(floor.id, fields, now());
      if (hook === "name_taken") {
        throw nameTaken(floor, fields.name);
      }
      await events.publish({
        type: "hook.added",
        version: 1,
        floorId: floor.id,
        hookId: hook.id,
        name: hook.name,
        trigger: hook.trigger,
      });
      return list(floor.id);
    },

    async update(floorId, id, input) {
      const floor = await changeable(floorId);
      const before = await hookOf(floor.id, id);
      const fields = hookFieldsOf(input);
      const changed = changedHookFields(before, fields);
      if (changed.length === 0) {
        return list(floor.id);
      }
      await check(floor, fields, before);
      const hook = await store.update(floor.id, id, fields, now());
      if (hook === "name_taken") {
        throw nameTaken(floor, fields.name);
      }
      if (hook === undefined) {
        throw new HookError(
          hookErrorCodes.hookNotFound,
          "The Floor has no such Hook.",
        );
      }
      await events.publish({
        type: "hook.changed",
        version: 1,
        floorId: floor.id,
        hookId: hook.id,
        name: hook.name,
        fields: changed,
        by: "owner",
        enabled: hook.enabled,
      });
      return list(floor.id);
    },

    async remove(floorId, id) {
      const floor = await changeable(floorId);
      const hook = await store.remove(floor.id, id);
      if (hook === undefined) {
        throw new HookError(
          hookErrorCodes.hookNotFound,
          "The Floor has no such Hook.",
        );
      }
      await events.publish({
        type: "hook.removed",
        version: 1,
        floorId: floor.id,
        hookId: hook.id,
        name: hook.name,
      });
      return list(floor.id);
    },

    async runNow(floorId, id) {
      const floor = await changeable(floorId);
      const hook = await hookOf(floor.id, id);
      if (hook.trigger !== "run_now") {
        throw new HookError(
          hookErrorCodes.hookNotRunNow,
          `"${hook.name}" runs when its event happens, not with Run now.`,
        );
      }
      if (!hook.enabled) {
        throw new HookError(
          hookErrorCodes.hookDisabled,
          `"${hook.name}" is off: turn it on to run it.`,
        );
      }
      const started = await options.runner.runNow(floor, hook);
      if (started === "rate_limited") {
        throw new HookError(
          hookErrorCodes.hookRateLimited,
          `"${hook.name}" has made its ${String(hook.runsPerHour)} runs this hour: try again later, or let it make more.`,
        );
      }
      if (started === "already_running") {
        throw new HookError(
          hookErrorCodes.hookRunning,
          `"${hook.name}" is running already.`,
        );
      }
      const team = await options.agents.list(floor.id);
      const names = new Map(team.map(({ id: each, name }) => [each, name]));
      return {
        run: runOf(started, (agentId) => names.get(agentId) ?? null),
        hooks: await list(floor.id),
      };
    },
  };
}
