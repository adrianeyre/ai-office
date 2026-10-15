import { createHash, randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  addSkillRequestSchema,
  describeSkill,
  importedSkillSources,
  skillErrorCodes,
  skillFilesInOrder,
  skillFilesSchema,
  skillProblems,
  type AddSkillRequest,
  type ImportSkillRequest,
  type SkillFile,
  type SkillSource,
  type SkillUpdate,
} from "@ai-office/shared";

import { SkillError } from "./errors.ts";
import type { SkillRepository } from "./git.ts";
import type { SkillChanges, SkillRecord, SkillStore } from "./store.ts";

// The office Skill library (PRD §6.14, FR-71, FR-72, FR-76): Skills in the
// Agent Skills format, added by upload, by import from a Git repository,
// or in the editor, then edited, turned on and off, and removed.
//
// Skills are instructions that reach models, so they are trusted input.
// One written in the editor is the Owner's own and starts enabled. One
// uploaded or imported from Git starts disabled, and is enabled only by a
// review: the Owner reads its full contents and confirms, naming their
// digest, so the review covers exactly what was read. Every add, change
// and removal is an event, for the Activity Feed.

export interface SkillLibrary {
  /** By name. */
  list(): Promise<SkillRecord[]>;
  get(id: string): Promise<SkillRecord>;
  /** Adds an uploaded Skill, or one written in the editor. */
  add(request: AddSkillRequest): Promise<SkillRecord>;
  /** Imports a Skill from a Git repository. It starts disabled. */
  importFromGit(
    request: ImportSkillRequest,
    signal?: AbortSignal,
  ): Promise<SkillRecord>;
  /** Replaces a Skill's files, or turns it on or off. */
  update(
    id: string,
    update: {
      readonly files?: SkillUpdate["files"] | readonly SkillFile[];
      readonly enabled?: SkillUpdate["enabled"];
    },
  ): Promise<SkillRecord>;
  /**
   * Records that the Owner reviewed the Skill's full contents, and enables
   * it. Refused if its files no longer have `digest`.
   */
  review(id: string, digest: string): Promise<SkillRecord>;
  remove(id: string): Promise<void>;
}

export interface SkillLibraryOptions {
  readonly store: SkillStore;
  readonly events: Pick<EventBus, "publish">;
  /** Where Skills are imported from; without one, imports are refused. */
  readonly repository?: SkillRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** `SKILL.md` first, then by path; each file only its path and content. */
const inOrder = (files: readonly SkillFile[]): SkillFile[] =>
  skillFilesInOrder(files.map(({ path, content }) => ({ path, content })));

/** The SHA-256 of a Skill's files (in order), in hex. */
export const skillDigest = (files: readonly SkillFile[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        inOrder(files).map(({ path, content }) => [path, content]),
      ),
    )
    .digest("hex");

const invalid = (problems: readonly string[]): SkillError =>
  new SkillError(
    skillErrorCodes.invalidSkill,
    "That is not a valid Skill.",
    problems,
  );

export function createSkillLibrary(options: SkillLibraryOptions): SkillLibrary {
  const { store, events } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const notFound = (id: string) =>
    new SkillError(skillErrorCodes.skillNotFound, `There is no Skill "${id}".`);

  const nameTaken = (name: string) =>
    new SkillError(
      skillErrorCodes.skillNameTaken,
      `The library already has a Skill called "${name}".`,
    );

  const get = async (id: string): Promise<SkillRecord> => {
    const skill = await store.get(id);
    if (skill === undefined) {
      throw notFound(id);
    }
    return skill;
  };

  const changed = (
    skill: SkillRecord,
    change: "edited" | "reviewed" | "enabled" | "disabled",
  ) =>
    events.publish({
      type: "skill.changed",
      version: 1,
      skillId: skill.id,
      name: skill.name,
      change,
    });

  /** Stores a new Skill from files already checked by `skillProblems`. */
  const addChecked = async (
    files: readonly SkillFile[],
    source: SkillSource,
    origin: SkillRecord["origin"],
  ): Promise<SkillRecord> => {
    const { name, description } = describeSkill(files);
    const at = now();
    const imported = importedSkillSources.includes(source);
    const ordered = inOrder(files);
    const skill: SkillRecord = {
      id: newId(),
      name,
      description,
      source,
      origin,
      files: ordered,
      digest: skillDigest(ordered),
      // The Owner wrote it here, so has read it; anything else waits.
      enabled: !imported,
      reviewedAt: imported ? null : at,
      createdAt: at,
      updatedAt: at,
    };
    if ((await store.add(skill)) === "name_taken") {
      throw nameTaken(name);
    }
    await events.publish({
      type: "skill.added",
      version: 1,
      skillId: skill.id,
      name,
      source,
      enabled: skill.enabled,
    });
    return skill;
  };

  /** Applies `changes`, or explains why they could not be. */
  const apply = async (
    id: string,
    changes: SkillChanges,
    ifDigest?: string,
  ): Promise<SkillRecord> => {
    const updated = await store.update(id, changes, ifDigest);
    if (updated === undefined) {
      throw notFound(id);
    }
    if (updated === "name_taken") {
      throw nameTaken(changes.name ?? "");
    }
    if (updated === "changed") {
      throw new SkillError(
        skillErrorCodes.skillChanged,
        "The Skill changed after the contents you reviewed. Review it again.",
      );
    }
    return updated;
  };

  return {
    list: () => store.list(),

    get,

    async add(request) {
      const parsed = addSkillRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw invalid(parsed.error.issues.map(({ message }) => message));
      }
      return addChecked(parsed.data.files, parsed.data.source, null);
    },

    async importFromGit(request, signal) {
      if (options.repository === undefined) {
        throw new SkillError(
          skillErrorCodes.importFailed,
          "Importing Skills from Git is not available here.",
        );
      }
      const fetched = await options.repository(request, signal);
      const problems = skillProblems(fetched.files, {
        folder: fetched.folder,
      });
      if (problems.length > 0) {
        throw new SkillError(
          skillErrorCodes.invalidSkill,
          "The repository's Skill cannot be imported.",
          problems,
        );
      }
      return addChecked(fetched.files, "git", {
        url: request.url,
        ref: request.ref ?? null,
        commit: fetched.commit,
        path: fetched.path,
      });
    },

    async update(id, update) {
      let skill = await get(id);
      if (update.files !== undefined) {
        const parsed = skillFilesSchema.safeParse(update.files);
        if (!parsed.success) {
          throw invalid(parsed.error.issues.map(({ message }) => message));
        }
        const files = inOrder(parsed.data);
        const digest = skillDigest(files);
        if (digest !== skill.digest) {
          const { name, description } = describeSkill(files);
          // The Owner's own edit: a reviewed Skill stays reviewed, and an
          // imported one not yet reviewed still waits for its review.
          skill = await apply(id, {
            name,
            description,
            files,
            digest,
            updatedAt: now(),
          });
          await changed(skill, "edited");
        }
      }
      if (update.enabled !== undefined && update.enabled !== skill.enabled) {
        if (update.enabled && skill.reviewedAt === null) {
          throw new SkillError(
            skillErrorCodes.skillNotReviewed,
            `Review "${skill.name}" before enabling it: it was ${skill.source === "git" ? "imported from Git" : "uploaded"}, so its full contents are read first.`,
          );
        }
        skill = await apply(id, { enabled: update.enabled, updatedAt: now() });
        await changed(skill, update.enabled ? "enabled" : "disabled");
      }
      return skill;
    },

    async review(id, digest) {
      await get(id);
      const at = now();
      const skill = await apply(
        id,
        { enabled: true, reviewedAt: at, updatedAt: at },
        digest,
      );
      await changed(skill, "reviewed");
      return skill;
    },

    async remove(id) {
      const skill = await store.remove(id);
      if (skill === undefined) {
        throw notFound(id);
      }
      await events.publish({
        type: "skill.removed",
        version: 1,
        skillId: skill.id,
        name: skill.name,
      });
    },
  };
}
