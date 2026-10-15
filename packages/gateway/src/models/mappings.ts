import { randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  maxModelMappings,
  modelMappingErrorCodes,
  type ModelMappingErrorCode,
  type ModelMappingRequest,
} from "@ai-office/shared";

import {
  sameName,
  type ModelMapping,
  type ModelMappingStore,
} from "./mappings-store.ts";

// Model mappings and aliases (PRD FR-41): the Owner's names for Models. An
// alias (no kind of AI Account) is resolved before a request is routed; a
// kind's mapping when an account of that kind serves it; `modelSentTo`
// (shared) says which wins. They are kept in memory once read, since
// every request asks: only these change them.

/** Why a model mapping was refused. */
export class ModelMappingError extends Error {
  readonly code: ModelMappingErrorCode;

  constructor(code: ModelMappingErrorCode, message: string) {
    super(message);
    this.name = "ModelMappingError";
    this.code = code;
  }
}

export interface ModelMappings {
  /** Aliases first, then by AI Provider, account type and name asked. */
  list(): Promise<ModelMapping[]>;
  add(request: ModelMappingRequest): Promise<ModelMapping>;
  /** Changes every field of one. */
  replace(id: string, request: ModelMappingRequest): Promise<ModelMapping>;
  remove(id: string): Promise<void>;
  /** Every mapping, as the AI Accounts apply them to each request. */
  rules(): Promise<readonly ModelMapping[]>;
}

export interface ModelMappingsOptions {
  readonly store: ModelMappingStore;
  /** Each change is a `config.changed` event, naming what changed. */
  readonly events: Pick<EventBus, "publish">;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** Aliases first, then by kind, then by the name asked for. */
const inOrder = (a: ModelMapping, b: ModelMapping): number =>
  (a.aiProvider ?? "").localeCompare(b.aiProvider ?? "") ||
  (a.accountType ?? "").localeCompare(b.accountType ?? "") ||
  a.from.localeCompare(b.from);

/** Where a mapping applies, for messages. */
const scopeOf = (mapping: ModelMappingRequest): string =>
  mapping.aiProvider === null || mapping.accountType === null
    ? "as an alias"
    : `for ${mapping.aiProvider} ${mapping.accountType === "oauth" ? "subscriptions" : "API keys"}`;

export function createModelMappings(
  options: ModelMappingsOptions,
): ModelMappings {
  const { store, events } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  let cached: Promise<ModelMapping[]> | undefined;
  const load = (): Promise<ModelMapping[]> => {
    cached ??= store
      .list()
      .then((mappings) => mappings.sort(inOrder))
      .catch((error: unknown) => {
        // Read again next time.
        cached = undefined;
        throw error;
      });
    return cached;
  };

  const changed = (keys: string[]) =>
    events.publish({
      type: "config.changed",
      version: 1,
      scope: "gateway",
      keys,
    });

  const notFound = (id: string) =>
    new ModelMappingError(
      modelMappingErrorCodes.modelMappingNotFound,
      `There is no model mapping "${id}".`,
    );
  const taken = (mapping: ModelMappingRequest) =>
    new ModelMappingError(
      modelMappingErrorCodes.modelMappingTaken,
      `${mapping.from} is already mapped ${scopeOf(mapping)}.`,
    );

  return {
    async list() {
      return [...(await load())];
    },

    rules: load,

    async add(request) {
      const mappings = await load();
      if (mappings.length >= maxModelMappings) {
        throw new ModelMappingError(
          modelMappingErrorCodes.tooManyModelMappings,
          `There are already ${String(maxModelMappings)} model mappings: delete one first.`,
        );
      }
      if (mappings.some((other) => sameName(other, request))) {
        throw taken(request);
      }
      const at = now();
      const mapping: ModelMapping = {
        id: newId(),
        from: request.from,
        to: request.to,
        aiProvider: request.aiProvider,
        accountType: request.accountType,
        createdAt: at,
        updatedAt: at,
      };
      const added = await store.add(mapping);
      cached = undefined;
      if (added === "taken") {
        throw taken(request);
      }
      await changed(["modelMappings.added"]);
      return mapping;
    },

    async replace(id, request) {
      const mappings = await load();
      const current = mappings.find((mapping) => mapping.id === id);
      if (current === undefined) {
        throw notFound(id);
      }
      if (
        mappings.some((other) => other.id !== id && sameName(other, request))
      ) {
        throw taken(request);
      }
      const updated = await store.replace(id, {
        from: request.from,
        to: request.to,
        aiProvider: request.aiProvider,
        accountType: request.accountType,
        updatedAt: now(),
      });
      cached = undefined;
      if (updated === undefined) {
        throw notFound(id);
      }
      if (updated === "taken") {
        throw taken(request);
      }
      await changed(["modelMappings.changed"]);
      return updated;
    },

    async remove(id) {
      const removed = await store.remove(id);
      cached = undefined;
      if (!removed) {
        throw notFound(id);
      }
      await changed(["modelMappings.deleted"]);
    },
  };
}
