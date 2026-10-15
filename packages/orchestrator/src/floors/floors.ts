import { randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  builtInRoles,
  defaultFloorSettings,
  defaultFloorTheme,
  developmentTemplateId,
  developmentTemplateRef,
  floorErrorCodes,
  sameFloorName,
  skillFilesInOrder,
  type FloorSettings,
  type FloorSettingsUpdate,
  type FloorTemplate,
  type InstalledRepository,
  type Random,
} from "@ai-office/shared";
import {
  GitHubNotConfiguredError,
  isGitHubError,
  type GitHubApp,
  type Repository,
} from "@ai-office/github";

import {
  agentCreatedEvent,
  defaultTeam,
  templateTeam,
} from "../agents/agents.ts";
import type { AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { RoleRecord, RoleStore } from "../roles/store.ts";
import { skillDigest } from "../skills/skills.ts";
import type { SkillStore } from "../skills/store.ts";
import { FloorError } from "./errors.ts";
import type { FloorRecord, FloorStore } from "./store.ts";

// Floors (PRD §6.2): the Owner adds one by picking a repository the App is
// installed on and a Floor Template (FR-6, FR-97), changes its settings
// (FR-7), and archives it to stop its intake and hide it, keeping its
// history (FR-9). Each change is an event.
//
// Adding a Floor from a template adds the template's Roles to the office
// Role library where it has no Role of that id, and its Skills to the
// office Skill library where it has no Skill of that name (one it has,
// perhaps edited by the Owner, is kept), creates the template's labels on
// the repository, then gives the Floor the template's team and settings.
// The Floor remembers which template it started from, to show it, and
// nothing reads the template again: everything it set up stays editable.

export interface Floors {
  /** Every repository the App is installed on, with its Floor if any. */
  installedRepositories(): Promise<InstalledRepository[]>;
  /**
   * Makes a Floor of `owner/name` from the Floor Template `template`
   * (Development when absent): its team, settings and labels.
   * Development's are a Manager, a coder, a reviewer (its required
   * reviewer) and a QA Agent, with the default settings.
   */
  add(repository: string, template?: string): Promise<FloorRecord>;
  /** The Floors in use, oldest first; archived ones are hidden. */
  list(): Promise<FloorRecord[]>;
  /** The Floors whose issues are taken in: those not archived. */
  active(): Promise<FloorRecord[]>;
  /** A Floor, archived or not. */
  get(id: string): Promise<FloorRecord>;
  /**
   * Changes some of a Floor's settings. Required reviewers must be its
   * reviewer Agents, not leaving. A new name (a rename) must be unique
   * among the Floors in use, whatever its case; renaming publishes
   * `floor.renamed` beside `config.changed`, and the Floor's id stays.
   */
  updateSettings(id: string, update: FloorSettingsUpdate): Promise<FloorRecord>;
  /** Archives a Floor: its intake stops and it is hidden. */
  archive(id: string): Promise<FloorRecord>;
}

export interface FloorsOptions {
  readonly store: FloorStore;
  /** The GitHub App; absent until the Owner has configured it. */
  readonly github: GitHubApp | undefined;
  readonly events: EventBus;
  /**
   * The Floors' Agents, whom required reviewers are chosen from (FR-27).
   * Without them, no required reviewer can be chosen.
   */
  readonly agents?: AgentStore;
  /** Each AI Provider's default Model, for new Agents' events. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /**
   * The office Role library (FR-98), whose Roles a new Floor's team is
   * in, and which a template's missing Roles are added to; the built-in
   * Roles when absent.
   */
  readonly roles?: Pick<RoleStore, "list" | "create">;
  /**
   * The office Skill library (FR-72), which a template's missing Skills
   * are added to, so that its Agents are given them (FR-75). Without it,
   * a template's Skills are not added.
   */
  readonly skills?: Pick<SkillStore, "list" | "add">;
  /**
   * The Floor Templates a Floor can be added from (FR-97), or how to read
   * them as each Floor is added: the built-in ones and the Owner's enabled
   * ones (FR-101). Without them, or without Development among them, a
   * Floor added without a choice is set up as Development always set
   * Floors up (`defaultTeam`).
   */
  readonly templates?:
    readonly FloorTemplate[] | (() => Promise<readonly FloorTemplate[]>);
  /**
   * The AI Providers the Owner has an AI Account for, which a Role's
   * suggested AI Provider needs (FR-98); every one when absent.
   */
  readonly aiAccountProviders?: () => Promise<ReadonlySet<string>>;
  readonly now?: () => Date;
  /** Picks new Agents' names and Avatars. */
  readonly random?: Random;
  /** Makes new Skills' ids. */
  readonly newId?: () => string;
}

/** The longest id a Floor gets from its repository's name. */
const maxSlugLength = 40;
/** How many ids (`web-shop`, `web-shop-2`, …) a new Floor tries. */
const maxIdAttempts = 100;

/** A Floor id from a repository's name: `Web_Shop` gives `web-shop`. */
export function floorSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, maxSlugLength)
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" ? "floor" : slug;
}

const sameSetting = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createFloors(options: FloorsOptions): Floors {
  const { store, events } = options;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  const github = (): GitHubApp => {
    if (options.github === undefined) {
      throw new FloorError(
        floorErrorCodes.githubNotConfigured,
        new GitHubNotConfiguredError().message,
      );
    }
    return options.github;
  };

  /** Runs a GitHub call, turning its failure into a `FloorError`. */
  const onGitHub = async <Result>(
    call: () => Promise<Result>,
    notFound?: FloorError,
  ): Promise<Result> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GitHubNotConfiguredError) {
        throw new FloorError(
          floorErrorCodes.githubNotConfigured,
          error.message,
        );
      }
      if (notFound !== undefined && isGitHubError(error, 404)) {
        throw notFound;
      }
      throw new FloorError(
        floorErrorCodes.githubUnavailable,
        `GitHub could not be asked: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  const get = async (id: string): Promise<FloorRecord> => {
    const floor = await store.get(id);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${id}".`,
      );
    }
    return floor;
  };

  const inUse = async (id: string): Promise<FloorRecord> => {
    const floor = await get(id);
    if (floor.archivedAt !== null) {
      throw new FloorError(
        floorErrorCodes.floorArchived,
        `The Floor "${floor.name}" is archived.`,
      );
    }
    return floor;
  };

  const roleNameTaken = (template: FloorTemplate, role: RoleRecord) =>
    new FloorError(
      floorErrorCodes.templateRoleNameTaken,
      `The ${template.name} Floor Template brings a Role called "${role.name}", and the Role library has another Role of that name. Rename it, then add the Floor.`,
    );

  /**
   * The template's Roles the library has no Role of that id for. Refused
   * when one's name is another Role's, before anything is changed.
   */
  const missingRoles = async (
    template: FloorTemplate,
  ): Promise<RoleRecord[]> => {
    if (options.roles === undefined) {
      return [];
    }
    const library = await options.roles.list();
    const missing = template.roles
      .map(({ role }) => role)
      .filter((role) => !library.some(({ id }) => id === role.id));
    const clash = missing.find((role) =>
      library.some(
        ({ name }) => name.toLowerCase() === role.name.toLowerCase(),
      ),
    );
    if (clash !== undefined) {
      throw roleNameTaken(template, clash);
    }
    return missing;
  };

  /** Adds the template's missing Roles to the library, each an event. */
  const addRoles = async (
    template: FloorTemplate,
    missing: readonly RoleRecord[],
  ): Promise<void> => {
    const roles = options.roles;
    if (roles === undefined) {
      return;
    }
    for (const role of missing) {
      if (!(await roles.create(role, now()))) {
        // Added meanwhile, by another Floor from a template that brings
        // it; or another Role took its name.
        if ((await roles.list()).some(({ id }) => id === role.id)) {
          continue;
        }
        throw roleNameTaken(template, role);
      }
      await events.publish({
        type: "role.created",
        version: 1,
        roleId: role.id,
        name: role.name,
        stage: role.stage,
        duplicatedFrom: null,
        template: { id: template.id, name: template.name },
      });
    }
  };

  /**
   * Adds the template's Skills the library has no Skill of that name for,
   * each an event. A built-in template ships with AI Office, reviewed as
   * part of it, so its Skills start enabled (FR-76).
   */
  const addSkills = async (template: FloorTemplate): Promise<void> => {
    const library = options.skills;
    if (library === undefined || template.skills.length === 0) {
      return;
    }
    const names = new Set((await library.list()).map(({ name }) => name));
    for (const skill of template.skills) {
      if (names.has(skill.name)) {
        continue;
      }
      const at = now();
      const files = skillFilesInOrder(
        skill.files.map(({ path, content }) => ({ path, content })),
      );
      const record = {
        id: (options.newId ?? randomUUID)(),
        name: skill.name,
        description: skill.description,
        source: "template" as const,
        origin: null,
        files,
        digest: skillDigest(files),
        enabled: true,
        reviewedAt: at,
        createdAt: at,
        updatedAt: at,
      };
      // Added meanwhile, by the Owner or another Floor: theirs is kept.
      if ((await library.add(record)) === "name_taken") {
        continue;
      }
      await events.publish({
        type: "skill.added",
        version: 1,
        skillId: record.id,
        name: record.name,
        source: "template",
        enabled: true,
        template: { id: template.id, name: template.name },
      });
    }
  };

  const floorExists = (repository: Repository, floorId?: string) =>
    new FloorError(
      floorErrorCodes.floorExists,
      floorId === undefined
        ? `${repository.fullName} is already a Floor.`
        : `${repository.fullName} is already a Floor ("${floorId}").`,
    );

  return {
    async installedRepositories() {
      const app = github();
      const [repositories, all] = await Promise.all([
        onGitHub(() => app.repositories()),
        store.list({ includeArchived: true }),
      ]);
      return repositories
        .map((repository) => ({
          fullName: repository.fullName,
          defaultBranch: repository.defaultBranch,
          private: repository.private,
          htmlUrl: repository.htmlUrl,
          floorId:
            all.find(
              ({ githubRepositoryId }) => githubRepositoryId === repository.id,
            )?.id ?? null,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
    },

    async add(fullName, templateId) {
      const app = github();
      const chosen = templateId ?? developmentTemplateId;
      const templates =
        typeof options.templates === "function"
          ? await options.templates()
          : options.templates;
      const template = templates?.find(({ id }) => id === chosen);
      if (template === undefined && chosen !== developmentTemplateId) {
        throw new FloorError(
          floorErrorCodes.templateNotFound,
          `There is no Floor Template "${chosen}".`,
        );
      }
      const repository = await onGitHub(
        () => app.repository(fullName).get(),
        new FloorError(
          floorErrorCodes.notInstalled,
          `The GitHub App is not installed on ${fullName}. Install it there first.`,
        ),
      );
      const existing = (await store.list({ includeArchived: true })).find(
        ({ githubRepositoryId }) => githubRepositoryId === repository.id,
      );
      if (existing !== undefined) {
        throw floorExists(repository, existing.id);
      }

      if (template !== undefined) {
        const missing = await missingRoles(template);
        for (const label of template.labels) {
          await onGitHub(() =>
            app.repository(repository.fullName).ensureLabel(label),
          );
        }
        await addRoles(template, missing);
        await addSkills(template);
      }

      const library = (await options.roles?.list()) ?? [
        ...builtInRoles,
        ...(template?.roles ?? [])
          .map(({ role }) => role)
          .filter(({ id }) => !builtInRoles.some((role) => role.id === id)),
      ];
      const withAccounts = await options.aiAccountProviders?.();
      const hasAccount =
        withAccounts === undefined
          ? {}
          : {
              hasAccount: (aiProvider: string) => withAccounts.has(aiProvider),
            };
      const slug = floorSlug(repository.name);
      for (let attempt = 1; attempt <= maxIdAttempts; attempt += 1) {
        const id = attempt === 1 ? slug : `${slug}-${String(attempt)}`;
        const createdAt = now();
        const team =
          template === undefined
            ? defaultTeam({
                floorId: id,
                random,
                now: createdAt,
                library,
                ...hasAccount,
              })
            : templateTeam({
                floorId: id,
                template,
                random,
                now: createdAt,
                library,
                ...hasAccount,
              });
        const reviewerRoles =
          template === undefined
            ? undefined
            : new Set(template.settings.requiredReviewers);
        const floor: FloorRecord = {
          id,
          githubRepositoryId: repository.id,
          repository: repository.fullName,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
          ...defaultFloorSettings,
          tokenCaps: { ...defaultFloorSettings.tokenCaps },
          ...(template === undefined
            ? {}
            : {
                setupCommand: template.settings.setupCommand,
                testCommand: template.settings.testCommand,
                mergePolicy: template.settings.mergePolicy,
                roundCap: template.settings.roundCap,
              }),
          requiredReviewerAgentIds: team
            .filter(
              ({ stage, role }) =>
                stage === "review" &&
                (reviewerRoles === undefined || reviewerRoles.has(role)),
            )
            .map(({ id: agentId }) => agentId),
          template:
            template === undefined
              ? { ...developmentTemplateRef }
              : { id: template.id, name: template.name },
          theme: template?.theme ?? defaultFloorTheme,
          createdAt,
          archivedAt: null,
        };
        const result = await store.create(floor, team);
        if (result === "repository_taken") {
          throw floorExists(repository);
        }
        if (result === "created") {
          await events.publish({
            type: "floor.created",
            version: 1,
            floorId: floor.id,
            name: floor.name,
            repository: floor.repository,
            template: { ...floor.template },
          });
          const defaults = await options.defaultModels?.();
          for (const agent of team) {
            await events.publish(agentCreatedEvent(agent, defaults));
          }
          return floor;
        }
      }
      throw new Error(
        `No free Floor id for ${repository.fullName} after ${String(maxIdAttempts)} tries.`,
      );
    },

    list: () => store.list(),
    active: () => store.list(),
    get,

    async updateSettings(id, update) {
      const floor = await inUse(id);
      const changes = Object.fromEntries(
        Object.entries(update).filter(
          ([key, value]) =>
            !sameSetting(floor[key as keyof FloorSettings], value),
        ),
      ) as Partial<FloorSettings>;
      const keys = Object.keys(changes);
      if (keys.length === 0) {
        return floor;
      }
      if (changes.requiredReviewerAgentIds !== undefined) {
        const reviewers = ((await options.agents?.list(id)) ?? []).filter(
          ({ stage, leavingAt }) => stage === "review" && leavingAt === null,
        );
        const other = changes.requiredReviewerAgentIds.find(
          (agentId) => !reviewers.some((agent) => agent.id === agentId),
        );
        if (other !== undefined) {
          throw new FloorError(
            floorErrorCodes.notAReviewer,
            `"${other}" is not one of ${floor.name}'s reviewer Agents.`,
          );
        }
      }
      if (changes.name !== undefined) {
        const name = changes.name;
        const namesake = (await store.list()).find(
          (other) => other.id !== id && sameFloorName(other.name, name),
        );
        if (namesake !== undefined) {
          throw new FloorError(
            floorErrorCodes.floorNameTaken,
            `Another Floor is called "${namesake.name}". Choose another name.`,
          );
        }
      }
      if (changes.defaultBranch !== undefined) {
        const branch = changes.defaultBranch;
        const app = github();
        const found = await onGitHub(() =>
          app.repository(floor.repository).getBranch(branch),
        );
        if (found === undefined) {
          throw new FloorError(
            floorErrorCodes.branchNotFound,
            `${floor.repository} has no branch "${branch}".`,
          );
        }
      }
      const updated = await store.update(id, changes);
      if (updated === undefined) {
        return get(id);
      }
      // Which settings changed, never their values.
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId: id,
        keys,
      });
      if (changes.name !== undefined) {
        await events.publish({
          type: "floor.renamed",
          version: 1,
          floorId: id,
          name: updated.name,
          previousName: floor.name,
        });
      }
      return updated;
    },

    async archive(id) {
      await inUse(id);
      const archived = await store.archive(id, now());
      if (archived === undefined) {
        // Archived meanwhile by another request.
        return inUse(id);
      }
      await events.publish({ type: "floor.archived", version: 1, floorId: id });
      return archived;
    },
  };
}
