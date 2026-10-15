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
  noTokens,
  tokenCapActions,
  type TokenUsageRow,
} from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createAgents, type Agents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createCapEnforcement,
  raisedCap,
  type CapEnforcement,
} from "./enforcement.ts";
import { createTokenCaps, type TokenCapService } from "./token-caps.ts";

// Token Cap enforcement (PRD FR-33, §5 scenario 5): a warning Notice at
// 80% of a cap in force, then at 100% a refusal, a pause and an action
// Notice whose actions ("Raise cap", "Resume tomorrow") resume the Agent.
// Every case runs with the stores in memory and in Postgres 18.

/** One recorded request: whose, for which issue, and its tokens. */
interface Request {
  readonly at: Date;
  readonly agent: AgentRecord;
  readonly issue: number | null;
  readonly tokens: number;
}

interface Setup {
  readonly stores: OfficeStores;
  readonly bus: EventBus;
  readonly agents: Agents;
  readonly caps: TokenCapService;
  readonly notices: Notices;
  readonly enforcement: CapEnforcement;
  readonly requests: Request[];
  readonly resumed: string[];
  readonly clock: { now: Date };
  readonly ada: AgentRecord;
  /** Uses `tokens` as `agent`, on `issue`, now. */
  readonly use: (tokens: number, issue?: number | null) => void;
  readonly events: () => Promise<OfficeEvent[]>;
  /** Another enforcement over the same stores: AI Office started again. */
  readonly restart: () => CapEnforcement;
}

const rowsOf =
  (requests: readonly Request[]) =>
  (from: Date, to: Date): Promise<TokenUsageRow[]> => {
    const rows = new Map<string, TokenUsageRow>();
    for (const request of requests) {
      if (request.at < from || request.at >= to) {
        continue;
      }
      const caller = {
        floorId: request.agent.floorId,
        agentId: request.agent.id,
        issue: request.issue,
        ownerTool: null,
      };
      const key = JSON.stringify(caller);
      rows.set(key, {
        ...caller,
        totals: addTokens(rows.get(key)?.totals ?? noTokens, {
          ...noTokens,
          requests: 1,
          inputTokens: request.tokens,
          tokens: request.tokens,
        }),
      });
    }
    return Promise.resolve([...rows.values()]);
  };

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const floors = createFloors({ store: stores.floors, github, events: bus });
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
  });
  await floors.add("adrianeyre/web-shop");
  const coder = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "coder",
  );
  if (coder === undefined) {
    throw new Error("web-shop has no coder.");
  }
  const clock = { now: new Date("2026-10-09T15:00:00.000Z") };
  const requests: Request[] = [];
  const resumed: string[] = [];
  const caps = createTokenCaps({
    store: stores.tokenCaps,
    floors: stores.floors,
    agents: stores.agents,
    events: bus,
    usage: rowsOf(requests),
    now: () => clock.now,
  });
  const notices = createNotices({ store: stores.notices, events: bus });
  const enforce = () =>
    createCapEnforcement({
      caps,
      agents: stores.agents,
      pauses: stores.capPauses,
      notices,
      events: bus,
      now: () => clock.now,
      onResume: (agentId) => {
        resumed.push(agentId);
      },
    });
  const enforcement = enforce();
  await enforcement.start();
  return {
    stores,
    bus,
    agents,
    caps,
    notices,
    enforcement,
    requests,
    resumed,
    clock,
    ada: coder,
    use: (tokens, issue = null) => {
      requests.push({ at: clock.now, agent: coder, issue, tokens });
    },
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
    restart: () => {
      enforcement.stop();
      return enforce();
    },
  };
}

const subjectOf = (agent: AgentRecord, issue?: number) => ({
  floorId: agent.floorId,
  agentId: agent.id,
  ...(issue === undefined ? {} : { issue }),
});

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "warns once at 80% of a cap in force, then refuses and pauses the Agent at 100%, with a Notice",
    async ({ agents, enforcement, notices, ada, use, events }) => {
      await agents.update("web-shop", ada.id, {
        tokenCaps: { daily: 1_000, monthly: null },
      });
      use(790);
      expect(await enforcement.check(subjectOf(ada, 4))).toBeUndefined();
      expect(await notices.open()).toEqual([]);

      // 80%: a warning, once.
      use(60);
      await enforcement.observe(subjectOf(ada, 4));
      expect(await enforcement.check(subjectOf(ada, 4))).toBeUndefined();
      await enforcement.observe(subjectOf(ada, 4));
      const warnings = await notices.open();
      expect(warnings).toEqual([
        expect.objectContaining({
          kind: "action",
          title: `Token Cap warning: ${ada.name} has used 85% of its own daily Token Cap (850 of 1,000 tokens)`,
          floorId: "web-shop",
          agentId: ada.id,
          actions: [],
        }),
      ]);
      expect(
        (await events()).filter(({ type }) => type === "cap.warning"),
      ).toEqual([
        {
          type: "cap.warning",
          version: 1,
          level: "agent",
          period: "daily",
          floorId: "web-shop",
          agentId: ada.id,
          issue: 4,
          used: 850,
          cap: 1_000,
        },
      ]);
      expect(enforcement.isPaused(ada.id)).toBe(false);

      // 100%: the next call is refused, and the Agent paused.
      use(200);
      const refusal = await enforcement.check(subjectOf(ada, 4));
      expect(refusal).toMatchObject({
        period: "daily",
        level: "agent",
        cap: 1_000,
        used: 1_050,
      });
      expect(refusal?.message).toContain(
        `${ada.name} reached its own daily Token Cap (1,000 tokens), so AI Office has paused it.`,
      );
      expect(enforcement.isPaused(ada.id)).toBe(true);
      expect(enforcement.pausedAgents()).toEqual([ada.id]);
      const reached = (await notices.open()).filter(
        ({ title }) => !title.startsWith("Token Cap warning"),
      );
      expect(reached).toEqual([
        expect.objectContaining({
          kind: "action",
          title: `Token Cap reached: ${ada.name} is paused at its own daily Token Cap (1,050 of 1,000 tokens)`,
          floorId: "web-shop",
          agentId: ada.id,
          actions: [
            { id: tokenCapActions.raiseCap, label: "Raise cap" },
            { id: tokenCapActions.resumeTomorrow, label: "Resume tomorrow" },
          ],
        }),
      ]);
      const after = await events();
      expect(after.filter(({ type }) => type === "cap.reached")).toEqual([
        {
          type: "cap.reached",
          version: 1,
          level: "agent",
          period: "daily",
          floorId: "web-shop",
          agentId: ada.id,
          issue: 4,
          used: 1_050,
          cap: 1_000,
        },
      ]);
      expect(after.at(-2)).toEqual({
        type: "agent.status_changed",
        version: 1,
        floorId: "web-shop",
        agentId: ada.id,
        status: "capped",
        issue: 4,
        reason: "Paused at its own daily Token Cap",
      });

      // Paused: every call is refused, whatever its issue, with no more
      // Notices.
      expect(await enforcement.check(subjectOf(ada, 9))).toMatchObject({
        period: "daily",
      });
      await enforcement.observe(subjectOf(ada));
      expect(await notices.open()).toHaveLength(2);
    },
  ],
  [
    "raising the cap from the Notice gives the Agent its own, higher cap and resumes it",
    async ({ stores, enforcement, notices, ada, use, resumed, events }) => {
      // The office's cap, which the other Agents keep.
      await stores.tokenCaps.setOfficeCaps(
        { daily: 1_000, monthly: 100_000_000 },
        new Date(),
      );
      use(1_200);
      expect(await enforcement.check(subjectOf(ada))).toMatchObject({
        level: "office",
      });
      const [notice] = await notices.open();
      expect(notice?.title).toContain("the office's daily Token Cap");

      await notices.act(notice?.id ?? "", tokenCapActions.raiseCap);

      expect(enforcement.isPaused(ada.id)).toBe(false);
      expect(resumed).toEqual([ada.id]);
      const [raised] = (await stores.agents.list("web-shop")).filter(
        ({ id }) => id === ada.id,
      );
      expect(raised?.tokenCaps).toEqual({
        daily: raisedCap(1_000, 1_200),
        monthly: null,
      });
      expect(raisedCap(1_000, 1_200)).toBe(2_200);
      expect(await stores.tokenCaps.officeCaps()).toEqual({
        daily: 1_000,
        monthly: 100_000_000,
      });
      expect(await enforcement.check(subjectOf(ada))).toBeUndefined();
      expect(await notices.open()).toEqual([]);
      const after = await events();
      expect(after).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "agent",
        floorId: "web-shop",
        agentId: ada.id,
        keys: ["tokenCaps.daily"],
      });
      expect(after).toContainEqual({
        type: "agent.status_changed",
        version: 1,
        floorId: "web-shop",
        agentId: ada.id,
        status: "idle",
      });
      expect(after.at(-1)).toMatchObject({
        type: "notice.acted_on",
        action: tokenCapActions.raiseCap,
      });
    },
  ],
  [
    "raises an issue's own cap when that is the cap reached",
    async ({ caps, stores, enforcement, notices, ada, use }) => {
      await caps.setIssueCaps("web-shop", 12, { daily: 500, monthly: null });
      use(600, 12);
      expect(await enforcement.check(subjectOf(ada, 12))).toMatchObject({
        level: "issue",
        cap: 500,
        used: 600,
      });
      const [notice] = await notices.open();
      expect(notice?.title).toContain("#12's daily Token Cap");

      await notices.act(notice?.id ?? "", tokenCapActions.raiseCap);
      expect(await caps.issueCaps("web-shop", 12)).toEqual({
        daily: 1_100,
        monthly: null,
      });
      const [unchanged] = (await stores.agents.list("web-shop")).filter(
        ({ id }) => id === ada.id,
      );
      expect(unchanged?.tokenCaps).toEqual(ada.tokenCaps);
      expect(await enforcement.check(subjectOf(ada, 12))).toBeUndefined();
    },
  ],
  [
    "resumes the Agent tomorrow, or next month for a monthly cap",
    async ({ agents, enforcement, notices, ada, use, clock, resumed }) => {
      await agents.update("web-shop", ada.id, {
        tokenCaps: { daily: 1_000, monthly: 1_500 },
      });
      use(1_000);
      await enforcement.observe(subjectOf(ada));
      const [notice] = (await notices.open()).filter(({ title }) =>
        title.startsWith("Token Cap reached"),
      );
      await notices.act(notice?.id ?? "", tokenCapActions.resumeTomorrow);
      // The Notice has gone; the Agent stays paused until tomorrow.
      expect(
        (await notices.open()).filter(({ title }) =>
          title.startsWith("Token Cap reached"),
        ),
      ).toEqual([]);
      clock.now = new Date("2026-10-09T23:59:59.000Z");
      expect(await enforcement.check(subjectOf(ada))).toBeDefined();
      expect(resumed).toEqual([]);

      clock.now = new Date("2026-10-10T00:00:00.000Z");
      expect(await enforcement.check(subjectOf(ada))).toBeUndefined();
      expect(resumed).toEqual([ada.id]);
      expect(enforcement.isPaused(ada.id)).toBe(false);

      // The month's cap: "Resume next month".
      use(600);
      expect(await enforcement.check(subjectOf(ada))).toMatchObject({
        period: "monthly",
        cap: 1_500,
        used: 1_600,
      });
      const [monthly] = (await notices.open()).filter(({ title }) =>
        title.startsWith("Token Cap reached"),
      );
      expect(monthly?.actions).toEqual([
        { id: tokenCapActions.raiseCap, label: "Raise cap" },
        { id: tokenCapActions.resumeNextMonth, label: "Resume next month" },
      ]);
      await notices.act(monthly?.id ?? "", tokenCapActions.resumeNextMonth);
      clock.now = new Date("2026-10-31T23:00:00.000Z");
      expect(await enforcement.check(subjectOf(ada))).toBeDefined();
      clock.now = new Date("2026-11-01T00:00:00.000Z");
      expect(await enforcement.check(subjectOf(ada))).toBeUndefined();
    },
  ],
  [
    "resumes an Agent whose cap is raised anywhere, and closes its Notice",
    async ({ caps, enforcement, notices, ada, use }) => {
      await caps.setOfficeCaps({ daily: 1_000, monthly: 100_000_000 });
      use(1_000);
      await enforcement.observe(subjectOf(ada));
      expect(enforcement.isPaused(ada.id)).toBe(true);

      // Raised in Admin, not from the Notice, but not enough.
      await caps.setOfficeCaps({ daily: 1_000_000, monthly: 900 });
      // Time for the change to be looked at.
      await new Promise((resolve) => setTimeout(resolve, 200));
      // A day's worth now, but the month's cap is still under its use.
      expect(enforcement.isPaused(ada.id)).toBe(true);
      expect(
        (await notices.open()).some(({ title }) =>
          title.startsWith("Token Cap reached"),
        ),
      ).toBe(true);

      await caps.setOfficeCaps({ daily: 1_000_000, monthly: 100_000_000 });
      await vi.waitFor(() => {
        expect(enforcement.isPaused(ada.id)).toBe(false);
      });
      await vi.waitFor(async () => {
        expect(await notices.open()).toEqual([]);
      });
      expect(await enforcement.check(subjectOf(ada))).toBeUndefined();
    },
  ],
  [
    "keeps a pause, and its resume time, across a restart",
    async ({ agents, enforcement, notices, ada, use, restart, clock }) => {
      await agents.update("web-shop", ada.id, {
        tokenCaps: { daily: 1_000, monthly: null },
      });
      use(1_000);
      await enforcement.observe(subjectOf(ada));
      const [notice] = await notices.open();
      await notices.act(notice?.id ?? "", tokenCapActions.resumeTomorrow);

      const again = restart();
      await again.start();
      expect(again.isPaused(ada.id)).toBe(true);
      expect(await again.check(subjectOf(ada))).toMatchObject({
        period: "daily",
      });
      // No second Notice for the same pause.
      expect(await notices.open()).toEqual([]);
      clock.now = new Date("2026-10-10T00:00:01.000Z");
      expect(await again.check(subjectOf(ada))).toBeUndefined();
      again.stop();
    },
  ],
];

describe("Token Cap enforcement, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const setup = await setUp(
        memoryStores(),
        createEventBus({ store: memoryEventStore() }),
      );
      try {
        await run(setup);
      } finally {
        setup.enforcement.stop();
      }
    });
  }
});

describe("Token Cap enforcement, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      try {
        await run(setup);
      } finally {
        setup.enforcement.stop();
      }
    });
  }
});

describe("a raised cap", () => {
  it("doubles the cap, or leaves a cap's worth of room above what is used", () => {
    expect(raisedCap(1_000, 1_000)).toBe(2_000);
    expect(raisedCap(1_000, 1_500)).toBe(2_500);
    expect(raisedCap(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
