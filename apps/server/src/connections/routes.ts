import {
  CommunicationsError,
  type Communications,
  type CommunicationsAgentInfo,
  type ConnectionInfo,
  type DeliveryRecord,
} from "@ai-office/communications";
import {
  addConnectionRequestSchema,
  connectionErrorCodes,
  updateCommunicationsAgentRequestSchema,
  updateConnectionRequestSchema,
  type ApiError,
  type CommunicationsAgent,
  type Connection,
  type ConnectionDelivery,
  type ConnectionErrorCode,
  type ConnectionTestResult,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Connections API (PRD FR-90, FR-93), a thin adapter over the
// Communications Agent: its config; and the Connections, added (their
// credentials then never sent back), renamed, given rules, paused,
// resumed, deleted and tested, each with its log of recent deliveries.
// Every route needs a signed-in session.

const statusFor: Record<ConnectionErrorCode, number> = {
  [connectionErrorCodes.connectionNotFound]: 404,
  [connectionErrorCodes.nameTaken]: 409,
};

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/** A delivery as the API sends it. */
export const deliveryBody = (delivery: DeliveryRecord): ConnectionDelivery => ({
  id: delivery.id,
  message: delivery.message,
  test: delivery.test,
  status: delivery.status,
  attempts: delivery.attempts,
  createdAt: delivery.createdAt.toISOString(),
  nextAttemptAt: iso(delivery.nextAttemptAt),
  lastAttemptAt: iso(delivery.lastAttemptAt),
  deliveredAt: iso(delivery.deliveredAt),
  error: delivery.error,
});

/** A Connection as the API sends it: each field named, never its credentials. */
export const connectionBody = (connection: ConnectionInfo): Connection => ({
  id: connection.id,
  name: connection.name,
  type: connection.type,
  rules: connection.rules,
  detailLevel: connection.detailLevel,
  hint: connection.hint,
  details: [...connection.details],
  paused: connection.paused,
  status: connection.status,
  consecutiveFailures: connection.consecutiveFailures,
  lastDelivery:
    connection.lastDelivery === null
      ? null
      : deliveryBody(connection.lastDelivery),
  createdAt: connection.createdAt.toISOString(),
});

const agentBody = (agent: CommunicationsAgentInfo): CommunicationsAgent => ({
  name: agent.name,
  role: agent.role,
  avatar: agent.avatar,
  aiProvider: agent.aiProvider,
  model: agent.model,
  modelOverride: agent.modelOverride,
  enabled: agent.enabled,
  createdAt: agent.createdAt.toISOString(),
});

/** Answers a `CommunicationsError` with its status; anything else is rethrown. */
const sendConnectionError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof CommunicationsError)) {
    throw error;
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface ConnectionParams {
  readonly connectionId: string;
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  options: { readonly communications: Communications },
): void {
  const { communications } = options;

  app.get(
    "/api/communications-agent",
    { config: { access: "owner" } },
    async () => agentBody(await communications.agent()),
  );

  app.patch(
    "/api/communications-agent",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = updateCommunicationsAgentRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      return agentBody(await communications.updateAgent(parsed.data));
    },
  );

  app.get("/api/connections", { config: { access: "owner" } }, async () => ({
    connections: (await communications.list()).map(connectionBody),
  }));

  app.post(
    "/api/connections",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = addConnectionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const connection = await communications.add(parsed.data);
        request.log.info(
          { connectionId: connection.id, type: connection.type },
          "A Connection was added.",
        );
        return await reply.code(201).send(connectionBody(connection));
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );

  app.patch<{ Params: ConnectionParams }>(
    "/api/connections/:connectionId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = updateConnectionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        return connectionBody(
          await communications.update(request.params.connectionId, parsed.data),
        );
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );

  app.delete<{ Params: ConnectionParams }>(
    "/api/connections/:connectionId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await communications.remove(request.params.connectionId);
        request.log.info(
          { connectionId: request.params.connectionId },
          "A Connection was deleted.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );

  app.post<{ Params: ConnectionParams }>(
    "/api/connections/:connectionId/test",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const outcome = await communications.sendTest(
          request.params.connectionId,
        );
        const body: ConnectionTestResult = {
          delivered: outcome.delivered,
          error: outcome.error,
          connection: connectionBody(outcome.connection),
        };
        return body;
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );

  app.get<{ Params: ConnectionParams }>(
    "/api/connections/:connectionId/deliveries",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return {
          deliveries: (
            await communications.deliveries(request.params.connectionId)
          ).map(deliveryBody),
        };
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );
}
