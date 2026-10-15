import type { StorageStore } from "@ai-office/orchestrator";
import {
  storagePruneRequestSchema,
  type StoragePruneResult,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// Storage in Admin (PRD §7, FR-65): how much of the database each kind of
// history takes, and deleting what is older than a number of days, to free
// space. Each kind keeps a minimum the request schema checks.

const dayMs = 24 * 60 * 60 * 1000;

export function registerStorageRoutes(
  app: FastifyInstance,
  options: {
    readonly storage: StorageStore;
    readonly now?: () => Date;
  },
): void {
  const { storage } = options;
  const now = options.now ?? (() => new Date());

  app.get("/api/office/storage", { config: { access: "owner" } }, () =>
    storage.usage(),
  );

  app.post(
    "/api/office/storage/prune",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = storagePruneRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { category, olderThanDays } = parsed.data;
      const before = new Date(now().getTime() - olderThanDays * dayMs);
      const deleted = await storage.prune(category, before);
      request.log.info(
        { category, olderThanDays, deleted },
        "Stored history was deleted to free space.",
      );
      const result: StoragePruneResult = { category, deleted };
      return result;
    },
  );
}
