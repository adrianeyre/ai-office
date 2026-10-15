import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { floorErrorCodes } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import { FloorError } from "../floors/errors.ts";
import { createFloors, type Floors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createOfficeSettings,
  outboundProxyPasswordContext,
  type OfficeSettings,
} from "./settings.ts";

// The office's Git identity and each Floor's override (PRD FR-68),
// intake's settings (FR-8), the AI Gateway's (FR-35, FR-37, FR-39), and
// the Decision Model's (FR-17, FR-89).
// Every case runs in memory and in Postgres 18.

const encryptor = encryptorFromKey(Buffer.alloc(32, 51));

interface Setup {
  readonly settings: OfficeSettings;
  readonly floors: Floors;
  readonly bus: EventBus;
  readonly stores: OfficeStores;
  /** Secrets told for redaction. */
  readonly secrets: string[];
}

function setUp(stores: OfficeStores, bus: EventBus): Setup {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const secrets: string[] = [];
  return {
    settings: createOfficeSettings({
      store: stores.office,
      floors: stores.floors,
      events: bus,
      encryptor,
      onSecret: (secret) => secrets.push(secret),
    }),
    floors: createFloors({ store: stores.floors, github, events: bus }),
    bus,
    stores,
    secrets,
  };
}

const owner = {
  name: "adrianeyre",
  email: "21265837+adrianeyre@users.noreply.github.com",
};
const company = { name: "Adrian Eyre", email: "adrian@company.example" };
const shopBot = { name: "Web Shop Owner", email: "owner@web-shop.example" };

const configChanges = async (bus: EventBus) =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type === "config.changed");

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "is the Owner's GitHub noreply identity until it is set",
    async ({ settings }) => {
      expect(await settings.gitIdentity()).toEqual({
        ...owner,
        isDefault: true,
      });
    },
  ],
  [
    "is set in the office admin, recording that it changed",
    async ({ settings, bus }) => {
      expect(await settings.setGitIdentity(company)).toEqual({
        ...company,
        isDefault: false,
      });
      expect(await settings.gitIdentity()).toEqual({
        ...company,
        isDefault: false,
      });
      // The same again changes nothing.
      await settings.setGitIdentity(company);
      expect(await configChanges(bus)).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "office",
          keys: ["gitIdentity"],
        },
      ]);
    },
  ],
  [
    "gives a Floor the office's identity, unless the Floor's own wins",
    async ({ settings, floors }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/blog");
      expect(await settings.floorGitIdentity("web-shop")).toEqual(owner);

      await settings.setGitIdentity(company);
      await floors.updateSettings("web-shop", { gitIdentity: shopBot });
      expect(await settings.floorGitIdentity("web-shop")).toEqual(shopBot);
      expect(await settings.floorGitIdentity("blog")).toEqual(company);
      expect((await floors.get("web-shop")).gitIdentity).toEqual(shopBot);

      // Without its own, the Floor goes back to the office's.
      await floors.updateSettings("web-shop", { gitIdentity: null });
      expect(await settings.floorGitIdentity("web-shop")).toEqual(company);
    },
  ],
  [
    "takes in the Owner's issues every 60 seconds until intake is set",
    async ({ settings, bus }) => {
      expect(await settings.intakeSettings()).toEqual({
        ownerLogin: "adrianeyre",
        intervalSeconds: 60,
      });
      const set = { ownerLogin: "ada-lovelace", intervalSeconds: 30 };
      expect(await settings.setIntakeSettings(set)).toEqual(set);
      expect(await settings.intakeSettings()).toEqual(set);
      // Setting the Git identity leaves intake's settings alone.
      await settings.setGitIdentity(company);
      await settings.setIntakeSettings({ ...set, intervalSeconds: 120 });
      expect(await settings.intakeSettings()).toEqual({
        ownerLogin: "ada-lovelace",
        intervalSeconds: 120,
      });
      expect((await configChanges(bus)).map(({ keys }) => keys)).toEqual([
        ["intake.ownerLogin", "intake.intervalSeconds"],
        ["gitIdentity"],
        ["intake.intervalSeconds"],
      ]);
    },
  ],
  [
    "runs 3 sandboxes at once until the limit is set",
    async ({ settings, bus }) => {
      expect(await settings.sandboxSettings()).toEqual({ concurrencyLimit: 3 });
      expect(
        await settings.setSandboxSettings({ concurrencyLimit: 1 }),
      ).toEqual({ concurrencyLimit: 1 });
      expect(await settings.sandboxSettings()).toEqual({ concurrencyLimit: 1 });
      // Other settings leave it alone; the same again changes nothing.
      await settings.setIntakeSettings({
        ownerLogin: "adrianeyre",
        intervalSeconds: 60,
      });
      await settings.setSandboxSettings({ concurrencyLimit: 1 });
      expect(await settings.sandboxSettings()).toEqual({ concurrencyLimit: 1 });
      expect((await configChanges(bus)).map(({ keys }) => keys)).toEqual([
        ["sandboxes.concurrencyLimit"],
      ]);
    },
  ],
  [
    "keeps Gateway request bodies until the Owner turns it off",
    async ({ settings, bus }) => {
      expect(await settings.requestBodiesSettings()).toEqual({ store: true });
      expect(await settings.setRequestBodiesSettings({ store: false })).toEqual(
        { store: false },
      );
      expect(await settings.requestBodiesSettings()).toEqual({ store: false });
      await settings.setRequestBodiesSettings({ store: false });
      await settings.setSandboxSettings({ concurrencyLimit: 2 });
      expect(await settings.requestBodiesSettings()).toEqual({ store: false });
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([
        ["gateway", ["requestBodies.store"]],
        ["office", ["sandboxes.concurrencyLimit"]],
      ]);
    },
  ],
  [
    "balances by session for five hours until the Owner chooses otherwise",
    async ({ settings, bus }) => {
      expect(await settings.loadBalancingSettings()).toEqual({
        strategy: "session",
        sessionWindowMinutes: 300,
      });
      await settings.setLoadBalancingSettings({
        strategy: "session",
        sessionWindowMinutes: 90,
      });
      await settings.setLoadBalancingSettings({
        strategy: "least_used",
        sessionWindowMinutes: 90,
      });
      // The same again changes nothing.
      await settings.setLoadBalancingSettings({
        strategy: "least_used",
        sessionWindowMinutes: 90,
      });
      expect(await settings.loadBalancingSettings()).toEqual({
        strategy: "least_used",
        sessionWindowMinutes: 90,
      });
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([
        ["gateway", ["loadBalancing.sessionWindowMinutes"]],
        ["gateway", ["loadBalancing.strategy"]],
      ]);
    },
  ],
  [
    "retries three times from 500 ms until the Owner chooses otherwise",
    async ({ settings, bus }) => {
      expect(await settings.retrySettings()).toEqual({
        attempts: 3,
        delayMs: 500,
        multiplier: 2,
        circuitBreakerThreshold: 5,
        circuitBreakerCooldownSeconds: 60,
      });
      const chosen = {
        attempts: 5,
        delayMs: 250,
        multiplier: 1.5,
        circuitBreakerThreshold: 5,
        circuitBreakerCooldownSeconds: 120,
      };
      expect(await settings.setRetrySettings(chosen)).toEqual(chosen);
      // The same again changes nothing.
      await settings.setRetrySettings(chosen);
      expect(await settings.retrySettings()).toEqual(chosen);
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([
        [
          "gateway",
          [
            "retries.attempts",
            "retries.delayMs",
            "retries.multiplier",
            "retries.circuitBreakerCooldownSeconds",
          ],
        ],
      ]);
    },
  ],
  [
    "keeps bodies 7 days, records 90, activity a year and delivery logs 90 days until the Owner chooses otherwise",
    async ({ settings, bus }) => {
      expect(await settings.retentionSettings()).toEqual({
        requestBodiesDays: 7,
        requestMetadataDays: 90,
        activityDays: 365,
        connectionDeliveriesDays: 90,
      });
      const chosen = {
        requestBodiesDays: 2,
        requestMetadataDays: 90,
        activityDays: 730,
        connectionDeliveriesDays: 30,
      };
      expect(await settings.setRetentionSettings(chosen)).toEqual(chosen);
      // The same again changes nothing.
      await settings.setRetentionSettings(chosen);
      expect(await settings.retentionSettings()).toEqual(chosen);
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([
        [
          "office",
          [
            "retention.requestBodiesDays",
            "retention.activityDays",
            "retention.connectionDeliveriesDays",
          ],
        ],
      ]);
    },
  ],
  [
    "auto-refreshes no usage window until the Owner turns it on",
    async ({ settings, bus }) => {
      expect(await settings.autoRefreshSettings()).toEqual({ enabled: false });
      // Off again changes nothing; on, then on again, is one change.
      await settings.setAutoRefreshSettings({ enabled: false });
      expect(await settings.setAutoRefreshSettings({ enabled: true })).toEqual({
        enabled: true,
      });
      await settings.setAutoRefreshSettings({ enabled: true });
      expect(await settings.autoRefreshSettings()).toEqual({ enabled: true });
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([["gateway", ["autoRefresh.enabled"]]]);
    },
  ],
  [
    "waterfalls no request through a Combo until the Owner turns Combos on",
    async ({ settings, bus }) => {
      expect(await settings.comboSettings()).toEqual({ enabled: false });
      // Off again changes nothing; on, then on again, is one change.
      await settings.setComboSettings({ enabled: false });
      expect(await settings.setComboSettings({ enabled: true })).toEqual({
        enabled: true,
      });
      await settings.setComboSettings({ enabled: true });
      expect(await settings.comboSettings()).toEqual({ enabled: true });
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([["gateway", ["comboSettings.enabled"]]]);
    },
  ],
  [
    "keeps no prompt cache warm until the Owner turns keep-alive on",
    async ({ settings, bus }) => {
      expect(await settings.keepAliveSettings()).toEqual({
        enabled: false,
        idleMinutes: 30,
        maxPerAccountPerHour: 60,
      });
      // The defaults again change nothing; then only what changed is named.
      await settings.setKeepAliveSettings({
        enabled: false,
        idleMinutes: 30,
        maxPerAccountPerHour: 60,
      });
      expect(
        await settings.setKeepAliveSettings({
          enabled: true,
          idleMinutes: 45,
          maxPerAccountPerHour: 60,
        }),
      ).toEqual({ enabled: true, idleMinutes: 45, maxPerAccountPerHour: 60 });
      await settings.setKeepAliveSettings({
        enabled: true,
        idleMinutes: 45,
        maxPerAccountPerHour: 20,
      });
      expect(await settings.keepAliveSettings()).toEqual({
        enabled: true,
        idleMinutes: 45,
        maxPerAccountPerHour: 20,
      });
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([
        ["gateway", ["keepAlive.enabled", "keepAlive.idleMinutes"]],
        ["gateway", ["keepAlive.maxPerAccountPerHour"]],
      ]);
    },
  ],
  [
    "asks no Decision Model until the Owner turns it on",
    async ({ settings, bus }) => {
      expect(await settings.decisionModelSettings()).toEqual({
        enabled: false,
        model: "typesafe/jev-1.13",
        summaries: false,
      });
      // The defaults again change nothing; then only what changed is named.
      await settings.setDecisionModelSettings({
        enabled: false,
        model: "typesafe/jev-1.13",
        summaries: false,
      });
      expect(
        await settings.setDecisionModelSettings({
          enabled: true,
          model: "~typesafe/jev-latest",
          summaries: false,
        }),
      ).toEqual({
        enabled: true,
        model: "~typesafe/jev-latest",
        summaries: false,
      });
      await settings.setDecisionModelSettings({
        enabled: true,
        model: "~typesafe/jev-latest",
        summaries: true,
      });
      expect(await settings.decisionModelSettings()).toEqual({
        enabled: true,
        model: "~typesafe/jev-latest",
        summaries: true,
      });
      expect(
        (await configChanges(bus)).map(({ scope, keys }) => [scope, keys]),
      ).toEqual([
        ["office", ["decisionModel.enabled", "decisionModel.model"]],
        ["office", ["decisionModel.summaries"]],
      ]);
    },
  ],
  [
    "sends upstream requests through no proxy until the Owner sets one, its password sealed and never shown",
    async ({ settings, bus, stores, secrets }) => {
      expect(await settings.outboundProxySettings()).toEqual({
        url: null,
        username: null,
        hasPassword: false,
        noProxy: [],
      });
      expect(await settings.outboundProxy()).toBeNull();

      const set = await settings.setOutboundProxySettings({
        url: "http://proxy.corp:3128",
        username: "office",
        password: "pr0xy-pa55",
        noProxy: ["ollama.lan"],
      });
      expect(set).toEqual({
        url: "http://proxy.corp:3128",
        username: "office",
        hasPassword: true,
        noProxy: ["ollama.lan"],
      });
      expect(JSON.stringify(set)).not.toContain("pr0xy-pa55");
      // Stored sealed: only the encryption key opens it.
      const stored = await stores.office.gatewayOutboundProxy();
      expect(stored?.password).toMatch(/^aio1:/);
      expect(stored?.password).not.toContain("pr0xy-pa55");
      expect(
        encryptor.decrypt(stored?.password ?? "", outboundProxyPasswordContext),
      ).toBe("pr0xy-pa55");
      // The Gateway gets it opened, and it is told for redaction.
      expect(await settings.outboundProxy()).toEqual({
        url: "http://proxy.corp:3128",
        username: "office",
        password: "pr0xy-pa55",
        noProxy: ["ollama.lan"],
      });
      expect(secrets).toContain("pr0xy-pa55");

      // No password given: the stored one stays, for the same username.
      await settings.setOutboundProxySettings({
        url: "http://proxy.corp:8080",
        username: "office",
      });
      expect((await settings.outboundProxy())?.password).toBe("pr0xy-pa55");
      expect((await settings.outboundProxySettings()).noProxy).toEqual([
        "ollama.lan",
      ]);
      // Another username drops it.
      await settings.setOutboundProxySettings({
        url: "http://proxy.corp:8080",
        username: "agents",
      });
      expect(await settings.outboundProxySettings()).toMatchObject({
        username: "agents",
        hasPassword: false,
      });
      // No proxy at all forgets everything.
      expect(await settings.setOutboundProxySettings({ url: null })).toEqual({
        url: null,
        username: null,
        hasPassword: false,
        noProxy: [],
      });
      expect(await settings.outboundProxy()).toBeNull();

      // Each change names what changed, never a value.
      const changes = (await configChanges(bus)).map(({ scope, keys }) => [
        scope,
        keys,
      ]);
      expect(changes).toEqual([
        [
          "gateway",
          [
            "outboundProxy.url",
            "outboundProxy.username",
            "outboundProxy.password",
            "outboundProxy.noProxy",
          ],
        ],
        ["gateway", ["outboundProxy.url"]],
        ["gateway", ["outboundProxy.username", "outboundProxy.password"]],
        [
          "gateway",
          [
            "outboundProxy.url",
            "outboundProxy.username",
            "outboundProxy.noProxy",
          ],
        ],
      ]);
      expect(JSON.stringify(await bus.eventsAfter(0))).not.toContain(
        "pr0xy-pa55",
      );
    },
  ],
  [
    "answers floor_not_found for a Floor that does not exist",
    async ({ settings }) => {
      const error = await settings.floorGitIdentity("nowhere").then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(FloorError);
      expect((error as FloorError).code).toBe(floorErrorCodes.floorNotFound);
    },
  ],
];

describe("office settings, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(setUp(memoryStores(), createEventBus({ store: memoryEventStore() }))),
    );
  }
});

describe("office settings, kept in Postgres 18", () => {
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
