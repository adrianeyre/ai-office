import {
  BatchError,
  FloorError,
  type AcknowledgementRecord,
  type BatchRecord,
  type BatchStore,
  type Batches,
  type FloorStore,
  type PlanRecord,
} from "@ai-office/orchestrator";
import {
  batchErrorCodes,
  floorErrorCodes,
  planApprovalSchema,
  planEditSchema,
  type ApiError,
  type Batch,
  type BatchDetail,
  type BatchErrorCode,
  type BatchList,
  type Plan,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// A Floor's Batches and their Plans (PRD FR-25): what the Owner handed the
// Manager, and each version of the Plan it drafted. Batches are made in the
// Manager chat. A Plan awaiting approval is edited and approved on the
// Floor's whiteboard (FR-25.3, FR-58): the Owner's edits are replanned by
// the Manager as the next version, and approving the latest version starts
// the work. Both name the version they were made on, and answer the Batch
// with every version of its Plan. A Batch carries its Kickoff's
// acknowledgements and, once it has finished, its Wrap-up's results
// (FR-25.2, FR-25.6). Every route needs a signed-in session.

const statusFor: Record<BatchErrorCode, number> = {
  [batchErrorCodes.batchNotFound]: 404,
  [batchErrorCodes.notAwaitingApproval]: 409,
  [batchErrorCodes.planChanged]: 409,
  [batchErrorCodes.invalidPlanEdit]: 400,
};

/** How many of a Floor's Batches the list gives, newest first. */
const listSize = 50;

export const planBody = (plan: PlanRecord): Plan => ({
  ...plan,
  items: plan.items.map((item) => ({
    ...item,
    dependsOn: [...item.dependsOn],
    files: [...item.files],
  })),
  overlaps: plan.overlaps.map(({ issues, files }) => ({
    issues: [issues[0], issues[1]],
    files: [...files],
  })),
  parallel: plan.parallel.map((group) => [...group]),
  leftOut: plan.leftOut.map((left) => ({ ...left })),
  createdAt: plan.createdAt.toISOString(),
});

const batchBody = (
  batch: BatchRecord,
  plan: PlanRecord,
  started: readonly number[],
  acknowledgements: readonly AcknowledgementRecord[],
): Batch => ({
  ...batch,
  issues: [...batch.issues],
  createdAt: batch.createdAt.toISOString(),
  startedAt: batch.startedAt?.toISOString() ?? null,
  started: [...started],
  plan: planBody(plan),
  acknowledgements: acknowledgements.map((acknowledgement) => ({
    ...acknowledgement,
    createdAt: acknowledgement.createdAt.toISOString(),
  })),
  finishedAt: batch.finishedAt?.toISOString() ?? null,
  wrapUp: batch.wrapUp,
});

/** A Batch's id from the address, if it is one. */
const batchIdOf = (batchId: string): number | undefined =>
  /^[1-9]\d{0,15}$/.test(batchId) ? Number(batchId) : undefined;

interface FloorParams {
  readonly floorId: string;
}

const notFound = (reply: FastifyReply): FastifyReply => {
  const body: ApiError = {
    error: batchErrorCodes.batchNotFound,
    message: "The Floor has no such Batch.",
  };
  return reply.code(404).send(body);
};

export function registerBatchRoutes(
  app: FastifyInstance,
  options: {
    readonly batches: BatchStore;
    readonly floors: FloorStore;
    /** Edits and approves Plans; absent without the GitHub App. */
    readonly plans?: Pick<Batches, "edit" | "approve"> | undefined;
  },
): void {
  const { batches, floors, plans } = options;

  const assertFloor = async (floorId: string): Promise<void> => {
    if ((await floors.get(floorId)) === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
  };

  /** The Batch with its latest Plan and started issues; undefined without a Plan. */
  const withPlan = async (batch: BatchRecord): Promise<Batch | undefined> => {
    const plan = await batches.latestPlan(batch.id);
    if (plan === undefined) {
      return undefined;
    }
    const started = await batches.started(batch.id);
    return batchBody(
      batch,
      plan,
      started.map(({ issue }) => issue),
      await batches.acknowledgements(batch.id),
    );
  };

  /** The Batch with every version of its Plan; undefined if it is not the Floor's. */
  const detail = async (
    floorId: string,
    batchId: string,
  ): Promise<BatchDetail | undefined> => {
    const id = batchIdOf(batchId);
    const batch = id === undefined ? undefined : await batches.get(id);
    const found =
      batch?.floorId !== floorId ? undefined : await withPlan(batch);
    if (batch === undefined || found === undefined) {
      return undefined;
    }
    return {
      batch: found,
      plans: (await batches.plans(batch.id)).map(planBody),
    };
  };

  /** Answers a refused edit or approval with its status. */
  const sendRefusal = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof BatchError) {
      const body: ApiError = { error: error.code, message: error.message };
      return reply.code(statusFor[error.code]).send(body);
    }
    return sendFloorError(reply, error);
  };

  /** Edits or approves the Floor's Batch, answering it with every version. */
  const change = async (
    floorId: string,
    batchId: string,
    reply: FastifyReply,
    work: (
      plans: Pick<Batches, "edit" | "approve">,
      batchId: number,
    ) => Promise<unknown>,
  ): Promise<FastifyReply | BatchDetail> => {
    if (plans === undefined) {
      return sendFloorError(
        reply,
        new FloorError(
          floorErrorCodes.githubNotConfigured,
          "Batches need the GitHub App, which is not configured.",
        ),
      );
    }
    const id = batchIdOf(batchId);
    try {
      if (id === undefined) {
        throw new BatchError(
          batchErrorCodes.batchNotFound,
          "The Floor has no such Batch.",
        );
      }
      await work(plans, id);
    } catch (error) {
      return sendRefusal(reply, error);
    }
    return (await detail(floorId, batchId)) ?? notFound(reply);
  };

  app.get<{ Params: FloorParams }>(
    "/api/floors/:floorId/batches",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await assertFloor(request.params.floorId);
      } catch (error) {
        return sendFloorError(reply, error);
      }
      const list: Batch[] = [];
      for (const batch of await batches.list(
        request.params.floorId,
        listSize,
      )) {
        const body = await withPlan(batch);
        if (body !== undefined) {
          list.push(body);
        }
      }
      const body: BatchList = { batches: list };
      return body;
    },
  );

  app.get<{ Params: FloorParams & { readonly batchId: string } }>(
    "/api/floors/:floorId/batches/:batchId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId, batchId } = request.params;
      try {
        await assertFloor(floorId);
      } catch (error) {
        return sendFloorError(reply, error);
      }
      return (await detail(floorId, batchId)) ?? notFound(reply);
    },
  );

  // The Owner's edits to a Plan awaiting approval: the Manager replans.
  app.post<{ Params: FloorParams & { readonly batchId: string } }>(
    "/api/floors/:floorId/batches/:batchId/plan",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = planEditSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { floorId, batchId } = request.params;
      const answer = await change(floorId, batchId, reply, (edit, id) =>
        edit.edit(floorId, id, parsed.data),
      );
      return "batch" in answer ? reply.code(201).send(answer) : answer;
    },
  );

  // The Owner approves the Plan's latest version: its work starts.
  app.post<{ Params: FloorParams & { readonly batchId: string } }>(
    "/api/floors/:floorId/batches/:batchId/approve",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = planApprovalSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const { floorId, batchId } = request.params;
      return change(floorId, batchId, reply, (approve, id) =>
        approve.approve(floorId, id, parsed.data.version),
      );
    },
  );
}
