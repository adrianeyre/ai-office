import { z } from "zod";

import { ownerProofShape } from "./auth.ts";
import { defaultKeyProfile, keyProfileSchema } from "./people.ts";

// Gateway Keys (PRD FR-46, ADR 0001): what callers of the AI Gateway
// present to say who they are. Each Agent has one, made with it (the
// Communications Agent too, for its Digests); the Owner makes named ones
// for their own tools. A key is shown once, when an Owner
// tool's key is made, and never again: only its SHA-256 is kept for
// checking it, and an Agent's own is kept sealed, for its sandboxes.

/** Every Gateway Key starts with this, so the redactor knows one. */
export const gatewayKeyPrefix = "aio_gk_";

/**
 * Who a key belongs to: one of a Floor's Agents, the Communications Agent
 * (FR-90), one of the Owner's own tools, or the Terminal, whose calls are
 * attributed to the Owner tool `terminalKeyName`.
 */
export const gatewayKeyKinds = [
  "agent",
  "communications",
  "owner_tool",
  "terminal",
] as const;
export type GatewayKeyKind = (typeof gatewayKeyKinds)[number];

/**
 * What a key may do: call models through the AI Gateway only, or sign in
 * to the web app as well (an Owner tool's key only).
 */
export const gatewayKeyAccessLevels = ["proxy", "proxy_and_ui"] as const;
export type GatewayKeyAccess = (typeof gatewayKeyAccessLevels)[number];

/** Each access level, for people. */
export const gatewayKeyAccessNames: Record<GatewayKeyAccess, string> = {
  proxy: "AI proxy only",
  proxy_and_ui: "AI proxy and UI",
};

/** How many characters of a key are shown to tell keys apart. */
export const gatewayKeyHintLength = gatewayKeyPrefix.length + 4;

const name = z
  .string({ error: "Give the Gateway Key a name." })
  .trim()
  .min(1, { error: "Give the Gateway Key a name." })
  .max(100, { error: "Use at most 100 characters for the name." });

/**
 * The body of `POST /api/gateway-keys`: a key for one of the Owner's tools.
 * A key with UI access signs in, so making one needs a fresh proof of the
 * Owner (A1-3).
 */
export const createGatewayKeyRequestSchema = z.strictObject({
  name,
  access: z.enum(gatewayKeyAccessLevels).default("proxy"),
  ...ownerProofShape,
});
export type CreateGatewayKeyRequest = z.infer<
  typeof createGatewayKeyRequestSchema
>;

/** A Gateway Key, as the API sends it: never the key itself. */
export const gatewayKeySchema = z.object({
  id: z.string(),
  kind: z.enum(gatewayKeyKinds),
  /** The Owner tool's name, or the Agent's when the key was made. */
  name: z.string(),
  /** The Agent it belongs to; null for an Owner tool's. */
  agentId: z.string().nullable(),
  floorId: z.string().nullable(),
  /** The key's first characters (`aio_gk_AbCd`), to tell it apart. */
  hint: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  /** When it last authenticated a request; null if never. */
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  /**
   * Who uses the key: a nickname and a time zone (British time until set).
   * Set in API Key Management.
   */
  profile: keyProfileSchema.default(defaultKeyProfile),
  access: z.enum(gatewayKeyAccessLevels).default("proxy"),
  /** False while disabled: refused everywhere, but kept to enable again. */
  enabled: z.boolean().default(true),
});

/**
 * The body of `PATCH /api/gateway-keys/:keyId`: an Owner tool's key's
 * access and whether it is enabled. A change after which the key signs in
 * where it did not (UI access given, or a UI key enabled again) needs a
 * fresh proof of the Owner (A1-3).
 */
export const gatewayKeyUpdateRequestSchema = z
  .strictObject({
    name,
    access: z.enum(gatewayKeyAccessLevels),
    enabled: z.boolean(),
  })
  .partial()
  .extend(ownerProofShape)
  .refine(
    ({ name, access, enabled }) =>
      name !== undefined || access !== undefined || enabled !== undefined,
    { error: "Change the name, the access or whether it is enabled." },
  );
export type GatewayKeyUpdateRequest = z.infer<
  typeof gatewayKeyUpdateRequestSchema
>;
export type GatewayKey = z.infer<typeof gatewayKeySchema>;

/** The body of `GET /api/gateway-keys`: the keys in use, newest first. */
export const gatewayKeyListSchema = z.object({
  keys: z.array(gatewayKeySchema),
});

/** What one key's requests added up to, of those retention has kept. */
export const gatewayKeyUsageSchema = z.object({
  gatewayKeyId: z.string(),
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Estimated, for information only (FR-43). */
  estimatedCostUsd: z.number().nonnegative(),
  lastRequestAt: z.iso.datetime({ offset: true }),
});
export type GatewayKeyUsage = z.infer<typeof gatewayKeyUsageSchema>;

/** The body of `GET /api/gateway-keys/usage`: each used key's. */
export const gatewayKeyUsageListSchema = z.object({
  usage: z.array(gatewayKeyUsageSchema),
});

/** The answer to `POST /api/gateway-keys`: the only time `key` is sent. */
export const createdGatewayKeySchema = z.object({
  gatewayKey: gatewayKeySchema,
  key: z.string().startsWith(gatewayKeyPrefix),
});
export type CreatedGatewayKey = z.infer<typeof createdGatewayKeySchema>;

export const gatewayKeyErrorCodes = {
  gatewayKeyNotFound: "gateway_key_not_found",
  /** Another Owner tool's key in use already has that name. */
  gatewayKeyNameTaken: "gateway_key_name_taken",
  /** An Agent's key goes with its Agent: it is rotated, not revoked. */
  agentKeyNotRevocable: "agent_key_not_revocable",
  /** Only an Owner tool's key may sign in to the web app. */
  agentKeyNoUi: "agent_key_no_ui",
  /** A key with UI access tried to sign in while disabled, or without it. */
  apiKeyNoUi: "api_key_no_ui",
} as const;
export type GatewayKeyErrorCode =
  (typeof gatewayKeyErrorCodes)[keyof typeof gatewayKeyErrorCodes];
