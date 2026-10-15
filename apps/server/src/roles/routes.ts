import {
  RoleError,
  type RoleLibrary,
  type RoleWithUsage,
} from "@ai-office/orchestrator";
import {
  createRoleRequestSchema,
  duplicateRoleRequestSchema,
  roleErrorCodes,
  updateRoleRequestSchema,
  type ApiError,
  type LibraryRole,
  type RoleErrorCode,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Role library API (PRD FR-98, FR-65), a thin adapter over the
// orchestrator's Role library: list the Roles with how many Agents fill
// each, read one, make one, duplicate one, edit one (which reaches every
// Agent with it), and delete one no Agent fills. Every route needs a
// signed-in session.

const statusFor: Record<RoleErrorCode, number> = {
  [roleErrorCodes.roleNotFound]: 404,
  [roleErrorCodes.invalidRole]: 400,
  [roleErrorCodes.roleNameTaken]: 409,
  [roleErrorCodes.roleInUse]: 409,
  [roleErrorCodes.roleInStartingTeam]: 409,
  [roleErrorCodes.stageInUse]: 409,
  [roleErrorCodes.skillNotFound]: 400,
  [roleErrorCodes.modelNotInCatalogue]: 400,
};

/** A Role as the API sends it. */
export const roleBody = (role: RoleWithUsage): LibraryRole => ({
  id: role.id,
  name: role.name,
  stage: role.stage,
  description: role.description,
  instructions: role.instructions,
  skills: [...role.skills],
  deskDressing: role.deskDressing,
  aiProvider: role.aiProvider,
  model: role.model,
  agents: role.agents,
  inStartingTeam: role.inStartingTeam,
});

/** Answers a `RoleError` with its status; anything else is rethrown. */
const sendRoleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof RoleError)) {
    throw error;
  }
  const body: ApiError = {
    error: error.code,
    message: error.message,
    ...(error.problems === undefined ? {} : { problems: [...error.problems] }),
  };
  return reply.code(statusFor[error.code]).send(body);
};

interface RoleParams {
  readonly roleId: string;
}

export function registerRoleRoutes(
  app: FastifyInstance,
  options: { readonly roles: RoleLibrary },
): void {
  const { roles } = options;

  app.get("/api/roles", { config: { access: "owner" } }, async () => ({
    roles: (await roles.list()).map(roleBody),
  }));

  app.get<{ Params: RoleParams }>(
    "/api/roles/:roleId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        return roleBody(await roles.get(request.params.roleId));
      } catch (error) {
        return sendRoleError(reply, error);
      }
    },
  );

  app.post(
    "/api/roles",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = createRoleRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const role = await roles.create(parsed.data);
        request.log.info({ roleId: role.id }, "A Role was made.");
        return await reply.code(201).send(roleBody(role));
      } catch (error) {
        return sendRoleError(reply, error);
      }
    },
  );

  app.post<{ Params: RoleParams }>(
    "/api/roles/:roleId/duplicate",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = duplicateRoleRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const role = await roles.duplicate(
          request.params.roleId,
          parsed.data.name,
        );
        request.log.info(
          { roleId: role.id, from: request.params.roleId },
          "A Role was duplicated.",
        );
        return await reply.code(201).send(roleBody(role));
      } catch (error) {
        return sendRoleError(reply, error);
      }
    },
  );

  app.patch<{ Params: RoleParams }>(
    "/api/roles/:roleId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = updateRoleRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const role = await roles.update(request.params.roleId, parsed.data);
        request.log.info(
          { roleId: role.id, agents: role.agents },
          "A Role was changed.",
        );
        return roleBody(role);
      } catch (error) {
        return sendRoleError(reply, error);
      }
    },
  );

  app.delete<{ Params: RoleParams }>(
    "/api/roles/:roleId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await roles.remove(request.params.roleId);
        request.log.info(
          { roleId: request.params.roleId },
          "A Role was deleted.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendRoleError(reply, error);
      }
    },
  );
}
