import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  addTokens,
  communicationsAgentId,
  defaultOfficeTokenCaps,
  floorErrorCodes,
  noTokens,
  type TokenTotals,
  type TokenUsageRow,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createAgents, type Agents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { FloorError } from "../floors/errors.ts";
import { createFloors, type Floors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  communicationsCapRefusal,
  ownerToolCapRefusal,
  createTokenCaps,
  type TokenCapService,
} from "./token-caps.ts";

// Token accounting and Token Caps (PRD FR-31, FR-32): caps at the office,
// Floor, Agent and issue levels, the most specific applying, each shown
// with its use, from the AI Gateway's request records. Every case runs
// with the stores in memory and in Postgres 18.

const now = new Date("2026-10-09T15:00:00.000Z");
const today = new Date("2026-10-09T09:00:00.000Z");
const earlierThisMonth = new Date("2026-10-02T09:00:00.000Z");
const lastMonth = new Date("2026-09-30T23:00:00.000Z");

/** A request as the Gateway records it: who, when, and its tokens. */
interface Request {
  readonly at: Date;
  readonly floorId: string | null;
  readonly agentId: string | null;
  readonly issue: number | null;
  readonly ownerTool: string | null;
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
}

const totalsOf = (request: Request): TokenTotals => ({
  requests: 1,
  inputTokens: request.input,
  outputTokens: request.output,
  cacheReadTokens: request.cacheRead ?? 0,
  cacheWriteTokens: 0,
  tokens: request.input + request.output,
  estimatedCostUsd: 0,
});

/** The request history's rows for a period, added up per caller and issue. */
const rowsOf =
  (requests: readonly Request[]) =>
  (from: Date, to: Date): Promise<TokenUsageRow[]> => {
    const rows = new Map<string, TokenUsageRow>();
    for (const request of requests) {
      if (request.at < from || request.at >= to) {
        continue;
      }
      const caller = {
        floorId: request.floorId,
        agentId: request.agentId,
        issue: request.issue,
        ownerTool: request.ownerTool,
      };
      const key = JSON.stringify(caller);
      rows.set(key, {
        ...caller,
        totals: addTokens(rows.get(key)?.totals ?? noTokens, totalsOf(request)),
      });
    }
    return Promise.resolve([...rows.values()]);
  };

interface Setup {
  readonly floors: Floors;
  readonly agents: Agents;
  readonly stores: OfficeStores;
  readonly requests: Request[];
  readonly caps: TokenCapService;
  readonly events: () => Promise<OfficeEvent[]>;
  /** web-shop's team: its Manager and coder, and blog's coder. */
  readonly team: () => Promise<{
    readonly ada: AgentRecord;
    readonly linus: AgentRecord;
    readonly grace: AgentRecord;
  }>;
}

function setUp(stores: OfficeStores, bus: EventBus): Setup {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const requests: Request[] = [];
  const floors = createFloors({ store: stores.floors, github, events: bus });
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
  });
  return {
    floors,
    agents,
    stores,
    requests,
    caps: createTokenCaps({
      store: stores.tokenCaps,
      floors: stores.floors,
      agents: stores.agents,
      events: bus,
      usage: rowsOf(requests),
      now: () => now,
    }),
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
    async team() {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/blog");
      const [ada, linus] = await stores.agents.list("web-shop");
      const [, grace] = await stores.agents.list("blog");
      if (ada === undefined || linus === undefined || grace === undefined) {
        throw new Error("The Floors have no team.");
      }
      return { ada, linus, grace };
    },
  };
}

const by = (agent: AgentRecord, issue: number | null = null) => ({
  floorId: agent.floorId,
  agentId: agent.id,
  issue,
  ownerTool: null,
});

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "starts from the office's defaults, and keeps the Owner's caps",
    async ({ caps, events }) => {
      expect(await caps.officeCaps()).toEqual(defaultOfficeTokenCaps);
      expect(
        await caps.setOfficeCaps({ daily: 2_000_000, monthly: 30_000_000 }),
      ).toEqual({ daily: 2_000_000, monthly: 30_000_000 });
      expect(await caps.officeCaps()).toEqual({
        daily: 2_000_000,
        monthly: 30_000_000,
      });
      expect((await events()).at(-1)).toEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["tokenCaps.daily", "tokenCaps.monthly"],
      });
      const before = (await events()).length;
      await caps.setOfficeCaps({ daily: 2_000_000, monthly: 30_000_000 });
      expect(await events()).toHaveLength(before);
    },
  ],
  [
    "applies the most specific cap set, counting the issue's tokens for an issue's cap and the Agent's for the others",
    async ({ caps, agents, floors, requests, team }) => {
      const { ada, linus } = await team();
      await caps.setOfficeCaps({ daily: 10_000, monthly: 100_000 });
      requests.push(
        { at: today, ...by(ada, 4), input: 300, output: 100 },
        { at: today, ...by(ada), input: 50, output: 50 },
        // Another Agent on the same issue counts for the issue's cap.
        { at: today, ...by(linus, 4), input: 1_000, output: 0 },
        { at: earlierThisMonth, ...by(ada), input: 2_000, output: 0 },
        // Last month's never count.
        { at: lastMonth, ...by(ada, 4), input: 99_999, output: 0 },
      );

      // The office's, counting Ada's own tokens.
      expect(
        await caps.capUse({ floorId: "web-shop", agentId: ada.id, issue: 4 }),
      ).toEqual({
        daily: { level: "office", cap: 10_000, used: 500 },
        monthly: { level: "office", cap: 100_000, used: 2_500 },
      });

      // The Floor's beats the office's.
      await floors.updateSettings("web-shop", {
        tokenCaps: { daily: 8_000, monthly: null },
      });
      expect(
        await caps.capUse({ floorId: "web-shop", agentId: ada.id }),
      ).toEqual({
        daily: { level: "floor", cap: 8_000, used: 500 },
        monthly: { level: "office", cap: 100_000, used: 2_500 },
      });

      // The Agent's beats the Floor's.
      await agents.update("web-shop", ada.id, {
        tokenCaps: { daily: 6_000, monthly: 50_000 },
      });
      expect(
        await caps.capUse({ floorId: "web-shop", agentId: ada.id, issue: 4 }),
      ).toEqual({
        daily: { level: "agent", cap: 6_000, used: 500 },
        monthly: { level: "agent", cap: 50_000, used: 2_500 },
      });

      // The issue's beats them all, and counts everyone's tokens on it.
      await caps.setIssueCaps("web-shop", 4, { daily: 3_000, monthly: null });
      expect(
        await caps.capUse({ floorId: "web-shop", agentId: ada.id, issue: 4 }),
      ).toEqual({
        daily: { level: "issue", cap: 3_000, used: 1_400 },
        monthly: { level: "agent", cap: 50_000, used: 2_500 },
      });
      // Not on another issue.
      expect(
        await caps.capUse({ floorId: "web-shop", agentId: ada.id, issue: 5 }),
      ).toMatchObject({ daily: { level: "agent", cap: 6_000 } });
      // Linus has no cap of his own: the Floor's, then the office's.
      expect(
        await caps.capUse({ floorId: "web-shop", agentId: linus.id }),
      ).toEqual({
        daily: { level: "floor", cap: 8_000, used: 1_000 },
        monthly: { level: "office", cap: 100_000, used: 1_000 },
      });
    },
  ],
  [
    "shows a Floor's caps and use: its Agents' against their caps, and its issues'",
    async ({ caps, agents, floors, requests, team }) => {
      const { ada, linus, grace } = await team();
      await floors.updateSettings("web-shop", {
        tokenCaps: { daily: null, monthly: 70_000_000 },
      });
      await agents.update("web-shop", linus.id, {
        tokenCaps: { daily: 1_000_000, monthly: null },
      });
      await caps.setIssueCaps("web-shop", 9, { daily: null, monthly: 500_000 });
      requests.push(
        { at: today, ...by(ada, 4), input: 300, output: 100, cacheRead: 5_000 },
        { at: earlierThisMonth, ...by(linus, 2), input: 40, output: 10 },
        { at: today, ...by(grace, 4), input: 7, output: 7 },
        {
          at: today,
          floorId: null,
          agentId: null,
          issue: null,
          ownerTool: "laptop",
          input: 1,
          output: 1,
        },
      );

      const usage = await caps.floorUsage("web-shop");
      expect(usage.floorId).toBe("web-shop");
      expect(usage.caps).toEqual({ daily: null, monthly: 70_000_000 });
      expect(usage.agentDefaults).toEqual({
        daily: { level: "office", cap: defaultOfficeTokenCaps.daily },
        monthly: { level: "floor", cap: 70_000_000 },
      });
      expect(usage.usage.daily).toMatchObject({
        requests: 1,
        tokens: 400,
        cacheReadTokens: 5_000,
      });
      expect(usage.usage.monthly).toMatchObject({ requests: 2, tokens: 450 });
      const ofAgent = (id: string) =>
        usage.agents.find(({ agentId }) => agentId === id);
      expect(usage.agents).toHaveLength(4);
      expect(ofAgent(ada.id)?.caps).toEqual({
        daily: {
          level: "office",
          cap: defaultOfficeTokenCaps.daily,
          used: 400,
        },
        monthly: { level: "floor", cap: 70_000_000, used: 400 },
      });
      expect(ofAgent(linus.id)?.caps).toEqual({
        daily: { level: "agent", cap: 1_000_000, used: 0 },
        monthly: { level: "floor", cap: 70_000_000, used: 50 },
      });
      // Issues with caps, or used this month, newest first; blog's #4 is
      // not web-shop's.
      expect(
        usage.issues.map(({ issue, caps: issueCaps, usage: used }) => ({
          issue,
          issueCaps,
          daily: used.daily.tokens,
          monthly: used.monthly.tokens,
        })),
      ).toEqual([
        {
          issue: 9,
          issueCaps: { daily: null, monthly: 500_000 },
          daily: 0,
          monthly: 0,
        },
        {
          issue: 4,
          issueCaps: { daily: null, monthly: null },
          daily: 400,
          monthly: 400,
        },
        {
          issue: 2,
          issueCaps: { daily: null, monthly: null },
          daily: 0,
          monthly: 50,
        },
      ]);
    },
  ],
  [
    "shows the Office's use: in all, per Floor, per Owner tool, and the Agent nearest its cap",
    async ({ caps, agents, requests, team }) => {
      const { ada, linus, grace } = await team();
      await agents.update("web-shop", linus.id, {
        tokenCaps: { daily: 100, monthly: null },
      });
      requests.push(
        { at: today, ...by(ada), input: 30_000, output: 0 },
        { at: today, ...by(linus), input: 60, output: 0 },
        { at: earlierThisMonth, ...by(grace), input: 4_000_000, output: 0 },
        {
          at: today,
          floorId: null,
          agentId: null,
          issue: null,
          ownerTool: "laptop",
          input: 5,
          output: 5,
        },
      );
      const usage = await caps.officeUsage();
      expect(usage.caps).toEqual(defaultOfficeTokenCaps);
      expect(usage.usage.daily.tokens).toBe(30_070);
      expect(usage.usage.monthly.tokens).toBe(4_030_070);
      expect(
        usage.floors.map(({ floorId, usage: used }) => [
          floorId,
          used.daily.tokens,
          used.monthly.tokens,
        ]),
      ).toEqual([
        ["blog", 0, 4_000_000],
        ["web-shop", 30_060, 30_060],
      ]);
      expect(usage.ownerTools).toEqual([
        {
          ownerTool: "laptop",
          usage: {
            daily: expect.objectContaining({ tokens: 10 }) as unknown,
            monthly: expect.objectContaining({ tokens: 10 }) as unknown,
          },
        },
      ]);
      // Linus used 60% of his own daily cap; Ada far less of the office's.
      expect(usage.busiestAgents.daily).toEqual({
        floorId: "web-shop",
        agentId: linus.id,
        use: { level: "agent", cap: 100, used: 60 },
      });
      expect(usage.busiestAgents.monthly).toEqual({
        floorId: "blog",
        agentId: grace.id,
        use: {
          level: "office",
          cap: defaultOfficeTokenCaps.monthly,
          used: 4_000_000,
        },
      });
    },
  ],
  [
    "sets and removes an issue's caps, naming them in config.changed, and refuses an archived Floor",
    async ({ caps, floors, events, team }) => {
      await team();
      await caps.setIssueCaps("web-shop", 12, { daily: 1_000, monthly: null });
      expect((await events()).at(-1)).toEqual({
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId: "web-shop",
        keys: ["issues.12.tokenCaps.daily"],
      });
      expect((await caps.floorUsage("web-shop")).issues).toEqual([
        expect.objectContaining({
          issue: 12,
          caps: { daily: 1_000, monthly: null },
        }),
      ]);
      await caps.setIssueCaps("web-shop", 12, { daily: null, monthly: null });
      expect((await caps.floorUsage("web-shop")).issues).toEqual([]);

      await floors.archive("web-shop");
      const error = await caps
        .setIssueCaps("web-shop", 12, { daily: 5, monthly: null })
        .catch((failure: unknown) => failure);
      expect((error as FloorError).code).toBe(floorErrorCodes.floorArchived);
      const missing = await caps
        .floorUsage("nowhere")
        .catch((failure: unknown) => failure);
      expect((missing as FloorError).code).toBe(floorErrorCodes.floorNotFound);
    },
  ],
  [
    "counts the Communications Agent's own tokens against the office's caps, refusing it at one",
    async ({ caps, requests, team }) => {
      const { ada } = await team();
      await caps.setOfficeCaps({ daily: 1_000, monthly: 100_000 });
      const communications = {
        floorId: null,
        agentId: communicationsAgentId,
        issue: null,
        ownerTool: null,
      };
      requests.push(
        { at: today, ...communications, input: 600, output: 200 },
        { at: earlierThisMonth, ...communications, input: 5_000, output: 0 },
        // Another Agent's tokens are its own.
        { at: today, ...by(ada), input: 9_000, output: 0 },
      );
      expect(await caps.communicationsCapUse()).toEqual({
        daily: { level: "office", cap: 1_000, used: 800 },
        monthly: { level: "office", cap: 100_000, used: 5_800 },
      });
      expect(await communicationsCapRefusal(caps)).toBeUndefined();
      requests.push({ at: today, ...communications, input: 200, output: 0 });
      expect(await communicationsCapRefusal(caps)).toEqual({
        message:
          "The Communications Agent reached the office's daily Token Cap (1,000 tokens). Its Digests are written without a model until the day is over, or the Owner raises the cap.",
      });
    },
  ],
  [
    "G1-3: counts each Owner tool's own tokens, the Terminal's too, against the office's caps, refusing it at one",
    async ({ caps, requests, team }) => {
      const { ada } = await team();
      await caps.setOfficeCaps({ daily: 1_000, monthly: 2_000 });
      const tool = (ownerTool: string) => ({
        floorId: null,
        agentId: null,
        issue: null,
        ownerTool,
      });
      requests.push(
        { at: today, ...tool("Laptop"), input: 600, output: 200 },
        { at: earlierThisMonth, ...tool("Laptop"), input: 900, output: 0 },
        { at: lastMonth, ...tool("Laptop"), input: 50_000, output: 0 },
        // Another Owner tool's tokens, and an Agent's, are their own.
        { at: today, ...tool("Terminal"), input: 1_500, output: 0 },
        { at: today, ...by(ada), input: 9_000, output: 0 },
      );
      expect(await caps.ownerToolCapUse("Laptop")).toEqual({
        daily: { level: "office", cap: 1_000, used: 800 },
        monthly: { level: "office", cap: 2_000, used: 1_700 },
      });
      expect(await ownerToolCapRefusal(caps, "Laptop")).toBeUndefined();
      expect(await ownerToolCapRefusal(caps, "Terminal")).toEqual({
        message:
          "The Owner tool \"Terminal\" reached the office's daily Token Cap (1,000 tokens), so AI Office refuses its calls until the day is over, or the Owner raises the office's cap.",
      });
      requests.push({
        at: earlierThisMonth,
        ...tool("Laptop"),
        input: 300,
        output: 0,
      });
      expect(await ownerToolCapRefusal(caps, "Laptop")).toEqual({
        message:
          "The Owner tool \"Laptop\" reached the office's monthly Token Cap (2,000 tokens), so AI Office refuses its calls until the month is over, or the Owner raises the office's cap.",
      });
    },
  ],
];

describe("Token Caps, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(setUp(memoryStores(), createEventBus({ store: memoryEventStore() }))),
    );
  }
});

describe("Token Caps, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(
        setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      ),
    );
  }
});
