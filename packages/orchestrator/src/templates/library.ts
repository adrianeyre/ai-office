import type { EventBus } from "@ai-office/events";
import {
  floorTemplateBundleFormat,
  floorTemplateBundleVersion,
  floorTemplateErrorCodes,
  managerRole,
  skillFilesInOrder,
  templateIdSchema,
  updateFloorTemplateRequestSchema,
  type FloorTemplate,
  type FloorTemplateBundle,
  type FloorTemplateFile,
  type FloorTemplateOrigin,
  type FloorTemplateSkill,
  type FloorTemplateSource,
  type ImportFloorTemplateFromGitRequest,
  type OwnerFloorTemplateSource,
  type RoleDefinition,
  type SaveFloorTemplateRequest,
  type UpdateFloorTemplateRequest,
} from "@ai-office/shared";

import type { AgentStore } from "../agents/store.ts";
import type { FloorStore } from "../floors/store.ts";
import type { RoleStore } from "../roles/store.ts";
import { skillDigest } from "../skills/skills.ts";
import type { SkillStore } from "../skills/store.ts";
import { FloorTemplateLibraryError } from "./errors.ts";
import {
  FloorTemplateError,
  floorTemplateDigest,
  floorTemplateFiles,
  floorTemplateFromFiles,
} from "./files.ts";
import type { TemplateRepository } from "./git.ts";
import type { FloorTemplateStore, OwnerTemplateRecord } from "./store.ts";

// The office's Floor Templates (PRD FR-97, FR-101): the built-in ones,
// shipped as files under `templates/` and read-only, and the Owner's own,
// stored in AI Office. The Owner duplicates a template (a built-in one
// too) and edits the copy: its Roles and their counts, settings, the
// Manager's guidance, labels and theme. They save a Floor's set-up as a
// new template, export a template with its Roles and Skills to a file,
// and import one from a file or a Git repository.
//
// An Owner's template holds its own copy of its Roles and Skills, as a
// built-in one does, so it is whole when exported and nothing depends on
// the libraries afterwards. Each time the Owner makes or edits one, its
// Roles are copied in as the Role library has them (and their Skills as
// the Skill library has them), since a Floor added from it gets the
// library's Role where the library has one. Every template, however it is
// made, is written as its folder's files and read back through the same
// checks as the built-in ones.
//
// Role instructions and Skills reach models, so they are trusted input
// (ADR 0003, FR-76). A template imported from a file or Git is disabled
// until the Owner has read its full contents and reviewed it, naming the
// digest of what they read; a copy of one not yet reviewed waits too.
// Where its Roles and Skills meet the libraries' of the same id or name,
// the clashes are reported. Every add, change and removal is an event,
// for the Activity Feed.

/** A template, built-in or the Owner's, with what the admin shows of it. */
export interface FloorTemplateEntry {
  readonly template: FloorTemplate;
  /** Shipped with AI Office: read-only. */
  readonly builtIn: boolean;
  readonly source: FloorTemplateSource;
  readonly origin: FloorTemplateOrigin | null;
  /** The SHA-256 of its files, which a review names. */
  readonly digest: string;
  /** Whether a Floor can be added from it. */
  readonly enabled: boolean;
  /** When the Owner reviewed it; null for a built-in one, or one waiting. */
  readonly reviewedAt: Date | null;
  /** Null for a built-in template. */
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

export interface FloorTemplateLibrary {
  /** The built-in templates, Development first, then the Owner's by name. */
  list(): Promise<FloorTemplateEntry[]>;
  get(id: string): Promise<FloorTemplateEntry>;
  /** The templates a Floor can be added from: all but those waiting for review. */
  enabled(): Promise<FloorTemplate[]>;
  /**
   * Where the template's Roles and Skills meet the libraries' of the same
   * id or name, one line each.
   */
  clashes(template: FloorTemplate): Promise<string[]>;
  /** Copies a template under `name`, or "<its name> copy". */
  duplicate(id: string, name?: string): Promise<FloorTemplateEntry>;
  /** Saves a Floor's set-up (its team, settings and Manager's instructions). */
  saveFloor(request: SaveFloorTemplateRequest): Promise<FloorTemplateEntry>;
  /** Changes one of the Owner's templates; a built-in one is read-only. */
  update(
    id: string,
    changes: UpdateFloorTemplateRequest,
  ): Promise<FloorTemplateEntry>;
  /** Deletes one of the Owner's templates; Floors from it keep everything. */
  remove(id: string): Promise<void>;
  /** A template's file: its folder, Roles and Skills included. */
  exportBundle(id: string): Promise<FloorTemplateBundle>;
  /** Imports an exported template, under `name` if given. It waits for review. */
  importBundle(
    bundle: FloorTemplateBundle,
    name?: string,
  ): Promise<FloorTemplateEntry>;
  /** Imports a template's folder from a Git repository. It waits for review. */
  importFromGit(
    request: ImportFloorTemplateFromGitRequest,
    signal?: AbortSignal,
  ): Promise<FloorTemplateEntry>;
  /**
   * Records that the Owner reviewed the template's full contents, and
   * enables it. Refused if its files no longer have `digest`.
   */
  review(id: string, digest: string): Promise<FloorTemplateEntry>;
}

export interface FloorTemplateLibraryOptions {
  /** The built-in templates, loaded from `templates/`, Development first. */
  readonly builtIn: readonly FloorTemplate[];
  readonly store: FloorTemplateStore;
  /** The office Role library, whose Roles a template's are copied from. */
  readonly roles: Pick<RoleStore, "list">;
  /** The office Skill library, whose Skills a template's are copied from. */
  readonly skills: Pick<SkillStore, "list">;
  /** The Floors and their Agents, whose set-up is saved as a template. */
  readonly floors?: Pick<FloorStore, "get">;
  readonly agents?: Pick<AgentStore, "list">;
  readonly events: Pick<EventBus, "publish">;
  /** Where templates are imported from; without one, Git imports are refused. */
  readonly repository?: TemplateRepository;
  readonly now?: () => Date;
}

/** The parts of a template the Owner edits, as `floor_template.changed` names them. */
const parts = [
  "name",
  "description",
  "icon",
  "theme",
  "roles",
  "settings",
  "manager",
  "labels",
  "skills",
] as const satisfies readonly (keyof FloorTemplate)[];

/** `value` as JSON with its keys in order, so two values compare as equal. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

/** A Role's own fields, without anything a store adds. */
const definitionOf = (role: RoleDefinition): RoleDefinition => ({
  id: role.id,
  name: role.name,
  stage: role.stage,
  description: role.description,
  instructions: role.instructions,
  skills: [...role.skills],
  deskDressing: role.deskDressing,
  aiProvider: role.aiProvider,
  model: role.model,
});

/** A template's parts, without its id (or anything else a loader adds). */
const partsOf = (template: FloorTemplate): Omit<FloorTemplate, "id"> => ({
  name: template.name,
  description: template.description,
  icon: template.icon,
  theme: template.theme,
  roles: template.roles,
  settings: template.settings,
  manager: template.manager,
  labels: template.labels,
  skills: template.skills,
});

/** A template as such, without the loader's list of the files it read. */
const templateOf = (template: FloorTemplate): FloorTemplate => ({
  id: template.id,
  ...partsOf(template),
});

/**
 * A template's id made from its name, as a Role's is: lowercase letters
 * and digits joined by hyphens, at most 40 characters (`Garden centre` is
 * `garden-centre`); `template` when the name has nothing to make one of.
 */
const templateIdOf = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return templateIdSchema.safeParse(slug).success ? slug : "template";
};

/** `id` with `-n` after it, within a template id's 40 characters. */
const numbered = (id: string, n: number): string => {
  const suffix = `-${String(n)}`;
  return `${id.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
};

/** `name`, cut so that `suffix` fits after it in a template's name. */
const withSuffix = (name: string, suffix: string): string =>
  `${name.slice(0, 40 - suffix.length).trimEnd()}${suffix}`;

export function createFloorTemplateLibrary(
  options: FloorTemplateLibraryOptions,
): FloorTemplateLibrary {
  const { store, events, builtIn } = options;
  const now = options.now ?? (() => new Date());

  const notFound = (id: string) =>
    new FloorTemplateLibraryError(
      floorTemplateErrorCodes.templateNotFound,
      `There is no Floor Template "${id}".`,
    );
  const nameTaken = (name: string) =>
    new FloorTemplateLibraryError(
      floorTemplateErrorCodes.templateNameTaken,
      `Another Floor Template is called "${name}": give this one another name.`,
    );
  const readOnly = (template: FloorTemplate) =>
    new FloorTemplateLibraryError(
      floorTemplateErrorCodes.templateBuiltIn,
      `${template.name} is a built-in Floor Template, so it is read-only: duplicate it, then change the copy.`,
    );
  const invalid = (error: unknown): never => {
    if (error instanceof FloorTemplateError) {
      throw new FloorTemplateLibraryError(
        floorTemplateErrorCodes.invalidTemplate,
        "That is not a valid Floor Template.",
        error.problems.map((problem) => `${error.path}: ${problem}`),
      );
    }
    throw error;
  };

  /** Reads a stored template's files; they were checked as it was stored. */
  const entryOf = (record: OwnerTemplateRecord): FloorTemplateEntry => {
    const template = templateOf(
      floorTemplateFromFiles(record.id, record.files),
    );
    return {
      template,
      builtIn: false,
      source: record.source,
      origin: record.origin,
      digest: record.digest,
      enabled: record.reviewedAt !== null,
      reviewedAt: record.reviewedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  };

  const builtInEntry = (loaded: FloorTemplate): FloorTemplateEntry => {
    // The loader's list of the files it read is not part of the template.
    const template = templateOf(loaded);
    return {
      template,
      builtIn: true,
      source: "built-in",
      origin: null,
      digest: floorTemplateDigest(floorTemplateFiles(template)),
      enabled: true,
      reviewedAt: null,
      createdAt: null,
      updatedAt: null,
    };
  };

  const get = async (id: string): Promise<FloorTemplateEntry> => {
    const shipped = builtIn.find((template) => template.id === id);
    if (shipped !== undefined) {
      return builtInEntry(shipped);
    }
    const record = await store.get(id);
    if (record === undefined) {
      throw notFound(id);
    }
    return entryOf(record);
  };

  /** One of the Owner's templates, refusing a built-in one. */
  const own = async (id: string): Promise<OwnerTemplateRecord> => {
    const shipped = builtIn.find((template) => template.id === id);
    if (shipped !== undefined) {
      throw readOnly(shipped);
    }
    const record = await store.get(id);
    if (record === undefined) {
      throw notFound(id);
    }
    return record;
  };

  /** Whether a built-in template is called `name`, whatever its case. */
  const builtInNamed = (name: string): boolean =>
    builtIn.some(
      (template) => template.name.toLowerCase() === name.toLowerCase(),
    );

  /** A free id for a new template, from `wanted` (or its name). */
  const freeId = async (wanted: string): Promise<string> => {
    const base = templateIdSchema.safeParse(wanted).success
      ? wanted
      : templateIdOf(wanted);
    const taken = new Set([
      ...builtIn.map(({ id }) => id),
      ...(await store.list()).map(({ id }) => id),
    ]);
    let id = base;
    for (let n = 2; taken.has(id); n += 1) {
      id = numbered(base, n);
    }
    return id;
  };

  /**
   * The template `id` from its parts, written as its files and read back
   * through every check a template passes; refused when one fails.
   */
  const compose = (
    id: string,
    template: Omit<FloorTemplate, "id">,
  ): { template: FloorTemplate; files: FloorTemplateFile[] } => {
    const files = floorTemplateFiles({ id, ...template });
    try {
      return { template: templateOf(floorTemplateFromFiles(id, files)), files };
    } catch (error) {
      return invalid(error);
    }
  };

  /**
   * Each Role `wanted` names, as the Role library has it, or as `holding`
   * holds it when the library has none; then their Skills, as the Skill
   * library has them, or as `holding` does. A Skill neither has is no
   * longer the Role's.
   */
  const copyIn = async (
    wanted: readonly { readonly role: string; readonly count: number }[],
    holding?: FloorTemplate,
  ): Promise<Pick<FloorTemplate, "roles" | "skills">> => {
    const [library, skillLibrary] = await Promise.all([
      options.roles.list(),
      options.skills.list(),
    ]);
    const skills = new Map<string, FloorTemplateSkill>();
    const skillNamed = (name: string): FloorTemplateSkill | undefined => {
      const inLibrary = skillLibrary.find((skill) => skill.name === name);
      return inLibrary !== undefined
        ? {
            name,
            description: inLibrary.description,
            files: skillFilesInOrder(
              inLibrary.files.map(({ path, content }) => ({ path, content })),
            ),
          }
        : holding?.skills.find((skill) => skill.name === name);
    };
    const roles = wanted.map(({ role: id, count }) => {
      const role =
        library.find((each) => each.id === id) ??
        holding?.roles.find(({ role: each }) => each.id === id)?.role;
      if (role === undefined) {
        throw new FloorTemplateLibraryError(
          floorTemplateErrorCodes.roleNotFound,
          `The Role library has no Role "${id}".`,
        );
      }
      const kept = role.skills.filter((name) => {
        const skill = skillNamed(name);
        if (skill !== undefined) {
          skills.set(name, skill);
        }
        return skill !== undefined;
      });
      return { role: { ...definitionOf(role), skills: kept }, count };
    });
    return {
      roles,
      skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  };

  /** Stores a new template of the Owner's, each an event. */
  const add = async (
    wantedId: string,
    template: Omit<FloorTemplate, "id">,
    source: OwnerFloorTemplateSource,
    details: {
      readonly origin?: FloorTemplateOrigin | null;
      readonly reviewed: boolean;
      readonly duplicatedFrom?: FloorTemplate;
      readonly floorId?: string;
    },
  ): Promise<FloorTemplateEntry> => {
    if (builtInNamed(template.name)) {
      throw nameTaken(template.name);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = await freeId(wantedId);
      const { template: composed, files } = compose(id, template);
      const at = now();
      const record: OwnerTemplateRecord = {
        id,
        name: composed.name,
        source,
        origin: details.origin ?? null,
        files,
        digest: floorTemplateDigest(files),
        reviewedAt: details.reviewed ? at : null,
        createdAt: at,
        updatedAt: at,
      };
      const added = await store.add(record);
      if (added === "name_taken") {
        throw nameTaken(composed.name);
      }
      if (added === "id_taken") {
        // Taken meanwhile by another request: try the next free one.
        continue;
      }
      await events.publish({
        type: "floor_template.added",
        version: 1,
        templateId: id,
        name: composed.name,
        source,
        duplicatedFrom:
          details.duplicatedFrom === undefined
            ? null
            : {
                id: details.duplicatedFrom.id,
                name: details.duplicatedFrom.name,
              },
        floorId: details.floorId ?? null,
        enabled: record.reviewedAt !== null,
      });
      return entryOf(record);
    }
    throw new Error(`No free Floor Template id for "${template.name}".`);
  };

  /**
   * Reads an imported template's files, under `name` if given; `id` is
   * only what its files are read as, and it is given its own as it is
   * stored.
   */
  const imported = (
    id: string,
    files: readonly FloorTemplateFile[],
    name: string | undefined,
  ): Omit<FloorTemplate, "id"> => {
    let read: FloorTemplate;
    try {
      read = floorTemplateFromFiles(id, files);
    } catch (error) {
      return invalid(error);
    }
    const template = partsOf(read);
    return name === undefined ? template : { ...template, name };
  };

  const clashes = async (template: FloorTemplate): Promise<string[]> => {
    const [library, skillLibrary] = await Promise.all([
      options.roles.list(),
      options.skills.list(),
    ]);
    const lines: string[] = [];
    for (const { role } of template.roles) {
      const same = library.find(({ id }) => id === role.id);
      if (
        same !== undefined &&
        stable(definitionOf(same)) !== stable(definitionOf(role))
      ) {
        lines.push(
          `The Role library has its own ${same.name} (${role.id}), which differs from this template's: a Floor added from it gets the library's.`,
        );
      }
      const namesake = library.find(
        ({ id, name }) =>
          id !== role.id && name.toLowerCase() === role.name.toLowerCase(),
      );
      if (namesake !== undefined) {
        lines.push(
          `The Role library's ${namesake.name} (${namesake.id}) has the name of this template's Role ${role.id}: rename one of them before adding a Floor from it.`,
        );
      }
    }
    for (const skill of template.skills) {
      const same = skillLibrary.find(({ name }) => name === skill.name);
      if (same !== undefined && same.digest !== skillDigest(skill.files)) {
        lines.push(
          `The Skill library has its own ${skill.name}, which differs from this template's: a Floor added from it keeps the library's.`,
        );
      }
    }
    return lines;
  };

  return {
    async list() {
      const owners = (await store.list()).map(entryOf);
      return [...builtIn.map(builtInEntry), ...owners];
    },

    get,

    async enabled() {
      const owners = (await store.list())
        .filter(({ reviewedAt }) => reviewedAt !== null)
        .map((record) => entryOf(record).template);
      return [...builtIn, ...owners];
    },

    clashes,

    async duplicate(id, name) {
      const { template: source, reviewedAt, builtIn: shipped } = await get(id);
      let copyName = name?.trim();
      if (copyName === undefined || copyName === "") {
        const names = new Set(
          [...builtIn, ...(await store.list())].map((each) =>
            each.name.toLowerCase(),
          ),
        );
        copyName = withSuffix(source.name, " copy");
        for (let n = 2; names.has(copyName.toLowerCase()); n += 1) {
          copyName = withSuffix(source.name, ` copy ${String(n)}`);
        }
      }
      const rest = partsOf(source);
      return add(
        copyName,
        {
          ...rest,
          name: copyName,
          ...(await copyIn(
            source.roles.map(({ role, count }) => ({ role: role.id, count })),
            source,
          )),
        },
        "duplicate",
        {
          // A copy of a template not yet reviewed waits for review too.
          reviewed: shipped || reviewedAt !== null,
          duplicatedFrom: source,
        },
      );
    },

    async saveFloor(request) {
      const floor = await options.floors?.get(request.floorId);
      if (floor === undefined) {
        throw new FloorTemplateLibraryError(
          floorTemplateErrorCodes.floorNotFound,
          `There is no Floor "${request.floorId}".`,
        );
      }
      const team = ((await options.agents?.list(floor.id)) ?? []).filter(
        ({ leavingAt }) => leavingAt === null,
      );
      const counts = new Map<string, number>();
      for (const agent of team) {
        if (agent.role !== managerRole) {
          counts.set(agent.role, (counts.get(agent.role) ?? 0) + 1);
        }
      }
      const reviewers = [
        ...new Set(
          floor.requiredReviewerAgentIds.flatMap((agentId) => {
            const reviewer = team.find(({ id }) => id === agentId);
            return reviewer?.stage === "review" ? [reviewer.role] : [];
          }),
        ),
      ];
      const manager = team.find(({ role }) => role === managerRole);
      // Its labels and icon are its own template's, if that is still here;
      // the Floor keeps no record of its labels.
      const started =
        builtIn.find(({ id }) => id === floor.template.id) ??
        (await store
          .get(floor.template.id)
          .then((record) =>
            record === undefined ? undefined : entryOf(record).template,
          ));
      return add(
        request.name,
        {
          name: request.name,
          description: request.description,
          icon: request.icon ?? started?.icon ?? "code",
          theme: floor.theme,
          ...(await copyIn(
            [...counts].map(([role, count]) => ({ role, count })),
          )),
          settings: {
            setupCommand: floor.setupCommand,
            testCommand: floor.testCommand,
            mergePolicy: floor.mergePolicy,
            roundCap: floor.roundCap,
            requiredReviewers: reviewers,
          },
          manager: {
            planningGuidance: manager?.extraInstructions ?? "",
            firstIssue: null,
          },
          labels: started?.labels.map((label) => ({ ...label })) ?? [],
        },
        "floor",
        { reviewed: true, floorId: floor.id },
      );
    },

    async update(id, changes) {
      const parsed = updateFloorTemplateRequestSchema.safeParse(changes);
      if (!parsed.success) {
        throw new FloorTemplateLibraryError(
          floorTemplateErrorCodes.invalidTemplate,
          "That is not a valid Floor Template.",
          parsed.error.issues.map(({ message }) => message),
        );
      }
      const record = await own(id);
      const { template: current } = entryOf(record);
      const { data } = parsed;
      if (data.name !== undefined && builtInNamed(data.name)) {
        throw nameTaken(data.name);
      }
      const rest = partsOf(current);
      const { template: next, files } = compose(id, {
        ...rest,
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.description === undefined
          ? {}
          : { description: data.description }),
        ...(data.icon === undefined ? {} : { icon: data.icon }),
        ...(data.theme === undefined ? {} : { theme: data.theme }),
        ...(data.roles === undefined ? {} : await copyIn(data.roles, current)),
        ...(data.settings === undefined ? {} : { settings: data.settings }),
        ...(data.manager === undefined ? {} : { manager: data.manager }),
        ...(data.labels === undefined ? {} : { labels: data.labels }),
      });
      const keys = parts.filter(
        (part) => stable(current[part]) !== stable(next[part]),
      );
      if (keys.length === 0) {
        return entryOf(record);
      }
      const updated = await store.update(id, {
        name: next.name,
        files,
        digest: floorTemplateDigest(files),
        updatedAt: now(),
      });
      if (updated === undefined) {
        throw notFound(id);
      }
      if (updated === "name_taken" || updated === "changed") {
        throw nameTaken(next.name);
      }
      await events.publish({
        type: "floor_template.changed",
        version: 1,
        templateId: id,
        name: next.name,
        change: "edited",
        keys: [...keys],
      });
      return entryOf(updated);
    },

    async remove(id) {
      await own(id);
      const removed = await store.remove(id);
      if (removed === undefined) {
        throw notFound(id);
      }
      await events.publish({
        type: "floor_template.removed",
        version: 1,
        templateId: removed.id,
        name: removed.name,
      });
    },

    async exportBundle(id) {
      const { template } = await get(id);
      return {
        format: floorTemplateBundleFormat,
        version: floorTemplateBundleVersion,
        exportedAt: now().toISOString(),
        id: template.id,
        files: floorTemplateFiles(template),
      };
    },

    async importBundle(bundle, name) {
      return add(bundle.id, imported(bundle.id, bundle.files, name), "file", {
        reviewed: false,
      });
    },

    async importFromGit(request, signal) {
      if (options.repository === undefined) {
        throw new FloorTemplateLibraryError(
          floorTemplateErrorCodes.importFailed,
          "Importing Floor Templates from Git is not available here.",
        );
      }
      const fetched = await options.repository(request, signal);
      const template = imported("imported", fetched.files, request.name);
      return add(fetched.folder ?? template.name, template, "git", {
        origin: {
          url: request.url,
          ref: request.ref ?? null,
          commit: fetched.commit,
          path: fetched.path,
        },
        reviewed: false,
      });
    },

    async review(id, digest) {
      await own(id);
      const at = now();
      const reviewed = await store.update(
        id,
        { reviewedAt: at, updatedAt: at },
        digest,
      );
      if (reviewed === undefined) {
        throw notFound(id);
      }
      if (reviewed === "changed" || reviewed === "name_taken") {
        throw new FloorTemplateLibraryError(
          floorTemplateErrorCodes.templateChanged,
          "The Floor Template changed after the contents you reviewed. Review it again.",
        );
      }
      await events.publish({
        type: "floor_template.changed",
        version: 1,
        templateId: id,
        name: reviewed.name,
        change: "reviewed",
        keys: [],
      });
      return entryOf(reviewed);
    },
  };
}
