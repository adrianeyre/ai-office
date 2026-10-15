import { z } from "zod";

import { agentNameSchema, maxExtraInstructions } from "./agents.ts";
import { avatarSchema } from "./avatar.ts";
import { freshStartThresholdSchema } from "./context-usage.ts";
import {
  floorTemplateFilesSchema,
  floorTemplateOriginSchema,
  ownerFloorTemplateSources,
} from "./floor-template-library.ts";
import {
  floorSettingsSchema,
  defaultMostAgents,
  mostAgentsSchema,
  floorTemplateRefSchema,
  floorThemeSchema,
  templateIdSchema,
} from "./floors.ts";
import { gatewayRetrySettingsSchema } from "./gateway-retries.ts";
import { requestBodiesSettingsSchema } from "./gateway-requests.ts";
import { gitIdentitySchema } from "./git-identity.ts";
import { intakeSettingsSchema } from "./intake.ts";
import {
  loadBalancingSettingsSchema,
  usageThrottlingSettingsSchema,
} from "./load-balancing.ts";
import { maxMemoryEntryLength } from "./memory.ts";
import {
  maxOfficeMemoryLength,
  maxRoleMemoryEntries,
} from "./office-memory.ts";
import { modelNameSchema, modelPriceSchema } from "./pricing.ts";
import { promptCacheSettingsSchema } from "./prompt-cache.ts";
import { retentionSettingsSchema } from "./retention.ts";
import { createRoleRequestSchema } from "./role-library.ts";
import { managerRole, roleIdSchema } from "./roles.ts";
import { sandboxSettingsSchema } from "./sandboxes.ts";
import {
  sandboxRoles,
  skillFilesSchema,
  skillOriginSchema,
  skillSources,
} from "./skills.ts";
import { officeTokenCapsSchema, tokenCapsSchema } from "./token-caps.ts";

// Configuration export and import (PRD FR-65): everything the Owner has
// configured, as one JSON document, without a single credential: the
// office Role library (FR-98, FR-101) with it, so a Floor's Agents arrive
// with their Roles, and the Owner's own Floor Templates. AI
// Accounts, Gateway Keys, the password and TOTP are credentials or hold
// them, so they are never in it; nor is anything AI Office recorded
// rather than was told (requests, events, Notices, Batches). Importing a
// document is previewed first: what it adds and changes, and anything
// that stops it. An import adds and changes; it never removes.

/** What a document says it is, so another JSON file is not mistaken for one. */
export const configurationFormat = "ai-office.configuration";
export const configurationVersion = 1;

/**
 * A Role in the office Role library (FR-98), by its id: the built-in
 * Roles, those Floor Templates brought and the Owner's own.
 */
export const configurationRoleSchema = z
  .strictObject({
    id: roleIdSchema,
    ...createRoleRequestSchema.shape,
    /** Its suggested AI Provider; null for the office default. */
    aiProvider: z.string().min(1).max(100).nullable(),
  })
  .refine(({ model, aiProvider }) => !(model !== null && aiProvider === null), {
    error: "Suggest an AI Provider for the Model.",
  });
export type ConfigurationRole = z.infer<typeof configurationRoleSchema>;

/** One Agent on a Floor (FR-11), with its id, which a Floor's settings name. */
export const configurationAgentSchema = z.strictObject({
  id: z.string().min(1).max(100),
  name: agentNameSchema,
  /**
   * `manager`, or a Role's id: one in the document's Role library or,
   * when it is imported, in the office's.
   */
  role: z.union([z.literal(managerRole), roleIdSchema]),
  aiProvider: z.string().min(1).max(100),
  /** Its own Model; null for its AI Provider's default. */
  modelOverride: modelNameSchema.nullable(),
  effort: z.string().min(1).max(40).nullable(),
  extraInstructions: z.string().max(maxExtraInstructions),
  enabled: z.boolean(),
  avatar: avatarSchema,
  tokenCaps: tokenCapsSchema,
  /** Its own Fresh Start threshold (FR-86); null for its Floor's. */
  freshStartThreshold: freshStartThresholdSchema.nullable(),
});
export type ConfigurationAgent = z.infer<typeof configurationAgentSchema>;

/** A Floor: its repository, its settings (FR-7) and what hangs off it. */
export const configurationFloorSchema = floorSettingsSchema
  .extend({
    // A document exported before these settings takes their defaults.
    mostAgents: mostAgentsSchema.default(defaultMostAgents),
    spinOffFromChat: z.boolean().default(true),
    hourlyStatusUpdates: z.boolean().default(true),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, { error: "A Floor's id is a slug." }),
    githubRepositoryId: z.number().int().positive(),
    /** `owner/name` on GitHub. */
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    archived: z.boolean(),
    /** The Floor Template it started from (FR-97), as it was then. */
    template: floorTemplateRefSchema,
    /** The 3D theme it is dressed in. */
    theme: floorThemeSchema,
    /** Oldest first; the Manager among them. */
    agents: z.array(configurationAgentSchema),
    /** Issues' own Token Caps (FR-32). */
    issueTokenCaps: z.array(
      z.strictObject({
        issue: z.number().int().positive(),
        caps: tokenCapsSchema,
      }),
    ),
    /** Skills turned on or off for a Role (FR-75). */
    skillToggles: z.array(
      z.strictObject({
        skillName: z.string().min(1).max(64),
        role: z.enum(sandboxRoles),
        enabled: z.boolean(),
      }),
    ),
    /** Each Role's accepted memory entries (FR-55), oldest first. */
    roleMemory: z.array(
      z.strictObject({
        role: roleIdSchema,
        text: z.string().min(1).max(maxMemoryEntryLength),
        issue: z.number().int().positive(),
        agentId: z.string().min(1),
      }),
    ),
  })
  .superRefine((floor, context) => {
    const problem = (message: string) => {
      context.addIssue({ code: "custom", message });
    };
    const managers = floor.agents.filter(({ role }) => role === managerRole);
    if (managers.length !== 1) {
      problem(`${floor.id} has ${String(managers.length)} Managers, not 1.`);
    }
    const names = floor.agents.map(({ name }) => name);
    for (const name of new Set(names)) {
      if (names.filter((other) => other === name).length > 1) {
        problem(`${floor.id} has two Agents named ${name}.`);
      }
    }
    // Whether its Role is in the review Stage is for the document's Role
    // library to say, or the office's as it is imported.
    for (const id of floor.requiredReviewerAgentIds) {
      if (
        !floor.agents.some(
          (agent) => agent.id === id && agent.role !== managerRole,
        )
      ) {
        problem(
          `${floor.id} requires ${id}, which is not one of its reviewers.`,
        );
      }
    }
    for (const role of new Set(floor.roleMemory.map((entry) => entry.role))) {
      if (
        floor.roleMemory.filter((entry) => entry.role === role).length >
        maxRoleMemoryEntries
      ) {
        problem(
          `${floor.id}'s ${role} memory has more than ${String(maxRoleMemoryEntries)} entries.`,
        );
      }
    }
  });
export type ConfigurationFloor = z.infer<typeof configurationFloorSchema>;

/** A Skill in the office library (FR-71, FR-72), with its whole folder. */
export const configurationSkillSchema = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  source: z.enum(skillSources),
  origin: skillOriginSchema.nullable(),
  files: skillFilesSchema,
  /** Whether it was enabled where it was exported. */
  enabled: z.boolean(),
});
export type ConfigurationSkill = z.infer<typeof configurationSkillSchema>;

/**
 * One of the Owner's own Floor Templates (FR-101), with its whole folder:
 * its manifest, its Roles' files and its Skills'. The built-in ones ship
 * with AI Office, so they are not in it.
 */
export const configurationFloorTemplateSchema = z.strictObject({
  id: templateIdSchema,
  source: z.enum(ownerFloorTemplateSources),
  origin: floorTemplateOriginSchema.nullable(),
  files: floorTemplateFilesSchema,
  /** Whether it was enabled where it was exported. */
  enabled: z.boolean(),
});
export type ConfigurationFloorTemplate = z.infer<
  typeof configurationFloorTemplateSchema
>;

/** The office's own settings (FR-65), as they were in force. */
export const configurationOfficeSchema = z.strictObject({
  /** Who agent commits are by (FR-68); null for the default, the Owner. */
  gitIdentity: gitIdentitySchema.nullable(),
  intake: intakeSettingsSchema,
  sandboxes: sandboxSettingsSchema,
  requestBodies: requestBodiesSettingsSchema,
  loadBalancing: loadBalancingSettingsSchema,
  retries: gatewayRetrySettingsSchema,
  usageThrottling: usageThrottlingSettingsSchema,
  /** The TTL the Gateway gives prompt-cache breakpoints (§6.8). */
  promptCache: promptCacheSettingsSchema,
  tokenCaps: officeTokenCapsSchema,
  retention: retentionSettingsSchema,
});
export type ConfigurationOffice = z.infer<typeof configurationOfficeSchema>;

/** `GET /api/configuration/export`, and what an import takes. */
export const configurationSchema = z
  .strictObject({
    format: z.literal(configurationFormat, {
      error: "This is not an AI Office configuration export.",
    }),
    version: z.literal(configurationVersion, {
      error: `This AI Office reads configuration version ${String(configurationVersion)}.`,
    }),
    exportedAt: z.iso.datetime({ offset: true }),
    office: configurationOfficeSchema,
    /** Each AI Provider's default Model (FR-15). */
    aiProviders: z.array(
      z.strictObject({
        aiProvider: z.string().min(1).max(100),
        defaultModel: modelNameSchema,
      }),
    ),
    /** The Owner's own Model prices (FR-43). */
    modelPrices: z.array(
      z.strictObject({ model: modelNameSchema, price: modelPriceSchema }),
    ),
    /** The office-wide memory (FR-54), as Markdown. */
    officeMemory: z.string().max(maxOfficeMemoryLength),
    skills: z.array(configurationSkillSchema),
    /** The office Role library (FR-98), in its order. */
    roles: z.array(configurationRoleSchema),
    /**
     * The Owner's own Floor Templates (FR-101), by name; absent from
     * exports made before them.
     */
    floorTemplates: z.array(configurationFloorTemplateSchema).default([]),
    floors: z.array(configurationFloorSchema),
  })
  .superRefine((configuration, context) => {
    const duplicates = (what: string, values: readonly (string | number)[]) => {
      const seen = new Set<string | number>();
      for (const value of values) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `${what} ${String(value)} is in it twice.`,
          });
        }
        seen.add(value);
      }
    };
    duplicates(
      "The Floor",
      configuration.floors.map(({ id }) => id),
    );
    duplicates(
      "The repository",
      configuration.floors.map(({ githubRepositoryId }) => githubRepositoryId),
    );
    duplicates(
      "The Agent",
      configuration.floors.flatMap(({ agents }) => agents.map(({ id }) => id)),
    );
    duplicates(
      "The Skill",
      configuration.skills.map(({ name }) => name),
    );
    duplicates(
      "The Role",
      configuration.roles.map(({ id }) => id),
    );
    duplicates(
      "The Floor Template",
      configuration.floorTemplates.map(({ id }) => id),
    );
    duplicates(
      "The Role named",
      configuration.roles.map(({ name }) => name.toLowerCase()),
    );
    duplicates(
      "The AI Provider",
      configuration.aiProviders.map(({ aiProvider }) => aiProvider),
    );
    duplicates(
      "The Model price for",
      configuration.modelPrices.map(({ model }) => model),
    );
    // A required reviewer is an Agent in a review Stage Role (FR-27).
    for (const floor of configuration.floors) {
      for (const id of floor.requiredReviewerAgentIds) {
        const role = configuration.roles.find(
          (each) =>
            each.id === floor.agents.find((agent) => agent.id === id)?.role,
        );
        if (role !== undefined && role.stage !== "review") {
          context.addIssue({
            code: "custom",
            message: `${floor.id} requires ${id}, which is not one of its reviewers.`,
          });
        }
      }
    }
  });
export type Configuration = z.infer<typeof configurationSchema>;

/** What an import changes, a thing at a time. */
export const configurationAreas = [
  "office",
  "ai_provider",
  "model_price",
  "office_memory",
  "skill",
  "role",
  "floor_template",
  "floor",
  "agent",
  "issue_token_caps",
  "skill_toggle",
  "role_memory",
] as const;
export type ConfigurationArea = (typeof configurationAreas)[number];

export const configurationChangeSchema = z.object({
  area: z.enum(configurationAreas),
  /** What it is, such as `web-shop`, `web-shop: Ada` or `retries`. */
  subject: z.string(),
  /** `add`: it is not here yet; `change`: it is, and differs. */
  action: z.enum(["add", "change"]),
  /** Which of its fields change, for a change. */
  fields: z.array(z.string()),
  /** Anything the Owner should know, such as a Skill waiting for review. */
  note: z.string().nullable(),
});
export type ConfigurationChange = z.infer<typeof configurationChangeSchema>;

/**
 * `POST /api/configuration/import/preview` and `…/import`: what the import
 * changes (or changed), and what stops it. With a problem, nothing is
 * applied.
 */
export const configurationPreviewSchema = z.object({
  changes: z.array(configurationChangeSchema),
  problems: z.array(z.string()),
});
export type ConfigurationPreview = z.infer<typeof configurationPreviewSchema>;

export const configurationErrorCodes = {
  /** The import has problems, which its preview names; nothing changed. */
  configurationConflicts: "configuration_conflicts",
} as const;
