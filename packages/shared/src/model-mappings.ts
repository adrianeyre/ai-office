import { z } from "zod";

import {
  aiAccountKindOf,
  aiAccountTypes,
  aiProviderOfModel,
  aiProviderTakes,
  platformModel,
} from "./ai-accounts.ts";
import { aiProviders } from "./agents.ts";
import { modelNameSchema } from "./pricing.ts";

// Model mappings and aliases (PRD FR-41): a name a caller asks for, sent
// to an AI Account as another Model. One with no kind of AI Account is an
// alias, office-wide: it is resolved before anything else, so the AI
// Gateway routes the request (its AI Provider, its Combo, its model
// family) as the Model it stands for. One with a kind of AI Account (an AI
// Provider and an account type) applies only when an account of that kind
// serves. An AI Account may also force a Model: whatever was asked for, it
// is sent that one. The server and the web app share these.

/** The most model mappings the Gateway keeps. */
export const maxModelMappings = 200;

/** A name callers ask for: a Model, or an alias such as `opus`. */
const requestedNameSchema = z
  .string({ error: "Name the Model or alias that is asked for." })
  .trim()
  .min(1, { error: "Name the Model or alias that is asked for." })
  .max(200, { error: "Use at most 200 characters for the name asked for." })
  .regex(/^\S*$/, { error: "A Model's name has no spaces in it." });

/**
 * `POST /api/gateway/model-mappings` and `PUT …/:id`: a name asked for,
 * the Model sent instead, and the kind of AI Account it applies to (both
 * null for every kind: an alias).
 */
export const modelMappingRequestSchema = z
  .strictObject({
    from: requestedNameSchema,
    to: modelNameSchema,
    aiProvider: z
      .enum(aiProviders, { error: "Choose an AI Provider, or none." })
      .nullable(),
    accountType: z
      .enum(aiAccountTypes, { error: "Choose an account type, or none." })
      .nullable(),
  })
  .superRefine((mapping, context) => {
    if ((mapping.aiProvider === null) !== (mapping.accountType === null)) {
      context.addIssue({
        code: "custom",
        path: ["accountType"],
        message:
          "Choose both an AI Provider and an account type, or neither for an alias.",
      });
      return;
    }
    if (
      mapping.aiProvider !== null &&
      mapping.accountType !== null &&
      aiAccountKindOf({
        aiProvider: mapping.aiProvider,
        accountType: mapping.accountType,
      }) === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["accountType"],
        message: `There is no ${mapping.aiProvider} account of that type.`,
      });
      return;
    }
    if (mapping.from === mapping.to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "Map the name to another Model.",
      });
      return;
    }
    if (
      mapping.aiProvider !== null &&
      !aiProviderTakes(mapping.aiProvider, mapping.to)
    ) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: `${mapping.to} is ${aiProviderOfModel(mapping.to) ?? ""}'s, but the mapping is for ${mapping.aiProvider} accounts.`,
      });
    }
  });
export type ModelMappingRequest = z.infer<typeof modelMappingRequestSchema>;

/** A model mapping, as the API sends it. */
export const modelMappingSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  aiProvider: z.string().nullable(),
  accountType: z.enum(aiAccountTypes).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ModelMappingEntry = z.infer<typeof modelMappingSchema>;

/** `GET /api/gateway/model-mappings`: aliases first, then by kind and name. */
export const modelMappingListSchema = z.object({
  mappings: z.array(modelMappingSchema),
});

/** Why a model mapping was refused. */
export const modelMappingErrorCodes = {
  modelMappingNotFound: "model_mapping_not_found",
  /** The name is already mapped for that kind of AI Account (or as an alias). */
  modelMappingTaken: "model_mapping_taken",
  /** There are `maxModelMappings` already. */
  tooManyModelMappings: "too_many_model_mappings",
} as const;
export type ModelMappingErrorCode =
  (typeof modelMappingErrorCodes)[keyof typeof modelMappingErrorCodes];

/** What a mapping needs to apply: what it maps, and to which kind. */
export interface ModelMappingRule {
  readonly from: string;
  readonly to: string;
  readonly aiProvider: string | null;
  readonly accountType: string | null;
}

/**
 * The Model a request for `requested` is routed as: an alias's Model, or
 * the name itself. Aliases do not chain: one step only.
 */
export const aliasedModel = (
  requested: string,
  mappings: readonly ModelMappingRule[],
): string =>
  mappings.find(
    (mapping) => mapping.aiProvider === null && mapping.from === requested,
  )?.to ?? requested;

/** `model` as an account of `kind` names it: a cloud platform's way. */
const asNamedBy = (
  kind: { readonly aiProvider: string; readonly accountType: string },
  model: string,
): string => {
  const known = aiAccountKindOf(kind);
  return known === undefined ? model : platformModel(known, model);
};

/**
 * The Model an account of `kind` is sent for `requested`, before its own
 * forced Model and any Combo slot: its kind's mapping for the name as
 * asked; else its kind's mapping for the alias's Model; else the alias's
 * Model; else the name as asked. A cloud platform's account is sent it
 * as that platform names it (`platformModel`).
 */
export const mappedModel = (
  requested: string,
  kind: { readonly aiProvider: string; readonly accountType: string },
  mappings: readonly ModelMappingRule[],
): string => {
  const forKind = (name: string) =>
    mappings.find(
      (mapping) =>
        mapping.aiProvider === kind.aiProvider &&
        mapping.accountType === kind.accountType &&
        mapping.from === name,
    )?.to;
  const aliased = aliasedModel(requested, mappings);
  return asNamedBy(kind, forKind(requested) ?? forKind(aliased) ?? aliased);
};

/**
 * The Model an AI Account is sent (FR-40, FR-41), most specific first:
 * 1. the account's forced Model;
 * 2. the Model of the Combo slot serving the request;
 * 3. the account's kind's mapping, then the office-wide alias
 *    (`mappedModel`);
 * 4. the Model asked for.
 * Each as a cloud platform's account names it. Undefined when the request
 * names no Model and nothing forces one.
 */
export const modelSentTo = (
  request: {
    readonly requested: string | null;
    readonly comboModel?: string | undefined;
  },
  account: {
    readonly aiProvider: string;
    readonly accountType: string;
    readonly forcedModel: string | null;
  },
  mappings: readonly ModelMappingRule[],
): string | undefined => {
  const model =
    account.forcedModel ??
    request.comboModel ??
    (request.requested === null
      ? undefined
      : mappedModel(request.requested, account, mappings));
  return model === undefined ? undefined : asNamedBy(account, model);
};
