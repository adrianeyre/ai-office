import {
  FloorError,
  MemoryError,
  type RepositoryMemoryShelf,
  type RoleEntryRecord,
  type SharedMemory,
} from "@ai-office/orchestrator";
import {
  memoryErrorCodes,
  officeMemoryUpdateSchema,
  roleMemoryRejectionSchema,
  type ApiError,
  type MemoryErrorCode,
  type OfficeMemory,
  type RepositoryMemoryView,
  type RoleMemoryEntry,
  type RoleMemoryList,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// Memory's API (PRD FR-53 to FR-56), a thin adapter over the
// orchestrator's: the office admin reads and saves the office-wide memory,
// refused (naming the lines) when any looks like a credential; a Floor's
// admin lists its Role memory, and accepts, rejects and removes entries as
// the Owner; a Floor's bookshelf reads its repository memory (FR-58),
// which changes only through pull requests. Every route needs a signed-in
// session.

const statusFor: Record<MemoryErrorCode, number> = {
  [memoryErrorCodes.memoryHoldsSecret]: 422,
  [memoryErrorCodes.officeMemoryTooLong]: 422,
  [memoryErrorCodes.roleMemoryNotFound]: 404,
  [memoryErrorCodes.roleMemoryDecided]: 409,
  [memoryErrorCodes.roleMemoryNotAccepted]: 409,
  [memoryErrorCodes.roleMemoryFull]: 409,
};

/** Answers a `MemoryError` or `FloorError` with its status. */
const sendMemoryError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof FloorError) {
    return sendFloorError(reply, error);
  }
  if (!(error instanceof MemoryError)) {
    throw error;
  }
  const body: ApiError = {
    error: error.code,
    message: error.message,
    ...(error.problems === undefined ? {} : { problems: [...error.problems] }),
  };
  return reply.code(statusFor[error.code]).send(body);
};

/** A Role memory entry as the API sends it. */
export const roleMemoryEntryBody = (
  entry: RoleEntryRecord,
): RoleMemoryEntry => ({
  id: entry.id,
  role: entry.role,
  text: entry.text,
  status: entry.status,
  issue: entry.issue,
  agentId: entry.agentId,
  createdAt: entry.createdAt.toISOString(),
  decidedBy: entry.decidedBy,
  decidedAt: entry.decidedAt?.toISOString() ?? null,
  reason: entry.reason,
});

interface EntryParams {
  readonly floorId: string;
  readonly entryId: string;
}

/** The entry's id, if the path holds one. */
const entryIdOf = (text: string): number | undefined =>
  /^[1-9]\d{0,15}$/.test(text) ? Number(text) : undefined;

const notFound = (reply: FastifyReply): FastifyReply =>
  reply.code(404).send({
    error: memoryErrorCodes.roleMemoryNotFound,
    message: "There is no such Role memory entry.",
  } satisfies ApiError);

export function registerMemoryRoutes(
  app: FastifyInstance,
  options: {
    readonly memory: SharedMemory;
    readonly repositoryMemory: RepositoryMemoryShelf;
  },
): void {
  const { memory, repositoryMemory } = options;

  app.get(
    "/api/memory/office",
    { config: { access: "owner" } },
    async (): Promise<OfficeMemory> => {
      const { content, updatedAt } = await memory.office();
      return { content, updatedAt: updatedAt?.toISOString() ?? null };
    },
  );

  app.put(
    "/api/memory/office",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = officeMemoryUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const { content, updatedAt } = await memory.setOffice(
          parsed.data.content,
        );
        request.log.info("The office-wide memory was saved.");
        return {
          content,
          updatedAt: updatedAt.toISOString(),
        } satisfies OfficeMemory;
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/role-memory",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const entries = await memory.roleEntries(request.params.floorId);
        return {
          entries: entries.map(roleMemoryEntryBody),
        } satisfies RoleMemoryList;
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/repository-memory",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const shown: RepositoryMemoryView = await repositoryMemory.show(
          request.params.floorId,
        );
        if (shown.readError !== null) {
          request.log.warn(
            { floorId: request.params.floorId },
            shown.readError,
          );
        }
        return shown;
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );

  app.post<{ Params: EntryParams }>(
    "/api/floors/:floorId/role-memory/:entryId/accept",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = entryIdOf(request.params.entryId);
      if (id === undefined) {
        return notFound(reply);
      }
      try {
        return roleMemoryEntryBody(
          await memory.decide(request.params.floorId, id, "accept", {
            by: "owner",
          }),
        );
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );

  app.post<{ Params: EntryParams }>(
    "/api/floors/:floorId/role-memory/:entryId/reject",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = entryIdOf(request.params.entryId);
      if (id === undefined) {
        return notFound(reply);
      }
      const parsed = roleMemoryRejectionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        return roleMemoryEntryBody(
          await memory.decide(
            request.params.floorId,
            id,
            "reject",
            { by: "owner" },
            parsed.data.reason,
          ),
        );
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );

  app.delete<{ Params: EntryParams }>(
    "/api/floors/:floorId/role-memory/:entryId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = entryIdOf(request.params.entryId);
      if (id === undefined) {
        return notFound(reply);
      }
      try {
        return roleMemoryEntryBody(
          await memory.remove(request.params.floorId, id),
        );
      } catch (error) {
        return sendMemoryError(reply, error);
      }
    },
  );
}
