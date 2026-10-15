import type { ModelCatalogue, RequestHistory } from "@ai-office/gateway";
import {
  contextUsageBody,
  type Agents,
  type ContextUsage,
  type FreshStarts,
} from "@ai-office/orchestrator";
import {
  agentErrorCodes,
  freshStartErrorCodes,
  type ApiError,
  type FloorContextUsage,
  type FreshStartResponse,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { catalogueModelsOf } from "../ai-providers/routes.ts";
import { sendFloorError } from "../floors/routes.ts";

// The Context Usage API (PRD FR-84 to FR-87), a thin adapter over the
// office's Context Usage and Fresh Starts:
// - `GET /api/floors/:floorId/context-usage` lists each of the Floor's
//   Agents with a session going, with its latest model call's input
//   tokens, its Model's context window and the share of it used. The 2D
//   views and the 3D displays read it, then follow the
//   `agent.context_usage` events.
// - `POST /api/floors/:floorId/agents/:agentId/fresh-start` makes a Fresh
//   Start of the Agent's sandbox session at once (the "Fresh start" action
//   of its card and monitor): 202 with the session being ended, or 409
//   `no_session` when it has none going.
// Every route needs a session.

/** How long the model catalogue is read from memory before again. */
const catalogueCacheMs = 60_000;

/**
 * A Model's context window from the catalogue (null when it gives none),
 * the catalogue read at most once a minute: every model call asks.
 */
export function contextWindowOf(
  catalogue: Pick<ModelCatalogue, "list">,
  now: () => number = Date.now,
): (aiProvider: string, model: string) => Promise<number | null> {
  let cached:
    | {
        readonly at: number;
        readonly entries: ReturnType<ModelCatalogue["list"]>;
      }
    | undefined;
  return async (aiProvider, model) => {
    if (cached === undefined || now() - cached.at >= catalogueCacheMs) {
      const entries = catalogue.list();
      cached = { at: now(), entries };
      // A failed read is not kept.
      entries.catch(() => {
        if (cached?.entries === entries) {
          cached = undefined;
        }
      });
    }
    const { models } = catalogueModelsOf(await cached.entries, aiProvider);
    return models.find((entry) => entry.model === model)?.contextWindow ?? null;
  };
}

/** Tells `usage` of every model call the Gateway records from now on. */
export const observeModelCalls = (
  history: Pick<RequestHistory, "subscribe">,
  usage: ContextUsage,
  onError: (error: unknown) => void,
): (() => void) =>
  history.subscribe((request) => {
    usage.observe(request).catch(onError);
  });

export function registerContextUsageRoutes(
  app: FastifyInstance,
  options: {
    readonly agents: Pick<Agents, "list">;
    readonly contextUsage: ContextUsage;
    /** Fresh Starts; without them no session can be ended. */
    readonly freshStarts?: Pick<FreshStarts, "request"> | undefined;
  },
): void {
  app.get<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/context-usage",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId } = request.params;
      try {
        const onFloor = new Set(
          (await options.agents.list(floorId)).map(({ id }) => id),
        );
        const body: FloorContextUsage = {
          agents: options.contextUsage
            .onFloor(floorId)
            .filter(({ agentId }) => onFloor.has(agentId))
            .map(contextUsageBody),
        };
        return body;
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.post<{ Params: { readonly floorId: string; readonly agentId: string } }>(
    "/api/floors/:floorId/agents/:agentId/fresh-start",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { floorId, agentId } = request.params;
      try {
        const onFloor = await options.agents.list(floorId);
        const agent = onFloor.find(({ id }) => id === agentId);
        if (agent === undefined) {
          const body: ApiError = {
            error: agentErrorCodes.agentNotFound,
            message: "There is no such Agent on this Floor.",
          };
          return await reply.code(404).send(body);
        }
        const session = options.freshStarts?.request(floorId, agentId);
        if (session === undefined) {
          const body: ApiError = {
            error: freshStartErrorCodes.noSession,
            message: `${agent.name} has no sandbox session going, so there is nothing to start afresh.`,
          };
          return await reply.code(409).send(body);
        }
        const body: FreshStartResponse = { session };
        return await reply.code(202).send(body);
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );
}
