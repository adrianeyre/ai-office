import {
  GatewayKeyError,
  type GatewayKeyInfo,
  type KeyUsage,
  type GatewayKeys,
} from "@ai-office/gateway";
import type { Agents } from "@ai-office/orchestrator";
import {
  agentErrorCodes,
  createGatewayKeyRequestSchema,
  defaultKeyProfile,
  gatewayKeyErrorCodes,
  gatewayKeyUpdateRequestSchema,
  keyProfileSchema,
  type ApiError,
  type CreatedGatewayKey,
  type GatewayKey,
  type GatewayKeyErrorCode,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { ProveOwner } from "../auth/owner-proof.ts";
import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// The Gateway Keys API (PRD FR-46), a thin adapter over the Gateway's
// keys: list the keys in use, make a key for one of the Owner's tools
// (the only answer that ever carries a key), revoke one, and rotate an
// Agent's. Every route needs a signed-in session.

const statusFor: Record<GatewayKeyErrorCode, number> = {
  [gatewayKeyErrorCodes.gatewayKeyNotFound]: 404,
  [gatewayKeyErrorCodes.gatewayKeyNameTaken]: 409,
  [gatewayKeyErrorCodes.agentKeyNotRevocable]: 409,
  [gatewayKeyErrorCodes.agentKeyNoUi]: 409,
  [gatewayKeyErrorCodes.apiKeyNoUi]: 401,
};

/** A Gateway Key as the API sends it: each field named, never the key. */
export const gatewayKeyBody = (key: GatewayKeyInfo): GatewayKey => ({
  id: key.id,
  kind: key.kind,
  name: key.name,
  agentId: key.agentId,
  floorId: key.floorId,
  hint: key.hint,
  createdAt: key.createdAt.toISOString(),
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  revokedAt: key.revokedAt?.toISOString() ?? null,
  profile: key.profile ?? defaultKeyProfile,
  access: key.access ?? "proxy",
  enabled: key.enabled ?? true,
});

/** Answers a `GatewayKeyError` with its status; anything else is rethrown. */
const sendGatewayKeyError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof GatewayKeyError)) {
    throw error;
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

export function registerGatewayKeyRoutes(
  app: FastifyInstance,
  options: {
    readonly keys: GatewayKeys;
    readonly agents: Agents;
    /** What each key's kept requests added up to. */
    readonly usage?: () => Promise<KeyUsage[]>;
    /**
     * Checks a fresh proof of the Owner (A1-3), which a key that signs in
     * needs: one with UI access, made, given it, or enabled again.
     */
    readonly proveOwner: ProveOwner;
  },
): void {
  const { keys, agents } = options;

  app.get(
    "/api/gateway-keys/usage",
    { config: { access: "owner" } },
    async () => ({
      usage: ((await options.usage?.()) ?? []).map(
        ({ lastRequestAt, ...usage }) => ({
          ...usage,
          lastRequestAt: lastRequestAt.toISOString(),
        }),
      ),
    }),
  );

  app.get("/api/gateway-keys", { config: { access: "owner" } }, async () => ({
    keys: (await keys.list()).map(gatewayKeyBody),
  }));

  app.post(
    "/api/gateway-keys",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = createGatewayKeyRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { name, access, currentPassword, code } = parsed.data;
      if (
        access === "proxy_and_ui" &&
        !(await options.proveOwner(request, reply, { currentPassword, code }))
      ) {
        return reply;
      }
      try {
        const { gatewayKey, key } = await keys.createOwnerToolKey(name, access);
        request.log.info(
          { gatewayKeyId: gatewayKey.id },
          "A Gateway Key was made for an Owner tool.",
        );
        const body: CreatedGatewayKey = {
          gatewayKey: gatewayKeyBody(gatewayKey),
          key,
        };
        // Shown once: nothing on the way may keep a copy.
        return await reply
          .code(201)
          .header("cache-control", "no-store")
          .send(body);
      } catch (error) {
        return sendGatewayKeyError(reply, error);
      }
    },
  );

  app.delete<{ Params: { readonly keyId: string } }>(
    "/api/gateway-keys/:keyId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await keys.revoke(request.params.keyId);
        request.log.info(
          { gatewayKeyId: request.params.keyId },
          "A Gateway Key was revoked.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendGatewayKeyError(reply, error);
      }
    },
  );

  app.patch<{ Params: { readonly keyId: string } }>(
    "/api/gateway-keys/:keyId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = gatewayKeyUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { currentPassword, code, ...changes } = parsed.data;
      // A change after which the key signs in where it did not: UI access
      // given to an enabled key, or a key with UI access enabled again.
      const current = (await keys.list()).find(
        ({ id }) => id === request.params.keyId,
      );
      if (current !== undefined) {
        const signsIn = (key: {
          access?: string | undefined;
          enabled?: boolean | undefined;
        }) => key.access === "proxy_and_ui" && key.enabled !== false;
        const widens =
          !signsIn(current) &&
          signsIn({
            access: changes.access ?? current.access,
            enabled: changes.enabled ?? current.enabled,
          });
        if (
          widens &&
          !(await options.proveOwner(request, reply, {
            currentPassword,
            code,
          }))
        ) {
          return reply;
        }
      }
      try {
        const key = await keys.update(request.params.keyId, changes);
        request.log.info(
          { gatewayKeyId: key.id, changes: Object.keys(changes) },
          "A Gateway Key's access was changed.",
        );
        return gatewayKeyBody(key);
      } catch (error) {
        return sendGatewayKeyError(reply, error);
      }
    },
  );

  app.put<{ Params: { readonly keyId: string } }>(
    "/api/gateway-keys/:keyId/profile",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = keyProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const key = await keys.setProfile(request.params.keyId, parsed.data);
        request.log.info(
          { gatewayKeyId: key.id },
          "A Gateway Key's profile was set.",
        );
        return gatewayKeyBody(key);
      } catch (error) {
        return sendGatewayKeyError(reply, error);
      }
    },
  );

  app.post<{ Params: { readonly floorId: string; readonly agentId: string } }>(
    "/api/floors/:floorId/agents/:agentId/gateway-key/rotate",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId, agentId } = request.params;
      let agent;
      try {
        agent = (await agents.list(floorId)).find(({ id }) => id === agentId);
      } catch (error) {
        return sendFloorError(reply, error);
      }
      if (agent === undefined) {
        const body: ApiError = {
          error: agentErrorCodes.agentNotFound,
          message: `There is no Agent "${agentId}" on this Floor.`,
        };
        return reply.code(404).send(body);
      }
      const rotated = await keys.issueAgentKey(agent);
      request.log.info(
        { agentId, gatewayKeyId: rotated.id },
        "An Agent's Gateway Key was rotated.",
      );
      return gatewayKeyBody(rotated);
    },
  );
}
