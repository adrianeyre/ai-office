import type { TokenCapService } from "@ai-office/orchestrator";
import {
  apiErrorCodes,
  issueTokenCapsRequestSchema,
  officeTokenCapsSchema,
  type ApiError,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// The Token Caps API (PRD FR-31, FR-32), a thin adapter over the
// orchestrator's Token Caps: the office's default caps with the Office's
// use, a Floor's caps with its Agents' and issues' use, and issues' own
// caps. Floors' caps are Floor settings, and Agents' are part of the
// Agent editor. Every route needs a signed-in session.

export function registerTokenCapRoutes(
  app: FastifyInstance,
  options: { readonly caps: TokenCapService },
): void {
  const { caps } = options;

  app.get("/api/office/token-caps", { config: { access: "owner" } }, () =>
    caps.officeUsage(),
  );

  app.put(
    "/api/office/token-caps",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = officeTokenCapsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      await caps.setOfficeCaps(parsed.data);
      return caps.officeUsage();
    },
  );

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/token-usage",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return await caps.floorUsage(request.params.floorId);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.put<{ Params: { readonly floorId: string; readonly issue: string } }>(
    "/api/floors/:floorId/issues/:issue/token-caps",
    { config: { access: "owner" } },
    async (request, reply) => {
      const issue = Number(request.params.issue);
      if (
        !/^\d+$/.test(request.params.issue) ||
        issue < 1 ||
        issue > 2 ** 31 - 1
      ) {
        const body: ApiError = {
          error: apiErrorCodes.invalidRequest,
          problems: ["Name the issue by its number."],
        };
        return reply.code(400).send(body);
      }
      const parsed = issueTokenCapsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        return await caps.setIssueCaps(
          request.params.floorId,
          issue,
          parsed.data,
        );
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );
}
