import type { AiAccountType } from "@ai-office/shared";

import type { CatalogueSource } from "../accounts/accounts.ts";
import { authHeaders } from "../accounts/auth-headers.ts";
import type { CatalogueEntry, ModelCatalogueStore } from "./store.ts";

// The AI Gateway's live model catalogue (PRD FR-41): each kind of AI
// Account's Models, as its AI Provider's models endpoint lists them,
// fetched with an account of that kind, on demand and once a day. A kind
// whose list cannot be fetched keeps the last one. The lists come in each
// AI Provider's own shape:
// - Anthropic: `{data: [{id, display_name}], has_more, last_id}`, a page at
//   a time (`limit`, `after_id`);
// - OpenAI-compatible APIs (xAI, Google's, OpenRouter, DeepSeek, Minimax,
//   Kimi): `{data: [{id}]}`, Google's ids as `models/<name>`; OpenRouter's
//   and DeepSeek's with a `name` to show, OpenRouter's and Kimi's with a
//   `context_length` and DeepSeek's a `context_window`;
// - a kind whose API lists none (Z.ai's): the Models its AI Provider
//   documents, kept with the kind;
// - ChatGPT's Codex backend: `{models: [{slug, display_name,
//   context_window}]}`;
// - Ollama's own (`/api/tags`): `{models: [{name}]}`.
// A kind with several sources (compatible endpoints, each serving what its
// owner put behind it) lists the Models of every one that answered.
// No answer's body is ever put in an error, nor a credential.

/** What one refresh did, by kind. */
export interface CatalogueRefreshReport {
  readonly refreshed: {
    readonly aiProvider: string;
    readonly accountType: AiAccountType;
    readonly models: number;
  }[];
  readonly failed: {
    readonly aiProvider: string;
    readonly accountType: AiAccountType;
    readonly message: string;
  }[];
}

export interface ModelCatalogue {
  /** Every Model in the catalogue. */
  list(): Promise<CatalogueEntry[]>;
  /**
   * Fetches every kind's list again, one refresh at a time: a refresh
   * asked for while one runs gets that one's report.
   */
  refresh(): Promise<CatalogueRefreshReport>;
  /** Why each kind's list last failed, until it is fetched again. */
  failures?(): CatalogueRefreshReport["failed"];
}

export interface ModelCatalogueOptions {
  readonly store: ModelCatalogueStore;
  /**
   * One account of each kind to ask, or several for a kind whose accounts
   * each list their own (`AiAccounts.catalogueSources`).
   */
  readonly sources: () => Promise<readonly CatalogueSource[]>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** Why a kind's Models could not be listed; never with a body or a key. */
export class CatalogueError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogueError";
  }
}

/** At most this many pages of a list are read. */
const maxPages = 20;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A Model's name as callers ask for it: Google's without `models/`. */
const modelName = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim().replace(/^models\//, "");
  return name !== "" && name.length <= 200 && !/\s/.test(name)
    ? name
    : undefined;
};

/** The first field of `item` among `fields` that is a positive integer. */
const positiveInteger = (
  item: Record<string, unknown>,
  fields: readonly string[],
): number | null => {
  for (const field of fields) {
    const value = item[field];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
};

/** The first field of `item` among `fields` that is a non-empty string. */
const text = (
  item: Record<string, unknown>,
  fields: readonly string[],
): string | null => {
  for (const field of fields) {
    const value = item[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim().slice(0, 200);
    }
  }
  return null;
};

/** The Models in one page of a list, in whichever shape it comes. */
export function modelsInList(body: unknown): {
  models: Omit<CatalogueEntry, "aiProvider" | "accountType" | "fetchedAt">[];
  nextAfter: string | undefined;
} {
  if (!isObject(body)) {
    throw new CatalogueError("The AI Provider's model list could not be read.");
  }
  const items = Array.isArray(body["data"])
    ? body["data"]
    : Array.isArray(body["models"])
      ? body["models"]
      : undefined;
  if (items === undefined) {
    throw new CatalogueError("The AI Provider's answer holds no model list.");
  }
  const models = items.flatMap((item: unknown) => {
    if (!isObject(item)) {
      return [];
    }
    const model = modelName(item["id"] ?? item["slug"] ?? item["name"]);
    return model === undefined
      ? []
      : [
          {
            model,
            // OpenRouter's and DeepSeek's `name` is a display name.
            displayName: text(item, ["display_name", "displayName", "name"]),
            contextWindow: positiveInteger(item, [
              "context_window",
              "context_length",
              // vLLM's.
              "max_model_len",
              "max_input_tokens",
              "input_token_limit",
              "inputTokenLimit",
            ]),
          },
        ];
  });
  const lastId = body["last_id"];
  return {
    models,
    nextAfter:
      body["has_more"] === true && typeof lastId === "string" && lastId !== ""
        ? lastId
        : undefined,
  };
}

/** The headers a kind's models endpoint needs: its credential, as it serves. */
function headersFor(source: CatalogueSource): Record<string, string> {
  const { account } = source;
  const anthropic = (account.apiFormat ?? "anthropic") === "anthropic";
  return {
    accept: "application/json",
    ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
    ...authHeaders(account),
    ...(account.betas !== undefined && account.betas.length > 0
      ? { "anthropic-beta": account.betas.join(",") }
      : {}),
    ...account.headers,
  };
}

/**
 * Lists one kind's Models through `source`'s account; a kind whose API
 * lists none, its documented Models.
 */
export async function fetchModels(
  source: CatalogueSource,
  options: { readonly fetch: typeof fetch; readonly now: Date },
): Promise<CatalogueEntry[]> {
  const { account, modelsPath } = source;
  if (modelsPath === null) {
    return (source.documentedModels ?? []).map((model) => ({
      aiProvider: source.aiProvider,
      accountType: source.accountType,
      model: model.model,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      fetchedAt: options.now,
    }));
  }
  const anthropic = (account.apiFormat ?? "anthropic") === "anthropic";
  const base = `${account.baseUrl.replace(/\/+$/, "")}${(account.apiPath ?? "/v1").replace(/\/+$/, "")}${modelsPath}`;
  const found = new Map<
    string,
    Omit<CatalogueEntry, "aiProvider" | "accountType" | "fetchedAt">
  >();
  let after: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(base);
    if (anthropic) {
      url.searchParams.set("limit", "1000");
      if (after !== undefined) {
        url.searchParams.set("after_id", after);
      }
    }
    let response: Response;
    try {
      response = await options.fetch(url, {
        headers: headersFor(source),
        signal: AbortSignal.timeout(30_000),
        // Its account's credential goes to its own endpoint only
        // (pen-testing G1-7).
        redirect: "manual",
      });
    } catch (error) {
      throw new CatalogueError("The AI Provider could not be reached.", {
        cause: error,
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogueError(
        `The AI Provider's model list answered ${String(response.status)}.`,
      );
    }
    const list = modelsInList(await response.json().catch(() => undefined));
    for (const model of list.models) {
      if (!found.has(model.model)) {
        found.set(model.model, model);
      }
    }
    after = list.nextAfter;
    if (after === undefined) {
      break;
    }
  }
  return [...found.values()].map((model) => ({
    aiProvider: source.aiProvider,
    accountType: source.accountType,
    ...model,
    fetchedAt: options.now,
  }));
}

export function createModelCatalogue(
  options: ModelCatalogueOptions,
): ModelCatalogue {
  const { store } = options;
  const fetchList = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  let running: Promise<CatalogueRefreshReport> | undefined;
  let lastFailed: CatalogueRefreshReport["failed"] = [];

  const refreshAll = async (): Promise<CatalogueRefreshReport> => {
    const report: {
      refreshed: CatalogueRefreshReport["refreshed"];
      failed: CatalogueRefreshReport["failed"];
    } = { refreshed: [], failed: [] };
    const kinds = new Map<string, CatalogueSource[]>();
    for (const source of await options.sources()) {
      const key = `${source.aiProvider}:${source.accountType}`;
      kinds.set(key, [...(kinds.get(key) ?? []), source]);
    }
    for (const sources of kinds.values()) {
      const [{ aiProvider, accountType }] = sources as [CatalogueSource];
      const failed = (error: unknown) => {
        report.failed.push({
          aiProvider,
          accountType,
          message:
            error instanceof CatalogueError
              ? error.message
              : "The model list could not be stored.",
        });
      };
      // Each Model once, as the first source to list it has it.
      const found = new Map<string, CatalogueEntry>();
      let listed = false;
      for (const source of sources) {
        try {
          const entries = await fetchModels(source, {
            fetch: fetchList,
            now: now(),
          });
          if (entries.length === 0) {
            throw new CatalogueError("The AI Provider listed no Models.");
          }
          listed = true;
          for (const entry of entries) {
            if (!found.has(entry.model)) {
              found.set(entry.model, entry);
            }
          }
        } catch (error) {
          failed(error);
        }
      }
      if (!listed) {
        continue;
      }
      try {
        await store.replace(aiProvider, accountType, [...found.values()]);
        report.refreshed.push({ aiProvider, accountType, models: found.size });
      } catch (error) {
        failed(error);
      }
    }
    lastFailed = report.failed.filter(
      ({ aiProvider, accountType }) =>
        !report.refreshed.some(
          (done) =>
            done.aiProvider === aiProvider && done.accountType === accountType,
        ),
    );
    return report;
  };

  return {
    list: () => store.list(),
    failures: () => lastFailed,
    refresh() {
      running ??= refreshAll().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
