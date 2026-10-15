import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { maxModelMappings, type ModelMappingRequest } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createModelMappings, ModelMappingError } from "./mappings.ts";
import {
  databaseModelMappingStore,
  memoryModelMappingStore,
  type ModelMappingStore,
} from "./mappings-store.ts";

// Model mappings and aliases (PRD FR-41): added, listed, changed and
// deleted, each change a `config.changed` event naming what changed; a
// name is mapped once per kind of AI Account, and once as an alias. Each
// case runs in memory and in Postgres 18.

const start = Date.parse("2026-10-10T12:00:00.000Z");

function setUp(store: ModelMappingStore, bus: EventBus) {
  let time = start;
  let id = 0;
  return createModelMappings({
    store,
    events: bus,
    now: () => new Date((time += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
}

const alias = (from: string, to: string): ModelMappingRequest => ({
  from,
  to,
  aiProvider: null,
  accountType: null,
});
const forKey = (from: string, to: string): ModelMappingRequest => ({
  from,
  to,
  aiProvider: "Claude",
  accountType: "api_key",
});

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) =>
      error instanceof ModelMappingError ? error.code : error,
  );

const changes = async (bus: EventBus) =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .flatMap((event) => (event.type === "config.changed" ? [event.keys] : []));

const cases: [
  string,
  (mappings: ReturnType<typeof setUp>, bus: EventBus) => Promise<void>,
][] = [
  [
    "adds, changes and deletes a mapping, telling which changed, never to what",
    async (mappings, bus) => {
      const added = await mappings.add(
        forKey("claude-opus-5-5", "claude-sonnet-5-5"),
      );
      expect(added).toEqual({
        id: "00000000-0000-4000-8000-000000000001",
        from: "claude-opus-5-5",
        to: "claude-sonnet-5-5",
        aiProvider: "Claude",
        accountType: "api_key",
        createdAt: new Date(start + 1000),
        updatedAt: new Date(start + 1000),
      });
      const changed = await mappings.replace(
        added.id,
        alias("opus", "claude-opus-5-5"),
      );
      expect(changed).toMatchObject({
        id: added.id,
        from: "opus",
        to: "claude-opus-5-5",
        aiProvider: null,
        accountType: null,
        createdAt: new Date(start + 1000),
        updatedAt: new Date(start + 2000),
      });
      expect(await mappings.rules()).toEqual([changed]);
      await mappings.remove(added.id);
      expect(await mappings.list()).toEqual([]);
      expect(await refusal(mappings.remove(added.id))).toBe(
        "model_mapping_not_found",
      );
      expect(
        await refusal(
          mappings.replace(added.id, alias("opus", "claude-opus-5-5")),
        ),
      ).toBe("model_mapping_not_found");
      const told = await changes(bus);
      expect(told).toEqual([
        ["modelMappings.added"],
        ["modelMappings.changed"],
        ["modelMappings.deleted"],
      ]);
      expect(JSON.stringify(told)).not.toContain("claude");
    },
  ],
  [
    "lists aliases first, then by kind and the name asked for",
    async (mappings) => {
      await mappings.add(forKey("opus", "claude-opus-4-5"));
      await mappings.add({
        ...forKey("claude-haiku-5-5", "claude-sonnet-5-5"),
        accountType: "oauth",
      });
      await mappings.add(alias("sonnet", "claude-sonnet-5-5"));
      await mappings.add(forKey("gpt-5", "claude-sonnet-5-5"));
      await mappings.add(alias("fast", "grok-code-fast-1"));
      expect(
        (await mappings.list()).map(
          ({ from, aiProvider, accountType }) =>
            `${aiProvider ?? "*"}/${accountType ?? "*"}: ${from}`,
        ),
      ).toEqual([
        "*/*: fast",
        "*/*: sonnet",
        "Claude/api_key: gpt-5",
        "Claude/api_key: opus",
        "Claude/oauth: claude-haiku-5-5",
      ]);
    },
  ],
  [
    "maps a name once per kind of AI Account, and once as an alias",
    async (mappings) => {
      await mappings.add(alias("opus", "claude-opus-5-5"));
      const forKind = await mappings.add(forKey("opus", "claude-opus-4-5"));
      // Another kind may map it too.
      await mappings.add({
        ...forKey("opus", "claude-opus-5-5"),
        accountType: "oauth",
      });
      const taken = await refusal(
        mappings.add(alias("opus", "claude-sonnet-5-5")),
      );
      expect(taken).toBe("model_mapping_taken");
      expect(
        await mappings
          .add(alias("opus", "x"))
          .catch((error: unknown) =>
            error instanceof Error ? error.message : "",
          ),
      ).toBe("opus is already mapped as an alias.");
      expect(
        await refusal(mappings.add(forKey("opus", "claude-sonnet-5-5"))),
      ).toBe("model_mapping_taken");
      // Changing one into another's place is refused too; into its own, not.
      expect(
        await refusal(
          mappings.replace(forKind.id, alias("opus", "claude-haiku-5-5")),
        ),
      ).toBe("model_mapping_taken");
      expect(
        await mappings.replace(forKind.id, forKey("opus", "claude-haiku-5-5")),
      ).toMatchObject({ to: "claude-haiku-5-5" });
      expect(await mappings.list()).toHaveLength(3);
    },
  ],
  [
    "keeps at most the most mappings there may be",
    async (mappings) => {
      for (let index = 0; index < maxModelMappings; index += 1) {
        await mappings.add(alias(`alias-${String(index)}`, "claude-opus-5-5"));
      }
      expect(
        await refusal(mappings.add(alias("one-more", "claude-opus-5-5"))),
      ).toBe("too_many_model_mappings");
    },
  ],
];

describe("model mappings, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const bus = createEventBus({ store: memoryEventStore() });
      await run(setUp(memoryModelMappingStore(), bus), bus);
    });
  }
});

describe("model mappings, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const bus = createEventBus({ store: databaseEventStore(database.db) });
      await run(setUp(databaseModelMappingStore(database.db), bus), bus);
    });
  }
});
