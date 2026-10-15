import {
  githubConnectionErrorCodes,
  GitHubConnectionError,
  type GitHubConnections,
} from "@ai-office/orchestrator";
import {
  githubAccessTokenConnectionCreateSchema,
  githubAppConnectionCreateSchema,
  githubConnectionUpdateSchema,
  type ApiError,
  type GitHubConnectionList,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The GitHub connections API (ADR 0011), the Owner's alone: list the
// GitHub Apps and access tokens AI Office reaches GitHub through, add one,
// rename, disable or remove it. No answer ever carries a private key or a
// token, and none is logged: only which connection changed.

const statusFor: Record<GitHubConnectionError["code"], number> = {
  [githubConnectionErrorCodes.notFound]: 404,
  [githubConnectionErrorCodes.appTaken]: 409,
};

/** Answers a `GitHubConnectionError` with its status; anything else is rethrown. */
const sendConnectionError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof GitHubConnectionError)) {
    throw error;
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

export function registerGitHubConnectionRoutes(
  app: FastifyInstance,
  options: { readonly connections: GitHubConnections },
): void {
  const { connections } = options;

  app.get(
    "/api/github/connections",
    { config: { access: "owner" } },
    async (): Promise<GitHubConnectionList> => ({
      connections: await connections.list(),
    }),
  );

  app.post(
    "/api/github/connections/apps",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = githubAppConnectionCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const added = await connections.addApp(parsed.data);
        request.log.info(
          { githubConnectionId: added.id, appId: added.appId },
          "A GitHub App was added.",
        );
        return await reply.code(201).send(added);
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );

  app.post(
    "/api/github/connections/access-tokens",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = githubAccessTokenConnectionCreateSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const added = await connections.addAccessToken(parsed.data);
      request.log.info(
        { githubConnectionId: added.id },
        "A GitHub access token was added.",
      );
      return reply.code(201).send(added);
    },
  );

  app.patch<{ Params: { readonly connectionId: string } }>(
    "/api/github/connections/:connectionId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = githubConnectionUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const updated = await connections.update(
          request.params.connectionId,
          parsed.data,
        );
        request.log.info(
          { githubConnectionId: updated.id, enabled: updated.enabled },
          "A GitHub connection was changed.",
        );
        return updated;
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );

  app.delete<{ Params: { readonly connectionId: string } }>(
    "/api/github/connections/:connectionId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await connections.remove(request.params.connectionId);
        request.log.info(
          { githubConnectionId: request.params.connectionId },
          "A GitHub connection was removed.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendConnectionError(reply, error);
      }
    },
  );
}
