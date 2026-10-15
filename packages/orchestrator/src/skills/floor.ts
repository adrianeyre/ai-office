import type { EventBus } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import {
  floorErrorCodes,
  isSandboxRole,
  managerRole,
  sandboxStages,
  sandboxRoles,
  skillErrorCodes,
  skillFilesInOrder,
  skillNamePattern,
  type AwaitingSkill,
  type FloorSkill,
  type FloorSkillList,
  type FloorSkillSource,
  type IgnoredSkill,
  type RepositorySkillDetail,
  type Role,
  type SandboxRole,
  type SkillFile,
} from "@ai-office/shared";

import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { memoryRoleStore, type RoleStore } from "../roles/store.ts";
import { builtInOverridesAll, builtInSkills } from "./built-in.ts";
import { SkillError } from "./errors.ts";
import {
  discoverRepositorySkills,
  fileSystemSkillReader,
  gitHubSkillReader,
  readGitHubSkillFolder,
  type RepositorySkill,
} from "./repository.ts";
import type { RepositorySkillReviewStore } from "./reviews.ts";
import { skillDigest } from "./skills.ts";
import type { SkillStore } from "./store.ts";
import { skillOnFor, type FloorSkillToggleStore } from "./toggles.ts";

// A Floor's Skills (PRD FR-72, FR-75): the office library's enabled Skills
// and the Floor repository's own, where a repository Skill overrides the
// office Skill of the same name on that Floor. The Floor admin turns each
// on or off per Role; a sandbox is given the Skills on for its Agent's
// Role, mounted read-only.
//
// Skills are trusted input (FR-76), so a repository Skill counts only once
// the Owner has reviewed exactly the files its folder holds (P1-10), as an
// office Skill is reviewed before it is enabled: until then, and again
// after it changes, it reaches no sandbox and not the Manager's chat, and
// an office Skill of its name keeps its place. Each is read whole, from
// the clone for a sandbox and from GitHub otherwise, and its digest is
// compared with the one the Owner reviewed.

/** A Skill as it applies on one Floor. */
export interface ResolvedSkill {
  readonly name: string;
  readonly description: string;
  readonly source: FloorSkillSource;
  /** A repository Skill's folder; null for an office Skill. */
  readonly folder: string | null;
  /** Whether this repository Skill overrides an office Skill of its name. */
  readonly overridesOffice: boolean;
  readonly files: readonly SkillFile[];
}

/**
 * The Skills on a Floor, by name: each office Skill, unless the
 * repository has one of its name, which overrides it there.
 */
export function resolveFloorSkills(
  office: readonly {
    readonly name: string;
    readonly description: string;
    readonly files: readonly SkillFile[];
  }[],
  repository: readonly RepositorySkill[],
): ResolvedSkill[] {
  const resolved = new Map<string, ResolvedSkill>();
  for (const { name, description, files } of office) {
    resolved.set(name, {
      name,
      description,
      source: "office",
      folder: null,
      overridesOffice: false,
      files,
    });
  }
  for (const { name, description, folder, files } of repository) {
    resolved.set(name, {
      name,
      description,
      source: "repository",
      folder,
      overridesOffice: resolved.has(name),
      files,
    });
  }
  return [...resolved.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/**
 * The Floor's Skills with AI Office's own built-in Skills (FR-77, FR-83b).
 * Those that start a Grilling Session (such as `/grilling`) take the place
 * of any office or repository Skill of their name; the others (such as
 * `/pr`) give way to one, so a Floor's own version wins. They are the
 * Manager's: a sandbox is never given them.
 */
export function withBuiltInSkills(
  skills: readonly ResolvedSkill[],
): ResolvedSkill[] {
  const floors = new Set(skills.map(({ name }) => name));
  const builtIn = builtInSkills.filter(
    ({ name }) => builtInOverridesAll(name) || !floors.has(name),
  );
  const names = new Set(builtIn.map(({ name }) => name));
  return [
    ...skills.filter(({ name }) => !names.has(name)),
    ...builtIn.map(({ name, description, files }): ResolvedSkill => ({
      name,
      description,
      source: "built-in",
      folder: null,
      overridesOffice: false,
      files,
    })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The Skills a sandbox is given, and the repository's that were left out. */
export interface SandboxSkills {
  readonly skills: readonly ResolvedSkill[];
  readonly ignored: readonly IgnoredSkill[];
}

/** A Floor's Skills in full, and why the repository's could not be read. */
export interface AvailableSkills {
  readonly skills: readonly ResolvedSkill[];
  readonly ignored: readonly IgnoredSkill[];
  /** Why the repository's Skills could not be read; null when they were. */
  readonly repositoryError: string | null;
}

/**
 * The repository's Skills the Owner reviewed as they are now, and those
 * that wait for a review (P1-10): never reviewed, or changed since.
 */
export function byReview(
  repository: readonly RepositorySkill[],
  reviews: readonly { readonly folder: string; readonly digest: string }[],
  officeNames: ReadonlySet<string>,
): { reviewed: RepositorySkill[]; awaiting: AwaitingSkill[] } {
  const reviewedDigest = new Map(
    reviews.map(({ folder, digest }) => [folder, digest]),
  );
  const reviewed: RepositorySkill[] = [];
  const awaiting: AwaitingSkill[] = [];
  for (const skill of repository) {
    const digest = skillDigest(skill.files);
    const before = reviewedDigest.get(skill.folder);
    if (before === digest) {
      reviewed.push(skill);
    } else {
      awaiting.push({
        name: skill.name,
        description: skill.description,
        folder: skill.folder,
        digest,
        overridesOffice: officeNames.has(skill.name),
        changed: before !== undefined,
      });
    }
  }
  return { reviewed, awaiting };
}

export interface FloorSkills {
  /**
   * The Floor's Skills with each Role's setting, the repository's read
   * from GitHub at the default branch.
   */
  list(floorId: string): Promise<FloorSkillList>;
  /**
   * The Floor's Skills with their files, the repository's read from
   * GitHub at the default branch: what the Available Skills list opens
   * and the Manager chat runs (FR-73, FR-74). Every one of them is
   * available to the Manager, whose Role has no per-Role setting.
   */
  available(floorId: string): Promise<AvailableSkills>;
  /** One of the Floor's Skills in full, by name; `skill_not_found` if none. */
  get(floorId: string, name: string): Promise<ResolvedSkill>;
  /**
   * A repository Skill in full, by its folder, read from GitHub at the
   * default branch, reviewed or not: what the Owner reads to review it
   * (P1-10). `skill_not_found` if the folder holds no usable Skill.
   */
  repositorySkill(
    floorId: string,
    folder: string,
  ): Promise<RepositorySkillDetail>;
  /**
   * The Owner's review of a repository Skill's files, by the digest of
   * those they read (P1-10): from now on it is used on the Floor while its
   * files are exactly those. `skill_changed` if they are not, now.
   */
  reviewRepositorySkill(
    floorId: string,
    folder: string,
    digest: string,
  ): Promise<RepositorySkillDetail>;
  /** Turns a Skill on or off for one Role's Agents on the Floor. */
  setEnabled(
    floorId: string,
    skillName: string,
    role: string,
    enabled: boolean,
  ): Promise<void>;
  /**
   * The Skills on for `role` on the Floor, the repository's read from its
   * clone at `clone`: what that Agent's sandbox is given. None for a Role
   * whose Stage works in no sandbox (review), nor for the Manager.
   */
  forSandbox(
    floorId: string,
    role: Role,
    clone: string,
  ): Promise<SandboxSkills>;
}

export interface FloorSkillsOptions {
  readonly floors: Pick<FloorStore, "get">;
  /** The office Skill library. */
  readonly library: Pick<SkillStore, "list">;
  /**
   * The office Role library (FR-98), whose Roles' Stages say which work
   * in sandboxes; the built-in Roles when absent.
   */
  readonly roles?: Pick<RoleStore, "get">;
  readonly toggles: FloorSkillToggleStore;
  readonly events: Pick<EventBus, "publish">;
  /** Reads the repository's Skills for the list; without it, they are not listed. */
  readonly github?: GitHubApp;
  /**
   * The repository Skills the Owner reviewed (P1-10): a repository Skill
   * is used only as reviewed.
   */
  readonly reviews: RepositorySkillReviewStore;
  readonly now?: () => Date;
}

export function createFloorSkills(options: FloorSkillsOptions): FloorSkills {
  const { floors, library, toggles, events } = options;
  const now = options.now ?? (() => new Date());
  const roles = options.roles ?? memoryRoleStore();
  const { reviews } = options;

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    return floor;
  };

  /** The library's enabled Skills: a disabled one is on no Floor. */
  const officeSkills = async () =>
    (await library.list()).filter(({ enabled }) => enabled);

  /**
   * The repository's Skills at its default branch, each folder read whole
   * through the GitHub App, so its digest is of every file (P1-10).
   */
  const fromRepository = async (
    floor: FloorRecord,
  ): Promise<{
    skills: readonly RepositorySkill[];
    ignored: readonly IgnoredSkill[];
    repositoryError: string | null;
  }> => {
    if (options.github === undefined) {
      return {
        skills: [],
        ignored: [],
        repositoryError:
          "The GitHub App is not set up, so the repository's Skills cannot be read.",
      };
    }
    try {
      const client = options.github.repository(floor.repository);
      return {
        ...(await discoverRepositorySkills({
          ...gitHubSkillReader(client, floor.defaultBranch),
          read: (folder) =>
            readGitHubSkillFolder(client, floor.defaultBranch, folder),
        })),
        repositoryError: null,
      };
    } catch (error) {
      return {
        skills: [],
        ignored: [],
        repositoryError: `The repository's Skills could not be read from GitHub: ${(error as Error).message}`,
      };
    }
  };

  /** The repository's Skills, split by the Owner's reviews (P1-10). */
  const reviewedOf = async (
    floorId: string,
    office: readonly { readonly name: string }[],
    repository: readonly RepositorySkill[],
  ) =>
    byReview(
      repository,
      await reviews.list(floorId),
      new Set(office.map(({ name }) => name)),
    );

  const available = async (floorId: string): Promise<AvailableSkills> => {
    const floor = await floorOf(floorId);
    const [office, repository] = await Promise.all([
      officeSkills(),
      fromRepository(floor),
    ]);
    const { reviewed } = await reviewedOf(floorId, office, repository.skills);
    return {
      skills: withBuiltInSkills(resolveFloorSkills(office, reviewed)),
      ignored: repository.ignored,
      repositoryError: repository.repositoryError,
    };
  };

  const repositorySkill = async (
    floorId: string,
    folder: string,
  ): Promise<RepositorySkillDetail> => {
    const floor = await floorOf(floorId);
    const found = (await fromRepository(floor)).skills.find(
      (skill) => skill.folder === folder,
    );
    if (found === undefined) {
      throw new SkillError(
        skillErrorCodes.skillNotFound,
        `The repository has no usable Skill in "${folder}".`,
      );
    }
    return {
      name: found.name,
      description: found.description,
      folder: found.folder,
      digest: skillDigest(found.files),
      files: skillFilesInOrder(found.files),
    };
  };

  return {
    available,
    repositorySkill,

    async reviewRepositorySkill(floorId, folder, digest) {
      const floor = await floorOf(floorId);
      if (floor.archivedAt !== null) {
        throw new FloorError(
          floorErrorCodes.floorArchived,
          `The Floor "${floor.name}" is archived, so its settings cannot change.`,
        );
      }
      const skill = await repositorySkill(floorId, folder);
      if (skill.digest !== digest) {
        throw new SkillError(
          skillErrorCodes.skillChanged,
          `The Skill in "${folder}" changed after the contents you read: read it again before you review it.`,
        );
      }
      await reviews.review(floorId, { folder, digest }, now());
      // Which Skill was reviewed; its contents are the repository's.
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId,
        keys: [`skills.${skill.name}.reviewed`],
      });
      return skill;
    },

    async get(floorId, name) {
      const skill = (await available(floorId)).skills.find(
        (each) => each.name === name,
      );
      if (skill === undefined) {
        throw new SkillError(
          skillErrorCodes.skillNotFound,
          `The Floor "${floorId}" has no Skill "${name}".`,
        );
      }
      if (skill.folder === null || options.github === undefined) {
        return { ...skill, files: skillFilesInOrder(skill.files) };
      }
      // The list read only its SKILL.md: now its whole folder.
      const floor = await floorOf(floorId);
      const read = await readGitHubSkillFolder(
        options.github.repository(floor.repository),
        floor.defaultBranch,
        skill.folder,
      );
      if ("problems" in read) {
        throw new SkillError(
          skillErrorCodes.invalidSkill,
          `The Skill "${name}" could not be read from the repository: ${read.problems.join(" ")}`,
        );
      }
      return { ...skill, files: skillFilesInOrder(read.files) };
    },

    async list(floorId) {
      const floor = await floorOf(floorId);
      const repository = await fromRepository(floor);
      const settings = await toggles.list(floorId);
      const office = await officeSkills();
      const { reviewed, awaiting } = await reviewedOf(
        floorId,
        office,
        repository.skills,
      );
      const skills: FloorSkill[] = withBuiltInSkills(
        resolveFloorSkills(office, reviewed),
      ).map(({ name, description, source, folder, overridesOffice }) => ({
        name,
        description,
        source,
        folder,
        overridesOffice,
        // A built-in Skill is the Manager's, never mounted into a sandbox.
        roles: Object.fromEntries(
          sandboxRoles.map((role) => [
            role,
            source !== "built-in" && skillOnFor(settings, name, role),
          ]),
        ) as Record<SandboxRole, boolean>,
      }));
      return {
        skills,
        awaitingReview: awaiting,
        ignored: [...repository.ignored],
        repositoryError: repository.repositoryError,
      };
    },

    async setEnabled(floorId, skillName, role, enabled) {
      const floor = await floorOf(floorId);
      if (floor.archivedAt !== null) {
        throw new FloorError(
          floorErrorCodes.floorArchived,
          `The Floor "${floor.name}" is archived, so its settings cannot change.`,
        );
      }
      if (!isSandboxRole(role)) {
        throw new SkillError(
          skillErrorCodes.notSandboxRole,
          `Skills are turned on or off for the Roles whose Agents work in sandboxes: ${sandboxRoles.join(", ")}.`,
        );
      }
      if (skillName.length > 64 || !skillNamePattern.test(skillName)) {
        throw new SkillError(
          skillErrorCodes.skillNotFound,
          `"${skillName}" is not a Skill's name.`,
        );
      }
      const changed = await toggles.set(
        floorId,
        { skillName, role, enabled },
        now(),
      );
      if (changed) {
        // Which setting changed; whether it is on is the Floor admin's to show.
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "floor",
          floorId,
          keys: [`skills.${skillName}.${role}`],
        });
      }
    },

    async forSandbox(floorId, role, clone) {
      // Every library Role whose Stage works in sandboxes is given Skills,
      // not only the built-in ones the Floor admin toggles.
      const stage =
        role === managerRole ? undefined : (await roles.get(role))?.stage;
      if (stage === undefined || !sandboxStages.includes(stage)) {
        return { skills: [], ignored: [] };
      }
      const [office, repository, settings] = await Promise.all([
        officeSkills(),
        discoverRepositorySkills(fileSystemSkillReader(clone)),
        toggles.list(floorId),
      ]);
      // Only those the Owner reviewed, as the clone has them (P1-10).
      const { reviewed } = await reviewedOf(floorId, office, repository.skills);
      return {
        skills: resolveFloorSkills(office, reviewed).filter(({ name }) =>
          skillOnFor(settings, name, role),
        ),
        ignored: repository.ignored,
      };
    },
  };
}
