import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import type { CatalogueEntry, ModelCatalogue } from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  agentSchema,
  anyAiProvider,
  floorSchema,
  type Agent,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// A Floor's Agents through the API (PRD FR-10, FR-11, FR-12): a new
// Floor's default team, and the Agent editor's changes. Each case runs in
// memory and in Postgres 18.

/** The model catalogue: two Claude Models and one Grok Model. */
const catalogue: ModelCatalogue = {
  list: () =>
    Promise.resolve(
      (
        [
          ["Claude", "claude-opus-5-5"],
          ["Claude", "claude-sonnet-5-5"],
          ["Grok", "grok-4"],
        ] as const
      ).map(([aiProvider, model]): CatalogueEntry => ({
        aiProvider,
        accountType: "api_key",
        model,
        displayName: null,
        contextWindow: null,
        fetchedAt: new Date("2026-10-09T08:00:00.000Z"),
      })),
    ),
  refresh: () => Promise.resolve({ refreshed: [], failed: [] }),
};

async function setUp(
  stores: OfficeStores,
  bus: EventBus,
): Promise<{ server: FastifyInstance; owner: SignedIn; bus: EventBus }> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    modelCatalogue: catalogue,
  });
  return { server, owner: await signIn(server), bus };
}

/** Adds web-shop as a Floor and answers its team. */
async function webShop({
  server,
  owner,
}: Awaited<ReturnType<typeof setUp>>): Promise<Agent[]> {
  await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  const response = await server.inject({
    url: "/api/floors/web-shop/agents",
    headers: owner.headers,
  });
  return agentListSchema.parse(response.json()).agents;
}

type Case = [
  name: string,
  run: (setup: Awaited<ReturnType<typeof setUp>>) => Promise<void>,
];

const cases: Case[] = [
  [
    "lists a new Floor's Manager, coder, reviewer and QA Agent",
    async ({ server, owner }) => {
      const added = await server.inject({
        method: "POST",
        url: "/api/floors",
        headers: owner.headers,
        payload: { repository: "adrianeyre/web-shop" },
      });
      const floor = floorSchema.parse(added.json());

      const response = await server.inject({
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
      });
      expect(response.statusCode).toBe(200);
      const { agents } = agentListSchema.parse(response.json());
      expect(
        agents.map(({ role, aiProvider, model, modelOverride, enabled }) => ({
          role,
          aiProvider,
          model,
          modelOverride,
          enabled,
        })),
      ).toEqual(
        ["manager", "coder", "reviewer", "qa"].map((role) => ({
          role,
          aiProvider: "Claude",
          model: "claude-opus-5-5",
          modelOverride: null,
          enabled: true,
        })),
      );
      expect(new Set(agents.map(({ name }) => name)).size).toBe(4);
      expect(floor.requiredReviewerAgentIds).toEqual([agents[2]?.id]);
    },
  ],
  [
    "changes an Agent's AI Provider, Model, effort, instructions and status",
    async (setup) => {
      const { server, owner, bus } = setup;
      const [, coder] = await webShop(setup);
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      const grok = await server.inject({
        method: "PUT",
        url: "/api/ai-providers/Grok",
        headers: owner.headers,
        payload: { defaultModel: "grok-4" },
      });
      expect(grok.statusCode).toBe(204);
      const patch = (payload: unknown) =>
        server.inject({
          method: "PATCH",
          url: `/api/floors/web-shop/agents/${coder.id}`,
          headers: owner.headers,
          payload: payload as Record<string, unknown>,
        });

      const moved = await patch({
        name: "  Not-a-pioneer ",
        aiProvider: "Grok",
        modelOverride: "grok-4",
        extraInstructions: "Keep diffs small.",
        enabled: false,
      });
      expect(moved.statusCode).toBe(200);
      expect(agentSchema.parse(moved.json())).toEqual({
        ...coder,
        name: "Not-a-pioneer",
        aiProvider: "Grok",
        model: "grok-4",
        modelOverride: "grok-4",
        extraInstructions: "Keep diffs small.",
        enabled: false,
      });
      const [event] = (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (stored) =>
            stored.type === "config.changed" && stored.scope === "agent",
        );
      expect(event).toEqual({
        type: "config.changed",
        version: 1,
        scope: "agent",
        floorId: "web-shop",
        agentId: coder.id,
        keys: [
          "name",
          "aiProvider",
          "modelOverride",
          "extraInstructions",
          "enabled",
        ],
      });

      // Back on Claude with its own Model and an effort.
      const back = await patch({
        aiProvider: "Claude",
        modelOverride: "claude-sonnet-5-5",
        effort: "high",
        enabled: true,
      });
      expect(back.statusCode).toBe(200);
      expect(back.json()).toMatchObject({
        aiProvider: "Claude",
        model: "claude-sonnet-5-5",
        modelOverride: "claude-sonnet-5-5",
        effort: "high",
        enabled: true,
      });
      // And to its default Model.
      const listed = await server.inject({
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
      });
      expect(
        agentListSchema
          .parse(listed.json())
          .agents.find(({ id }) => id === coder.id),
      ).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
      const reset = await patch({ modelOverride: null, effort: null });
      expect(reset.json()).toMatchObject({
        model: "claude-opus-5-5",
        modelOverride: null,
        effort: null,
      });
      // On any AI Provider: given one when a task starts, with its default
      // Model, so it has none of its own.
      const anyOne = await patch({ aiProvider: anyAiProvider });
      expect(anyOne.statusCode).toBe(200);
      expect(anyOne.json()).toMatchObject({
        aiProvider: anyAiProvider,
        model: "",
        modelOverride: null,
        effort: null,
      });
      const ownModel = await patch({ modelOverride: "claude-sonnet-5-5" });
      expect(ownModel.statusCode).toBe(400);
      expect(ownModel.json()).toMatchObject({
        error: "model_not_in_catalogue",
      });
    },
  ],
  [
    "changes an Agent's Avatar from the Avatar Editor, at once",
    async (setup) => {
      const { server, owner, bus } = setup;
      const [, coder] = await webShop(setup);
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      const avatar: Agent["avatar"] = {
        ...coder.avatar,
        presentation: "androgynous",
        hairColour: "#2e6fd8",
        outfit: {
          style: "overalls",
          primaryColour: "#d98e04",
          secondaryColour: "#2b2b2b",
        },
        deskMascot: "rubber-duck",
        deskItems: [],
      };
      const response = await server.inject({
        method: "PATCH",
        url: `/api/floors/web-shop/agents/${coder.id}`,
        headers: owner.headers,
        payload: { avatar },
      });
      expect(response.statusCode).toBe(200);
      expect(agentSchema.parse(response.json())).toEqual({ ...coder, avatar });

      const listed = await server.inject({
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
      });
      expect(
        agentListSchema
          .parse(listed.json())
          .agents.find(({ id }) => id === coder.id)?.avatar,
      ).toEqual(avatar);
      const changes = (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (stored) =>
            stored.type === "config.changed" && stored.scope === "agent",
        );
      expect(changes).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "agent",
          floorId: "web-shop",
          agentId: coder.id,
          keys: ["avatar"],
        },
      ]);
    },
  ],
  [
    "refuses what the Agent editor may not set",
    async (setup) => {
      const { server, owner } = setup;
      const [manager, coder] = await webShop(setup);
      if (manager === undefined || coder === undefined) {
        throw new Error("The Floor has no team.");
      }
      const patch = (
        payload: unknown,
        agentId = coder.id,
        floor = "web-shop",
      ) =>
        server.inject({
          method: "PATCH",
          url: `/api/floors/${floor}/agents/${agentId}`,
          headers: owner.headers,
          payload: payload as Record<string, unknown>,
        });
      const refused = async (
        payload: unknown,
        status: number,
        error: string,
        agentId?: string,
        floor?: string,
      ) => {
        const response = await patch(payload, agentId, floor);
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error });
      };

      await refused({}, 400, "invalid_request");
      await refused({ role: "manager" }, 400, "invalid_request");
      await refused({ name: " " }, 400, "invalid_request");
      await refused({ aiProvider: "Jev" }, 400, "invalid_request");
      // Jev is the Decision Model only, never an Agent's Model (FR-17).
      await refused(
        { modelOverride: "typesafe/jev-1.13" },
        400,
        "invalid_request",
      );
      await refused(
        { extraInstructions: "x".repeat(4001) },
        400,
        "invalid_request",
      );
      await refused(
        { modelOverride: "claude-imaginary" },
        400,
        "model_not_in_catalogue",
      );
      await refused({ effort: "turbo" }, 400, "effort_not_supported");
      await refused({ aiProvider: "Gemini" }, 400, "model_required");
      await refused({ name: manager.name }, 409, "agent_name_taken");
      // An Avatar is checked part by part: the kit has no mohawk.
      await refused(
        { avatar: { ...coder.avatar, hairstyle: "mohawk" } },
        400,
        "invalid_request",
      );
      await refused(
        { avatar: { ...coder.avatar, cape: "red" } },
        400,
        "invalid_request",
      );
      await refused({ enabled: false }, 404, "agent_not_found", "nobody");
      await refused(
        { enabled: false },
        404,
        "floor_not_found",
        coder.id,
        "nowhere",
      );

      // None of them changed it.
      const listed = await server.inject({
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
      });
      expect(
        agentListSchema
          .parse(listed.json())
          .agents.find(({ id }) => id === coder.id),
      ).toEqual(coder);
    },
  ],
  [
    "answers 404 for a Floor that does not exist",
    async ({ server, owner }) => {
      const response = await server.inject({
        url: "/api/floors/nowhere/agents",
        headers: owner.headers,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "floor_not_found" });
    },
  ],
];

describe("the Agent API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryStores(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the Agent API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});
