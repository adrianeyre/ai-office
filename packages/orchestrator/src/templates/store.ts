import { floorTemplates, type Database } from "@ai-office/db";
import {
  floorTemplateFileSchema,
  ownerFloorTemplateSources,
  type FloorTemplateFile,
  type FloorTemplateOrigin,
  type OwnerFloorTemplateSource,
} from "@ai-office/shared";
import { and, asc, eq } from "drizzle-orm";

// Where the Owner's own Floor Templates live (PRD FR-101): the
// `floor_templates` table, or memory for tests. Each is the files of its
// folder, as a built-in template's are; the built-in ones are never here.

/** One of the Owner's templates, as AI Office stores it. */
export interface OwnerTemplateRecord {
  readonly id: string;
  /** From its manifest; unique whatever its case. */
  readonly name: string;
  readonly source: OwnerFloorTemplateSource;
  /** Where in its Git repository it came from; null unless imported from Git. */
  readonly origin: FloorTemplateOrigin | null;
  /** Its whole folder: `template.yaml`, its Roles' files and its Skills'. */
  readonly files: readonly FloorTemplateFile[];
  /** The SHA-256 of `files`, which a review names. */
  readonly digest: string;
  /**
   * When the Owner reviewed it, which enables it; null for an imported
   * template not yet reviewed.
   */
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What can change about a template once it is stored. */
export interface OwnerTemplateChanges {
  readonly name?: string;
  readonly source?: OwnerFloorTemplateSource;
  readonly origin?: FloorTemplateOrigin | null;
  readonly files?: readonly FloorTemplateFile[];
  readonly digest?: string;
  readonly reviewedAt?: Date | null;
  readonly updatedAt: Date;
}

export interface FloorTemplateStore {
  /** By name. */
  list(): Promise<OwnerTemplateRecord[]>;
  get(id: string): Promise<OwnerTemplateRecord | undefined>;
  /** Adds a template, unless another one has its id or its name. */
  add(
    template: OwnerTemplateRecord,
  ): Promise<"added" | "id_taken" | "name_taken">;
  /**
   * Changes a template: undefined if there is none by that id,
   * `name_taken` if another one has the new name, and `changed` if
   * `ifDigest` is given and its files no longer have that digest.
   */
  update(
    id: string,
    changes: OwnerTemplateChanges,
    ifDigest?: string,
  ): Promise<OwnerTemplateRecord | "name_taken" | "changed" | undefined>;
  /** Deletes a template, answering with it; undefined if there was none. */
  remove(id: string): Promise<OwnerTemplateRecord | undefined>;
}

const byName = (a: OwnerTemplateRecord, b: OwnerTemplateRecord): number =>
  a.name.localeCompare(b.name);

/** Keeps the Owner's templates in memory: for tests. */
export function memoryFloorTemplateStore(): FloorTemplateStore & {
  readonly templates: Map<string, OwnerTemplateRecord>;
} {
  const all = new Map<string, OwnerTemplateRecord>();
  const copy = (template: OwnerTemplateRecord): OwnerTemplateRecord =>
    structuredClone(template);
  const nameTaken = (name: string, except?: string): boolean =>
    [...all.values()].some(
      (template) =>
        template.name.toLowerCase() === name.toLowerCase() &&
        template.id !== except,
    );
  return {
    templates: all,
    list() {
      return Promise.resolve([...all.values()].sort(byName).map(copy));
    },
    get(id) {
      const template = all.get(id);
      return Promise.resolve(
        template === undefined ? undefined : copy(template),
      );
    },
    add(template) {
      if (all.has(template.id)) {
        return Promise.resolve("id_taken");
      }
      if (nameTaken(template.name)) {
        return Promise.resolve("name_taken");
      }
      all.set(template.id, copy(template));
      return Promise.resolve("added");
    },
    update(id, changes, ifDigest) {
      const template = all.get(id);
      if (template === undefined) {
        return Promise.resolve(undefined);
      }
      if (ifDigest !== undefined && template.digest !== ifDigest) {
        return Promise.resolve("changed");
      }
      if (changes.name !== undefined && nameTaken(changes.name, id)) {
        return Promise.resolve("name_taken");
      }
      const updated = copy({ ...template, ...changes });
      all.set(id, updated);
      return Promise.resolve(copy(updated));
    },
    remove(id) {
      const template = all.get(id);
      all.delete(id);
      return Promise.resolve(template);
    },
  };
}

type FloorTemplateRow = typeof floorTemplates.$inferSelect;

const sourceOf = (source: string): OwnerFloorTemplateSource => {
  const known = ownerFloorTemplateSources.find((each) => each === source);
  if (known === undefined) {
    throw new Error(`A Floor Template has an unknown source, ${source}.`);
  }
  return known;
};

const toRecord = (row: FloorTemplateRow): OwnerTemplateRecord => ({
  id: row.id,
  name: row.name,
  source: sourceOf(row.source),
  origin:
    row.gitUrl === null || row.gitCommit === null || row.gitPath === null
      ? null
      : {
          url: row.gitUrl,
          ref: row.gitRef,
          commit: row.gitCommit,
          path: row.gitPath,
        },
  files: floorTemplateFileSchema.array().parse(row.files),
  digest: row.digest,
  reviewedAt: row.reviewedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The `floor_templates` columns of a template's origin. */
const originColumns = (origin: FloorTemplateOrigin | null) => ({
  gitUrl: origin?.url ?? null,
  gitRef: origin?.ref ?? null,
  gitCommit: origin?.commit ?? null,
  gitPath: origin?.path ?? null,
});

/** The unique constraint Postgres refused a row by, if it did. */
const refusedBy = (error: unknown): string | undefined => {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    const { code, constraint } = cause as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505" && typeof constraint === "string") {
      return constraint;
    }
  }
  return undefined;
};

/** Keeps the Owner's templates in the `floor_templates` table. */
export function databaseFloorTemplateStore(db: Database): FloorTemplateStore {
  const get = async (id: string): Promise<OwnerTemplateRecord | undefined> => {
    const [row] = await db
      .select()
      .from(floorTemplates)
      .where(eq(floorTemplates.id, id));
    return row === undefined ? undefined : toRecord(row);
  };

  return {
    async list() {
      const rows = await db
        .select()
        .from(floorTemplates)
        .orderBy(asc(floorTemplates.name));
      return rows.map(toRecord).sort(byName);
    },

    get,

    async add(template) {
      try {
        await db.insert(floorTemplates).values({
          id: template.id,
          name: template.name,
          source: template.source,
          ...originColumns(template.origin),
          files: template.files,
          digest: template.digest,
          reviewedAt: template.reviewedAt,
          createdAt: template.createdAt,
          updatedAt: template.updatedAt,
        });
        return "added";
      } catch (error) {
        const constraint = refusedBy(error);
        if (constraint === "floor_templates_name_unique") {
          return "name_taken";
        }
        if (constraint === "floor_templates_pkey") {
          return "id_taken";
        }
        throw error;
      }
    },

    async update(id, changes, ifDigest) {
      const { origin, ...rest } = changes;
      try {
        const [row] = await db
          .update(floorTemplates)
          .set({
            ...rest,
            ...(origin === undefined ? {} : originColumns(origin)),
          })
          .where(
            ifDigest === undefined
              ? eq(floorTemplates.id, id)
              : and(
                  eq(floorTemplates.id, id),
                  eq(floorTemplates.digest, ifDigest),
                ),
          )
          .returning();
        if (row !== undefined) {
          return toRecord(row);
        }
        return ifDigest !== undefined && (await get(id)) !== undefined
          ? "changed"
          : undefined;
      } catch (error) {
        if (refusedBy(error) === "floor_templates_name_unique") {
          return "name_taken";
        }
        throw error;
      }
    },

    async remove(id) {
      const [row] = await db
        .delete(floorTemplates)
        .where(eq(floorTemplates.id, id))
        .returning();
      return row === undefined ? undefined : toRecord(row);
    },
  };
}
