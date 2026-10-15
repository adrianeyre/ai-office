import { z } from "zod";

import {
  floorTemplateDescriptionSchema,
  floorTemplateIcons,
  floorTemplateLabelSchema,
  floorTemplateNameSchema,
  floorTemplateSummarySchema,
  templateManagerSchema,
  templateRoleSchema,
  templateSettingsSchema,
} from "./floor-templates.ts";
import { floorThemeSchema, templateIdSchema } from "./floors.ts";
import { roleDefinitionSchema } from "./roles.ts";
import {
  importSkillRequestSchema,
  skillDigestSchema,
  skillFileSchema,
  skillOriginSchema,
} from "./skills.ts";

// The Owner's own Floor Templates (PRD FR-101): in the office admin the
// Owner duplicates a template and edits it, saves a Floor's set-up as a
// new template, exports one with its Roles and Skills to a file, and
// imports one from a file or a Git repository. Built-in templates are
// read-only and can be duplicated.
//
// A template is the same thing wherever it comes from: the folder of files
// a built-in one is (`template.yaml`, `roles/<role>.md`,
// `skills/<skill>/…`). An export is those files in one JSON document, and
// a Git repository holds them as a folder; both are read by the same
// checks as the built-in templates. An Owner's template holds its own copy
// of its Roles and Skills, so it is whole when exported, and nothing
// depends on the libraries it was saved from.
//
// Role instructions and Skills reach models, so they are trusted input: an
// imported template is disabled until the Owner has read its full contents
// and enabled it, naming the digest of what was read (FR-76). The server
// and the web app share these.

/**
 * Where a template came from: shipped with AI Office, or the Owner's own,
 * duplicated from another template, saved from a Floor, or imported from
 * a file or a Git repository.
 */
export const floorTemplateSources = [
  "built-in",
  "duplicate",
  "floor",
  "file",
  "git",
] as const;
export type FloorTemplateSource = (typeof floorTemplateSources)[number];

/** The sources of the Owner's own templates, which AI Office stores. */
export const ownerFloorTemplateSources = [
  "duplicate",
  "floor",
  "file",
  "git",
] as const satisfies readonly FloorTemplateSource[];
export type OwnerFloorTemplateSource =
  (typeof ownerFloorTemplateSources)[number];

/** The sources whose templates wait for the Owner's review (FR-101). */
export const importedFloorTemplateSources: readonly FloorTemplateSource[] = [
  "file",
  "git",
];

/** Each source, as people read it. */
export const floorTemplateSourceLabels: Record<FloorTemplateSource, string> = {
  "built-in": "Built in",
  duplicate: "Duplicated",
  floor: "Saved from a Floor",
  file: "Imported from a file",
  git: "Imported from Git",
};

/** What an exported template's file says it is. */
export const floorTemplateBundleFormat = "ai-office.floor-template";
export const floorTemplateBundleVersion = 1;
/** The most files a template holds, Skills' files included. */
export const maxFloorTemplateFiles = 500;
/** The most bytes a template's files hold together. */
export const maxFloorTemplateBytes = 8_000_000;

/** One file of a template's folder, by its path in the folder. */
export const floorTemplateFileSchema = z.strictObject({
  path: z
    .string({ error: "A file's path is text." })
    .min(1, { error: "Give each file its path." })
    .max(500, { error: "That file's path is too long." }),
  content: z.string({ error: "A file holds text." }),
});
export type FloorTemplateFile = z.infer<typeof floorTemplateFileSchema>;

/** A template's folder: each file once, within the limits. */
export const floorTemplateFilesSchema = z
  .array(floorTemplateFileSchema)
  .min(1, { error: "A Floor Template has at least its template.yaml." })
  .max(maxFloorTemplateFiles, {
    error: `A Floor Template holds at most ${String(maxFloorTemplateFiles)} files.`,
  })
  .refine(
    (files) => new Set(files.map(({ path }) => path)).size === files.length,
    { error: "Each file is in a Floor Template once." },
  )
  .refine(
    (files) =>
      files.reduce(
        (bytes, { content }) =>
          bytes + new TextEncoder().encode(content).length,
        0,
      ) <= maxFloorTemplateBytes,
    {
      error: `A Floor Template's files hold at most ${String(maxFloorTemplateBytes / 1_000_000)} MB.`,
    },
  );

/**
 * An exported template (`GET /api/floor-templates/:id/export`): its folder
 * of files, Roles and Skills included, in one JSON document.
 */
export const floorTemplateBundleSchema = z.strictObject({
  format: z.literal(floorTemplateBundleFormat, {
    error: "This is not an exported AI Office Floor Template.",
  }),
  version: z.literal(floorTemplateBundleVersion, {
    error: `This AI Office reads Floor Template version ${String(floorTemplateBundleVersion)}.`,
  }),
  exportedAt: z.iso.datetime({ offset: true }),
  /** Its id where it was exported. */
  id: templateIdSchema,
  files: floorTemplateFilesSchema,
});
export type FloorTemplateBundle = z.infer<typeof floorTemplateBundleSchema>;

/** A digest of a template's files, in hex, which a review names. */
export const floorTemplateDigestSchema = skillDigestSchema;

/** Where a template imported from Git came from. */
export const floorTemplateOriginSchema = skillOriginSchema;
export type FloorTemplateOrigin = z.infer<typeof floorTemplateOriginSchema>;

/** A Skill a template brings, with its whole folder. */
export const floorTemplateSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  files: z.array(skillFileSchema),
});

/**
 * A template with its full contents (`GET /api/floor-templates/:id`):
 * every Role's instructions and every Skill's files, which the Owner reads
 * before enabling an imported one, and what clashes with the libraries.
 */
export const floorTemplateDetailSchema = floorTemplateSummarySchema.extend({
  source: z.enum(floorTemplateSources),
  /** For a template imported from Git; null otherwise. */
  origin: floorTemplateOriginSchema.nullable(),
  /** When the Owner enabled it; null for an imported one not yet reviewed. */
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  /** The SHA-256 of its files, which a review names. */
  digest: z.string(),
  /** Its Roles as it holds them, in its order, with their counts. */
  roles: z.array(
    z.object({ role: roleDefinitionSchema, count: z.number().int().min(0) }),
  ),
  settings: templateSettingsSchema,
  manager: templateManagerSchema,
  labels: z.array(floorTemplateLabelSchema),
  skills: z.array(floorTemplateSkillSchema),
  /**
   * Where its Roles and Skills meet the libraries' of the same id or name:
   * which a Floor from it gets, or what stops a Floor being added.
   */
  clashes: z.array(z.string()),
  /** Null for a built-in template. */
  createdAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type FloorTemplateDetail = z.infer<typeof floorTemplateDetailSchema>;

/**
 * The body of `POST /api/floor-templates/:id/duplicate`: the copy's name,
 * "<its name> copy" when absent.
 */
export const duplicateFloorTemplateRequestSchema = z.strictObject({
  name: floorTemplateNameSchema.optional(),
});
export type DuplicateFloorTemplateRequest = z.infer<
  typeof duplicateFloorTemplateRequestSchema
>;

/** The body of `POST /api/floor-templates`: a Floor's set-up, saved. */
export const saveFloorTemplateRequestSchema = z.strictObject({
  floorId: z.string({ error: "Name the Floor." }).min(1).max(100),
  name: floorTemplateNameSchema,
  description: floorTemplateDescriptionSchema,
  /** Its picker icon; the Floor's own template's when absent. */
  icon: z
    .enum(floorTemplateIcons, {
      error: `The icon is one of ${floorTemplateIcons.join(", ")}.`,
    })
    .optional(),
});
export type SaveFloorTemplateRequest = z.infer<
  typeof saveFloorTemplateRequestSchema
>;

/**
 * The body of `PATCH /api/floor-templates/:id`, for the Owner's own
 * templates: any of its parts. Its Roles are library Roles by id (or ones
 * it already holds), each copied in as the library has it.
 */
export const updateFloorTemplateRequestSchema = z
  .strictObject({
    name: floorTemplateNameSchema,
    description: floorTemplateDescriptionSchema,
    icon: z.enum(floorTemplateIcons, {
      error: `The icon is one of ${floorTemplateIcons.join(", ")}.`,
    }),
    theme: floorThemeSchema,
    roles: z.array(templateRoleSchema).max(20),
    settings: templateSettingsSchema,
    manager: templateManagerSchema,
    labels: z.array(floorTemplateLabelSchema).max(50),
  })
  .partial()
  .refine((update) => Object.keys(update).length > 0, {
    error: "Change at least one part of the template.",
  });
export type UpdateFloorTemplateRequest = z.infer<
  typeof updateFloorTemplateRequestSchema
>;

/**
 * The body of `POST /api/floor-templates/import`: an exported template's
 * file, and the name to import it under if not its own (when another
 * template has that name).
 */
export const importFloorTemplateRequestSchema = z.strictObject({
  bundle: floorTemplateBundleSchema,
  name: floorTemplateNameSchema.optional(),
});
export type ImportFloorTemplateRequest = z.infer<
  typeof importFloorTemplateRequestSchema
>;

/**
 * The body of `POST /api/floor-templates/import/git`: a public repository
 * over HTTPS holding a template's folder, the branch or tag (its default
 * branch when absent), the folder (absent: the repository's only
 * template), and the name to import it under if not its own.
 */
export const importFloorTemplateFromGitRequestSchema = z.strictObject({
  url: importSkillRequestSchema.shape.url,
  ref: importSkillRequestSchema.shape.ref,
  path: importSkillRequestSchema.shape.path,
  name: floorTemplateNameSchema.optional(),
});
export type ImportFloorTemplateFromGitRequest = z.infer<
  typeof importFloorTemplateFromGitRequestSchema
>;

/**
 * The body of `POST /api/floor-templates/:id/review`: the digest of the
 * contents the Owner read. If the template changed since, the review is
 * refused.
 */
export const reviewFloorTemplateRequestSchema = z.strictObject({
  digest: floorTemplateDigestSchema,
});
export type ReviewFloorTemplateRequest = z.infer<
  typeof reviewFloorTemplateRequestSchema
>;

/** Codes in the `error` field of the Floor Template API's errors. */
export const floorTemplateErrorCodes = {
  /** There is no Floor Template of that id. */
  templateNotFound: "template_not_found",
  /** A built-in template is read-only: duplicate it to change it. */
  templateBuiltIn: "template_built_in",
  /** Another Floor Template has that name. */
  templateNameTaken: "template_name_taken",
  /** What was sent, or read, is not a valid Floor Template. */
  invalidTemplate: "invalid_template",
  /** The template changed after the contents the Owner reviewed. */
  templateChanged: "template_changed",
  /** A Role to put in it is in neither the Role library nor the template. */
  roleNotFound: "role_not_found",
  /** The Floor to save does not exist. */
  floorNotFound: "floor_not_found",
  /** The repository could not be cloned, or importing is not available. */
  importFailed: "import_failed",
  /** The repository has no template where it was looked for. */
  noTemplateInRepository: "no_template_in_repository",
  /** The repository holds several templates: name the folder of one. */
  templatePathRequired: "template_path_required",
} as const;
export type FloorTemplateErrorCode =
  (typeof floorTemplateErrorCodes)[keyof typeof floorTemplateErrorCodes];
