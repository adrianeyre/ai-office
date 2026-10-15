import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type EventOfType,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { communicationsAgentId, directChatSession } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import { memoryStores } from "../stores.ts";
import {
  callInputTokens,
  contextUsageBody,
  createContextUsage,
  followSandboxSessions,
  type ContextUsage,
  type ContextUsageState,
  type ObservedModelCall,
} from "./usage.ts";

// Context Usage (PRD FR-84, FR-85): each model call the AI Gateway records
// is counted against its Agent's current session, as its input tokens over
// its Model's context window from the catalogue.

const opus = "claude-opus-5-5";
const windows: Record<string, number | null> = {
  [opus]: 200_000,
  "claude-haiku-5-5": 200_000,
  "claude-mystery-1": null,
};

interface Setup {
  readonly bus: EventBus;
  readonly usage: ContextUsage;
  readonly coder: AgentRecord;
  readonly reviewer: AgentRecord;
  readonly manager: AgentRecord;
  readonly stores: ReturnType<typeof memoryStores>;
  readonly told: ContextUsageState[];
  readonly events: () => Promise<EventOfType<"agent.context_usage">[]>;
}

async function setUp(): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github, events: bus }).add(
    "adrianeyre/web-shop",
  );
  const team = await stores.agents.list("web-shop");
  const of = (role: AgentRecord["role"]) => {
    const agent = team.find((member) => member.role === role);
    if (agent === undefined) {
      throw new Error(`A new Floor has a ${role}.`);
    }
    return agent;
  };
  const usage = createContextUsage({
    events: bus,
    agents: stores.agents,
    contextWindow: (_aiProvider, model) =>
      Promise.resolve(windows[model] ?? null),
    now: () => new Date("2026-10-10T09:00:00.000Z"),
  });
  const told: ContextUsageState[] = [];
  usage.subscribe((state) => told.push(state));
  return {
    bus,
    usage,
    coder: of("coder"),
    reviewer: of("reviewer"),
    manager: of("manager"),
    stores,
    told,
    events: async () =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (event): event is EventOfType<"agent.context_usage"> =>
            event.type === "agent.context_usage",
        ),
  };
}

let clock = 0;
/** A recorded call: `tokens` of input in all, by default to Opus. */
const call = (
  agent: AgentRecord,
  tokens: number,
  overrides: Partial<ObservedModelCall> = {},
): ObservedModelCall => ({
  agentId: agent.id,
  floorId: agent.floorId,
  session: "sbx-1",
  issue: 4,
  endpoint: "messages",
  model: opus,
  status: 200,
  startedAt: new Date(Date.UTC(2026, 9, 10, 8, 0, clock++)),
  // Mostly read from the cache, as an agent tool's calls are.
  inputTokens: Math.min(tokens, 10),
  cacheReadInputTokens: Math.max(0, tokens - 10),
  cacheCreationInputTokens: 0,
  ...overrides,
});

describe("callInputTokens", () => {
  it("is the whole prompt: fresh, cache-read and cache-written tokens", () => {
    expect(
      callInputTokens({
        inputTokens: 5,
        cacheReadInputTokens: 90_000,
        cacheCreationInputTokens: 1_000,
      }),
    ).toBe(91_005);
    expect(
      callInputTokens({
        inputTokens: 40,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
      }),
    ).toBe(40);
  });

  it("is unknown when the call reported no usage", () => {
    expect(
      callInputTokens({
        inputTokens: null,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: null,
      }),
    ).toBeNull();
  });
});

describe("createContextUsage", () => {
  it("computes Context Usage from recorded requests: the latest call's input tokens over the Model's context window", async () => {
    const { usage, coder, told, events } = await setUp();
    await usage.observe(call(coder, 20_000));
    await usage.observe(call(coder, 50_000));
    await usage.observe(call(coder, 120_000));

    expect(usage.of(coder.id)).toMatchObject({
      floorId: "web-shop",
      session: "sbx-1",
      issue: 4,
      model: opus,
      inputTokens: 120_000,
      contextWindow: 200_000,
      contextUsage: 0.6,
    });
    expect(told.map(({ contextUsage }) => contextUsage)).toEqual([
      0.1, 0.25, 0.6,
    ]);
    expect(await events()).toEqual([
      expect.objectContaining({ active: true, contextUsage: 0.1 }),
      expect.objectContaining({ active: true, contextUsage: 0.25 }),
      {
        type: "agent.context_usage",
        version: 1,
        floorId: "web-shop",
        agentId: coder.id,
        issue: 4,
        active: true,
        model: opus,
        inputTokens: 120_000,
        contextWindow: 200_000,
        contextUsage: 0.6,
      },
    ]);
    const state = usage.of(coder.id);
    if (state === undefined) {
      throw new Error("The coder has a session going.");
    }
    expect(contextUsageBody(state)).toEqual({
      agentId: coder.id,
      floorId: "web-shop",
      issue: 4,
      model: opus,
      inputTokens: 120_000,
      contextWindow: 200_000,
      contextUsage: 0.6,
      updatedAt: "2026-10-10T09:00:00.000Z",
    });
  });

  it("emits an event only when the whole percentage changes", async () => {
    const { usage, coder, told, events } = await setUp();
    await usage.observe(call(coder, 100_000));
    await usage.observe(call(coder, 100_500));
    await usage.observe(call(coder, 101_999));
    await usage.observe(call(coder, 102_000));

    expect(told).toHaveLength(4);
    expect((await events()).map(({ inputTokens }) => inputTokens)).toEqual([
      100_000, 102_000,
    ]);
  });

  it("shows a Model with no context window in the catalogue as unknown, not 0%", async () => {
    const { usage, coder, stores, events } = await setUp();
    await stores.agents.update({ ...coder, modelOverride: "claude-mystery-1" });
    await usage.observe(call(coder, 90_000, { model: "claude-mystery-1" }));

    expect(usage.of(coder.id)).toMatchObject({
      inputTokens: 90_000,
      contextWindow: null,
      contextUsage: null,
    });
    expect(await events()).toEqual([
      expect.objectContaining({
        active: true,
        contextWindow: null,
        contextUsage: null,
      }),
    ]);
  });

  it("leaves reviewer calls out: they are stateless", async () => {
    const { usage, reviewer, told, events } = await setUp();
    await usage.observe(call(reviewer, 150_000, { session: null }));

    expect(usage.of(reviewer.id)).toBeUndefined();
    expect(told).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("leaves out a sandbox Agent's calls outside its sandbox, such as its Kickoff acknowledgement", async () => {
    const { usage, coder, told, events } = await setUp();
    // Acknowledging a Plan at the Kickoff names no session: it is no
    // working context, and the coder has none until its sandbox's first call.
    await usage.observe(call(coder, 12_000, { session: null, issue: null }));
    expect(usage.of(coder.id)).toBeUndefined();
    expect(told).toEqual([]);
    expect(await events()).toEqual([]);

    // Nor does one change a sandbox's session under way.
    await usage.observe(call(coder, 100_000));
    await usage.observe(call(coder, 12_000, { session: null, issue: null }));
    expect(usage.of(coder.id)).toMatchObject({
      session: "sbx-1",
      contextUsage: 0.5,
    });
  });

  it("leaves out the Owner's direct chat with an Agent, which is a conversation of its own", async () => {
    const { usage, coder, manager, told, events } = await setUp();
    await usage.observe(call(coder, 100_000));
    await usage.observe(
      call(coder, 150_000, { session: directChatSession, issue: null }),
    );
    await usage.observe(
      call(manager, 30_000, { session: directChatSession, issue: null }),
    );
    expect(usage.of(coder.id)).toMatchObject({
      session: "sbx-1",
      contextUsage: 0.5,
    });
    expect(usage.of(manager.id)).toBeUndefined();
    expect(told).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("leaves out the Communications Agent's calls, which belong to no Floor", async () => {
    const { usage, manager, told } = await setUp();
    // A Digest, written with the same Model as the Manager's.
    await usage.observe(
      call(manager, 40_000, {
        agentId: communicationsAgentId,
        floorId: null,
        session: null,
        issue: null,
      }),
    );
    expect(usage.of(communicationsAgentId)).toBeUndefined();
    expect(told).toEqual([]);
  });

  it("counts the Manager chat's calls, which name no session", async () => {
    const { usage, manager } = await setUp();
    await usage.observe(call(manager, 30_000, { session: null, issue: null }));

    expect(usage.of(manager.id)).toMatchObject({
      session: null,
      issue: null,
      contextUsage: 0.15,
    });
  });

  it("ignores side calls to another Model, failed calls, token counting and calls without usage", async () => {
    const { usage, coder } = await setUp();
    await usage.observe(call(coder, 100_000));
    await usage.observe(call(coder, 900, { model: "claude-haiku-5-5" }));
    await usage.observe(call(coder, 1_000, { status: 529 }));
    await usage.observe(call(coder, 1_000, { endpoint: "count_tokens" }));
    await usage.observe(
      call(coder, 0, { inputTokens: null, cacheReadInputTokens: null }),
    );
    await usage.observe(call(coder, 1_000, { agentId: null }));

    expect(usage.of(coder.id)?.inputTokens).toBe(100_000);
  });

  it("ignores a call that started before the one already counted", async () => {
    const { usage, coder } = await setUp();
    const early = call(coder, 40_000);
    await usage.observe(call(coder, 60_000));
    await usage.observe(early);

    expect(usage.of(coder.id)?.inputTokens).toBe(60_000);
  });

  it("starts again with each session, and ends with it", async () => {
    const { usage, coder, events } = await setUp();
    await usage.observe(call(coder, 170_000));
    await usage.endSession(coder.id, "sbx-1");

    expect(usage.of(coder.id)).toBeUndefined();
    expect(usage.onFloor("web-shop")).toEqual([]);
    // Left over from the session that ended.
    await usage.observe(call(coder, 171_000));
    expect(usage.of(coder.id)).toBeUndefined();

    await usage.observe(call(coder, 8_000, { session: "sbx-2" }));
    expect(usage.of(coder.id)).toMatchObject({
      session: "sbx-2",
      contextUsage: 0.04,
    });
    expect(
      (await events()).map(({ active, contextUsage }) => [
        active,
        contextUsage,
      ]),
    ).toEqual([
      [true, 0.85],
      [false, null],
      [true, 0.04],
    ]);
  });

  it("does not end the current session for another that ended", async () => {
    const { usage, coder } = await setUp();
    await usage.observe(call(coder, 50_000, { session: "sbx-2" }));
    await usage.endSession(coder.id, "sbx-1");

    expect(usage.of(coder.id)?.session).toBe("sbx-2");
  });

  it("follows sandboxes: a stopped sandbox ends its session, a removed Agent is forgotten", async () => {
    const { bus, usage, coder, manager } = await setUp();
    followSandboxSessions(bus, usage);
    await usage.observe(call(coder, 50_000));
    await usage.observe(call(manager, 10_000, { session: null }));
    expect(usage.onFloor("web-shop").map(({ agentId }) => agentId)).toEqual(
      [coder.id, manager.id].sort(),
    );

    await bus.publish({
      type: "sandbox.stopped",
      version: 1,
      floorId: "web-shop",
      agentId: coder.id,
      issue: 4,
      sandboxId: "sbx-1",
      outcome: "finished",
      exitCode: 0,
    });
    await bus.publish({
      type: "agent.removed",
      version: 1,
      floorId: "web-shop",
      agentId: manager.id,
    });
    // The listeners' work is queued behind the events.
    await usage.endSession("nobody", null);

    expect(usage.onFloor("web-shop")).toEqual([]);
  });
});
