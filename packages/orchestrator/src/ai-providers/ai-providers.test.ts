import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { aiProviderErrorCodes } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  AiProviderError,
  createAiProviders,
  databaseAiProviderSettingsStore,
  memoryAiProviderSettingsStore,
  type AiProviderSettingsStore,
  type AiProviders,
} from "./ai-providers.ts";

// The AI Providers' default Models (PRD FR-15): chosen from the model
// catalogue, Claude's `claude-opus-5-5` until the Owner chooses, and none
// for the others. Every case runs in memory and in Postgres 18.

interface Setup {
  readonly aiProviders: AiProviders;
  /** What the catalogue lists, by AI Provider. */
  readonly catalogue: Record<string, string[]>;
  readonly events: () => Promise<OfficeEvent[]>;
}

function setUp(store: AiProviderSettingsStore, bus: EventBus): Setup {
  const catalogue: Record<string, string[]> = {
    Claude: ["claude-opus-5-5", "claude-sonnet-5-5"],
    Grok: ["grok-4"],
  };
  return {
    aiProviders: createAiProviders({
      store,
      events: bus,
      catalogue: (aiProvider) => Promise.resolve(catalogue[aiProvider] ?? []),
    }),
    catalogue,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const refusal = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(AiProviderError);
  return error as AiProviderError;
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "gives an AI Provider with an AI Account but no default Model its catalogue's first",
    async ({ aiProviders, catalogue, events }) => {
      catalogue["ChatGPT"] = ["gpt-5.5-codex", "gpt-5.5-mini"];
      // Claude keeps its own; Gemini's catalogue lists nothing yet.
      expect(
        await aiProviders.chooseMissingDefaults([
          "Claude",
          "ChatGPT",
          "ChatGPT",
          "Gemini",
        ]),
      ).toEqual(["ChatGPT"]);
      expect(await aiProviders.defaultModels()).toEqual({
        Claude: "claude-opus-5-5",
        ChatGPT: "gpt-5.5-codex",
      });
      expect((await events()).map((event) => event.type)).toEqual([
        "config.changed",
      ]);
      // Once it has one, the Owner's choice stays.
      await aiProviders.setDefaultModel("ChatGPT", "gpt-5.5-mini");
      expect(await aiProviders.chooseMissingDefaults(["ChatGPT"])).toEqual([]);
      expect((await aiProviders.defaultModels())["ChatGPT"]).toBe(
        "gpt-5.5-mini",
      );
    },
  ],
  [
    "starts with Claude's default Model and none for the others",
    async ({ aiProviders }) => {
      expect(await aiProviders.defaultModels()).toEqual({
        Claude: "claude-opus-5-5",
      });
    },
  ],
  [
    "sets a default Model from the catalogue, naming the setting in an event",
    async ({ aiProviders, events }) => {
      await aiProviders.setDefaultModel("Grok", "grok-4");
      await aiProviders.setDefaultModel("Claude", "claude-sonnet-5-5");
      expect(await aiProviders.defaultModels()).toEqual({
        Claude: "claude-sonnet-5-5",
        Grok: "grok-4",
      });
      expect(await events()).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "office",
          keys: ["aiProviders.Grok.defaultModel"],
        },
        {
          type: "config.changed",
          version: 1,
          scope: "office",
          keys: ["aiProviders.Claude.defaultModel"],
        },
      ]);
    },
  ],
  [
    "refuses another AI Provider's Model, and an unknown AI Provider",
    async ({ aiProviders, events }) => {
      expect(
        (await refusal(aiProviders.setDefaultModel("Grok", "claude-opus-5-5")))
          .code,
      ).toBe(aiProviderErrorCodes.modelNotInCatalogue);
      expect(
        (await refusal(aiProviders.setDefaultModel("Jev", "jev-1"))).code,
      ).toBe(aiProviderErrorCodes.aiProviderNotFound);
      expect(await aiProviders.defaultModels()).toEqual({
        Claude: "claude-opus-5-5",
      });
      expect(await events()).toEqual([]);

      // One no catalogue lists yet can be typed in.
      await aiProviders.setDefaultModel("Gemini", "gemini-2.5-pro");
      expect((await aiProviders.defaultModels())["Gemini"]).toBe(
        "gemini-2.5-pro",
      );
    },
  ],
];

describe("AI Providers, kept in memory", () => {
  it.each(cases)("%s", async (_name, run) => {
    await run(
      setUp(
        memoryAiProviderSettingsStore(),
        createEventBus({ store: memoryEventStore() }),
      ),
    );
  });
});

describe("AI Providers, in Postgres 18", () => {
  postgresTest.for(cases)("%s", async ([, run], { database }) => {
    await run(
      setUp(
        databaseAiProviderSettingsStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      ),
    );
  });
});
