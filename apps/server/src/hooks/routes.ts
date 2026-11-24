import { HookError, type HooksAdmin } from "@ai-office/orchestrator";
import {
  hookErrorCodes,
  hookInputSchema,
  type ApiError,
  type HookErrorCode,
  type HookList,
  type StartedHookRun,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// A Floor's Hooks in its admin (Guidelines, Specs and Hooks PRD, FR-121;
// ADR 0016), a thin adapter over the orchestrator's Hooks admin: list
// them with their latest runs and the Skills a Hook can run; add one,
// change the whole of one (turning it off or on among the changes), delete
// one; and Run now. Only the Owner reaches these: every route needs the
// Owner's session, and nothing else in AI Office changes a Hook.

interface HookParams {
  readonly floorId: string;
  readonly id: string;
}

/** Each refusal's status. */
const statusOf: Readonly<Record<HookErrorCode, number>> = {
  [hookErrorCodes.hookNotFound]: 404,
  [hookErrorCodes.hookNameTaken]: 409,
  [hookErrorCodes.hookInvalid]: 400,
  [hookErrorCodes.hookNotRunNow]: 409,
  [hookErrorCodes.hookDisabled]: 409,
  [hookErrorCodes.hookRateLimited]: 429,
  [hookErrorCodes.hookRunning]: 409,
};

/** Answers a `HookError` or `FloorError`; anything else is rethrown. */
const sendHookError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof HookError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusOf[error.code]).send(body);
};

/** A Hook's id from the path; undefined unless a positive integer. */
const hookIdOf = (id: string): number | undefined =>
  /^[1-9]\d{0,15}$/.test(id) ? Number(id) : undefined;

const notFound = () =>
  new HookError(hookErrorCodes.hookNotFound, "The Floor has no such Hook.");

export function registerHookRoutes(
  app: FastifyInstance,
  options: { readonly hooks: HooksAdmin },
): void {
  const { hooks } = options;

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/hooks",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const list: HookList = await hooks.list(request.params.floorId);
        return list;
      } catch (error) {
        return sendHookError(reply, error);
      }
    },
  );

  app.post<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/hooks",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = hookInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const list: HookList = await hooks.create(
          request.params.floorId,
          parsed.data,
        );
        return await reply.code(201).send(list);
      } catch (error) {
        return sendHookError(reply, error);
      }
    },
  );

  app.put<{ Params: HookParams }>(
    "/api/floors/:floorId/hooks/:id",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = hookIdOf(request.params.id);
      if (id === undefined) {
        return sendHookError(reply, notFound());
      }
      const parsed = hookInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const list: HookList = await hooks.update(
          request.params.floorId,
          id,
          parsed.data,
        );
        return list;
      } catch (error) {
        return sendHookError(reply, error);
      }
    },
  );

  app.delete<{ Params: HookParams }>(
    "/api/floors/:floorId/hooks/:id",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = hookIdOf(request.params.id);
      if (id === undefined) {
        return sendHookError(reply, notFound());
      }
      try {
        const list: HookList = await hooks.remove(request.params.floorId, id);
        return list;
      } catch (error) {
        return sendHookError(reply, error);
      }
    },
  );

  app.post<{ Params: HookParams }>(
    "/api/floors/:floorId/hooks/:id/run",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = hookIdOf(request.params.id);
      if (id === undefined) {
        return sendHookError(reply, notFound());
      }
      try {
        const started: StartedHookRun = await hooks.runNow(
          request.params.floorId,
          id,
        );
        return await reply.code(202).send(started);
      } catch (error) {
        return sendHookError(reply, error);
      }
    },
  );
}
