import {
  FloorError,
  RecurringGoalError,
  type FloorStore,
  type RecurringGoals,
} from "@ai-office/orchestrator";
import {
  floorErrorCodes,
  recurringGoalErrorCodes,
  recurringGoalInputSchema,
  recurringGoalUpdateSchema,
  type ApiError,
  type RecurringGoal,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// A Floor's Recurring Goals in its admin (Scorecards PRD, FR-136, FR-141;
// ADR 0018), a thin adapter over the orchestrator's Recurring Goals: list
// them with each one's last and next run and the Office's time zone; add
// one; change one (turning it off or on among the changes); delete one;
// and Run now. Only the Owner reaches these: every route needs the
// Owner's session, and nothing else in AI Office changes a Recurring Goal.

interface GoalParams {
  readonly floorId: string;
  readonly id: string;
}

/** What each route answers: every Recurring Goal on the Floor. */
interface GoalList {
  readonly recurringGoals: RecurringGoal[];
  readonly timeZone: string;
}

const statusOf: Readonly<
  Record<
    (typeof recurringGoalErrorCodes)[keyof typeof recurringGoalErrorCodes],
    number
  >
> = {
  [recurringGoalErrorCodes.notFound]: 404,
  [recurringGoalErrorCodes.nameTaken]: 409,
  [recurringGoalErrorCodes.tooMany]: 409,
  [recurringGoalErrorCodes.running]: 409,
};

/** Answers a `RecurringGoalError` or `FloorError`; anything else is rethrown. */
const sendError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof RecurringGoalError)) {
    return sendFloorError(reply, error);
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusOf[error.code]).send(body);
};

/** An id from the path; undefined unless a positive integer. */
const idOf = (id: string): number | undefined =>
  /^[1-9]\d{0,15}$/.test(id) ? Number(id) : undefined;

const notFound = () =>
  new RecurringGoalError(
    recurringGoalErrorCodes.notFound,
    "The Floor has no such Recurring Goal.",
  );

export function registerRecurringGoalRoutes(
  app: FastifyInstance,
  options: {
    readonly recurringGoals: RecurringGoals;
    readonly floors: Pick<FloorStore, "get">;
    /** The Office's time zone, which every schedule is in. */
    readonly timeZone: () => Promise<string>;
  },
): void {
  const { recurringGoals } = options;

  /** The Floor, which must be in use to be changed (FR-9). */
  const floorOf = async (floorId: string, changing: boolean) => {
    const floor = await options.floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    if (changing && floor.archivedAt !== null) {
      throw new FloorError(
        floorErrorCodes.floorArchived,
        `${floor.name} is archived, so its Recurring Goals cannot change.`,
      );
    }
    return floor;
  };

  const list = async (floorId: string): Promise<GoalList> => ({
    recurringGoals: await recurringGoals.list(floorId),
    timeZone: await options.timeZone(),
  });

  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/recurring-goals",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await floorOf(request.params.floorId, false);
        return await list(request.params.floorId);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/recurring-goals",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = recurringGoalInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        await floorOf(request.params.floorId, true);
        await recurringGoals.create(request.params.floorId, parsed.data);
        return await reply.code(201).send(await list(request.params.floorId));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.patch<{ Params: GoalParams }>(
    "/api/floors/:floorId/recurring-goals/:id",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = idOf(request.params.id);
      if (id === undefined) {
        return sendError(reply, notFound());
      }
      const parsed = recurringGoalUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        await floorOf(request.params.floorId, true);
        await recurringGoals.update(request.params.floorId, id, parsed.data);
        return await list(request.params.floorId);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.delete<{ Params: GoalParams }>(
    "/api/floors/:floorId/recurring-goals/:id",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = idOf(request.params.id);
      if (id === undefined) {
        return sendError(reply, notFound());
      }
      try {
        await floorOf(request.params.floorId, true);
        await recurringGoals.remove(request.params.floorId, id);
        return await list(request.params.floorId);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: GoalParams }>(
    "/api/floors/:floorId/recurring-goals/:id/run",
    { config: { access: "owner" } },
    async (request, reply) => {
      const id = idOf(request.params.id);
      if (id === undefined) {
        return sendError(reply, notFound());
      }
      try {
        await floorOf(request.params.floorId, true);
        await recurringGoals.runNow(request.params.floorId, id);
        return await reply.code(202).send(await list(request.params.floorId));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
