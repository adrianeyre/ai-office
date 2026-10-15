import {
  accountsNearLimits,
  breakdownOf,
  seriesOf,
  topConsumersOf,
  type AiAccounts,
  type AnalyticsFilter,
  type AnalyticsNames,
  type RequestHistory,
} from "@ai-office/gateway";
import type { AgentStore, FloorStore } from "@ai-office/orchestrator";
import {
  analyticsBreakdownQuerySchema,
  analyticsRangeSchema,
  analyticsSeriesQuerySchema,
  aiAccountErrorCodes,
  communicationsAgentId,
  type ApiError,
  type AnalyticsBreakdown,
  type AnalyticsInsights,
  type AnalyticsSeries,
  type AnalyticsUsageWindows,
  type UsageReading,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The AI Gateway's analytics (PRD FR-43), a thin adapter over the request
// history and the AI Accounts, for a time range (`from`, `to`):
// - `GET /api/analytics/series`: the totals, and per hour or day, of every
//   request or only one AI Account's (`aiAccountId`, as AI Settings charts
//   each account);
// - `GET /api/analytics/breakdown?by=`: by AI Account, AI Provider, Model,
//   Floor, Agent, issue or Owner tool;
// - `GET /api/analytics/insights`: the top consumers, and the accounts
//   close to their limits;
// - `GET /api/analytics/usage-windows`: each account's usage-window
//   readings.
// Every route needs a signed-in session.

/** The most usage readings read per account. */
const maxReadings = 5_000;

export interface AnalyticsRoutesOptions {
  readonly history: RequestHistory;
  readonly accounts: AiAccounts;
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  readonly now: () => Date;
}

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  options: AnalyticsRoutesOptions,
): void {
  const { history, accounts } = options;

  /** Floors' and Agents' names, archived and removed ones by their id. */
  const names = async (): Promise<AnalyticsNames> => {
    const floors = await options.floors.list({ includeArchived: true });
    const teams = await Promise.all(
      floors.map((floor) => options.agents.list(floor.id)),
    );
    const floorNames = new Map(floors.map(({ id, name }) => [id, name]));
    const agentNames = new Map(
      teams.flat().map(({ id, name }) => [id, name] as const),
    );
    return {
      floor: (id) => floorNames.get(id) ?? id,
      agent: (id) =>
        agentNames.get(id) ??
        (id === communicationsAgentId ? "Communications Agent" : id),
    };
  };

  app.get(
    "/api/analytics/series",
    { config: { access: "owner" } },
    async (request, reply): Promise<AnalyticsSeries> => {
      const query = analyticsSeriesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const from = new Date(query.data.from);
      const to = new Date(query.data.to);
      const { bucket, aiAccountId } = query.data;
      let filter: AnalyticsFilter = {};
      if (aiAccountId !== undefined) {
        const account = (await accounts.list()).find(
          ({ id }) => id === aiAccountId,
        );
        if (account === undefined) {
          const error: ApiError = {
            error: aiAccountErrorCodes.aiAccountNotFound,
            message: "There is no such AI Account.",
          };
          return reply.code(404).send(error);
        }
        filter = { aiAccount: { id: account.id, name: account.name } };
      }
      return seriesOf(
        await history.analyticsRows(from, to, bucket, filter),
        from,
        to,
        bucket,
      );
    },
  );

  app.get(
    "/api/analytics/breakdown",
    { config: { access: "owner" } },
    async (request, reply): Promise<AnalyticsBreakdown> => {
      const query = analyticsBreakdownQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const rows = await history.analyticsRows(
        new Date(query.data.from),
        new Date(query.data.to),
        "day",
      );
      return breakdownOf(rows, query.data.by, await names());
    },
  );

  app.get(
    "/api/analytics/insights",
    { config: { access: "owner" } },
    async (request, reply): Promise<AnalyticsInsights> => {
      const query = analyticsRangeSchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const [rows, named, all] = await Promise.all([
        history.analyticsRows(
          new Date(query.data.from),
          new Date(query.data.to),
          "day",
        ),
        names(),
        accounts.list(),
      ]);
      return {
        topConsumers: topConsumersOf(rows, named),
        accountsNearLimits: accountsNearLimits(all, options.now()),
      };
    },
  );

  app.get(
    "/api/analytics/usage-windows",
    { config: { access: "owner" } },
    async (request, reply): Promise<AnalyticsUsageWindows> => {
      const query = analyticsRangeSchema.safeParse(request.query);
      if (!query.success) {
        return sendInvalidRequest(reply, query.error);
      }
      const from = new Date(query.data.from);
      const to = new Date(query.data.to);
      const all = await accounts.list();
      const read = await Promise.all(
        all.map(async (account) => ({
          accountId: account.id,
          name: account.name,
          aiProvider: account.aiProvider,
          readings: (
            await accounts.usageHistory(account.id, {
              since: from,
              limit: maxReadings,
            })
          )
            .filter(({ observedAt }) => observedAt < to)
            .reverse()
            .map((reading): UsageReading => ({
              window: reading.window,
              utilization: reading.utilization,
              resetsAt: reading.resetsAt.toISOString(),
              observedAt: reading.observedAt.toISOString(),
            })),
        })),
      );
      return { accounts: read.filter(({ readings }) => readings.length > 0) };
    },
  );
}
