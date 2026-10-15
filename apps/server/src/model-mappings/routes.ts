import {
  ModelMappingError,
  type ModelMapping,
  type ModelMappings,
} from "@ai-office/gateway";
import {
  modelMappingErrorCodes,
  modelMappingRequestSchema,
  type ApiError,
  type ModelMappingEntry,
  type ModelMappingErrorCode,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The model mappings API (PRD FR-41), a thin adapter over the AI Gateway's
// model mappings and aliases: list them, add one, change one and delete
// it. Forcing a Model, and extra usage, are an AI Account's own settings
// (PATCH /api/ai-accounts/:id). Every route needs a signed-in session.

const statusFor: Record<ModelMappingErrorCode, number> = {
  [modelMappingErrorCodes.modelMappingNotFound]: 404,
  [modelMappingErrorCodes.modelMappingTaken]: 409,
  [modelMappingErrorCodes.tooManyModelMappings]: 409,
};

/** A model mapping as the API sends it. */
export const modelMappingBody = (mapping: ModelMapping): ModelMappingEntry => ({
  id: mapping.id,
  from: mapping.from,
  to: mapping.to,
  aiProvider: mapping.aiProvider,
  accountType: mapping.accountType,
  createdAt: mapping.createdAt.toISOString(),
  updatedAt: mapping.updatedAt.toISOString(),
});

/** Answers a `ModelMappingError` with its status; anything else is rethrown. */
const sendMappingError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof ModelMappingError)) {
    throw error;
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface MappingParams {
  readonly mappingId: string;
}

export function registerModelMappingRoutes(
  app: FastifyInstance,
  options: { readonly mappings: ModelMappings },
): void {
  const { mappings } = options;

  app.get(
    "/api/gateway/model-mappings",
    { config: { access: "owner" } },
    async () => ({
      mappings: (await mappings.list()).map(modelMappingBody),
    }),
  );

  app.post(
    "/api/gateway/model-mappings",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = modelMappingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const mapping = await mappings.add(parsed.data);
        request.log.info(
          { modelMappingId: mapping.id },
          "A model mapping was added.",
        );
        return await reply.code(201).send(modelMappingBody(mapping));
      } catch (error) {
        return sendMappingError(reply, error);
      }
    },
  );

  app.put<{ Params: MappingParams }>(
    "/api/gateway/model-mappings/:mappingId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = modelMappingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const mapping = await mappings.replace(
          request.params.mappingId,
          parsed.data,
        );
        request.log.info(
          { modelMappingId: mapping.id },
          "A model mapping was changed.",
        );
        return modelMappingBody(mapping);
      } catch (error) {
        return sendMappingError(reply, error);
      }
    },
  );

  app.delete<{ Params: MappingParams }>(
    "/api/gateway/model-mappings/:mappingId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await mappings.remove(request.params.mappingId);
        request.log.info(
          { modelMappingId: request.params.mappingId },
          "A model mapping was deleted.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendMappingError(reply, error);
      }
    },
  );
}
