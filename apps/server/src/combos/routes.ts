import { ComboError, type Combo, type Combos } from "@ai-office/gateway";
import {
  addComboRequestSchema,
  comboErrorCodes,
  comboUpdateSchema,
  type ApiError,
  type ComboEntry,
  type ComboErrorCode,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Combos API (PRD FR-40), a thin adapter over the AI Gateway's Combos:
// list them, add one, change its name, model families, slots or whether it
// is enabled, and delete it. Whether Combos apply at all is the office
// setting at /api/office/combos. Every route needs a signed-in session.

const statusFor: Record<ComboErrorCode, number> = {
  [comboErrorCodes.comboNotFound]: 404,
  [comboErrorCodes.comboNameTaken]: 409,
  [comboErrorCodes.modelFamilyTaken]: 409,
  [comboErrorCodes.unknownAiAccount]: 400,
  [comboErrorCodes.slotModelMismatch]: 400,
  [comboErrorCodes.duplicateSlot]: 400,
};

/** A Combo as the API sends it. */
export const comboBody = (combo: Combo): ComboEntry => ({
  id: combo.id,
  name: combo.name,
  modelFamilies: [...combo.modelFamilies],
  slots: combo.slots.map(({ aiAccountId, model }) => ({ aiAccountId, model })),
  enabled: combo.enabled,
  createdAt: combo.createdAt.toISOString(),
  updatedAt: combo.updatedAt.toISOString(),
});

/** Answers a `ComboError` with its status; anything else is rethrown. */
const sendComboError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof ComboError)) {
    throw error;
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface ComboParams {
  readonly comboId: string;
}

export function registerComboRoutes(
  app: FastifyInstance,
  options: { readonly combos: Combos },
): void {
  const { combos } = options;

  app.get("/api/gateway/combos", { config: { access: "owner" } }, async () => ({
    combos: (await combos.list()).map(comboBody),
  }));

  app.post(
    "/api/gateway/combos",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = addComboRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const combo = await combos.add(parsed.data);
        request.log.info({ comboId: combo.id }, "A Combo was added.");
        return await reply.code(201).send(comboBody(combo));
      } catch (error) {
        return sendComboError(reply, error);
      }
    },
  );

  app.patch<{ Params: ComboParams }>(
    "/api/gateway/combos/:comboId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = comboUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const combo = await combos.update(request.params.comboId, parsed.data);
        request.log.info({ comboId: combo.id }, "A Combo was changed.");
        return comboBody(combo);
      } catch (error) {
        return sendComboError(reply, error);
      }
    },
  );

  app.delete<{ Params: ComboParams }>(
    "/api/gateway/combos/:comboId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await combos.remove(request.params.comboId);
        request.log.info(
          { comboId: request.params.comboId },
          "A Combo was deleted.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendComboError(reply, error);
      }
    },
  );
}
