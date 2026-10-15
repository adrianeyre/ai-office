import { aiProviderSettings, type Database } from "@ai-office/db";
import type { EventBus } from "@ai-office/events";
import {
  aiProviderErrorCodes,
  aiProviders,
  initialDefaultModels,
  type AiProvider,
  type AiProviderErrorCode,
} from "@ai-office/shared";

// The AI Providers in the office admin (PRD FR-15): each one's default
// Model, chosen by the Owner from the AI Gateway's model catalogue (FR-41).
// Until the Owner chooses one, Claude's is `claude-opus-5-5` (so a new
// Floor's team works from the start) and the others have none; an AI
// Provider without a default Model cannot be used by any Agent.

/** Each AI Provider's default Model; absent for one with none yet. */
export type DefaultModels = Partial<Record<string, string>>;

/** Where the Owner's default Models live. */
export interface AiProviderSettingsStore {
  /** The default Models the Owner chose, by AI Provider. */
  defaultModels(): Promise<DefaultModels>;
  setDefaultModel(aiProvider: string, model: string, at: Date): Promise<void>;
}

/** Keeps the default Models in memory: for tests. */
export function memoryAiProviderSettingsStore(): AiProviderSettingsStore {
  const models = new Map<string, string>();
  return {
    defaultModels: () => Promise.resolve(Object.fromEntries(models)),
    setDefaultModel(aiProvider, model) {
      models.set(aiProvider, model);
      return Promise.resolve();
    },
  };
}

/** Keeps the default Models in the `ai_provider_settings` table. */
export function databaseAiProviderSettingsStore(
  db: Database,
): AiProviderSettingsStore {
  return {
    async defaultModels() {
      const rows = await db.select().from(aiProviderSettings);
      return Object.fromEntries(
        rows.map(({ aiProvider, defaultModel }) => [aiProvider, defaultModel]),
      );
    },
    async setDefaultModel(aiProvider, model, at) {
      const values = { defaultModel: model, updatedAt: at };
      await db
        .insert(aiProviderSettings)
        .values({ aiProvider, ...values })
        .onConflictDoUpdate({
          target: aiProviderSettings.aiProvider,
          set: values,
        });
    },
  };
}

/** Why an AI Provider's settings were not changed. */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;

  constructor(code: AiProviderErrorCode, message: string) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
  }
}

export interface AiProviders {
  /** Each AI Provider's default Model: the Owner's, or its initial one. */
  defaultModels(): Promise<DefaultModels>;
  /**
   * Sets an AI Provider's default Model: one its catalogue lists, or one
   * it does not list yet, but never another AI Provider's.
   * A `config.changed` event names the setting, never the Model.
   */
  setDefaultModel(aiProvider: string, model: string): Promise<void>;
  /**
   * Gives each of `withAccounts` (the AI Providers the Owner has an AI
   * Account for) that has no default Model the first Model its catalogue
   * lists, so its first AI Account makes it usable at once. The Owner can
   * choose another. Answers the AI Providers given one; one whose catalogue
   * lists nothing yet is left without.
   */
  chooseMissingDefaults(withAccounts: Iterable<string>): Promise<string[]>;
}

export interface AiProvidersOptions {
  readonly store: AiProviderSettingsStore;
  readonly events: Pick<EventBus, "publish">;
  /** The Models the AI Gateway's catalogue lists for an AI Provider. */
  readonly catalogue: (aiProvider: AiProvider) => Promise<readonly string[]>;
  readonly now?: () => Date;
}

export function createAiProviders(options: AiProvidersOptions): AiProviders {
  const { store, events, catalogue } = options;
  const now = options.now ?? (() => new Date());
  const providers: AiProviders = {
    async defaultModels() {
      return { ...initialDefaultModels, ...(await store.defaultModels()) };
    },

    async setDefaultModel(aiProvider, model) {
      const known = aiProviders.find((name) => name === aiProvider);
      if (known === undefined) {
        throw new AiProviderError(
          aiProviderErrorCodes.aiProviderNotFound,
          `There is no AI Provider "${aiProvider}".`,
        );
      }
      // A Model the catalogue does not list yet (a subscription whose list
      // could not be fetched, or one just released) may be typed in, but
      // never one the catalogue lists only for another AI Provider.
      if (!(await catalogue(known)).includes(model)) {
        for (const other of aiProviders) {
          if (other !== known && (await catalogue(other)).includes(model)) {
            throw new AiProviderError(
              aiProviderErrorCodes.modelNotInCatalogue,
              `"${model}" is ${other}'s Model, not ${known}'s.`,
            );
          }
        }
      }
      await store.setDefaultModel(known, model, now());
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: [`aiProviders.${known}.defaultModel`],
      });
    },

    async chooseMissingDefaults(withAccounts) {
      const defaults = await providers.defaultModels();
      const chosen: string[] = [];
      for (const aiProvider of new Set(withAccounts)) {
        const known = aiProviders.find((name) => name === aiProvider);
        if (known === undefined || defaults[known] !== undefined) {
          continue;
        }
        const [first] = await catalogue(known);
        if (first === undefined) {
          continue;
        }
        await providers.setDefaultModel(known, first);
        chosen.push(known);
      }
      return chosen;
    },
  };
  return providers;
}
