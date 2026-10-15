import {
  FloorError,
  type FloorRecord,
  type Floors,
  type FloorStops,
} from "@ai-office/orchestrator";
import {
  addFloorRequestSchema,
  floorErrorCodes,
  floorSettingsUpdateSchema,
  type ApiError,
  type Floor,
  type FloorErrorCode,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Floor API (PRD §6.2), a thin adapter over the orchestrator's Floors:
// the repositories the App is installed on, adding a Floor from a
// repository and a Floor Template (FR-97), its settings, and archiving it.
// The templates themselves are `floor-templates/routes.ts`'. Every route
// needs a signed-in session.

const statusFor: Record<FloorErrorCode, number> = {
  [floorErrorCodes.githubNotConfigured]: 503,
  [floorErrorCodes.githubUnavailable]: 502,
  [floorErrorCodes.notInstalled]: 422,
  [floorErrorCodes.floorExists]: 409,
  [floorErrorCodes.floorNotFound]: 404,
  [floorErrorCodes.floorArchived]: 409,
  [floorErrorCodes.floorNameTaken]: 409,
  [floorErrorCodes.branchNotFound]: 422,
  [floorErrorCodes.notAReviewer]: 422,
  [floorErrorCodes.templateNotFound]: 422,
  [floorErrorCodes.templateRoleNameTaken]: 409,
};

/** A Floor as the API sends it. */
export const floorBody = (floor: FloorRecord): Floor => ({
  ...floor,
  createdAt: floor.createdAt.toISOString(),
  archivedAt: floor.archivedAt?.toISOString() ?? null,
});

/** Answers a `FloorError` with its status; anything else is rethrown. */
export const sendFloorError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof FloorError)) {
    throw error;
  }
  if (error.code === floorErrorCodes.githubUnavailable) {
    reply.log.warn({ err: error }, "GitHub could not be asked.");
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface FloorParams {
  readonly floorId: string;
}

export function registerFloorRoutes(
  app: FastifyInstance,
  options: {
    readonly floors: Floors;
    /** Where the Owner stopped everything, from the Meeting Room. */
    readonly stops: FloorStops;
  },
): void {
  const { floors, stops } = options;
  const stopBody = (floorId: string) => ({
    stoppedAt: stops.stoppedAt(floorId)?.toISOString() ?? null,
  });

  app.get(
    "/api/github/repositories",
    { config: { access: "owner" } },
    async (_request, reply) => {
      try {
        return { repositories: await floors.installedRepositories() };
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.get("/api/floors", { config: { access: "owner" } }, async () => ({
    floors: (await floors.list()).map(floorBody),
  }));

  app.post(
    "/api/floors",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = addFloorRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const floor = await floors.add(
          parsed.data.repository,
          parsed.data.template,
        );
        request.log.info(
          {
            floorId: floor.id,
            repository: floor.repository,
            template: floor.template.id,
          },
          "A Floor was added.",
        );
        return await reply.code(201).send(floorBody(floor));
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return floorBody(await floors.get(request.params.floorId));
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.patch<{ Params: FloorParams }>(
    "/api/floors/:floorId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = floorSettingsUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        return floorBody(
          await floors.updateSettings(request.params.floorId, parsed.data),
        );
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.post<{ Params: FloorParams }>(
    "/api/floors/:floorId/archive",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const floor = await floors.archive(request.params.floorId);
        request.log.info({ floorId: floor.id }, "A Floor was archived.");
        return floorBody(floor);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/stop",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const floor = await floors.get(request.params.floorId);
        return stopBody(floor.id);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  // "Stop everything" in the Meeting Room: the Floor's running work goes
  // back in the queue, and none starts until it continues.
  app.post<{ Params: FloorParams }>(
    "/api/floors/:floorId/stop",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const floor = await floors.get(request.params.floorId);
        await stops.stop(floor.id);
        request.log.info({ floorId: floor.id }, "A Floor was stopped.");
        return stopBody(floor.id);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  // "Continue working": the Floor's Agents carry on where they were.
  app.post<{ Params: FloorParams }>(
    "/api/floors/:floorId/continue",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const floor = await floors.get(request.params.floorId);
        await stops.carryOn(floor.id);
        request.log.info({ floorId: floor.id }, "A Floor carries on working.");
        return stopBody(floor.id);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );
}
