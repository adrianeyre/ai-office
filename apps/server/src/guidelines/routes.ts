import {
  GuidelineVersionError,
  type GuidelinesAdmin,
} from "@ai-office/orchestrator";
import {
  guidelineErrorCodes,
  guidelineVersionRequestSchema,
  type ApiError,
  type FloorGuidelineList,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// A Floor's Guidelines in its admin (Guidelines, Specs and Hooks PRD,
// FR-103, FR-111; ADR 0014), a thin adapter over the orchestrator's
// Guidelines admin: list them as they are on the default branch now, and
// approve or dismiss the version the Owner saw, named by its content hash.
// A version that is no longer the one waiting is a 409. Every route needs
// a signed-in session.

interface GuidelineParams {
  readonly floorId: string;
  readonly name: string;
}

/** Answers a `GuidelineVersionError` or `FloorError`; anything else is rethrown. */
const sendGuidelineError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof GuidelineVersionError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError =
    error.code === "not_found"
      ? { error: guidelineErrorCodes.guidelineNotFound, message: error.message }
      : { error: guidelineErrorCodes.guidelineChanged, message: error.message };
  return reply.code(error.code === "not_found" ? 404 : 409).send(body);
};

export function registerGuidelineRoutes(
  app: FastifyInstance,
  options: { readonly guidelines: GuidelinesAdmin },
): void {
  const { guidelines } = options;

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/guidelines",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const list: FloorGuidelineList = await guidelines.list(
          request.params.floorId,
        );
        return list;
      } catch (error) {
        return sendGuidelineError(reply, error);
      }
    },
  );

  for (const action of ["approve", "dismiss"] as const) {
    app.post<{ Params: GuidelineParams }>(
      `/api/floors/:floorId/guidelines/:name/${action}`,
      { config: { access: "owner" } },
      async (request, reply) => {
        const parsed = guidelineVersionRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return sendInvalidRequest(reply, parsed.error);
        }
        const { floorId, name } = request.params;
        try {
          const list: FloorGuidelineList = await guidelines[action](
            floorId,
            name,
            parsed.data.contentHash,
          );
          return list;
        } catch (error) {
          return sendGuidelineError(reply, error);
        }
      },
    );
  }
}
