import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createAiAccounts,
  createCombos,
  databaseAiAccountStore,
  databaseComboStore,
  memoryAiAccountStore,
  memoryComboStore,
  type AiAccountStore,
  type ComboStore,
} from "@ai-office/gateway";
import {
  apiErrorSchema,
  comboListSchema,
  comboSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Combos API (PRD FR-40): list, add, change and delete the Owner's
// Combos, each a named, ordered chain of (AI Account, Model) slots
// assigned to model families. Each case runs in memory and in Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  readonly claude: string;
  readonly grok: string;
}

async function setUp(
  accountStore: AiAccountStore,
  store: ComboStore,
  bus: EventBus,
): Promise<Setup> {
  const auth = await testAuth();
  let time = Date.parse("2026-10-10T12:00:00.000Z");
  const now = () => new Date((time += 1000));
  const aiAccounts = createAiAccounts({
    store: accountStore,
    encryptor: auth.encryptor,
    events: bus,
    now,
  });
  const claude = await aiAccounts.add({
    name: "Claude key",
    aiProvider: "Claude",
    accountType: "api_key",
    credential: "sk-ant-api03-combo-routes-0123456789",
  });
  const grok = await aiAccounts.add({
    name: "Grok key",
    aiProvider: "Grok",
    accountType: "api_key",
    credential: "xai-combo-routes-0123456789",
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth,
    events: bus,
    aiAccounts,
    combos: createCombos({ store, accounts: aiAccounts, events: bus, now }),
  });
  return {
    server,
    owner: await signIn(server),
    bus,
    claude: claude.id,
    grok: grok.id,
  };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const list = async (setup: Setup) =>
  comboListSchema.parse(
    (await request(setup, "GET", "/api/gateway/combos")).json(),
  ).combos;

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds a Combo, changes it and deletes it",
    async (setup) => {
      expect(await list(setup)).toEqual([]);
      const added = await request(setup, "POST", "/api/gateway/combos", {
        name: "Opus chain",
        modelFamilies: ["claude-opus-5-5"],
        slots: [
          { aiAccountId: setup.claude, model: "claude-opus-5-5" },
          { aiAccountId: setup.grok, model: "grok-4" },
        ],
        enabled: true,
      });
      expect(added.statusCode).toBe(201);
      const combo = comboSchema.parse(added.json());
      expect(combo).toMatchObject({
        name: "Opus chain",
        // A Model's name stands for its family.
        modelFamilies: ["claude-opus"],
        slots: [
          { aiAccountId: setup.claude, model: "claude-opus-5-5" },
          { aiAccountId: setup.grok, model: "grok-4" },
        ],
        enabled: true,
      });
      expect(await list(setup)).toEqual([combo]);

      const changed = await request(
        setup,
        "PATCH",
        `/api/gateway/combos/${combo.id}`,
        { enabled: false, modelFamilies: ["claude-opus", "claude-sonnet"] },
      );
      expect(changed.statusCode).toBe(200);
      expect(comboSchema.parse(changed.json())).toMatchObject({
        enabled: false,
        modelFamilies: ["claude-opus", "claude-sonnet"],
        slots: combo.slots,
      });

      const deleted = await request(
        setup,
        "DELETE",
        `/api/gateway/combos/${combo.id}`,
      );
      expect(deleted.statusCode).toBe(204);
      expect(await list(setup)).toEqual([]);
      for (const [method, payload] of [
        ["DELETE", undefined],
        ["PATCH", { enabled: true }],
      ] as const) {
        const missing = await request(
          setup,
          method,
          `/api/gateway/combos/${combo.id}`,
          payload,
        );
        expect(missing.statusCode).toBe(404);
        expect(apiErrorSchema.parse(missing.json()).error).toBe(
          "combo_not_found",
        );
      }
      expect(
        (await setup.bus.eventsAfter(0)).flatMap(({ event }) =>
          event.type === "config.changed" &&
          event.keys.some((key) => key.startsWith("combos."))
            ? [event.keys]
            : [],
        ),
      ).toEqual([
        ["combos.added"],
        ["combos.modelFamilies", "combos.enabled"],
        ["combos.deleted"],
      ]);
    },
  ],
  [
    "refuses a Combo that does not make sense, saying why",
    async (setup) => {
      const valid = {
        name: "Opus chain",
        modelFamilies: ["claude-opus"],
        slots: [{ aiAccountId: setup.claude, model: "claude-opus-5-5" }],
        enabled: true,
      };
      for (const payload of [
        { ...valid, name: "" },
        { ...valid, modelFamilies: [] },
        { ...valid, slots: [] },
        { ...valid, enabled: "yes" },
        { ...valid, extra: true },
      ]) {
        const response = await request(
          setup,
          "POST",
          "/api/gateway/combos",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
        expect(apiErrorSchema.parse(response.json()).error).toBe(
          "invalid_request",
        );
      }
      for (const [payload, status, error] of [
        [
          { ...valid, slots: [{ aiAccountId: "nowhere", model: "grok-4" }] },
          400,
          "combo_unknown_ai_account",
        ],
        [
          {
            ...valid,
            slots: [{ aiAccountId: setup.grok, model: "claude-opus-5-5" }],
          },
          400,
          "combo_slot_model_mismatch",
        ],
        [
          { ...valid, slots: [...valid.slots, ...valid.slots] },
          400,
          "combo_duplicate_slot",
        ],
      ] as const) {
        const response = await request(
          setup,
          "POST",
          "/api/gateway/combos",
          payload,
        );
        expect(response.statusCode).toBe(status);
        expect(apiErrorSchema.parse(response.json())).toMatchObject({
          error,
          message: expect.stringMatching(/^Slot [12]\b/) as unknown,
        });
      }
      expect(
        (await request(setup, "POST", "/api/gateway/combos", valid)).statusCode,
      ).toBe(201);
      const taken = await request(setup, "POST", "/api/gateway/combos", valid);
      expect(taken.statusCode).toBe(409);
      expect(apiErrorSchema.parse(taken.json()).error).toBe("combo_name_taken");
      const family = await request(setup, "POST", "/api/gateway/combos", {
        ...valid,
        name: "Second chain",
      });
      expect(family.statusCode).toBe(409);
      expect(apiErrorSchema.parse(family.json())).toEqual({
        error: "combo_model_family_taken",
        message:
          'The enabled Combo "Opus chain" is already assigned to claude-opus. Disable it first, or assign this one elsewhere.',
      });
      expect(await list(setup)).toHaveLength(1);
    },
  ],
];

describe("the Combos API, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const setup = await setUp(
        memoryAiAccountStore(),
        memoryComboStore(),
        createEventBus({ store: memoryEventStore() }),
      );
      await run(setup);
      await setup.server.close();
    });
  }
});

describe("the Combos API, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseAiAccountStore(database.db),
        databaseComboStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      await run(setup);
      await setup.server.close();
    });
  }
});
