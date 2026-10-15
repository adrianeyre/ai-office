import type { Branches } from "@ai-office/orchestrator";
import type { FastifyInstance } from "fastify";

import { sendFloorError } from "../floors/routes.ts";

// A Floor's AI Office branches (the Branches page), a thin adapter over the
// orchestrator's: each branch AI Office made, as a lane off the Floor's
// default branch, with its commits, issue, pull request, CI and Agent. It
// only reads; GitHub is asked by the server, with the App's installation
// token, which never reaches the browser. It needs a signed-in session.

export function registerBranchRoutes(
  app: FastifyInstance,
  options: { readonly branches: Branches },
): void {
  const { branches } = options;

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/branches",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return await branches.floorBranches(request.params.floorId);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );
}
