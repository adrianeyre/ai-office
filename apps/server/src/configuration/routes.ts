import {
  ConfigurationError,
  type ConfigurationService,
} from "@ai-office/orchestrator";
import {
  configurationErrorCodes,
  configurationSchema,
  type ApiError,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// Configuration export and import (PRD FR-65): every setting the Owner
// has made, as one JSON file without a credential; and the same file
// read back, previewed first.

/** A whole configuration, Skills' folders and all, escaped as JSON. */
const configurationBodyLimit = 64 * 1024 * 1024;

export function registerConfigurationRoutes(
  app: FastifyInstance,
  options: { readonly configuration: ConfigurationService },
): void {
  const { configuration } = options;

  app.get(
    "/api/configuration/export",
    { config: { access: "owner" } },
    async (request, reply) => {
      const exported = await configuration.export();
      request.log.info("The configuration was exported.");
      return reply
        .header(
          "content-disposition",
          `attachment; filename="ai-office-configuration-${exported.exportedAt.slice(0, 10)}.json"`,
        )
        .header("cache-control", "no-store")
        .send(exported);
    },
  );

  app.post(
    "/api/configuration/import/preview",
    { config: { access: "owner" }, bodyLimit: configurationBodyLimit },
    async (request, reply) => {
      const parsed = configurationSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      return configuration.preview(parsed.data);
    },
  );

  app.post(
    "/api/configuration/import",
    { config: { access: "owner" }, bodyLimit: configurationBodyLimit },
    async (request, reply) => {
      const parsed = configurationSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const applied = await configuration.import(parsed.data);
        request.log.info(
          { changes: applied.changes.length },
          "A configuration was imported.",
        );
        return applied;
      } catch (error) {
        if (error instanceof ConfigurationError) {
          const body: ApiError = {
            error: configurationErrorCodes.configurationConflicts,
            message: error.message,
            problems: [...error.problems],
          };
          return reply.code(409).send(body);
        }
        throw error;
      }
    },
  );
}
