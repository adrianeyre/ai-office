import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createGatewayKeys,
  databaseGatewayKeyStore,
  memoryGatewayKeyStore,
  type GatewayKeys,
  type GatewayKeyStore,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createAgents,
  createWorkQueue,
  databaseStores,
  databaseWorkQueueStore,
  memoryStores,
  memoryWorkQueueStore,
  type Agents,
  type OfficeStores,
  type WorkQueue,
  type WorkQueueStore,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  floorSchema,
  gatewayKeyListSchema,
  teamChangeSchema,
  type Agent,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  signIn,
  testAuth,
  testEncryptor,
  type SignedIn,
} from "../test-support.ts";

// A Floor's team through the API, as the server runs it (PRD FR-10): the
// Agents, the work queue whose running work keeps an Agent busy, and the
// Gateway Keys each new Agent gets and each removed one loses. Raising a
// Role's team size adds copies of its first Agent, each with its own name,
// Avatar and Gateway Key; lowering it removes idle Agents first, and a busy
// one finishes its task, then goes. Each case runs in memory and in
// Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  readonly keys: GatewayKeys;
  readonly queue: WorkQueue;
  /** The Agents, as the orchestrator adds Contractors to them. */
  readonly agents: Agents;
  /** Ends the running work for an issue. */
  readonly finish: (issue: number) => void;
  /** Issues whose work has started, and the Agent working each. */
  readonly started: { issue: number; agentId: string | null }[];
}

async function setUp(
  stores: OfficeStores,
  work: WorkQueueStore,
  keyStore: GatewayKeyStore,
  bus: EventBus,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  const keys = createGatewayKeys({
    store: keyStore,
    encryptor: testEncryptor,
    events: bus,
  });
  // As the server wires them: an Agent removed in the middle of a task
  // goes once the work queue says its work has ended.
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    roles: stores.roles,
    work,
  });
  const running = new Map<number, () => void>();
  const started: Setup["started"] = [];
  const queue = createWorkQueue({
    store: work,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    execute: (item) =>
      new Promise((resolve) => {
        started.push({ issue: item.issue, agentId: item.agentId });
        running.set(item.issue, () => {
          resolve("finished");
        });
      }),
    onEnded: (item) => {
      void agents.settle(item.floorId);
    },
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    gatewayKeys: keys,
    workQueue: work,
    agents,
  });
  await queue.start();
  return {
    server,
    owner: await signIn(server),
    bus,
    keys,
    queue,
    agents,
    started,
    finish(issue) {
      running.get(issue)?.();
      running.delete(issue);
    },
  };
}

/** Adds web-shop as a Floor. */
async function webShop({ server, owner }: Setup) {
  const response = await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  return floorSchema.parse(response.json());
}

async function team({ server, owner }: Setup): Promise<Agent[]> {
  const response = await server.inject({
    url: "/api/floors/web-shop/agents",
    headers: owner.headers,
  });
  return agentListSchema.parse(response.json()).agents;
}

const coders = async (setup: Setup) =>
  (await team(setup)).filter(({ role }) => role === "coder");

async function setCoders({ server, owner }: Setup, count: number) {
  const response = await server.inject({
    method: "PUT",
    url: "/api/floors/web-shop/team/coder",
    headers: owner.headers,
    payload: { count },
  });
  expect(response.statusCode).toBe(200);
  return teamChangeSchema.parse(response.json());
}

/** What makes Avatars look different at a glance (as `randomAvatar` judges). */
const look = ({ avatar }: Agent) =>
  [
    avatar.presentation,
    avatar.hairstyle,
    avatar.hairColour,
    avatar.skinTone,
    avatar.outfit.style,
    avatar.outfit.primaryColour,
  ].join(" ");

const ids = (agents: readonly Agent[]) => agents.map(({ id }) => id);

/** The Gateway Keys in use, by Agent, as the admin lists them. */
async function keysInUse({ server, owner }: Setup) {
  const response = await server.inject({
    url: "/api/gateway-keys",
    headers: owner.headers,
  });
  return gatewayKeyListSchema.parse(response.json()).keys;
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "raising the coder count to 3 creates two copies with distinct names, Avatars and Gateway Keys",
    async (setup) => {
      const { server, owner, keys } = setup;
      await webShop(setup);
      const [first] = await coders(setup);
      if (first === undefined) {
        throw new Error("The Floor has no coder.");
      }
      // The first coder as the Owner set it up: the copies follow it.
      await server.inject({
        method: "PATCH",
        url: `/api/floors/web-shop/agents/${first.id}`,
        headers: owner.headers,
        payload: {
          effort: "high",
          extraInstructions: "Keep diffs small.",
          tokenCaps: { daily: 50_000, monthly: null },
        },
      });

      const { added, removed, leaving } = await setCoders(setup, 3);

      expect(removed).toEqual([]);
      expect(leaving).toEqual([]);
      expect(added).toHaveLength(2);
      for (const copy of added) {
        expect(copy).toMatchObject({
          role: "coder",
          aiProvider: "Claude",
          model: "claude-opus-5-5",
          modelOverride: null,
          effort: "high",
          extraInstructions: "Keep diffs small.",
          tokenCaps: { daily: 50_000, monthly: null },
          enabled: true,
          leavingAt: null,
        });
      }
      const all = await team(setup);
      const three = all.filter(({ role }) => role === "coder");
      expect(ids(three)).toEqual([first.id, ...ids(added)]);
      // Distinct names and Avatars, across the whole Floor.
      expect(new Set(all.map(({ name }) => name)).size).toBe(all.length);
      expect(new Set(all.map(look)).size).toBe(all.length);

      // Each coder has a Gateway Key of its own, which calls as it.
      await vi.waitFor(async () => {
        expect(
          (await keysInUse(setup)).filter(({ agentId }) =>
            ids(three).includes(agentId ?? ""),
          ),
        ).toHaveLength(3);
      });
      const secrets = await Promise.all(
        three.map(async ({ id }) => keys.agentKey(id)),
      );
      expect(new Set(secrets).size).toBe(3);
      for (const [index, coder] of three.entries()) {
        const secret = secrets[index];
        expect(secret).toMatch(/^aio_gk_/);
        expect(await keys.authenticate(secret ?? "")).toMatchObject({
          agentId: coder.id,
          floorId: "web-shop",
        });
      }
      await setup.queue.stop();
    },
  ],
  [
    "lowering it removes idle Agents first and lets a busy one finish",
    async (setup) => {
      const { server, owner, keys, queue, started, finish } = setup;
      await webShop(setup);
      const [first] = await coders(setup);
      const { added } = await setCoders(setup, 3);
      const [second, third] = added;
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error("The Floor has no three coders.");
      }
      // An issue goes to the coder with least work, the oldest: the first.
      await queue.enqueue({
        floorId: "web-shop",
        issue: 1,
        stage: "needs-work",
      });
      await vi.waitFor(() => {
        expect(started).toEqual([{ issue: 1, agentId: first.id }]);
      });
      await vi.waitFor(async () => {
        expect(await keys.agentKey(third.id)).toBeDefined();
      });

      // Down to 1: the two idle copies go, newest first; the busy one stays.
      const lowered = await setCoders(setup, 1);
      expect(ids(lowered.removed)).toEqual([third.id, second.id]);
      expect(lowered.leaving).toEqual([]);
      expect(ids(await coders(setup))).toEqual([first.id]);
      // Their Gateway Keys are revoked with them.
      await vi.waitFor(async () => {
        expect(await keys.agentKey(second.id)).toBeUndefined();
        expect(await keys.agentKey(third.id)).toBeUndefined();
      });

      // Down to 0: the busy one finishes its task first.
      const emptied = await setCoders(setup, 0);
      expect(emptied.removed).toEqual([]);
      expect(ids(emptied.leaving)).toEqual([first.id]);
      const [leaving] = await coders(setup);
      expect(leaving?.leavingAt).toEqual(expect.any(String));
      // Its work is not cut off, and its key still calls models.
      const key = await keys.agentKey(first.id);
      expect(await keys.authenticate(key ?? "")).toMatchObject({
        agentId: first.id,
      });
      // Removing it again says it is still leaving.
      const again = await server.inject({
        method: "DELETE",
        url: `/api/floors/web-shop/agents/${first.id}`,
        headers: owner.headers,
      });
      expect(again.statusCode).toBe(200);
      expect(ids(teamChangeSchema.parse(again.json()).leaving)).toEqual([
        first.id,
      ]);

      finish(1);
      await vi.waitFor(async () => {
        expect(await coders(setup)).toEqual([]);
      });
      await vi.waitFor(async () => {
        expect(await keys.agentKey(first.id)).toBeUndefined();
      });
      expect(await keys.authenticate(key ?? "")).toBeUndefined();
      expect(
        (await setup.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter((event) => event.type === "agent.removed")
          .map(({ agentId }) => agentId),
      ).toEqual([third.id, second.id, first.id]);
      await queue.stop();
    },
  ],
  [
    "adds an Agent of any Role but the Manager's, and removes one; never the Manager",
    async (setup) => {
      const { server, owner } = setup;
      await webShop(setup);
      const [manager, first] = await team(setup);
      if (manager === undefined || first === undefined) {
        throw new Error("The Floor has no team.");
      }
      const added = await server.inject({
        method: "POST",
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
        payload: { role: "coder", name: "Hopper" },
      });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({
        name: "Hopper",
        role: "coder",
        aiProvider: first.aiProvider,
        model: first.model,
        leavingAt: null,
      });
      const designer = await server.inject({
        method: "POST",
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
        payload: { role: "designer" },
      });
      expect(designer.statusCode).toBe(201);
      const designerId = designer.json<Agent>().id;

      const removed = await server.inject({
        method: "DELETE",
        url: `/api/floors/web-shop/agents/${designerId}`,
        headers: owner.headers,
      });
      expect(removed.statusCode).toBe(200);
      expect(teamChangeSchema.parse(removed.json())).toMatchObject({
        added: [],
        removed: [{ id: designerId, role: "designer" }],
        leaving: [],
      });

      const refusals = await Promise.all(
        [
          {
            method: "DELETE",
            url: `/api/floors/web-shop/agents/${manager.id}`,
          },
          {
            method: "PUT",
            url: "/api/floors/web-shop/team/manager",
            payload: { count: 0 },
          },
          {
            method: "PUT",
            url: "/api/floors/web-shop/team/manager",
            payload: { count: 2 },
          },
          {
            method: "POST",
            url: "/api/floors/web-shop/agents",
            payload: { role: "manager" },
          },
          {
            method: "POST",
            url: "/api/floors/web-shop/agents",
            payload: { role: "coder", name: "Hopper" },
          },
          {
            method: "POST",
            url: "/api/floors/web-shop/agents",
            payload: { role: "janitor" },
          },
          {
            method: "PUT",
            url: "/api/floors/web-shop/team/janitor",
            payload: { count: 1 },
          },
          {
            method: "PUT",
            url: "/api/floors/web-shop/team/coder",
            payload: { count: 11 },
          },
          {
            method: "PUT",
            url: "/api/floors/web-shop/team/coder",
            payload: { count: 1.5 },
          },
          {
            method: "DELETE",
            url: `/api/floors/web-shop/agents/${designerId}`,
          },
          { method: "DELETE", url: "/api/floors/nowhere/agents/anyone" },
        ].map(async (request) => {
          const response = await server.inject({
            ...(request as { method: "DELETE" | "PUT" | "POST"; url: string }),
            headers: owner.headers,
            ...("payload" in request ? { payload: request.payload } : {}),
          });
          return [
            response.statusCode,
            response.json<{ error: string }>().error,
          ];
        }),
      );
      expect(refusals).toEqual([
        [409, "manager_not_removable"],
        [409, "manager_not_removable"],
        [409, "manager_exists"],
        [409, "manager_exists"],
        [409, "agent_name_taken"],
        // A Role the office Role library does not have.
        [404, "role_not_found"],
        [404, "role_not_found"],
        // Beyond the Floor's "most Agents", 8 by default (FR-10): there is
        // no per-Role maximum any more.
        [409, "most_agents_reached"],
        [400, "invalid_request"],
        [404, "agent_not_found"],
        [404, "floor_not_found"],
      ]);
      expect(
        (await team(setup)).filter(({ role }) => role === "manager"),
      ).toEqual([manager]);

      // Nothing changes on an archived Floor.
      await server.inject({
        method: "POST",
        url: "/api/floors/web-shop/archive",
        headers: owner.headers,
      });
      const archived = await server.inject({
        method: "PUT",
        url: "/api/floors/web-shop/team/coder",
        headers: owner.headers,
        payload: { count: 1 },
      });
      expect(archived.statusCode).toBe(409);
      expect(archived.json()).toMatchObject({ error: "floor_archived" });
      await setup.queue.stop();
    },
  ],
  [
    'keeps the team within the Floor\'s "most Agents", or lets it grow with No limit (FR-10)',
    async (setup) => {
      const { server, owner } = setup;
      await webShop(setup);
      const patch = (mostAgents: unknown) =>
        server.inject({
          method: "PATCH",
          url: "/api/floors/web-shop",
          headers: owner.headers,
          payload: { mostAgents },
        });
      const size = (count: number) =>
        server.inject({
          method: "PUT",
          url: "/api/floors/web-shop/team/coder",
          headers: owner.headers,
          payload: { count },
        });
      // A new Floor allows 8 besides its Manager.
      expect(
        floorSchema.parse(
          (
            await server.inject({
              url: "/api/floors/web-shop",
              headers: owner.headers,
            })
          ).json(),
        ).mostAgents,
      ).toBe(8);
      for (const invalid of [0, -1, 1.5, "lots", 1001]) {
        expect((await patch(invalid)).statusCode).toBe(400);
      }
      // A coder, a reviewer and a QA Agent: room for one more coder at 4.
      expect((await patch(4)).statusCode).toBe(200);
      expect((await size(2)).statusCode).toBe(200);
      const refused = await size(3);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: "most_agents_reached" });
      const added = await server.inject({
        method: "POST",
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
        payload: { role: "docs" },
      });
      expect(added.statusCode).toBe(409);
      // With No limit, beyond the old per-Role maximum of 10.
      expect(floorSchema.parse((await patch(null)).json()).mostAgents).toBe(
        null,
      );
      expect((await size(11)).statusCode).toBe(200);
      expect(await coders(setup)).toHaveLength(11);
      await setup.queue.stop();
    },
  ],
  [
    "lists a Contractor with its one-off Role, and keeps it on the team at the Owner's word (ADR 0004)",
    async (setup) => {
      const { server, owner, agents } = setup;
      await webShop(setup);
      const contractor = await agents.addContractor("web-shop", {
        oneOff: {
          name: "Migration writer",
          description: "Writes the database migrations a change needs.",
        },
        kind: "work",
        batchId: null,
      });
      const listed = (await team(setup)).find(({ id }) => id === contractor.id);
      expect(listed).toMatchObject({
        name: "Migration writer",
        stage: "work",
        contractor: {
          kind: "work",
          batchId: null,
          oneOffRole: {
            name: "Migration writer",
            description: "Writes the database migrations a change needs.",
          },
        },
      });
      // Its one-off Role is in no library.
      const library = async () =>
        (
          await server.inject({ url: "/api/roles", headers: owner.headers })
        ).json<{ roles: { name: string }[] }>().roles;
      expect((await library()).map(({ name }) => name)).not.toContain(
        "Migration writer",
      );

      const kept = await server.inject({
        method: "POST",
        url: `/api/floors/web-shop/agents/${contractor.id}/keep`,
        headers: owner.headers,
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json<Agent>().contractor).toBeNull();
      // Its Role persists: it joined the library.
      expect((await library()).map(({ name }) => name)).toContain(
        "Migration writer",
      );
      const again = await server.inject({
        method: "POST",
        url: `/api/floors/web-shop/agents/${contractor.id}/keep`,
        headers: owner.headers,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "not_a_contractor" });
      await setup.queue.stop();
    },
  ],
  [
    "sets a Floor's required reviewers among its reviewer Agents",
    async (setup) => {
      const { server, owner } = setup;
      const floor = await webShop(setup);
      const second = await server.inject({
        method: "POST",
        url: "/api/floors/web-shop/agents",
        headers: owner.headers,
        payload: { role: "reviewer" },
      });
      const both = [...floor.requiredReviewerAgentIds, second.json<Agent>().id];
      const patch = (requiredReviewerAgentIds: unknown) =>
        server.inject({
          method: "PATCH",
          url: "/api/floors/web-shop",
          headers: owner.headers,
          payload: { requiredReviewerAgentIds },
        });

      const set = await patch(both);
      expect(set.statusCode).toBe(200);
      expect(floorSchema.parse(set.json()).requiredReviewerAgentIds).toEqual(
        both,
      );
      const [coder] = await coders(setup);
      const refused = await patch([coder?.id]);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: "not_a_reviewer" });
      for (const invalid of [[], [both[0], both[0]], "everyone"]) {
        const response = await patch(invalid);
        expect(response.statusCode).toBe(400);
      }
      const current = await server.inject({
        url: "/api/floors/web-shop",
        headers: owner.headers,
      });
      expect(
        floorSchema.parse(current.json()).requiredReviewerAgentIds,
      ).toEqual(both);
      await setup.queue.stop();
    },
  ],
];

describe("a Floor's team through the API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      await run(
        await setUp(
          stores,
          memoryWorkQueueStore(stores.floors),
          memoryGatewayKeyStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("a Floor's team through the API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          databaseWorkQueueStore(database.db),
          databaseGatewayKeyStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});
