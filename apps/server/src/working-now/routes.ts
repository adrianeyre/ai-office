import type { EventBus } from "@ai-office/events";
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
    /** The event log: each issue's title, and each sandbox's last step. */
    readonly events: Pick<EventBus, "history">;
  },
): void {
  const titleOf = async (floorId: string, issue: number) => {
    const [picked] = await options.events.history({
      filter: { floorId, issue, types: ["issue.picked_up"] },
      limit: 1,
    });
    return picked?.event.type === "issue.picked_up" ? picked.event.title : null;
  };
  const latestOf = async (
    floorId: string,
    agentId: string,
    issue: number,
    since: Date,
  ): Promise<WorkingAgent["latest"]> => {
    const [last] = await options.events.history({
      filter: {
        floorId,
        agentId,
        issue,
        types: ["sandbox.text", "sandbox.tool_call"],
      },
      from: since,
      limit: 1,
    });
    if (last === undefined) {
      return null;
    }
    const at = last.occurredAt.toISOString();
    return last.event.type === "sandbox.text"
      ? { kind: "text", text: last.event.text, at }
      : last.event.type === "sandbox.tool_call"
        ? {
            kind: "tool",
            text: `${last.event.name} ${last.event.args}`.trim(),
            at,
          }
        : null;
  };
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
    const work = (
      await Promise.all(
        (await options.work.active()).map(
          async (item): Promise<WorkingAgent[]> => {
            const floor = floors.get(item.floorId);
            if (floor === undefined) {
              return [];
            }
            const agent =
              item.agentId === null ? undefined : agents.get(item.agentId);
            const [issueTitle, latest] = await Promise.all([
              titleOf(floor.id, item.issue),
              item.status === "running" &&
              item.agentId !== null &&
              item.startedAt !== null
                ? latestOf(floor.id, item.agentId, item.issue, item.startedAt)
                : null,
            ]);
            return [
              {
                id: item.id,
                floorId: floor.id,
                floorName: floor.name,
                repository: floor.repository,
                issue: item.issue,
                issueTitle,
                stage: item.stage,
                status: item.status === "running" ? "running" : "queued",
                agentId: item.agentId,
                agentName: agent?.name ?? null,
                role: item.role ?? agent?.role ?? null,
                queuedAt: item.createdAt.toISOString(),
                startedAt: item.startedAt?.toISOString() ?? null,
                latest,
              },
            ];
          },
        ),
      )
    ).flat();
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
