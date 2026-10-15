import { z } from "zod";

import { avatarSchema } from "./avatar.ts";
import { freshStartThresholdSchema } from "./context-usage.ts";
import { agentModelSchema } from "./decision-model.ts";
import { maxMostAgents } from "./floors.ts";
import { managerRole, roleIdSchema, stages } from "./roles.ts";
import { tokenCapSchema, tokenCapsSchema } from "./token-caps.ts";

// Agents and Roles (PRD §6.3), as the API sends them. The server, the web
// app and the event schema share these.

/**
 * The Role an Agent fills: a library Role's id (FR-98), or `manager` for
 * the Manager, which is built in. A Floor may have several of one Role.
 */
export type Role = string;

/** Every new Floor starts with these (FR-10). */
export const defaultTeamRoles: readonly Role[] = [
  managerRole,
  "coder",
  "reviewer",
  "qa",
];

/**
 * The AI Providers (FR-15): the first four, then those the AI Gateway has
 * come to support (FR-35): OpenRouter, DeepSeek, Z.ai, Minimax and Kimi,
 * each through an API key; Qwen, through its sign-in; Ollama, the Owner's
 * own server or Ollama Cloud; and any Anthropic-compatible or
 * OpenAI-compatible endpoint, whatever Models it serves.
 */
export const aiProviders = [
  "Claude",
  "ChatGPT",
  "Grok",
  "Gemini",
  "OpenRouter",
  "DeepSeek",
  "Z.ai",
  "Minimax",
  "Kimi",
  "Qwen",
  "Ollama",
  "Anthropic-compatible",
  "OpenAI-compatible",
] as const;
export type AiProvider = (typeof aiProviders)[number];

/**
 * An Agent's AI Provider when the Owner lets it use whichever is available
 * (FR-11): when a task starts, the AI Provider of the first usable AI
 * Account, in priority order, whose AI Provider has a default Model. It
 * then uses that AI Provider's default Model and effort.
 */
export const anyAiProvider = "Any AI Provider";

/** The AI Providers an Agent may be given: each one, or any of them. */
export const agentAiProviders = [...aiProviders, anyAiProvider] as const;
export type AgentAiProvider = (typeof agentAiProviders)[number];

/** The AI Provider a new Floor's Agents use. */
export const defaultAiProvider: AiProvider = "Claude";

/**
 * Each AI Provider's default Model until the Owner chooses one from the AI
 * Gateway's live model catalogue in the office admin (FR-15): Claude's, so
 * a new Floor's team works from the start. Another AI Provider has none
 * until the Owner chooses one, and no Agent can use it before then.
 */
export const initialDefaultModels: Partial<Record<AiProvider, string>> = {
  Claude: "claude-opus-5-5",
};

/**
 * The effort or reasoning levels each AI Provider's agent tool takes
 * (FR-11, FR-16), lowest first; empty where it takes none.
 */
export const aiProviderEfforts: Record<AiProvider, readonly string[]> = {
  Claude: ["low", "medium", "high", "xhigh", "max"],
  ChatGPT: ["minimal", "low", "medium", "high"],
  Grok: [],
  Gemini: [],
  OpenRouter: [],
  DeepSeek: [],
  "Z.ai": [],
  Minimax: [],
  Kimi: [],
  Qwen: [],
  Ollama: [],
  "Anthropic-compatible": [],
  "OpenAI-compatible": [],
};

/** The effort levels an AI Provider's agent tool takes; none for an unknown one. */
export const effortsOf = (aiProvider: string): readonly string[] =>
  (aiProviderEfforts as Partial<Record<string, readonly string[]>>)[
    aiProvider
  ] ?? [];

/** An Agent's name: unique on its Floor. */
export const agentNameSchema = z
  .string({ error: "Name the Agent." })
  .trim()
  .min(1, { error: "Name the Agent." })
  .max(40, { error: "Use at most 40 characters for the name." })
  .regex(/^[^\p{Cc}]*$/u, { error: "Use one line for the name." });

/** The most characters an Agent's extra instructions may have. */
export const maxExtraInstructions = 4000;

const tokenCap = tokenCapSchema;

/**
 * What a Contractor does for its Batch (ADR 0004): changes the repository
 * in the work Stage, or researches without changing anything.
 */
export const contractorKinds = ["work", "research"] as const;
export type ContractorKind = (typeof contractorKinds)[number];

/**
 * What makes an Agent a Contractor (FR-10, FR-24): an Agent the Manager
 * added for one Batch, which leaves once no running Batch needs it, unless
 * the Owner keeps it on the team.
 */
export const contractorSchema = z.object({
  kind: z.enum(contractorKinds),
  /** The Batch it was added for; null for research, which has none. */
  batchId: z.number().int().positive().nullable(),
  /**
   * The one-off Role the Manager wrote for its task, which is in no Role
   * library and goes when it leaves; null when it fills a library Role.
   */
  oneOffRole: z
    .object({ name: z.string(), description: z.string() })
    .nullable(),
});
export type Contractor = z.infer<typeof contractorSchema>;

/** An Agent, as `GET /api/floors/:floorId/agents` lists it (FR-11). */
export const agentSchema = z.object({
  id: z.string(),
  floorId: z.string(),
  name: z.string(),
  /** Its Role: a library Role's id, or `manager`. */
  role: z.string(),
  /** Its Role's Stage (FR-98); null for the Manager. */
  stage: z.enum(stages).nullable(),
  /** One of `aiProviders`, or `anyAiProvider`. */
  aiProvider: z.string(),
  /**
   * The Model it uses: its own, or its AI Provider's default; empty with
   * any AI Provider, which is chosen when a task starts.
   */
  model: z.string(),
  /** Its own Model, overriding its AI Provider's default; null for none. */
  modelOverride: z.string().nullable(),
  /** Its effort or reasoning level; null for its AI Provider's default. */
  effort: z.string().nullable(),
  extraInstructions: z.string(),
  /** False while it is paused. */
  enabled: z.boolean(),
  avatar: avatarSchema,
  /** Overrides of its Floor's Token Caps; null uses the Floor's. */
  tokenCaps: z.object({ daily: tokenCap, monthly: tokenCap }),
  /**
   * The Context Usage, in percent, at which it makes a Fresh Start
   * (FR-86); null uses its Floor's.
   */
  freshStartThreshold: freshStartThresholdSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /**
   * Since when it has been leaving: the Owner removed it in the middle of
   * a task, which it finishes first (FR-10). Null while it stays.
   */
  leavingAt: z.iso.datetime({ offset: true }).nullable(),
  /** Null for an ordinary Agent; what it is there for, for a Contractor. */
  contractor: contractorSchema.nullable(),
});
export type Agent = z.infer<typeof agentSchema>;

/** The body of `GET /api/floors/:floorId/agents`. */
export const agentListSchema = z.object({ agents: z.array(agentSchema) });

/**
 * The body of `PATCH /api/floors/:floorId/agents/:agentId` (FR-11, FR-13):
 * any of these, applied from the Agent's next task (its Avatar at once). A
 * new AI Provider without a Model or effort of its own uses its default
 * for both.
 */
export const updateAgentRequestSchema = z
  .strictObject({
    name: agentNameSchema,
    /** One AI Provider, or `anyAiProvider` for whichever is available. */
    aiProvider: z.enum(agentAiProviders, { error: "Choose an AI Provider." }),
    /**
     * From the AI Provider's catalogue; null uses its default Model. Never
     * the Decision Model (FR-17).
     */
    modelOverride: agentModelSchema.nullable(),
    /** One of its AI Provider's `aiProviderEfforts`; null for the default. */
    effort: z.string().trim().min(1).max(20).nullable(),
    extraInstructions: z.string().max(maxExtraInstructions, {
      error: `Use at most ${String(maxExtraInstructions)} characters for the extra instructions.`,
    }),
    /** False pauses it: no new work goes to it. */
    enabled: z.boolean(),
    /** Its own Token Caps; null in a period uses its Floor's or the office's. */
    tokenCaps: tokenCapsSchema,
    /** Its own Fresh Start threshold in percent; null uses its Floor's. */
    freshStartThreshold: freshStartThresholdSchema.nullable(),
    /**
     * Its Avatar, from the Avatar Editor (FR-13): how it looks in the
     * Office, at once. It never changes how it works.
     */
    avatar: avatarSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    error: "Change at least one setting.",
  });
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

/**
 * The body of `POST /api/floors/:floorId/agents`: a new Agent in `role`,
 * copied from the Role's first Agent (FR-10), named `name` or at random.
 */
export const addAgentRequestSchema = z.strictObject({
  /** A library Role's id, or `manager` (refused: a Floor has its one). */
  role: z.union([z.literal(managerRole), roleIdSchema], {
    error: "Choose a Role.",
  }),
  name: agentNameSchema.optional(),
});
export type AddAgentRequest = z.infer<typeof addAgentRequestSchema>;

/**
 * The body of `PUT /api/floors/:floorId/team/:role`: its team size (FR-10),
 * which the Floor's "most Agents" limits, with every other Agent on it.
 */
export const teamSizeRequestSchema = z.strictObject({
  count: z
    .number({ error: "The team size is a whole number of Agents." })
    .int({ error: "The team size is a whole number of Agents." })
    .min(0, { error: "The team size is at least 0." })
    .max(maxMostAgents, {
      error: `The team size is at most ${maxMostAgents.toLocaleString("en-GB")}.`,
    }),
});
export type TeamSizeRequest = z.infer<typeof teamSizeRequestSchema>;

/**
 * What removing Agents did (FR-10), as `PUT /api/floors/:floorId/team/:role`
 * and `DELETE /api/floors/:floorId/agents/:agentId` answer it.
 */
export const teamChangeSchema = z.object({
  /** Agents added, each copied from its Role's first Agent. */
  added: z.array(agentSchema),
  /** Idle Agents, removed at once. */
  removed: z.array(agentSchema),
  /** Agents in the middle of a task, removed once it ends. */
  leaving: z.array(agentSchema),
});
export type TeamChange = z.infer<typeof teamChangeSchema>;

/** Codes in the `error` field of the Agent API's errors. */
export const agentErrorCodes = {
  /** The Floor has its Manager: there is exactly one per Floor. */
  managerExists: "manager_exists",
  /** A Floor's Manager is never removed: there is exactly one per Floor. */
  managerNotRemovable: "manager_not_removable",
  /** Another Agent on the Floor has that name. */
  nameTaken: "agent_name_taken",
  /** The office Role library has no such Role. */
  roleNotFound: "role_not_found",
  /** The AI Provider has no default Model yet: no Agent can use it. */
  modelRequired: "model_required",
  /** The Floor has no Agent by that id. */
  agentNotFound: "agent_not_found",
  /** The Model is not in the AI Provider's catalogue. */
  modelNotInCatalogue: "model_not_in_catalogue",
  /** The AI Provider's agent tool takes no such effort level. */
  effortNotSupported: "effort_not_supported",
  /** The Floor has as many Agents as its "most Agents" allows (FR-10). */
  mostAgentsReached: "most_agents_reached",
  /** The Agent is not a Contractor, so there is nothing to keep. */
  notAContractor: "not_a_contractor",
} as const;
export type AgentErrorCode =
  (typeof agentErrorCodes)[keyof typeof agentErrorCodes];
