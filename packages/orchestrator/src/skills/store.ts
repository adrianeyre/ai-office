import { skills, type Database } from "@ai-office/db";
import {
  skillFileSchema,
  type SkillFile,
  type SkillOrigin,
  type SkillSource,
} from "@ai-office/shared";
import { and, asc, eq } from "drizzle-orm";

// Where the office Skill library lives (PRD FR-72): the `skills` table, or
// memory for tests.

/** A Skill as the library holds it. */
export interface SkillRecord {
  readonly id: string;
  /** From its `SKILL.md`'s frontmatter; unique in the library. */
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  /** Where in its Git repository it came from; null unless imported from Git. */
  readonly origin: SkillOrigin | null;
  /** Its whole folder, `SKILL.md` first, then by path. */
  readonly files: readonly SkillFile[];
  /** The SHA-256 of `files`, which a review names. */
  readonly digest: string;
  readonly enabled: boolean;
  /** When the Owner reviewed it; null for an imported Skill not yet reviewed. */
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What can change about a Skill once it is in the library. */
export interface SkillChanges {
  readonly name?: string;
  readonly description?: string;
  readonly files?: readonly SkillFile[];
  readonly digest?: string;
  readonly enabled?: boolean;
  readonly reviewedAt?: Date;
  readonly updatedAt: Date;
}

export interface SkillStore {
  /** By name. */
  list(): Promise<SkillRecord[]>;
  get(id: string): Promise<SkillRecord | undefined>;
  /** Adds a Skill, unless another one has its name. */
  add(skill: SkillRecord): Promise<"added" | "name_taken">;
  /**
   * Changes a Skill: undefined if there is none by that id, `name_taken`
   * if another one has the new name, and `changed` if `ifDigest` is given
   * and its files no longer have that digest.
   */
  update(
    id: string,
    changes: SkillChanges,
    ifDigest?: string,
  ): Promise<SkillRecord | "name_taken" | "changed" | undefined>;
  /** Deletes a Skill, answering with it; undefined if there was none. */
  remove(id: string): Promise<SkillRecord | undefined>;
}

const byName = (a: SkillRecord, b: SkillRecord): number =>
  a.name.localeCompare(b.name);

/** Keeps Skills in memory: for tests. */
export function memorySkillStore(): SkillStore & {
  readonly skills: Map<string, SkillRecord>;
} {
  const all = new Map<string, SkillRecord>();
  const copy = (skill: SkillRecord): SkillRecord => structuredClone(skill);
  const nameTaken = (name: string, except?: string): boolean =>
    [...all.values()].some(
      (skill) => skill.name === name && skill.id !== except,
    );
  return {
    skills: all,
    list() {
      return Promise.resolve([...all.values()].sort(byName).map(copy));
    },
    get(id) {
      const skill = all.get(id);
      return Promise.resolve(skill === undefined ? undefined : copy(skill));
    },
    add(skill) {
      if (all.has(skill.id)) {
        return Promise.reject(new Error(`Skill ${skill.id} exists.`));
      }
      if (nameTaken(skill.name)) {
        return Promise.resolve("name_taken");
      }
      all.set(skill.id, copy(skill));
      return Promise.resolve("added");
    },
    update(id, changes, ifDigest) {
      const skill = all.get(id);
      if (skill === undefined) {
        return Promise.resolve(undefined);
      }
      if (ifDigest !== undefined && skill.digest !== ifDigest) {
        return Promise.resolve("changed");
      }
      if (changes.name !== undefined && nameTaken(changes.name, id)) {
        return Promise.resolve("name_taken");
      }
      if (
        (changes.enabled ?? skill.enabled) &&
        (changes.reviewedAt ?? skill.reviewedAt) === null
      ) {
        // As the table's `skills_enabled_reviewed` check does.
        return Promise.reject(
          new Error("A Skill is enabled only once it is reviewed."),
        );
      }
      const updated = copy({ ...skill, ...changes });
      all.set(id, updated);
      return Promise.resolve(copy(updated));
    },
    remove(id) {
      const skill = all.get(id);
      all.delete(id);
      return Promise.resolve(skill);
    },
  };
}

type SkillRow = typeof skills.$inferSelect;

const toRecord = (row: SkillRow): SkillRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  source:
    row.source === "git"
      ? "git"
      : row.source === "upload"
        ? "upload"
        : row.source === "template"
          ? "template"
          : "editor",
  origin:
    row.gitUrl === null || row.gitCommit === null || row.gitPath === null
      ? null
      : {
          url: row.gitUrl,
          ref: row.gitRef,
          commit: row.gitCommit,
          path: row.gitPath,
        },
  files: skillFileSchema.array().parse(row.files),
  digest: row.digest,
  enabled: row.enabled,
  reviewedAt: row.reviewedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Whether `error` is Postgres refusing a second Skill of one name. */
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
    if (code === "23505" && constraint === "skills_name_unique") {
      return true;
    }
  }
  return false;
};

/** Keeps Skills in the `skills` table. */
export function databaseSkillStore(db: Database): SkillStore {
  const get = async (id: string): Promise<SkillRecord | undefined> => {
    const [row] = await db.select().from(skills).where(eq(skills.id, id));
    return row === undefined ? undefined : toRecord(row);
  };

  return {
    async list() {
      const rows = await db.select().from(skills).orderBy(asc(skills.name));
      return rows.map(toRecord);
    },

    get,

    async add(skill) {
      try {
        await db.insert(skills).values({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          gitUrl: skill.origin?.url ?? null,
          gitRef: skill.origin?.ref ?? null,
          gitCommit: skill.origin?.commit ?? null,
          gitPath: skill.origin?.path ?? null,
          files: skill.files,
          digest: skill.digest,
          enabled: skill.enabled,
          reviewedAt: skill.reviewedAt,
          createdAt: skill.createdAt,
          updatedAt: skill.updatedAt,
        });
        return "added";
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },

    async update(id, changes, ifDigest) {
      try {
        const [row] = await db
          .update(skills)
          .set(changes)
          .where(
            ifDigest === undefined
              ? eq(skills.id, id)
              : and(eq(skills.id, id), eq(skills.digest, ifDigest)),
          )
          .returning();
        if (row !== undefined) {
          return toRecord(row);
        }
        return ifDigest !== undefined && (await get(id)) !== undefined
          ? "changed"
          : undefined;
      } catch (error) {
        if (isNameTaken(error)) {
          return "name_taken";
        }
        throw error;
      }
    },

    async remove(id) {
      const [row] = await db
        .delete(skills)
        .where(eq(skills.id, id))
        .returning();
      return row === undefined ? undefined : toRecord(row);
    },
  };
}
