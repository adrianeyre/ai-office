import type { StatusUpdates } from "@ai-office/orchestrator";
import type { StatusUpdateTrigger } from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendFloorError } from "../floors/routes.ts";

// A Floor's Status update (PRD FR-23a), a thin adapter over the
// orchestrator's: `POST …/status-update` gives one now (the Status update
// button), and `POST …/status-update/daily` gives the day's own, the first
// time the Owner opens the Floor that day, and none after (`statusUpdate`
// is then null). Each answers what was said; the Office walks the Floor in
// from its `status_update.given` event. Both need a signed-in session, and
// the CSRF token as every change does. `GET …/status-update/latest`
// answers the latest given on the Floor since the server started, or null:
// what a browser shows when it hears of one it did not ask for, such as
// the hourly one given while the Floor's Agents work.

interface FloorParams {
  readonly floorId: string;
}

export function registerStatusUpdateRoutes(
  app: FastifyInstance,
  options: { readonly statusUpdates: StatusUpdates },
): void {
  const { statusUpdates } = options;

  const give = async (
    floorId: string,
    trigger: StatusUpdateTrigger,
    reply: FastifyReply,
  ) => {
    try {
      const statusUpdate = (await statusUpdates.give(floorId, trigger)) ?? null;
      return await reply
        .code(statusUpdate === null ? 200 : 201)
        .send({ statusUpdate });
    } catch (error) {
      return sendFloorError(reply, error);
    }
  };

  app.post<{ Params: FloorParams }>(
    "/api/floors/:floorId/status-update",
    { config: { access: "owner" } },
    (request, reply) => give(request.params.floorId, "owner", reply),
  );

  app.post<{ Params: FloorParams }>(
    "/api/floors/:floorId/status-update/daily",
    { config: { access: "owner" } },
    (request, reply) => give(request.params.floorId, "daily", reply),
  );

  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/status-update/latest",
    { config: { access: "owner" } },
    (request) => ({
      statusUpdate: statusUpdates.latest(request.params.floorId) ?? null,
    }),
  );
}
