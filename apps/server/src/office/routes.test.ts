import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  allowInternalHosts,
  allowedInternalHosts,
  apiErrorSchema,
  floorSchema,
  defaultLobbyCast,
  defaultSeasonalEvents,
  intakeSettingsSchema,
  lobbyCastSchema,
  officeGitIdentitySchema,
  ownerProfileSchema,
  sandboxSettingsSchema,
  storageUsageSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, onTestFinished } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The office's Git identity and a Floor's override, through the API (PRD
// FR-68), and intake's settings (FR-8). Each case runs in memory and in
// Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  readonly stores: OfficeStores;
  /** Every log line. */
  readonly logs: string[];
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const logs: string[] = [];
  const server = await buildApp({
    logger: createLogger({
      level: "trace",
      secrets: [],
      destination: { write: (line: string) => logs.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
  });
  return { server, owner: await signIn(server), bus, stores, logs };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "PUT" | "POST" | "PATCH",
  url: string,
  payload?: object,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload }),
  });

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "sends upstream requests through no proxy until the Owner sets one, whose password never comes back",
    async (setup) => {
      // The Owner's proxy is on their own network, which they allow
      // (ADR 0007).
      const allowed = allowedInternalHosts();
      allowInternalHosts([...allowed, ".corp"]);
      onTestFinished(() => {
        allowInternalHosts(allowed);
      });
      const path = "/api/office/outbound-proxy";
      const none = {
        url: null,
        username: null,
        hasPassword: false,
        noProxy: [],
      };
      expect((await request(setup, "GET", path)).json()).toEqual(none);
      const set = await request(setup, "PUT", path, {
        url: "http://proxy.corp:3128",
        username: "office",
        password: "pr0xy-pa55",
        noProxy: ["ollama.lan", ".internal"],
      });
      expect(set.statusCode).toBe(200);
      const shown = {
        url: "http://proxy.corp:3128",
        username: "office",
        hasPassword: true,
        noProxy: ["ollama.lan", ".internal"],
      };
      expect(set.json()).toEqual(shown);
      expect((await request(setup, "GET", path)).json()).toEqual(shown);
      // Sealed where it is kept.
      const stored = await setup.stores.office.gatewayOutboundProxy();
      expect(stored?.password).toMatch(/^aio1:/);
      // Changed without the password: it is kept.
      const moved = await request(setup, "PUT", path, {
        url: "http://proxy.corp:8080",
        username: "office",
        noProxy: ["ollama.lan", ".internal"],
      });
      expect(moved.json()).toEqual({ ...shown, url: "http://proxy.corp:8080" });
      for (const [payload, problem] of [
        [
          { url: "http://office:pr0xy-pa55@proxy.corp:3128" },
          "Leave credentials out of the proxy URL; the username and password have their own fields.",
        ],
        [
          { url: "http://proxy.corp:3128", password: "pr0xy-pa55" },
          "Enter the username the password is for.",
        ],
        [{ url: "socks5://proxy.corp:1080" }, undefined],
      ] as const) {
        const refused = await request(setup, "PUT", path, payload);
        expect(refused.statusCode).toBe(400);
        expect(refused.body).not.toContain("pr0xy-pa55");
        if (problem !== undefined) {
          expect(apiErrorSchema.parse(refused.json()).problems).toEqual([
            problem,
          ]);
        }
      }
      expect((await request(setup, "PUT", path, { url: null })).json()).toEqual(
        none,
      );
      // Each change names what changed, never a value.
      const changes = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (event) =>
            event.type === "config.changed" &&
            event.keys.some((key) => key.startsWith("outboundProxy.")),
        );
      expect(changes).toHaveLength(3);
      expect(JSON.stringify(changes)).not.toContain("pr0xy-pa55");
      expect(setup.logs.join("\n")).not.toContain("pr0xy-pa55");
      // Only the Owner may see or set it.
      const anonymous = await setup.server.inject({ method: "GET", url: path });
      expect(anonymous.statusCode).toBe(401);
    },
  ],
  [
    "has the Owner's noreply identity by default, and sets another",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/git-identity");
      expect(before.statusCode).toBe(200);
      expect(officeGitIdentitySchema.parse(before.json())).toEqual({
        name: "adrianeyre",
        email: "21265837+adrianeyre@users.noreply.github.com",
        isDefault: true,
      });

      const set = await request(setup, "PUT", "/api/office/git-identity", {
        name: "Adrian Eyre",
        email: "adrian@company.example",
      });
      expect(set.statusCode).toBe(200);
      const expected = {
        name: "Adrian Eyre",
        email: "adrian@company.example",
        isDefault: false,
      };
      expect(set.json()).toEqual(expected);
      expect(
        (await request(setup, "GET", "/api/office/git-identity")).json(),
      ).toEqual(expected);
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["gitIdentity"],
      });
    },
  ],
  [
    "refuses a name or an email Git could not use",
    async (setup) => {
      for (const payload of [
        {},
        { name: "", email: "adrian@company.example" },
        { name: "Adrian <Eyre>", email: "adrian@company.example" },
        { name: "Adrian\nEyre", email: "adrian@company.example" },
        { name: "Adrian Eyre", email: "not an email" },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/git-identity",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
      expect(
        (await request(setup, "GET", "/api/office/git-identity")).json(),
      ).toMatchObject({ isDefault: true });
    },
  ],
  [
    "overrides it for a Floor, and clears the override",
    async (setup) => {
      await request(setup, "POST", "/api/floors", {
        repository: "adrianeyre/web-shop",
      });
      const shopBot = {
        name: "Web Shop Owner",
        email: "owner@web-shop.example",
      };
      const set = await request(setup, "PATCH", "/api/floors/web-shop", {
        gitIdentity: shopBot,
      });
      expect(set.statusCode).toBe(200);
      expect(floorSchema.parse(set.json()).gitIdentity).toEqual(shopBot);
      for (const gitIdentity of [
        { name: "Web Shop Owner" },
        { name: "Web <Shop>", email: "owner@web-shop.example" },
      ]) {
        const refused = await request(setup, "PATCH", "/api/floors/web-shop", {
          gitIdentity,
        });
        expect(refused.statusCode).toBe(400);
      }

      const cleared = await request(setup, "PATCH", "/api/floors/web-shop", {
        gitIdentity: null,
      });
      expect(floorSchema.parse(cleared.json()).gitIdentity).toBeNull();
    },
  ],
  [
    "takes in the Owner's issues every 60 seconds by default, and sets intake",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/intake");
      expect(before.statusCode).toBe(200);
      expect(intakeSettingsSchema.parse(before.json())).toEqual({
        ownerLogin: "adrianeyre",
        intervalSeconds: 60,
      });

      const intake = { ownerLogin: "ada-lovelace", intervalSeconds: 300 };
      const set = await request(setup, "PUT", "/api/office/intake", intake);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual(intake);
      expect(
        (await request(setup, "GET", "/api/office/intake")).json(),
      ).toEqual(intake);
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["intake.ownerLogin", "intake.intervalSeconds"],
      });

      for (const payload of [
        {},
        { ownerLogin: "ada-lovelace" },
        { ownerLogin: "ai-office[bot]", intervalSeconds: 60 },
        { ownerLogin: "ada-lovelace", intervalSeconds: 5 },
        { ownerLogin: "ada-lovelace", intervalSeconds: 7200 },
        { ownerLogin: "ada-lovelace", intervalSeconds: "60" },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/intake",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
      expect(
        (await request(setup, "GET", "/api/office/intake")).json(),
      ).toEqual(intake);
    },
  ],
  [
    "runs 3 sandboxes at once by default, and sets another limit",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/sandboxes");
      expect(before.statusCode).toBe(200);
      expect(sandboxSettingsSchema.parse(before.json())).toEqual({
        concurrencyLimit: 3,
      });

      const set = await request(setup, "PUT", "/api/office/sandboxes", {
        concurrencyLimit: 1,
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({ concurrencyLimit: 1 });
      expect(
        (await request(setup, "GET", "/api/office/sandboxes")).json(),
      ).toEqual({ concurrencyLimit: 1 });
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["sandboxes.concurrencyLimit"],
      });

      for (const payload of [
        {},
        { concurrencyLimit: 0 },
        { concurrencyLimit: 51 },
        { concurrencyLimit: 1.5 },
        { concurrencyLimit: "2" },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/sandboxes",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "keeps bodies 7 days, records 90, the Activity Feed a year and delivery logs 90 days by default, and sets other periods",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/retention");
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        requestBodiesDays: 7,
        requestMetadataDays: 90,
        activityDays: 365,
        connectionDeliveriesDays: 90,
      });
      const chosen = {
        requestBodiesDays: 3,
        requestMetadataDays: 40,
        activityDays: 365,
        connectionDeliveriesDays: 30,
      };
      const set = await request(setup, "PUT", "/api/office/retention", chosen);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual(chosen);
      expect(
        (await request(setup, "GET", "/api/office/retention")).json(),
      ).toEqual(chosen);
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: [
          "retention.requestBodiesDays",
          "retention.requestMetadataDays",
          "retention.connectionDeliveriesDays",
        ],
      });

      for (const payload of [
        {},
        { ...chosen, requestBodiesDays: -1 },
        { ...chosen, requestMetadataDays: 31 },
        { ...chosen, requestMetadataDays: 3651 },
        { ...chosen, activityDays: 29 },
        { ...chosen, activityDays: 100.5 },
        { ...chosen, connectionDeliveriesDays: 0 },
        { ...chosen, requestBodiesDays: 41 },
        { ...chosen, extra: true },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/retention",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "retries three times from 500 ms by default, and sets other retries at runtime",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/retries");
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        attempts: 3,
        delayMs: 500,
        multiplier: 2,
        circuitBreakerThreshold: 5,
        circuitBreakerCooldownSeconds: 60,
      });
      const chosen = {
        attempts: 4,
        delayMs: 1000,
        multiplier: 1.5,
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownSeconds: 60,
      };
      const set = await request(setup, "PUT", "/api/office/retries", chosen);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual(chosen);
      expect(
        (await request(setup, "GET", "/api/office/retries")).json(),
      ).toEqual(chosen);
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "gateway",
        keys: [
          "retries.attempts",
          "retries.delayMs",
          "retries.multiplier",
          "retries.circuitBreakerThreshold",
        ],
      });

      for (const payload of [
        {},
        { ...chosen, attempts: 0 },
        { ...chosen, attempts: 11 },
        { ...chosen, attempts: 2.5 },
        { ...chosen, delayMs: -1 },
        { ...chosen, delayMs: 60_001 },
        { ...chosen, multiplier: 0.5 },
        { ...chosen, circuitBreakerThreshold: 0 },
        { ...chosen, circuitBreakerCooldownSeconds: 3601 },
        { ...chosen, extra: true },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/retries",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "paces no usage window by default, and turns the pacing gates on at runtime",
    async (setup) => {
      const before = await request(
        setup,
        "GET",
        "/api/office/usage-throttling",
      );
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        fiveHourPacing: false,
        weeklyPacing: false,
      });
      const set = await request(setup, "PUT", "/api/office/usage-throttling", {
        fiveHourPacing: true,
        weeklyPacing: false,
      });
      expect(set.statusCode).toBe(200);
      expect(
        (await request(setup, "GET", "/api/office/usage-throttling")).json(),
      ).toEqual({ fiveHourPacing: true, weeklyPacing: false });
      // Setting the same again changes nothing.
      await request(setup, "PUT", "/api/office/usage-throttling", {
        fiveHourPacing: true,
        weeklyPacing: false,
      });
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.type === "config.changed" &&
              event.keys.some((key) => key.startsWith("usageThrottling.")),
          ),
      ).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["usageThrottling.fiveHourPacing"],
        },
      ]);
      for (const payload of [
        {},
        { fiveHourPacing: true },
        { fiveHourPacing: "on", weeklyPacing: false },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/usage-throttling",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "auto-refreshes no usage window by default, and turns auto-refresh on at runtime",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/auto-refresh");
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ enabled: false });
      const set = await request(setup, "PUT", "/api/office/auto-refresh", {
        enabled: true,
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({ enabled: true });
      expect(
        (await request(setup, "GET", "/api/office/auto-refresh")).json(),
      ).toEqual({ enabled: true });
      // Setting the same again changes nothing; turning it off does.
      await request(setup, "PUT", "/api/office/auto-refresh", {
        enabled: true,
      });
      await request(setup, "PUT", "/api/office/auto-refresh", {
        enabled: false,
      });
      expect(
        (await request(setup, "GET", "/api/office/auto-refresh")).json(),
      ).toEqual({ enabled: false });
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.type === "config.changed" &&
              event.keys.includes("autoRefresh.enabled"),
          ),
      ).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["autoRefresh.enabled"],
        },
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["autoRefresh.enabled"],
        },
      ]);
      for (const payload of [
        {},
        { enabled: "on" },
        { enabled: true, bufferSeconds: 60 },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/auto-refresh",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "keeps no prompt cache warm by default, and turns keep-alive on at runtime",
    async (setup) => {
      const path = "/api/office/prompt-cache-keep-alive";
      const before = await request(setup, "GET", path);
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        enabled: false,
        idleMinutes: 30,
        maxPerAccountPerHour: 60,
      });
      const on = { enabled: true, idleMinutes: 20, maxPerAccountPerHour: 30 };
      const set = await request(setup, "PUT", path, on);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual(on);
      expect((await request(setup, "GET", path)).json()).toEqual(on);
      // Setting the same again changes nothing.
      await request(setup, "PUT", path, on);
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.type === "config.changed" &&
              event.keys.some((key) => key.startsWith("keepAlive.")),
          ),
      ).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: [
            "keepAlive.enabled",
            "keepAlive.idleMinutes",
            "keepAlive.maxPerAccountPerHour",
          ],
        },
      ]);
      for (const payload of [
        {},
        { enabled: true },
        { ...on, enabled: "on" },
        { ...on, idleMinutes: 4 },
        { ...on, idleMinutes: 481 },
        { ...on, maxPerAccountPerHour: 0 },
        { ...on, maxPerAccountPerHour: 601 },
        { ...on, ttl: "1h" },
      ]) {
        const response = await request(setup, "PUT", path, payload);
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
      expect((await request(setup, "GET", path)).json()).toEqual(on);
    },
  ],
  [
    "asks no Decision Model by default, and turns Jev on at runtime, never as anything but Jev",
    async (setup) => {
      const path = "/api/office/decision-model";
      const before = await request(setup, "GET", path);
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        enabled: false,
        model: "typesafe/jev-1.13",
        summaries: false,
      });
      const on = {
        enabled: true,
        model: "~typesafe/jev-latest",
        summaries: true,
      };
      const set = await request(setup, "PUT", path, on);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual(on);
      expect((await request(setup, "GET", path)).json()).toEqual(on);
      // Setting the same again changes nothing.
      await request(setup, "PUT", path, on);
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.type === "config.changed" &&
              event.keys.some((key) => key.startsWith("decisionModel.")),
          ),
      ).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "office",
          keys: [
            "decisionModel.enabled",
            "decisionModel.model",
            "decisionModel.summaries",
          ],
        },
      ]);
      for (const payload of [
        {},
        { enabled: true },
        { ...on, enabled: "on" },
        { ...on, model: "claude-opus-5-5" },
        { ...on, model: "typesafe/jev-router" },
        { ...on, threshold: 0.8 },
      ]) {
        const response = await request(setup, "PUT", path, payload);
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
      expect((await request(setup, "GET", path)).json()).toEqual(on);
      const anonymous = await setup.server.inject({ method: "GET", url: path });
      expect(anonymous.statusCode).toBe(401);
    },
  ],
  [
    "waterfalls through no Combo by default, and turns Combos on at runtime",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/combos");
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ enabled: false });
      const set = await request(setup, "PUT", "/api/office/combos", {
        enabled: true,
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({ enabled: true });
      expect(
        (await request(setup, "GET", "/api/office/combos")).json(),
      ).toEqual({ enabled: true });
      // Setting the same again changes nothing; turning them off does.
      await request(setup, "PUT", "/api/office/combos", { enabled: true });
      await request(setup, "PUT", "/api/office/combos", { enabled: false });
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.type === "config.changed" &&
              event.keys.includes("comboSettings.enabled"),
          ),
      ).toHaveLength(2);
      for (const payload of [{}, { enabled: "on" }, { enabled: true, x: 1 }]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/combos",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "balances by session for five hours by default, and sets another strategy at runtime",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/load-balancing");
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        strategy: "session",
        sessionWindowMinutes: 300,
      });

      const set = await request(setup, "PUT", "/api/office/load-balancing", {
        strategy: "least_used",
        sessionWindowMinutes: 300,
      });
      expect(set.statusCode).toBe(200);
      expect(
        (await request(setup, "GET", "/api/office/load-balancing")).json(),
      ).toEqual({ strategy: "least_used", sessionWindowMinutes: 300 });
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "gateway",
        keys: ["loadBalancing.strategy"],
      });

      // Session-affinity and drain-soonest, strict or not (FR-37), are
      // kept as the others are: in Postgres too, past its check.
      for (const strategy of [
        "session_affinity",
        "drain_soonest",
        "drain_soonest_strict",
      ]) {
        const chosen = await request(
          setup,
          "PUT",
          "/api/office/load-balancing",
          { strategy, sessionWindowMinutes: 60 },
        );
        expect(chosen.statusCode).toBe(200);
        expect(
          (await request(setup, "GET", "/api/office/load-balancing")).json(),
        ).toEqual({ strategy, sessionWindowMinutes: 60 });
      }

      for (const payload of [
        {},
        { strategy: "round_robin", sessionWindowMinutes: 300 },
        { strategy: "session", sessionWindowMinutes: 0 },
        { strategy: "session", sessionWindowMinutes: 10081 },
        { strategy: "session" },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/load-balancing",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "has every seasonal event on, on its usual dates, until the Owner changes them",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/seasonal-events");
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual(defaultSeasonalEvents);
      const changed = structuredClone(defaultSeasonalEvents);
      changed.events.halloween.actors["creepy-clown"] = false;
      changed.events.easter.enabled = false;
      changed.events.christmas.start = "12-05";
      const set = await request(
        setup,
        "PUT",
        "/api/office/seasonal-events",
        changed,
      );
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual(changed);
      expect(
        (await request(setup, "GET", "/api/office/seasonal-events")).json(),
      ).toEqual(changed);
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.type === "config.changed" &&
              event.keys.includes("seasonalEvents"),
          ),
      ).toHaveLength(1);
      for (const payload of [
        {},
        { events: { ...changed.events, christmas: undefined } },
        {
          events: {
            ...changed.events,
            easter: { ...changed.events.easter, end: "02-30" },
          },
        },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/seasonal-events",
          payload,
        );
        expect(response.statusCode).toBe(400);
      }
    },
  ],
  [
    "leaves prompt-cache TTLs as sent by default, and sets one at runtime",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/prompt-cache");
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({ ttl: "as_sent" });
      for (const ttl of ["1h", "1h", "5m", "as_sent"]) {
        const set = await request(setup, "PUT", "/api/office/prompt-cache", {
          ttl,
        });
        expect(set.json()).toEqual({ ttl });
        expect(
          (await request(setup, "GET", "/api/office/prompt-cache")).json(),
        ).toEqual({ ttl });
      }
      // Told once for each change; never for setting the same again.
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.type === "config.changed" &&
              event.keys.includes("promptCache.ttl"),
          ),
      ).toHaveLength(3);
      for (const payload of [{}, { ttl: "10m" }, { ttl: "1h", extra: 1 }]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/prompt-cache",
          payload,
        );
        expect({ payload, status: response.statusCode }).toEqual({
          payload,
          status: 400,
        });
      }
    },
  ],
  [
    "tells the storage each history takes, and deletes only what may go",
    async (setup) => {
      const usage = await request(setup, "GET", "/api/office/storage");
      expect(usage.statusCode).toBe(200);
      const parsed = storageUsageSchema.parse(usage.json());
      expect(parsed.categories.map(({ category }) => category)).toEqual([
        "activity",
        "request_bodies",
        "requests",
        "usage_history",
        "sign_ins",
        "connection_deliveries",
      ]);

      const pruned = await request(setup, "POST", "/api/office/storage/prune", {
        category: "request_bodies",
        olderThanDays: 0,
      });
      expect(pruned.statusCode).toBe(200);
      expect(pruned.json()).toEqual({ category: "request_bodies", deleted: 0 });

      // A month of request metadata and of activity are kept, as
      // retention keeps them.
      for (const [payload, problem] of [
        [
          { category: "requests", olderThanDays: 31 },
          "Gateway requests: the last 32 days are always kept.",
        ],
        [
          { category: "activity", olderThanDays: 29 },
          "Activity: the last 30 days are always kept.",
        ],
        [
          { category: "connection_deliveries", olderThanDays: 0 },
          "Connection deliveries: the last day is always kept.",
        ],
        [
          { category: "everything", olderThanDays: 90 },
          "Choose what to delete: activity, request_bodies, requests, usage_history, sign_ins, connection_deliveries.",
        ],
        [
          { category: "activity", olderThanDays: 1.5 },
          "Give a whole number of days.",
        ],
      ] as const) {
        const response = await request(
          setup,
          "POST",
          "/api/office/storage/prune",
          payload,
        );
        expect(response.statusCode).toBe(400);
        expect(apiErrorSchema.parse(response.json()).problems).toContain(
          problem,
        );
      }
    },
  ],
  [
    "has an empty profile in British time by default, and sets another",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/profile");
      expect(before.statusCode).toBe(200);
      expect(ownerProfileSchema.parse(before.json())).toEqual({
        forename: "",
        surname: "",
        nickname: "",
        timeZone: "Europe/London",
      });

      const profile = {
        forename: "Adrian",
        surname: "Eyre",
        nickname: "Ade",
        timeZone: "America/New_York",
      };
      const set = await request(setup, "PUT", "/api/office/profile", profile);
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual(profile);
      expect(
        (await request(setup, "GET", "/api/office/profile")).json(),
      ).toEqual(profile);
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["ownerProfile"],
      });
    },
  ],
  [
    "refuses a profile with an unknown time zone or a name with a line break",
    async (setup) => {
      for (const payload of [
        {},
        { forename: "", surname: "", nickname: "", timeZone: "Mars/Olympus" },
        {
          forename: "Ade\nEyre",
          surname: "",
          nickname: "",
          timeZone: "Europe/London",
        },
      ]) {
        const response = await request(
          setup,
          "PUT",
          "/api/office/profile",
          payload,
        );
        expect(response.statusCode).toBe(400);
        expect(apiErrorSchema.parse(response.json()).error).toBe(
          "invalid_request",
        );
      }
    },
  ],
  [
    "has the default lobby cast, and sets the receptionist and the visitor apart",
    async (setup) => {
      const before = await request(setup, "GET", "/api/office/lobby-cast");
      expect(before.statusCode).toBe(200);
      expect(lobbyCastSchema.parse(before.json())).toEqual(defaultLobbyCast);

      const receptionist = {
        name: "Rosa",
        avatar: {
          ...defaultLobbyCast.receptionist.avatar,
          skinTone: "#3b2219",
        },
      };
      const set = await request(
        setup,
        "PUT",
        "/api/office/lobby-cast/receptionist",
        receptionist,
      );
      expect(set.statusCode).toBe(200);
      const expected = { ...defaultLobbyCast, receptionist };
      expect(set.json()).toEqual(expected);
      expect(
        (await request(setup, "GET", "/api/office/lobby-cast")).json(),
      ).toEqual(expected);
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["lobbyCast.receptionist"],
      });

      for (const [url, payload] of [
        ["/api/office/lobby-cast/manager", receptionist],
        ["/api/office/lobby-cast/visitor", { ...receptionist, name: "" }],
        [
          "/api/office/lobby-cast/visitor",
          { ...receptionist, avatar: { presentation: "robot" } },
        ],
      ] as const) {
        const refused = await request(setup, "PUT", url, payload);
        expect(refused.statusCode).toBe(400);
      }
    },
  ],
  [
    "turns a Floor's idle activities off and on again",
    async (setup) => {
      await request(setup, "POST", "/api/floors", {
        repository: "adrianeyre/web-shop",
      });
      expect(
        (await request(setup, "GET", "/api/office/activities")).json(),
      ).toEqual({ disabled: {} });
      const set = await request(
        setup,
        "PUT",
        "/api/floors/web-shop/activities",
        { disabled: ["darts", "water-cooler chat"] },
      );
      expect(set.statusCode).toBe(200);
      expect(
        (await request(setup, "GET", "/api/office/activities")).json(),
      ).toEqual({ disabled: { "web-shop": ["darts", "water-cooler chat"] } });
      expect(
        (await setup.bus.eventsAfter(0)).map(({ event }) => event),
      ).toContainEqual({
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId: "web-shop",
        keys: ["activities"],
      });
      await request(setup, "PUT", "/api/floors/web-shop/activities", {
        disabled: [],
      });
      expect(
        (await request(setup, "GET", "/api/office/activities")).json(),
      ).toEqual({ disabled: {} });
      expect(
        (
          await request(setup, "PUT", "/api/floors/nowhere/activities", {
            disabled: [],
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await request(setup, "PUT", "/api/floors/web-shop/activities", {
            disabled: ["darts", "darts"],
          })
        ).statusCode,
      ).toBe(400);
    },
  ],
];

describe("the office's settings, in memory", () => {
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

describe("the office's settings, in Postgres 18", () => {
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
