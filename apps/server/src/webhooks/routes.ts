import {
  webhookDeliveryHeader,
  webhookEventHeader,
  webhookSignatureHeader,
} from "@ai-office/github";
import {
  WebhookSettingsError,
  type GitHubWebhooks,
} from "@ai-office/orchestrator";
import {
  apiErrorCodes,
  githubWebhookPath,
  webhookSettingsUpdateSchema,
  type ApiError,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { clientKey } from "../auth/login-limiter.ts";
import { notFoundBody, sendInvalidRequest } from "../auth/responses.ts";
import {
  createDeliveryLimiter,
  type DeliveryLimiter,
} from "./delivery-limiter.ts";

// The GitHub App's webhooks (PRD FR-8, FR-65). The office admin turns them
// on and keeps their secret (`/api/office/webhooks`, the Owner's). GitHub
// delivers to `POST /api/github/webhooks`, which needs no session, since
// GitHub has none: a delivery is believed only when its signature matches
// the secret, checked over the raw body before anything reads it. While
// webhooks are off the path answers as if it did not exist. A client whose
// deliveries keep failing that check is refused with 429 before they are
// verified, and logged no more (W1-4; `delivery-limiter.ts`).

/** GitHub caps a delivery at 25 MB; what AI Office reads is far smaller. */
const webhookBodyLimit = 5 * 1024 * 1024;

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
};

export async function registerWebhookRoutes(
  app: FastifyInstance,
  options: {
    readonly webhooks: GitHubWebhooks;
    /** Bounds each client's failed deliveries; the defaults otherwise. */
    readonly limiter?: DeliveryLimiter;
  },
): Promise<void> {
  const { webhooks } = options;
  const limiter = options.limiter ?? createDeliveryLimiter();

  app.get("/api/office/webhooks", { config: { access: "owner" } }, () =>
    webhooks.settings(),
  );

  app.put(
    "/api/office/webhooks",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = webhookSettingsUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const settings = await webhooks.setSettings(parsed.data);
        // A new secret, or webhooks turned on again: what failed before
        // may match now.
        limiter.clear();
        request.log.info(
          { enabled: settings.enabled },
          "GitHub webhooks were set.",
        );
        return settings;
      } catch (error) {
        if (error instanceof WebhookSettingsError) {
          const body: ApiError = { error: error.code, message: error.message };
          return reply.code(400).send(body);
        }
        throw error;
      }
    },
  );

  // Its own scope, whose bodies are kept as the bytes GitHub signed.
  await app.register((deliveries, _options, done) => {
    deliveries.removeAllContentTypeParsers();
    deliveries.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: webhookBodyLimit },
      (_request, body, done) => {
        done(null, body);
      },
    );
    deliveries.post(
      githubWebhookPath,
      { config: { access: "public" }, bodyLimit: webhookBodyLimit },
      async (request, reply) => {
        const event = header(request, webhookEventHeader);
        const delivery = header(request, webhookDeliveryHeader);
        const client = clientKey(request.ip);
        const retryAfter = limiter.refusedFor(client);
        if (retryAfter !== undefined) {
          // Neither verified nor logged: it was said once, at the bound.
          const body: ApiError = {
            error: apiErrorCodes.tooManyAttempts,
            message: `Too many deliveries failed the signature check. Try again in ${String(retryAfter)} ${retryAfter === 1 ? "second" : "seconds"}.`,
          };
          return reply
            .code(429)
            .header("retry-after", String(retryAfter))
            .send(body);
        }
        const outcome = await webhooks.receive({
          event,
          signature: header(request, webhookSignatureHeader),
          body: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        });
        switch (outcome.status) {
          case "off":
            return reply.code(404).send(notFoundBody);
          case "refused": {
            if (limiter.failed(client)) {
              request.log.warn(
                { event, delivery, client },
                "A GitHub webhook delivery was refused: its signature does not match the secret. Its client's deliveries are refused for a while, unverified and unlogged: too many failed.",
              );
            } else {
              request.log.warn(
                { event, delivery },
                "A GitHub webhook delivery was refused: its signature does not match the secret.",
              );
            }
            const body: ApiError = {
              error: apiErrorCodes.unauthorized,
              message:
                "The delivery's signature does not match the webhook secret.",
            };
            return reply.code(401).send(body);
          }
          case "repeated":
            // Only a delivery taken before, signed: it starts nothing again.
            request.log.debug(
              { event, delivery },
              "A GitHub webhook delivery was taken before: it starts nothing again.",
            );
            return reply.code(202).send({ started: [] });
          case "malformed": {
            const body: ApiError = {
              error: apiErrorCodes.invalidRequest,
              message: "The delivery's body is not a JSON object.",
            };
            return reply.code(400).send(body);
          }
          case "accepted":
            // Signed with the secret, and new: only GitHub sends one.
            limiter.passed(client);
            request.log.info(
              {
                event,
                delivery,
                floorId: outcome.floorId,
                started: outcome.started,
              },
              "A GitHub webhook delivery was taken.",
            );
            return reply.code(202).send({ started: outcome.started });
        }
      },
    );
    done();
  });
}
