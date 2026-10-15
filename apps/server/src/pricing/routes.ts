import { PricingError, type PriceInfo, type Pricing } from "@ai-office/gateway";
import {
  modelNameSchema,
  modelPriceSchema,
  type ApiError,
  type ModelPriceEntry,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Model prices API (PRD FR-43), a thin adapter over the Gateway's
// pricing: the price in use for each Model and where it comes from, and
// the Owner's overrides, set and removed. Every route needs a session.

/** A Model's price as the API sends it. */
export const priceBody = (info: PriceInfo): ModelPriceEntry => ({
  model: info.model,
  price: info.price,
  source: info.source,
  standard: info.standard,
  updatedAt: info.updatedAt?.toISOString() ?? null,
});

interface ModelParams {
  readonly model: string;
}

export function registerPricingRoutes(
  app: FastifyInstance,
  options: { readonly pricing: Pricing },
): void {
  const { pricing } = options;

  app.get("/api/gateway/prices", { config: { access: "owner" } }, () => ({
    prices: pricing.list().map(priceBody),
  }));

  app.put<{ Params: ModelParams }>(
    "/api/gateway/prices/:model",
    { config: { access: "owner" } },
    async (request, reply) => {
      const model = modelNameSchema.safeParse(request.params.model);
      if (!model.success) {
        return sendInvalidRequest(reply, model.error);
      }
      const price = modelPriceSchema.safeParse(request.body);
      if (!price.success) {
        return sendInvalidRequest(reply, price.error);
      }
      const set = await pricing.setOverride(model.data, price.data);
      request.log.info({ model: model.data }, "A Model's price was set.");
      return priceBody(set);
    },
  );

  app.delete<{ Params: ModelParams }>(
    "/api/gateway/prices/:model",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await pricing.clearOverride(request.params.model);
      } catch (error) {
        if (!(error instanceof PricingError)) {
          throw error;
        }
        const body: ApiError = { error: error.code, message: error.message };
        return reply.code(404).send(body);
      }
      request.log.info(
        { model: request.params.model },
        "A Model's price went back to its default.",
      );
      return reply.code(204).send();
    },
  );
}
