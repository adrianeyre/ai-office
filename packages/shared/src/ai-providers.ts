import { z } from "zod";

import { agentTools, aiAccountTypes, type AgentTool } from "./ai-accounts.ts";
import { aiProviders, type AiProvider } from "./agents.ts";
import { agentModelSchema } from "./decision-model.ts";

// The AI Providers in the office admin (PRD FR-15, FR-41): each with the
// agent tool it runs in sandboxes (FR-16) and the default Model the Owner
// chose for it from the AI Gateway's live model catalogue. The catalogue
// is each kind of AI Account's model list, fetched from its AI Provider
// on demand and once a day. An AI Provider with no default Model cannot be
// used by any Agent until it has one.

/** The agent tool each AI Provider runs in the sandbox (FR-16). */
export const aiProviderAgentTools: Record<AiProvider, AgentTool> = {
  Claude: "Claude Code",
  ChatGPT: "Codex",
  Grok: "opencode",
  Gemini: "opencode",
  OpenRouter: "opencode",
  DeepSeek: "opencode",
  "Z.ai": "opencode",
  Minimax: "opencode",
  Kimi: "opencode",
  Qwen: "opencode",
  Ollama: "opencode",
  // Claude Code speaks Anthropic's Messages; opencode, OpenAI's formats.
  "Anthropic-compatible": "Claude Code",
  "OpenAI-compatible": "opencode",
};

/** One Model in the catalogue, as `GET /api/ai-providers` lists it. */
export const catalogueModelSchema = z.object({
  model: z.string(),
  /** How the AI Provider names it; null when it does not say. */
  displayName: z.string().nullable(),
  /** Its context window in tokens; null when the AI Provider does not say. */
  contextWindow: z.number().int().positive().nullable(),
  /** The kinds of AI Account that list it. */
  accountTypes: z.array(z.enum(aiAccountTypes)),
});
export type CatalogueModel = z.infer<typeof catalogueModelSchema>;

/** An AI Provider, as `GET /api/ai-providers` lists it. */
export const aiProviderSchema = z.object({
  aiProvider: z.enum(aiProviders),
  agentTool: z.enum(agentTools),
  /** Its default Model; null until the Owner chooses one. */
  defaultModel: z.string().nullable(),
  /** Its Models in the catalogue, by name. */
  models: z.array(catalogueModelSchema),
  /** When its Models were last fetched; null if never. */
  catalogueFetchedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Whether the Owner has an AI Account for it. */
  hasAccount: z.boolean().optional(),
  /** Why its AI Accounts' model list could not be read, the last time. */
  catalogueError: z.string().nullable().optional(),
});
export type AiProviderEntry = z.infer<typeof aiProviderSchema>;

/** The body of `GET /api/ai-providers`: in the order of `aiProviders`. */
export const aiProviderListSchema = z.object({
  aiProviders: z.array(aiProviderSchema),
});

/** The body of `PUT /api/ai-providers/:aiProvider`. */
export const setDefaultModelRequestSchema = z.strictObject({
  /** Never the Decision Model (FR-17): no Agent may use it. */
  defaultModel: agentModelSchema,
});
export type SetDefaultModelRequest = z.infer<
  typeof setDefaultModelRequestSchema
>;

/** What one refresh of the catalogue did, by kind of AI Account. */
export const catalogueRefreshSchema = z.object({
  refreshed: z.array(
    z.object({
      aiProvider: z.string(),
      accountType: z.enum(aiAccountTypes),
      /** How many Models it listed. */
      models: z.number().int().min(0),
    }),
  ),
  /** Kinds whose list could not be fetched: they keep their last one. */
  failed: z.array(
    z.object({
      aiProvider: z.string(),
      accountType: z.enum(aiAccountTypes),
      message: z.string(),
    }),
  ),
});
export type CatalogueRefresh = z.infer<typeof catalogueRefreshSchema>;

export const aiProviderErrorCodes = {
  aiProviderNotFound: "ai_provider_not_found",
  /** The Model is not in the AI Provider's catalogue: refresh it first. */
  modelNotInCatalogue: "model_not_in_catalogue",
} as const;
export type AiProviderErrorCode =
  (typeof aiProviderErrorCodes)[keyof typeof aiProviderErrorCodes];
