import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import type { ComboSettings } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import { createAiAccounts, type AiAccounts } from "../accounts/accounts.ts";
import {
  databaseAiAccountStore,
  memoryAiAccountStore,
  type AiAccountStore,
} from "../accounts/store.ts";
import { ComboError, createCombos, type Combos } from "./combos.ts";
import {
  databaseComboStore,
  memoryComboStore,
  type ComboStore,
} from "./store.ts";

// Combos (PRD FR-40): added, listed, changed and deleted, each change a
// `config.changed` event; slots that could never serve are refused, and no
// two enabled Combos share a model family. Which Combo a request
// waterfalls through: the enabled one for its family, while Combos are on.
// Each case runs in memory and in Postgres 18.

interface Setup {
  readonly accounts: AiAccounts;
  readonly combos: Combos;
  readonly bus: EventBus;
  /** The switch for every Combo. */
  readonly settings: { current: ComboSettings };
  readonly claude: string;
  readonly grok: string;
}

const encryptor = encryptorFromKey(Buffer.alloc(32, 41));
const start = Date.parse("2026-10-10T12:00:00.000Z");

async function setUp(
  accountStore: AiAccountStore,
  store: ComboStore,
  bus: EventBus,
): Promise<Setup> {
  let time = start;
  let id = 0;
  const now = () => new Date((time += 1000));
  const newId = () =>
    `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const accounts = createAiAccounts({
    store: accountStore,
    encryptor,
    events: bus,
    now,
    newId,
  });
  const claude = await accounts.add({
    name: "Claude key",
    aiProvider: "Claude",
    accountType: "api_key",
    credential: "sk-ant-api03-combos-claude-0123456789",
  });
  const grok = await accounts.add({
    name: "Grok key",
    aiProvider: "Grok",
    accountType: "api_key",
    credential: "xai-combos-grok-0123456789",
  });
  const settings = { current: { enabled: true } };
  const combos = createCombos({
    store,
    accounts: accountStore,
    events: bus,
    settings: () => settings.current,
    now,
    newId,
  });
  return { accounts, combos, bus, settings, claude: claude.id, grok: grok.id };
}

/** The keys of each `config.changed` event the Combos published. */
const comboChanges = async (bus: EventBus) =>
  (await bus.eventsAfter(0)).flatMap(({ event }) =>
    event.type === "config.changed" &&
    event.keys.some((key) => key.startsWith("combos."))
      ? [event.keys]
      : [],
  );

/** The error code `promise` is refused with. */
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(ComboError);
  return (error as ComboError).code;
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "adds, changes and deletes a Combo, telling which settings changed",
    async ({ combos, bus, claude, grok }) => {
      const added = await combos.add({
        name: "Opus chain",
        modelFamilies: ["claude-opus"],
        slots: [
          { aiAccountId: claude, model: "claude-opus-5-5" },
          { aiAccountId: grok, model: "grok-4" },
        ],
        enabled: true,
      });
      expect(added).toMatchObject({
        name: "Opus chain",
        modelFamilies: ["claude-opus"],
        slots: [
          { aiAccountId: claude, model: "claude-opus-5-5" },
          { aiAccountId: grok, model: "grok-4" },
        ],
        enabled: true,
      });
      expect(await combos.list()).toEqual([added]);

      const updated = await combos.update(added.id, {
        name: "Opus chain",
        slots: [
          { aiAccountId: grok, model: "grok-4" },
          { aiAccountId: claude, model: "claude-opus-5-5" },
        ],
        enabled: false,
      });
      expect(updated.slots.map(({ model }) => model)).toEqual([
        "grok-4",
        "claude-opus-5-5",
      ]);
      expect(updated.enabled).toBe(false);
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        added.updatedAt.getTime(),
      );
      expect(await combos.list()).toEqual([updated]);
      // Nothing changed: nothing is told.
      await combos.update(added.id, { enabled: false });

      await combos.remove(added.id);
      expect(await combos.list()).toEqual([]);
      expect(await refusal(combos.remove(added.id))).toBe("combo_not_found");
      expect(await refusal(combos.update(added.id, { enabled: true }))).toBe(
        "combo_not_found",
      );
      // Which settings changed, never their values.
      expect(await comboChanges(bus)).toEqual([
        ["combos.added"],
        ["combos.slots", "combos.enabled"],
        ["combos.deleted"],
      ]);
    },
  ],
  [
    "lists Combos oldest first",
    async ({ combos, claude }) => {
      for (const name of ["First", "Second", "Third"]) {
        await combos.add({
          name,
          modelFamilies: [`gpt-${name.toLowerCase()}`],
          slots: [{ aiAccountId: claude, model: "claude-opus-5-5" }],
          enabled: true,
        });
      }
      expect((await combos.list()).map(({ name }) => name)).toEqual([
        "First",
        "Second",
        "Third",
      ]);
    },
  ],
  [
    "refuses slots that could never serve, or that repeat one another",
    async ({ combos, bus, claude, grok }) => {
      const add = (slots: { aiAccountId: string; model: string }[]) =>
        combos.add({
          name: "Opus chain",
          modelFamilies: ["claude-opus"],
          slots,
          enabled: true,
        });
      expect(
        await refusal(
          add([{ aiAccountId: "nowhere", model: "claude-opus-5-5" }]),
        ),
      ).toBe("combo_unknown_ai_account");
      // A Grok account cannot serve a Claude Model.
      expect(
        await refusal(add([{ aiAccountId: grok, model: "claude-opus-5-5" }])),
      ).toBe("combo_slot_model_mismatch");
      expect(
        await refusal(
          add([
            { aiAccountId: claude, model: "claude-opus-5-5" },
            { aiAccountId: claude, model: "claude-opus-5-5" },
          ]),
        ),
      ).toBe("combo_duplicate_slot");
      // A Model of no AI Provider it knows may be any account's.
      const combo = await add([{ aiAccountId: grok, model: "my-own-model" }]);
      expect(
        await refusal(
          combos.update(combo.id, {
            slots: [{ aiAccountId: "nowhere", model: "grok-4" }],
          }),
        ),
      ).toBe("combo_unknown_ai_account");
      expect(await comboChanges(bus)).toEqual([["combos.added"]]);
    },
  ],
  [
    "refuses a name another Combo has",
    async ({ combos, claude }) => {
      const slots = [{ aiAccountId: claude, model: "claude-opus-5-5" }];
      await combos.add({
        name: "Opus chain",
        modelFamilies: ["claude-opus"],
        slots,
        enabled: true,
      });
      const other = await combos.add({
        name: "Sonnet chain",
        modelFamilies: ["claude-sonnet"],
        slots,
        enabled: true,
      });
      expect(
        await refusal(
          combos.add({
            name: "Opus chain",
            modelFamilies: ["claude-haiku"],
            slots,
            enabled: true,
          }),
        ),
      ).toBe("combo_name_taken");
      expect(
        await refusal(combos.update(other.id, { name: "Opus chain" })),
      ).toBe("combo_name_taken");
    },
  ],
  [
    "lets only one enabled Combo have a model family",
    async ({ combos, claude }) => {
      const slots = [{ aiAccountId: claude, model: "claude-sonnet-5-5" }];
      await combos.add({
        name: "Opus chain",
        modelFamilies: ["claude-opus", "claude-haiku"],
        slots,
        enabled: true,
      });
      expect(
        await refusal(
          combos.add({
            name: "Other chain",
            modelFamilies: ["claude-haiku"],
            slots,
            enabled: true,
          }),
        ),
      ).toBe("combo_model_family_taken");
      // Disabled, it may wait for its turn; enabled, it may not.
      const other = await combos.add({
        name: "Other chain",
        modelFamilies: ["claude-haiku"],
        slots,
        enabled: false,
      });
      expect(await refusal(combos.update(other.id, { enabled: true }))).toBe(
        "combo_model_family_taken",
      );
      expect(
        (await combos.update(other.id, { modelFamilies: ["claude-sonnet"] }))
          .modelFamilies,
      ).toEqual(["claude-sonnet"]);
      expect((await combos.update(other.id, { enabled: true })).enabled).toBe(
        true,
      );
    },
  ],
  [
    "finds the enabled Combo for a Model's family, while Combos are on",
    async ({ combos, settings, claude }) => {
      const slots = [{ aiAccountId: claude, model: "claude-sonnet-5-5" }];
      const disabled = await combos.add({
        name: "Disabled chain",
        modelFamilies: ["claude-opus"],
        slots,
        enabled: false,
      });
      expect(await combos.forModel("claude-opus-5-5")).toBeUndefined();
      const enabled = await combos.add({
        name: "Opus chain",
        modelFamilies: ["claude-opus"],
        slots,
        enabled: true,
      });
      expect((await combos.forModel("claude-opus-4-1-20250805"))?.id).toBe(
        enabled.id,
      );
      expect(await combos.forModel("claude-sonnet-5-5")).toBeUndefined();

      // Off, no Combo applies, enabled or not.
      settings.current = { enabled: false };
      expect(await combos.forModel("claude-opus-5-5")).toBeUndefined();
      settings.current = { enabled: true };

      await combos.update(enabled.id, { enabled: false });
      await combos.update(disabled.id, { enabled: true });
      expect((await combos.forModel("claude-opus-5-5"))?.id).toBe(disabled.id);
      await combos.remove(disabled.id);
      expect(await combos.forModel("claude-opus-5-5")).toBeUndefined();
    },
  ],
  [
    "keeps a slot whose AI Account was deleted, and changes the rest",
    async ({ accounts, combos, claude, grok }) => {
      const combo = await combos.add({
        name: "Opus chain",
        modelFamilies: ["claude-opus"],
        slots: [
          { aiAccountId: grok, model: "grok-4" },
          { aiAccountId: claude, model: "claude-opus-5-5" },
        ],
        enabled: false,
      });
      // The Gateway skips its slot; only slots the Owner sets are checked.
      await accounts.remove(grok);
      const updated = await combos.update(combo.id, {
        name: "Renamed",
        enabled: true,
      });
      expect(updated.slots).toEqual(combo.slots);
      expect(
        await refusal(
          combos.update(combo.id, { slots: [...combo.slots].reverse() }),
        ),
      ).toBe("combo_unknown_ai_account");
    },
  ],
];

describe("Combos, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memoryAiAccountStore(),
          memoryComboStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("Combos, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseAiAccountStore(database.db),
          databaseComboStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});
