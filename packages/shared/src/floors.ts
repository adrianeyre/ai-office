import { z } from "zod";

import {
  defaultFreshStartThreshold,
  freshStartThresholdSchema,
} from "./context-usage.ts";
import { gitIdentitySchema } from "./git-identity.ts";
import { tokenCapSchema } from "./token-caps.ts";

// Floors and their settings (PRD §6.2), as the API sends and takes them.
// The server and the web app share these.

/** What happens to a pull request that passes its Review Loop (FR-29). */
export const mergePolicies = ["send_to_me", "auto_merge"] as const;
export type MergePolicy = (typeof mergePolicies)[number];

export const mergePolicyLabels: Record<MergePolicy, string> = {
  send_to_me: "Send to me",
  auto_merge: "Merge automatically",
};

/**
 * The labels that override a Floor's Merge Policy for one issue (FR-29).
 * With both, the issue goes to the Owner.
 */
export const mergePolicyOverrides = {
  auto_merge: "ai-office:auto-merge",
  send_to_me: "ai-office:manual",
} as const satisfies Record<MergePolicy, string>;

/** The action a "PR #N awaiting your approval" Notice offers (FR-48). */
export const mergeActions = {
  /** The GitHub App merges the pull request, as the Owner approved it. */
  approveAndMerge: "approve_and_merge",
} as const;

/** `owner/name` on GitHub. */
export const repositoryNameSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, { error: "Name a repository as owner/name." });

const tokenCap = tokenCapSchema;

/**
 * The most Agents a new Floor may have besides its Manager (FR-10): the
 * Owner's and the Manager's Contractors alike.
 */
export const defaultMostAgents = 8;
/** The highest "most Agents" a Floor may set, short of no limit. */
export const maxMostAgents = 1000;

/** A Floor's "most Agents" (FR-10): a whole number from 1, or null for no limit. */
export const mostAgentsSchema = z
  .number({ error: "Most Agents is a whole number of Agents, or no limit." })
  .int({ error: "Most Agents is a whole number of Agents, or no limit." })
  .min(1, { error: "Most Agents is at least 1." })
  .max(maxMostAgents, {
    error: `Most Agents is at most ${maxMostAgents.toLocaleString("en-GB")}, or no limit.`,
  })
  .nullable();

/** A Floor's settings (FR-7), with their limits. */
export const floorSettingsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Give the Floor a name." })
    .max(100, { error: "Use at most 100 characters for the name." }),
  defaultBranch: z
    .string()
    .trim()
    .min(1, { error: "Name the default branch." })
    .max(255, { error: "Use at most 255 characters for the branch." })
    .regex(/^[^\s~^:?*[\\]+$/, {
      error: "That is not a branch name Git allows.",
    }),
  /** Run in the sandbox before work starts; empty for none. */
  setupCommand: z
    .string()
    .max(4000, { error: "Use at most 4000 characters for a command." }),
  /** Run in the sandbox to test the work; empty for none. */
  testCommand: z
    .string()
    .max(4000, { error: "Use at most 4000 characters for a command." }),
  mergePolicy: z.enum(mergePolicies, {
    error: "The Merge Policy is send_to_me or auto_merge.",
  }),
  roundCap: z
    .number({ error: "The Round Cap is a whole number of rounds." })
    .int({ error: "The Round Cap is a whole number of rounds." })
    .min(1, { error: "The Round Cap is at least 1." })
    .max(10, { error: "The Round Cap is at most 10." }),
  /** Overrides of the office's Token Caps; null uses the office's. */
  tokenCaps: z.object({ daily: tokenCap, monthly: tokenCap }),
  /** A lower limit on this Floor's running sandboxes; null for none. */
  concurrencyLimit: z
    .number({ error: "The concurrency limit is a whole number." })
    .int({ error: "The concurrency limit is a whole number." })
    .min(1, { error: "The concurrency limit is at least 1." })
    .max(100, { error: "The concurrency limit is at most 100." })
    .nullable(),
  /** Its work starts before lower-priority Floors' (FR-22's queue). */
  priority: z
    .number({ error: "The priority is a whole number from 0 to 10." })
    .int({ error: "The priority is a whole number from 0 to 10." })
    .min(0, { error: "The priority is at least 0." })
    .max(10, { error: "The priority is at most 10." }),
  /** The reviewer Agents every Review Loop round needs (FR-27). */
  requiredReviewerAgentIds: z.array(z.string().min(1)),
  /** Whether work waits for the Owner to approve the Plan (FR-25). */
  planApproval: z.boolean(),
  /**
   * The most Agents the Floor may have besides its Manager, the Owner's
   * and Contractors alike (FR-10); null for no limit.
   */
  mostAgents: mostAgentsSchema,
  /**
   * Whether the Manager turns the Owner's chat requests into Batches,
   * filing their issues and adding Contractors (FR-24, ADR 0004); off, it
   * only talks and takes typed commands.
   */
  spinOffFromChat: z.boolean(),
  /**
   * Whether the Floor gives a Status update every hour while its Agents
   * work (FR-23a); off, only the Owner's and the day's own.
   */
  hourlyStatusUpdates: z.boolean(),
  /**
   * The Context Usage, in percent, at which a sandbox Agent makes a Fresh
   * Start (FR-86); an Agent's own overrides it.
   */
  freshStartThreshold: freshStartThresholdSchema,
  /** Who this Floor's commits are by (FR-68); null uses the office's. */
  gitIdentity: gitIdentitySchema.nullable(),
});
export type FloorSettings = z.infer<typeof floorSettingsSchema>;

/** A new Floor's settings, apart from its name and default branch. */
export const defaultFloorSettings = {
  setupCommand: "",
  testCommand: "",
  mergePolicy: "send_to_me",
  roundCap: 3,
  tokenCaps: { daily: null, monthly: null },
  concurrencyLimit: null,
  priority: 0,
  requiredReviewerAgentIds: [],
  planApproval: true,
  mostAgents: defaultMostAgents,
  spinOffFromChat: true,
  hourlyStatusUpdates: true,
  freshStartThreshold: defaultFreshStartThreshold,
  gitIdentity: null,
} as const satisfies Omit<FloorSettings, "name" | "defaultBranch">;

/**
 * A Floor Template's id: its folder's name under `templates/`, such as
 * `development` (PRD FR-97, FR-100).
 */
export const templateIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    error:
      "A Floor Template's id is lowercase letters and digits, joined by hyphens.",
  })
  .max(40, { error: "A Floor Template's id is at most 40 characters." });

/**
 * The 3D themes a Floor can be dressed in (PRD FR-57, FR-99): a Floor
 * Template names one, and a Floor added from it keeps it. Decoration only:
 * nothing but the 3D Office reads it. Each is drawn from its own props,
 * which are data in the web app (`apps/web/src/scene/floor-themes.ts`).
 */
export const floorThemes = [
  "office",
  "stockroom",
  "studio",
  "editorial",
  "library",
  "atelier",
  "observatory",
  "data-centre",
  "device-lab",
] as const;
export type FloorTheme = (typeof floorThemes)[number];

/** A Floor's 3D theme, by its id. */
export const floorThemeSchema = z.enum(floorThemes, {
  error: `The 3D theme is one of ${floorThemes.join(", ")}.`,
});

/**
 * The theme of Development, and so of Floors added before Floor Templates
 * or without one: the office every Floor had before themes.
 */
export const defaultFloorTheme: FloorTheme = "office";

/**
 * The Floor Template a Floor is added from when none is chosen, and that
 * Floors added before Floor Templates count as (FR-97).
 */
export const developmentTemplateId = "development";

/**
 * The Floor Template a Floor started from, as it was then: the Floor shows
 * it, and nothing else about the Floor depends on it (FR-97).
 */
export const floorTemplateRefSchema = z.object({
  id: templateIdSchema,
  name: z.string().min(1),
});
export type FloorTemplateRef = z.infer<typeof floorTemplateRefSchema>;

/** Development, as Floors added before Floor Templates record it. */
export const developmentTemplateRef: FloorTemplateRef = {
  id: developmentTemplateId,
  name: "Development",
};

/** A Floor, as `GET /api/floors/:floorId` returns it. */
export const floorSchema = floorSettingsSchema.extend({
  id: z.string(),
  /** `owner/name` on GitHub. */
  repository: z.string(),
  githubRepositoryId: z.number().int(),
  /** The Floor Template it started from. */
  template: floorTemplateRefSchema,
  /** The 3D theme it is dressed in, its template's when it was added. */
  theme: floorThemeSchema,
  createdAt: z.iso.datetime({ offset: true }),
  /** When it was archived; null while it is in use. */
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Floor = z.infer<typeof floorSchema>;

/**
 * The body of `GET`, and of `POST`, `/api/floors/:floorId/stop` and
 * `/api/floors/:floorId/continue`: whether the Owner stopped everything on
 * the Floor from the Meeting Room, and since when; null while it works.
 */
export const floorStopSchema = z.object({
  stoppedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type FloorStopState = z.infer<typeof floorStopSchema>;

/** The body of `GET /api/floors`: the Floors in use, not archived ones. */
export const floorListSchema = z.object({ floors: z.array(floorSchema) });

/** The body of `POST /api/floors`. */
export const addFloorRequestSchema = z.object({
  repository: repositoryNameSchema,
  /** The Floor Template to set it up from; Development when absent. */
  template: templateIdSchema.optional(),
});
export type AddFloorRequest = z.infer<typeof addFloorRequestSchema>;

/** The most characters a Floor's name may have when the Owner chooses it. */
export const maxFloorNameLength = 60;

/**
 * A Floor's name as the Owner chooses it (FR-7): what the Office shows
 * for the Floor everywhere, while its id, from its repository's name,
 * stays in its addresses. Trimmed, 1 to 60 characters, and unique among
 * the Floors in use whatever its case (the Floors check that).
 */
export const floorNameSchema = z
  .string({ error: "Give the Floor a name." })
  .trim()
  .min(1, { error: "Give the Floor a name." })
  .max(maxFloorNameLength, {
    error: `Use at most ${String(maxFloorNameLength)} characters for the name.`,
  });

/** Whether two Floors' names are the same, whatever their case. */
export const sameFloorName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase("en-GB") === b.trim().toLocaleLowerCase("en-GB");

/** The body of `PATCH /api/floors/:floorId`: the settings to change. */
export const floorSettingsUpdateSchema = floorSettingsSchema
  .extend({
    /** A new name (a rename), checked as the Owner chooses one. */
    name: floorNameSchema,
    /** Reviewer Agents on the Floor, at least one, each once (FR-27). */
    requiredReviewerAgentIds: z
      .array(z.string().min(1).max(100))
      .min(1, { error: "Choose at least one required reviewer." })
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        error: "Name each required reviewer once.",
      }),
  })
  .partial()
  .strict()
  .refine((update) => Object.keys(update).length > 0, {
    error: "Change at least one setting.",
  });
export type FloorSettingsUpdate = z.infer<typeof floorSettingsUpdateSchema>;

/** A repository the App is installed on, and its Floor if it has one. */
export const installedRepositorySchema = z.object({
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  floorId: z.string().nullable(),
});
export type InstalledRepository = z.infer<typeof installedRepositorySchema>;

/** The body of `GET /api/github/repositories`. */
export const installedRepositoryListSchema = z.object({
  repositories: z.array(installedRepositorySchema),
});

/** Codes in the `error` field of the Floor API's errors. */
export const floorErrorCodes = {
  /** No GitHub App or access token is set. */
  githubNotConfigured: "github_not_configured",
  /** GitHub could not be reached, or refused the App. */
  githubUnavailable: "github_unavailable",
  /** The App is not installed on that repository. */
  notInstalled: "repository_not_installed",
  /** The repository is already a Floor (perhaps an archived one). */
  floorExists: "floor_exists",
  floorNotFound: "floor_not_found",
  /** The Floor is archived, so it cannot be changed. */
  floorArchived: "floor_archived",
  /** Another Floor in use has that name, whatever its case. */
  floorNameTaken: "floor_name_taken",
  /** The repository has no branch of that name. */
  branchNotFound: "branch_not_found",
  /** A required reviewer is not one of the Floor's reviewer Agents. */
  notAReviewer: "not_a_reviewer",
  /** There is no Floor Template of that id. */
  templateNotFound: "template_not_found",
  /**
   * The Floor Template brings a Role whose name another Role in the
   * library has, under another id.
   */
  templateRoleNameTaken: "template_role_name_taken",
} as const;
export type FloorErrorCode =
  (typeof floorErrorCodes)[keyof typeof floorErrorCodes];
