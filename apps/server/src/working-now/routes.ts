import type {
  AgentRecord,
  FloorStore,
  FloorStops,
  ManagerChat,
  WorkQueueStore,
} from "@ai-office/orchestrator";
import {
  workingNowErrorCodes,
  type ApiError,
  type WorkingAgent,
  type WorkingManager,
  type WorkingNow,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

// The Working now page's API: every Agent's work, running or queued, and
// every Manager answering, across the Floors in use; and stopping any one
// of them, the Owner's choice. Work stopped is cancelled, its sandbox
// stopped, rather than queued again as "Stop everything" does.

export function registerWorkingNowRoutes(
  app: FastifyInstance,
  options: {
    readonly floors: Pick<FloorStore, "list">;
    readonly agents: { list(floorId: string): Promise<AgentRecord[]> };
    readonly work: Pick<WorkQueueStore, "active">;
    readonly stops: Pick<FloorStops, "cancel">;
    readonly managerChat: Pick<ManagerChat, "working" | "end">;
  },
): void {
  const workingNow = async (): Promise<WorkingNow> => {
    const floors = new Map(
      (await options.floors.list()).map((floor) => [floor.id, floor]),
    );
    const agents = new Map(
      (
        await Promise.all(
          [...floors.keys()].map((floorId) => options.agents.list(floorId)),
        )
      )
        .flat()
        .map((agent) => [agent.id, agent]),
    );
    const work = (await options.work.active()).flatMap(
      (item): WorkingAgent[] => {
        const floor = floors.get(item.floorId);
        if (floor === undefined) {
          return [];
        }
        const agent =
          item.agentId === null ? undefined : agents.get(item.agentId);
        return [
          {
            id: item.id,
            floorId: floor.id,
            floorName: floor.name,
            repository: floor.repository,
            issue: item.issue,
            stage: item.stage,
            status: item.status === "running" ? "running" : "queued",
            agentId: item.agentId,
            agentName: agent?.name ?? null,
            role: item.role ?? agent?.role ?? null,
            queuedAt: item.createdAt.toISOString(),
            startedAt: item.startedAt?.toISOString() ?? null,
          },
        ];
      },
    );
    const managers = options.managerChat
      .working()
      .flatMap(({ floorId, phase, since }): WorkingManager[] => {
        const floor = floors.get(floorId);
        if (floor === undefined) {
          return [];
        }
        const manager = [...agents.values()].find(
          (agent) => agent.floorId === floorId && agent.role === "manager",
        );
        return [
          {
            floorId,
            floorName: floor.name,
            agentId: manager?.id ?? null,
            agentName: manager?.name ?? "The Manager",
            phase,
            since: since.toISOString(),
          },
        ];
      });
    return { work, managers };
  };

  app.get("/api/working-now", { config: { access: "owner" } }, workingNow);

  app.post<{ Params: { workId: string } }>(
    "/api/working-now/work/:workId/stop",
    { config: { access: "owner" } },
    async (request, reply) => {
      const workId = Number(request.params.workId);
      const stopped =
        Number.isSafeInteger(workId) && (await options.stops.cancel(workId));
      if (!stopped) {
        const body: ApiError = {
          error: workingNowErrorCodes.workNotFound,
          message: "That work is not running or queued any more.",
        };
        return reply.code(404).send(body);
      }
      request.log.info({ workId }, "The Owner stopped a piece of work.");
      return workingNow();
    },
  );

  app.post<{ Params: { floorId: string } }>(
    "/api/working-now/managers/:floorId/stop",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId } = request.params;
      if (
        !options.managerChat.working().some((each) => each.floorId === floorId)
      ) {
        const body: ApiError = {
          error: workingNowErrorCodes.managerNotWorking,
          message: "That Manager is not answering any more.",
        };
        return reply.code(404).send(body);
      }
      await options.managerChat.end(floorId);
      request.log.info({ floorId }, "The Owner stopped a Manager's answer.");
      return workingNow();
    },
  );
}
