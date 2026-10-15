import type { CatalogueEntry, ModelCatalogue } from "@ai-office/gateway";
import { AiProviderError, type AiProviders } from "@ai-office/orchestrator";
import {
  aiProviderAgentTools,
  aiProviderErrorCodes,
  aiProviderTakes,
  aiProviders as aiProviderNames,
  setDefaultModelRequestSchema,
  type AiProviderEntry,
  type AiProviderErrorCode,
  type ApiError,
  type CatalogueModel,
  type CatalogueRefresh,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The AI Providers API (PRD FR-15, FR-41), a thin adapter over the
// office's AI Providers and the Gateway's model catalogue: each AI
// Provider with its agent tool, its default Model and its Models in the
// catalogue; setting a default Model from the catalogue; and refreshing
// the catalogue now, as well as once a day. Every route needs a session.

const statusFor: Record<AiProviderErrorCode, number> = {
  [aiProviderErrorCodes.aiProviderNotFound]: 404,
  [aiProviderErrorCodes.modelNotInCatalogue]: 400,
};

/**
 * An AI Provider's Models in the catalogue, by name: those its kinds of AI
 * Account list, less any the Gateway would send to another AI Provider (a
 * compatible endpoint keeps every one it lists).
 */
export function catalogueModelsOf(
  entries: readonly CatalogueEntry[],
  aiProvider: string,
): { models: CatalogueModel[]; fetchedAt: Date | null } {
  const models = new Map<string, CatalogueModel>();
  let fetchedAt: Date | null = null;
  for (const entry of entries) {
    if (
      entry.aiProvider !== aiProvider ||
      !aiProviderTakes(aiProvider, entry.model)
    ) {
      continue;
    }
    if (fetchedAt === null || entry.fetchedAt > fetchedAt) {
      fetchedAt = entry.fetchedAt;
    }
    const known = models.get(entry.model);
    models.set(entry.model, {
      model: entry.model,
      displayName: known?.displayName ?? entry.displayName,
      contextWindow: known?.contextWindow ?? entry.contextWindow,
      accountTypes: [...(known?.accountTypes ?? []), entry.accountType],
    });
  }
  return {
    models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)),
    fetchedAt,
  };
}

/**
 * The Models an AI Provider's default, or an Agent's own, is chosen from:
 * those its catalogue lists.
 */
export const catalogueOf =
  (catalogue: Pick<ModelCatalogue, "list">) =>
  async (aiProvider: string): Promise<string[]> =>
    catalogueModelsOf(await catalogue.list(), aiProvider).models.map(
      ({ model }) => model,
    );

export function registerAiProviderRoutes(
  app: FastifyInstance,
  options: {
    readonly aiProviders: AiProviders;
    readonly catalogue: ModelCatalogue;
    /** The AI Providers the Owner has an AI Account for. */
    readonly withAccounts?: () => Promise<readonly string[]>;
  },
): void {
  const { aiProviders, catalogue } = options;
  const withAccounts = options.withAccounts ?? (() => Promise.resolve([]));

  app.get("/api/ai-providers", { config: { access: "owner" } }, async () => {
    const [defaults, entries, accounts] = await Promise.all([
      aiProviders.defaultModels(),
      catalogue.list(),
      withAccounts(),
    ]);
    const failures = catalogue.failures?.() ?? [];
    return {
      aiProviders: aiProviderNames.map((aiProvider): AiProviderEntry => {
        const { models, fetchedAt } = catalogueModelsOf(entries, aiProvider);
        return {
          aiProvider,
          agentTool: aiProviderAgentTools[aiProvider],
          defaultModel: defaults[aiProvider] ?? null,
          models,
          catalogueFetchedAt: fetchedAt?.toISOString() ?? null,
          hasAccount: accounts.includes(aiProvider),
          catalogueError:
            failures.find((failure) => failure.aiProvider === aiProvider)
              ?.message ?? null,
        };
      }),
    };
  });

  app.put<{ Params: { readonly aiProvider: string } }>(
    "/api/ai-providers/:aiProvider",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = setDefaultModelRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        await aiProviders.setDefaultModel(
          request.params.aiProvider,
          parsed.data.defaultModel,
        );
      } catch (error) {
        if (!(error instanceof AiProviderError)) {
          throw error;
        }
        const body: ApiError = { error: error.code, message: error.message };
        return reply.code(statusFor[error.code]).send(body);
      }
      request.log.info(
        { aiProvider: request.params.aiProvider },
        "An AI Provider's default Model was set.",
      );
      return reply.code(204).send();
    },
  );

  // Fetches every kind of AI Account's Models now (FR-41).
  app.post(
    "/api/model-catalogue/refresh",
    { config: { access: "owner" } },
    async (request): Promise<CatalogueRefresh> => {
      const report = await catalogue.refresh();
      for (const failed of report.failed) {
        request.log.warn(failed, "A model list could not be refreshed.");
      }
      // As the daily refresh does: an AI Provider with an AI Account but no
      // default Model gets the first its catalogue now lists (FR-15).
      await aiProviders.chooseMissingDefaults(await withAccounts());
      return report;
    },
  );
}
