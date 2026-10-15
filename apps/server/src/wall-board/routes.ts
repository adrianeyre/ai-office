import type { WallBoard } from "@ai-office/orchestrator";
import type { FastifyInstance } from "fastify";

import { sendFloorError } from "../floors/routes.ts";

// A Floor's wall board (PRD FR-50, FR-57), a thin adapter over the
// orchestrator's: its issues in progress, with their Agents, stages, links
// and rounds, and its queues. Its Notices (`GET /api/notices?floorId=`)
// and its tokens against caps (`GET /api/floors/:floorId/token-usage`)
// have their own routes. It needs a signed-in session.

export function registerWallBoardRoutes(
  app: FastifyInstance,
  options: { readonly wallBoard: WallBoard },
): void {
  const { wallBoard } = options;

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/wall-board",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return await wallBoard.floorBoard(request.params.floorId);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );
}
