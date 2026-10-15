import { z } from "zod";

import { aiProviders } from "./agents.ts";
import { modelNameSchema } from "./pricing.ts";
import {
  deskDressings,
  maxRoleInstructions,
  roleDefinitionSchema,
  roleIdSchema,
  stages,
} from "./roles.ts";
import { maxSkillNameLength, skillNamePattern } from "./skills.ts";

// The Role library's admin (PRD FR-98, FR-65), as the API sends it: the
// office's Roles with how many Agents fill each, and the bodies that
// create, duplicate, edit and delete one. Changing a Role changes every
// Agent with it, so the list says how many that is.

/** The most characters a Role's name may have. */
export const maxRoleNameLength = 40;

/** The most characters a Role's one-line routing description may have. */
export const maxRoleDescriptionLength = 200;

const roleNameSchema = z
  .string({ error: "Name the Role." })
  .trim()
  .min(1, { error: "Name the Role." })
  .max(maxRoleNameLength, {
    error: `Use at most ${String(maxRoleNameLength)} characters for the Role's name.`,
  })
  .regex(/^[^\p{Cc}]*$/u, { error: "Use one line for the Role's name." })
  .regex(/[\p{L}\p{N}]/u, {
    error: "Use at least one letter or digit in the Role's name.",
  })
  .refine((name) => name.toLowerCase() !== "manager", {
    error: "The Manager is built in, not a library Role.",
  });

/** A Role's fields as the Owner writes them; its id comes from its name. */
const roleFieldsShape = {
  name: roleNameSchema,
  stage: z.enum(stages, { error: "Choose a Stage: work, review, QA or docs." }),
  description: z
    .string({ error: "Describe the Role in one line." })
    .trim()
    .min(1, { error: "Describe the Role in one line." })
    .max(maxRoleDescriptionLength, {
      error: `Use at most ${String(maxRoleDescriptionLength)} characters for the description.`,
    })
    .regex(/^[^\p{Cc}]*$/u, { error: "Use one line for the description." }),
  instructions: z.string().max(maxRoleInstructions, {
    error: `Use at most ${String(maxRoleInstructions)} characters for the instructions.`,
  }),
  /** Skills from the office Skill library, by name, each once. */
  skills: z
    .array(
      z
        .string()
        .max(maxSkillNameLength)
        .regex(skillNamePattern, { error: "That is not a Skill's name." }),
    )
    .max(100)
    .refine((names) => new Set(names).size === names.length, {
      error: "Give each Skill once.",
    }),
  deskDressing: z.enum(deskDressings, { error: "Choose a desk dressing." }),
  /** The AI Provider a new Agent in it starts with; null for the office default. */
  aiProvider: z
    .enum(aiProviders, { error: "Choose an AI Provider." })
    .nullable(),
  /** From that AI Provider's catalogue; null for its default Model. */
  model: modelNameSchema.nullable(),
};

const modelNeedsProvider = {
  check: (role: {
    aiProvider?: string | null | undefined;
    model?: string | null | undefined;
  }) => !(role.model != null && role.aiProvider === null),
  message: "Suggest an AI Provider for the Model.",
};

/** The body of `POST /api/roles`: a new Role, its id made from its name. */
export const createRoleRequestSchema = z
  .strictObject(roleFieldsShape)
  .refine(modelNeedsProvider.check, { error: modelNeedsProvider.message });
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

/**
 * The body of `PATCH /api/roles/:roleId`: any of a Role's fields. It
 * changes every Agent with the Role, from each one's next task.
 */
export const updateRoleRequestSchema = z
  .strictObject(roleFieldsShape)
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    error: "Change at least one field.",
  })
  .refine(modelNeedsProvider.check, { error: modelNeedsProvider.message });
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

/** The body of `POST /api/roles/:roleId/duplicate`: its copy's name, if not "… copy". */
export const duplicateRoleRequestSchema = z.strictObject({
  name: roleNameSchema.optional(),
});
export type DuplicateRoleRequest = z.infer<typeof duplicateRoleRequestSchema>;

/** A Role as the Role library's admin lists it (`GET /api/roles`). */
export const roleSchema = roleDefinitionSchema.extend({
  /**
   * How many Agents fill it, on every Floor (leaving ones too): the
   * Agents a change to it reaches. A Role no Agent fills can be deleted.
   */
  agents: z.number().int().min(0),
  /**
   * Whether a Floor Template starts Floors with an Agent in it, which
   * keeps it in the library.
   */
  inStartingTeam: z.boolean(),
});
export type LibraryRole = z.infer<typeof roleSchema>;

/** The body of `GET /api/roles`. */
export const roleListSchema = z.object({ roles: z.array(roleSchema) });

/** Why a Role library change was refused. */
export const roleErrorCodes = {
  /** The library has no such Role. */
  roleNotFound: "role_not_found",
  /** What was sent is not a valid Role. */
  invalidRole: "invalid_role",
  /** Another Role in the library has that name. */
  roleNameTaken: "role_name_taken",
  /** Agents fill the Role, so it cannot be deleted. */
  roleInUse: "role_in_use",
  /**
   * A Floor Template starts Floors with an Agent in it, so it cannot be
   * deleted.
   */
  roleInStartingTeam: "role_in_starting_team",
  /**
   * Agents fill the Role, and their work is in its Stage: its Stage
   * changes only while no Agent fills it.
   */
  stageInUse: "role_stage_in_use",
  /** The office Skill library has no Skill of that name. */
  skillNotFound: "role_skill_not_found",
  /** The Model is not in the AI Provider's catalogue. */
  modelNotInCatalogue: "model_not_in_catalogue",
} as const;
export type RoleErrorCode =
  (typeof roleErrorCodes)[keyof typeof roleErrorCodes];

/**
 * A Role's id made from its name: lowercase letters and digits joined by
 * hyphens, at most 40 characters (`Brand reviewer` is `brand-reviewer`).
 * Never `manager`; `role` when the name has nothing to make one of.
 */
export function roleIdOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return roleIdSchema.safeParse(slug).success ? slug : "role";
}
