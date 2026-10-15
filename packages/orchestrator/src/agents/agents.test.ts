import { agents as agentsTable, schemaMeta } from "@ai-office/db";
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
  agentErrorCodes,
  anyAiProvider,
  avatarSchema,
  floorErrorCodes,
  lookDistinct,
  randomAvatar,
  seededRandom,
  type Avatar,
} from "@ai-office/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  createAiProviders,
  type AiProviders,
} from "../ai-providers/ai-providers.ts";
import { agentChatSystemPrompt } from "../direct-chats/chat.ts";
import { FloorError } from "../floors/errors.ts";
import { createFloors, type Floors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  AgentError,
  createAgents,
  oneOffRoleInstructions,
  type Agents,
} from "./agents.ts";
import { workingAgentStore } from "./any-ai-provider.ts";
import { agentNames, roleAvatars } from "./names.ts";

// Agents and Roles (PRD FR-10, FR-11): a new Floor gets its default team,
// and a Floor has exactly one Manager. Every case runs twice: with the
// Floors and Agents in memory, and in Postgres 18.

interface Setup {
  readonly floors: Floors;
  readonly agents: Agents;
  /** Default Models, chosen from a catalogue that lists everything. */
  readonly aiProviders: AiProviders;
  readonly stores: OfficeStores;
  readonly events: () => Promise<OfficeEvent[]>;
}

const start = new Date("2026-10-08T12:00:00.000Z");

function setUp(stores: OfficeStores, bus: EventBus): Setup {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  // Each step a second after the one before.
  let tick = 0;
  const now = () => new Date(start.getTime() + 1000 * tick++);
  const catalogue = () =>
    Promise.resolve([
      "claude-sonnet-5-5",
      "gemini-2.5-pro",
      "grok-4",
      "gpt-5-codex",
    ]);
  const aiProviders = createAiProviders({
    store: stores.aiProviders,
    events: bus,
    catalogue,
  });
  return {
    floors: createFloors({
      store: stores.floors,
      github,
      events: bus,
      defaultModels: () => aiProviders.defaultModels(),
      now,
    }),
    agents: createAgents({
      store: stores.agents,
      floors: stores.floors,
      events: bus,
      defaultModels: () => aiProviders.defaultModels(),
      catalogue,
      roles: stores.roles,
      now,
    }),
    aiProviders,
    stores,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const refusal = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
};

/** What makes Avatars look different at a glance (as `randomAvatar` judges). */
const look = ({ avatar }: { avatar: ReturnType<typeof randomAvatar> }) =>
  [
    avatar.presentation,
    avatar.hairstyle,
    avatar.hairColour,
    avatar.skinTone,
    avatar.outfit.style,
    avatar.outfit.primaryColour,
  ].join(" ");

type Case = [name: string, run: (setup: Setup) => Promise<void>];

/** Adrian's own look (#337): bald, with stubble and a blue hoodie. */
const adrian: Avatar = (() => {
  if (roleAvatars["coder"] === undefined) {
    throw new Error("The coder has no Avatar of its own.");
  }
  return roleAvatars["coder"];
})();

/** A Floor's coder, which every new Floor has. */
const coderOn = async (agents: Agents, floorId: string) => {
  const coder = (await agents.list(floorId)).find(
    ({ role }) => role === "coder",
  );
  if (coder === undefined) {
    throw new Error(`${floorId} has no coder.`);
  }
  return coder;
};

const cases: Case[] = [
  [
    "gives a new Floor a Manager, a coder, a reviewer and a QA Agent",
    async ({ floors, agents, events }) => {
      const floor = await floors.add("adrianeyre/web-shop");
      const team = await agents.list("web-shop");

      expect(team.map(({ role }) => role)).toEqual([
        "manager",
        "coder",
        "reviewer",
        "qa",
      ]);
      // Each Role's Stage, from the Role library; the Manager has none.
      expect(team.map(({ stage }) => stage)).toEqual([
        null,
        "work",
        "review",
        "qa",
      ]);
      for (const agent of team) {
        expect(agent).toEqual({
          id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
          floorId: "web-shop",
          name: expect.any(String) as unknown,
          role: agent.role,
          stage: agent.stage,
          aiProvider: "Claude",
          modelOverride: null,
          effort: null,
          extraInstructions: "",
          enabled: true,
          avatar: agent.avatar,
          tokenCaps: { daily: null, monthly: null },
          // Its Floor's Fresh Start threshold (FR-86).
          freshStartThreshold: null,
          createdAt: expect.any(Date) as unknown,
          leavingAt: null,
          contractor: null,
        });
        expect(agent.role === "coder" ? ["Adrian"] : agentNames).toContain(
          agent.name,
        );
        expect(avatarSchema.parse(agent.avatar)).toEqual(agent.avatar);
      }
      // Distinct names, and Avatars that look different.
      expect(new Set(team.map(({ name }) => name)).size).toBe(4);
      expect(new Set(team.map(look)).size).toBe(4);

      // The reviewer is the Floor's required reviewer.
      const reviewer = team.find(({ role }) => role === "reviewer");
      expect(floor.requiredReviewerAgentIds).toEqual([reviewer?.id]);

      expect((await events()).slice(1)).toEqual(
        team.map((agent) => ({
          type: "agent.created",
          version: 1,
          floorId: "web-shop",
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          aiProvider: "Claude",
          model: "claude-opus-5-5",
        })),
      );
    },
  ],
  [
    "refuses a second Manager",
    async ({ floors, agents, events }) => {
      await floors.add("adrianeyre/web-shop");
      const before = await events();
      const error = await refusal(
        agents.add("web-shop", { role: "manager", name: "Grace Hopper" }),
      );
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe(agentErrorCodes.managerExists);
      expect(error.message).toBe(
        "web-shop already has its Manager: a Floor has exactly one.",
      );
      const team = await agents.list("web-shop");
      expect(team.filter(({ role }) => role === "manager")).toHaveLength(1);
      expect(team).toHaveLength(4);
      expect(await events()).toEqual(before);
    },
  ],
  [
    "lets each Floor have its own Manager",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/blog");
      for (const floorId of ["web-shop", "blog"]) {
        expect(
          (await agents.list(floorId)).filter(({ role }) => role === "manager"),
        ).toHaveLength(1);
      }
    },
  ],
  [
    "adds more Agents of any other Role, each unlike the others",
    async ({ floors, agents, aiProviders, events }) => {
      await floors.add("adrianeyre/web-shop");
      await aiProviders.setDefaultModel("Gemini", "gemini-2.5-pro");
      const coder = await agents.add("web-shop", { role: "coder" });
      const docs = await agents.add("web-shop", {
        role: "docs",
        name: "Ursula",
        aiProvider: "Gemini",
        modelOverride: "gemini-pro",
      });
      const team = await agents.list("web-shop");
      expect(team.map(({ role }) => role)).toEqual([
        "manager",
        "coder",
        "reviewer",
        "qa",
        "coder",
        "docs",
      ]);
      expect(team.slice(4)).toEqual([coder, docs]);
      expect(new Set(team.map(({ name }) => name)).size).toBe(6);
      expect(new Set(team.map(look)).size).toBe(6);
      expect((await events()).slice(-2)).toEqual([
        expect.objectContaining({
          type: "agent.created",
          agentId: coder.id,
          role: "coder",
          model: "claude-opus-5-5",
        }),
        expect.objectContaining({
          type: "agent.created",
          agentId: docs.id,
          name: "Ursula",
          aiProvider: "Gemini",
          model: "gemini-pro",
        }),
      ]);
    },
  ],
  [
    "refuses a name another Agent on the Floor has",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      const [manager] = await agents.list("web-shop");
      const error = await refusal(
        agents.add("web-shop", { role: "coder", name: manager?.name ?? "" }),
      );
      expect((error as AgentError).code).toBe(agentErrorCodes.nameTaken);
    },
  ],
  [
    "refuses an AI Provider until it has a default Model, even for an Agent with a Model of its own",
    async ({ floors, agents, aiProviders, events }) => {
      await floors.add("adrianeyre/web-shop");
      for (const agent of [
        { role: "reviewer", aiProvider: "Grok" },
        { role: "reviewer", aiProvider: "Grok", modelOverride: "grok-4" },
        { role: "coder", aiProvider: "ChatGPT", modelOverride: "gpt-5-codex" },
      ] as const) {
        const error = await refusal(agents.add("web-shop", agent));
        expect((error as AgentError).code).toBe(agentErrorCodes.modelRequired);
        expect(error.message).toBe(
          `${agent.aiProvider} has no default Model yet: choose one in the office admin's AI Providers first.`,
        );
      }
      expect(await agents.list("web-shop")).toHaveLength(4);

      // Once the Owner chooses one, Agents can use it, and use it.
      await aiProviders.setDefaultModel("Grok", "grok-4");
      const reviewer = await agents.add("web-shop", {
        role: "reviewer",
        aiProvider: "Grok",
      });
      expect((await events()).at(-1)).toMatchObject({
        type: "agent.created",
        agentId: reviewer.id,
        aiProvider: "Grok",
        model: "grok-4",
      });
    },
  ],
  [
    "gives each Agent its AI Provider's default Model as the Owner chose it",
    async ({ floors, agents, aiProviders, events }) => {
      await aiProviders.setDefaultModel("Claude", "claude-sonnet-5-5");
      await floors.add("adrianeyre/web-shop");
      const created = (await events()).filter(
        (event) => event.type === "agent.created",
      );
      expect(created).toHaveLength(4);
      for (const event of created) {
        expect(event).toMatchObject({ model: "claude-sonnet-5-5" });
      }
      const coder = await agents.add("web-shop", { role: "coder" });
      expect((await events()).at(-1)).toMatchObject({
        agentId: coder.id,
        model: "claude-sonnet-5-5",
      });
    },
  ],
  [
    "gives a docs Agent its AI Provider's small Model, unless it is given one",
    async ({ floors, agents, aiProviders, events }) => {
      await aiProviders.setDefaultModel("Grok", "grok-4");
      await floors.add("adrianeyre/web-shop");
      const docs = await agents.add("web-shop", { role: "docs" });
      expect(docs.modelOverride).toBe("claude-haiku-5-5");
      expect((await events()).at(-1)).toMatchObject({
        agentId: docs.id,
        role: "docs",
        model: "claude-haiku-5-5",
      });
      // Its own Model, or an AI Provider without a small one, wins.
      const own = await agents.add("web-shop", {
        role: "docs",
        modelOverride: null,
      });
      expect(own.modelOverride).toBeNull();
      const grok = await agents.add("web-shop", {
        role: "docs",
        aiProvider: "Grok",
      });
      expect(grok.modelOverride).toBeNull();
      // Other Roles use the default Model.
      const coder = await agents.add("web-shop", { role: "coder" });
      expect(coder.modelOverride).toBeNull();
    },
  ],
  [
    "adds no Agents to an archived Floor, nor to one that does not exist",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.archive("web-shop");
      const archived = await refusal(agents.add("web-shop", { role: "qa" }));
      expect((archived as FloorError).code).toBe(floorErrorCodes.floorArchived);
      // Its team is still there to read.
      expect(await agents.list("web-shop")).toHaveLength(4);

      for (const attempt of [
        () => agents.add("nowhere", { role: "qa" }),
        () => agents.list("nowhere"),
      ]) {
        const error = await refusal(attempt());
        expect(error).toBeInstanceOf(FloorError);
        expect((error as FloorError).code).toBe(floorErrorCodes.floorNotFound);
      }
    },
  ],
  [
    "edits an Agent's config, naming what changed in a config.changed event",
    async ({ floors, agents, aiProviders, events }) => {
      await floors.add("adrianeyre/web-shop");
      const [, coder] = await agents.list("web-shop");
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      await aiProviders.setDefaultModel("ChatGPT", "gpt-5-codex");

      const edited = await agents.update("web-shop", coder.id, {
        name: "Not-a-pioneer",
        aiProvider: "ChatGPT",
        modelOverride: "gpt-5-codex",
        effort: "high",
        extraInstructions: "Prefer small commits.",
        enabled: false,
      });

      const expected = {
        ...coder,
        name: "Not-a-pioneer",
        aiProvider: "ChatGPT",
        modelOverride: "gpt-5-codex",
        effort: "high",
        extraInstructions: "Prefer small commits.",
        enabled: false,
      };
      expect(edited).toEqual(expected);
      // Stored: what the next task reads.
      expect(
        (await agents.list("web-shop")).find(({ id }) => id === coder.id),
      ).toEqual(expected);
      expect((await events()).at(-1)).toEqual({
        type: "config.changed",
        version: 1,
        scope: "agent",
        floorId: "web-shop",
        agentId: coder.id,
        keys: [
          "name",
          "aiProvider",
          "modelOverride",
          "effort",
          "extraInstructions",
          "enabled",
        ],
      });

      // Nothing changed: no event.
      const before = (await events()).length;
      expect(
        await agents.update("web-shop", coder.id, { name: "Not-a-pioneer" }),
      ).toEqual(expected);
      expect(await events()).toHaveLength(before);
    },
  ],
  [
    "gives an Agent moved to another AI Provider that one's default Model and effort",
    async ({ floors, agents, aiProviders }) => {
      await floors.add("adrianeyre/web-shop");
      const [, coder] = await agents.list("web-shop");
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      await agents.update("web-shop", coder.id, {
        modelOverride: "claude-sonnet-5-5",
        effort: "max",
      });
      await aiProviders.setDefaultModel("Grok", "grok-4");

      const moved = await agents.update("web-shop", coder.id, {
        aiProvider: "Grok",
      });
      expect(moved).toMatchObject({
        aiProvider: "Grok",
        modelOverride: null,
        effort: null,
      });

      // Back to Claude's default Model.
      const back = await agents.update("web-shop", coder.id, {
        aiProvider: "Claude",
        modelOverride: null,
      });
      expect(back).toMatchObject({ aiProvider: "Claude", modelOverride: null });
    },
  ],
  [
    "refuses a Model outside the catalogue, an unsupported effort, a taken name and an AI Provider with no default",
    async ({ floors, agents, aiProviders }) => {
      await floors.add("adrianeyre/web-shop");
      const [manager, coder] = await agents.list("web-shop");
      if (manager === undefined || coder === undefined) {
        throw new Error("The Floor has no team.");
      }
      const refusedWith = async (
        changes: Parameters<Agents["update"]>[2],
        code: string,
        message?: RegExp,
      ) => {
        const error = await refusal(
          agents.update("web-shop", coder.id, changes),
        );
        expect(error).toBeInstanceOf(AgentError);
        expect((error as AgentError).code).toBe(code);
        if (message !== undefined) {
          expect(error.message).toMatch(message);
        }
      };

      await refusedWith(
        { modelOverride: "claude-imaginary" },
        agentErrorCodes.modelNotInCatalogue,
        /Claude's model catalogue has no "claude-imaginary"/,
      );
      await refusedWith(
        { effort: "turbo" },
        agentErrorCodes.effortNotSupported,
        /low, medium, high, xhigh, max/,
      );
      await refusedWith({ name: manager.name }, agentErrorCodes.nameTaken);
      await refusedWith(
        { aiProvider: "Gemini" },
        agentErrorCodes.modelRequired,
        /Gemini has no default Model yet/,
      );
      await aiProviders.setDefaultModel("Gemini", "gemini-2.5-pro");
      await refusedWith(
        { aiProvider: "Gemini", effort: "high" },
        agentErrorCodes.effortNotSupported,
        /takes no effort level/,
      );
      await refusedWith(
        { aiProvider: "Gemini", modelOverride: "gemini-nowhere" },
        agentErrorCodes.modelNotInCatalogue,
      );
      // Nothing was changed by any of them.
      expect(
        (await agents.list("web-shop")).find(({ id }) => id === coder.id),
      ).toEqual(coder);

      const missing = await refusal(
        agents.update("web-shop", "no-such-agent", { enabled: false }),
      );
      expect((missing as AgentError).code).toBe(agentErrorCodes.agentNotFound);
    },
  ],
  [
    "puts an Agent on any AI Provider, which it works on as the one available",
    async ({ floors, agents, stores, events }) => {
      await floors.add("adrianeyre/web-shop");
      const [, coder] = await agents.list("web-shop");
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      await agents.update("web-shop", coder.id, { effort: "high" });

      // Its Model and effort go: whichever AI Provider it gets, it uses
      // that one's defaults.
      const anyOne = await agents.update("web-shop", coder.id, {
        aiProvider: anyAiProvider,
      });
      expect(anyOne).toMatchObject({
        aiProvider: anyAiProvider,
        modelOverride: null,
        effort: null,
      });
      expect((await events()).at(-1)).toMatchObject({
        type: "config.changed",
        keys: ["aiProvider", "effort"],
      });
      const refused = await refusal(
        agents.update("web-shop", coder.id, {
          modelOverride: "claude-sonnet-5-5",
        }),
      );
      expect((refused as AgentError).code).toBe(
        agentErrorCodes.modelNotInCatalogue,
      );
      const noEffort = await refusal(
        agents.update("web-shop", coder.id, { effort: "high" }),
      );
      expect((noEffort as AgentError).code).toBe(
        agentErrorCodes.effortNotSupported,
      );
      // A copy of it is on any AI Provider too.
      const copy = await agents.addToTeam("web-shop", "coder");
      expect(copy.aiProvider).toBe(anyAiProvider);

      // The flows read it on the AI Provider available when a task starts,
      // and keep it, with its Model, until the task ends or a Fresh Start
      // begins; their changes keep its choice.
      const account = (aiProvider: string, priority: number) => ({
        aiProvider,
        priority,
        paused: false,
        limitedUntil: null,
        createdAt: start,
      });
      let accounts = [account("Grok", 1), account("Claude", 2)];
      const running: {
        floorId: string;
        agentId: string;
        status: "running";
        stage: "needs-work";
      }[] = [];
      const bus = createEventBus({ store: memoryEventStore() });
      const working = workingAgentStore({
        store: stores.agents,
        availability: () =>
          Promise.resolve({
            defaults: { Claude: "claude-opus-5-5", Grok: "grok-4" },
            accounts,
          }),
        work: { active: () => Promise.resolve(running) },
        floors: stores.floors,
        events: bus,
      });
      const coderAtWork = async () => {
        const found = (await working.list("web-shop")).find(
          ({ id }) => id === coder.id,
        );
        if (found === undefined) {
          throw new Error("The coder is not on the Floor.");
        }
        return found;
      };

      // A task starts on Grok, the first available.
      running.push({
        floorId: "web-shop",
        agentId: coder.id,
        status: "running",
        stage: "needs-work",
      });
      expect(await coderAtWork()).toMatchObject({
        aiProvider: "Grok",
        modelOverride: "grok-4",
        effort: null,
      });
      // Grok's account goes, mid-task: the coder stays on Grok, as its
      // sandbox's agent tool and its Gateway Key must.
      accounts = [account("Claude", 2)];
      expect(await coderAtWork()).toMatchObject({
        aiProvider: "Grok",
        modelOverride: "grok-4",
      });
      // A Fresh Start begins a new session, given what is available now.
      await bus.publish({
        type: "agent.fresh_start",
        version: 1,
        floorId: "web-shop",
        agentId: coder.id,
        trigger: "manual",
        contextUsage: 0.9,
      });
      expect(await coderAtWork()).toMatchObject({
        aiProvider: "Claude",
        modelOverride: "claude-opus-5-5",
      });
      accounts = [account("Grok", 1), account("Claude", 2)];
      expect((await coderAtWork()).aiProvider).toBe("Claude");
      // The task ends; the next is given what is available then.
      running.length = 0;
      expect((await coderAtWork()).aiProvider).toBe("Grok");
      accounts = [account("Claude", 2)];
      running.push({
        floorId: "web-shop",
        agentId: coder.id,
        status: "running",
        stage: "needs-work",
      });
      const atWork = await coderAtWork();
      expect(atWork.aiProvider).toBe("Claude");
      expect(await working.update({ ...atWork, enabled: false })).toBe(
        "updated",
      );
      working.stop();
      expect(
        (await agents.list("web-shop")).find(({ id }) => id === coder.id),
      ).toMatchObject({ aiProvider: anyAiProvider, enabled: false });
    },
  ],
  [
    "keeps a Model override that has left the catalogue while other settings change",
    async ({ floors, agents, stores }) => {
      await floors.add("adrianeyre/web-shop");
      const [, coder] = await agents.list("web-shop");
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      // Chosen when the catalogue listed it.
      await stores.agents.update({ ...coder, modelOverride: "claude-retired" });

      expect(
        await agents.update("web-shop", coder.id, { enabled: false }),
      ).toMatchObject({ modelOverride: "claude-retired", enabled: false });
    },
  ],
  [
    "sets and clears an Agent's own Token Caps",
    async ({ floors, agents, events }) => {
      await floors.add("adrianeyre/web-shop");
      const [, coder] = await agents.list("web-shop");
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      const capped = await agents.update("web-shop", coder.id, {
        tokenCaps: { daily: 250_000, monthly: null },
      });
      expect(capped.tokenCaps).toEqual({ daily: 250_000, monthly: null });
      expect(
        (await agents.list("web-shop")).find(({ id }) => id === coder.id)
          ?.tokenCaps,
      ).toEqual({ daily: 250_000, monthly: null });
      expect((await events()).at(-1)).toMatchObject({
        type: "config.changed",
        scope: "agent",
        keys: ["tokenCaps.daily"],
      });
      const cleared = await agents.update("web-shop", coder.id, {
        tokenCaps: { daily: null, monthly: 9_000_000 },
      });
      expect(cleared.tokenCaps).toEqual({ daily: null, monthly: 9_000_000 });
      expect((await events()).at(-1)).toMatchObject({
        keys: ["tokenCaps.daily", "tokenCaps.monthly"],
      });
    },
  ],
  [
    "changes an Agent's Avatar, and nothing else, naming it but never its parts",
    async ({ floors, agents, events }) => {
      await floors.add("adrianeyre/web-shop");
      const [, coder] = await agents.list("web-shop");
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      const avatar = {
        ...coder.avatar,
        hairColour:
          coder.avatar.hairColour === "#2e6fd8" ? "#d64f8f" : "#2e6fd8",
        outfit: { ...coder.avatar.outfit, style: "overalls" as const },
        accessories: ["cap", "watch"] as ("cap" | "watch")[],
      };
      const changed = await agents.update("web-shop", coder.id, { avatar });

      expect(changed).toEqual({ ...coder, avatar });
      expect(
        (await agents.list("web-shop")).find(({ id }) => id === coder.id),
      ).toEqual({ ...coder, avatar });
      const event = (await events()).at(-1);
      expect(event).toEqual({
        type: "config.changed",
        version: 1,
        scope: "agent",
        floorId: "web-shop",
        agentId: coder.id,
        keys: ["avatar"],
      });
      expect(JSON.stringify(event)).not.toContain("#2e6fd8");

      // The same Avatar, its accessories in another order: nothing changed.
      const count = (await events()).length;
      await agents.update("web-shop", coder.id, {
        avatar: { ...avatar, accessories: ["watch", "cap"] },
      });
      expect(await events()).toHaveLength(count);
    },
  ],
  [
    "has the store refuse a name taken on the Floor, and an Agent it does not have",
    async ({ floors, stores }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/blog");
      const [manager, coder] = await stores.agents.list("web-shop");
      const [blogManager] = await stores.agents.list("blog");
      if (
        manager === undefined ||
        coder === undefined ||
        blogManager === undefined
      ) {
        throw new Error("The Floors have no team.");
      }
      // Past every check in the code, as a racing request would be.
      expect(await stores.agents.update({ ...coder, name: manager.name })).toBe(
        "name_taken",
      );
      expect(await stores.agents.update({ ...coder, id: "nobody" })).toBe(
        "not_found",
      );
      // Not on another Floor's.
      expect(await stores.agents.update({ ...coder, floorId: "blog" })).toBe(
        "not_found",
      );
      // A name used on another Floor is fine.
      expect(
        await stores.agents.update({ ...blogManager, name: "Not-a-pioneer" }),
      ).toBe("updated");
      expect(
        await stores.agents.update({ ...coder, name: "Not-a-pioneer" }),
      ).toBe("updated");
    },
  ],
  [
    'keeps the team within the Floor\'s "most Agents", the Manager aside, or none with No limit (FR-10)',
    async ({ floors, agents, stores }) => {
      await floors.add("adrianeyre/web-shop");
      await stores.floors.update("web-shop", { mostAgents: 4 });
      // A coder, a reviewer and QA: one more fits, by any way in.
      await agents.addToTeam("web-shop", "docs");
      for (const attempt of [
        () => agents.addToTeam("web-shop", "coder"),
        () => agents.setTeamSize("web-shop", "coder", 2),
        () =>
          agents.addContractor("web-shop", {
            role: "coder",
            kind: "work",
            batchId: null,
          }),
      ]) {
        const error = await refusal(attempt());
        expect((error as AgentError).code).toBe(
          agentErrorCodes.mostAgentsReached,
        );
        expect(error.message).toBe(
          'web-shop may have at most 4 Agents besides its Manager, and has 4: raise "Most Agents" in its Floor settings first.',
        );
      }
      // Lowering a team needs no room.
      expect(
        (await agents.setTeamSize("web-shop", "docs", 0)).removed,
      ).toHaveLength(1);
      await stores.floors.update("web-shop", { mostAgents: null });
      // No per-Role maximum: 12 coders.
      expect(
        (await agents.setTeamSize("web-shop", "coder", 12)).added,
      ).toHaveLength(11);
    },
  ],
  [
    "adds a Contractor named after its Role, on the Role's AI Provider and Model, and never a one-off Role's team size",
    async ({ floors, agents, stores, events }) => {
      await floors.add("adrianeyre/web-shop");
      const writer = {
        name: "Migration writer",
        description: "Writes migrations.",
        instructions: "Write the migration.",
      };
      const first = await agents.addContractor("web-shop", {
        oneOff: writer,
        kind: "work",
        batchId: null,
      });
      const second = await agents.addContractor("web-shop", {
        oneOff: writer,
        kind: "work",
        batchId: null,
      });
      const coder = await agents.addContractor("web-shop", {
        role: "coder",
        kind: "work",
        batchId: null,
      });
      expect([first.name, second.name, coder.name]).toEqual([
        "Migration writer",
        "Migration writer 2",
        "Coder",
      ]);
      // Each one-off Role is its own, in the work Stage, in no library,
      // with AI Office's instructions, never those it was given (P2-4).
      expect(first.role).not.toBe(second.role);
      expect(await stores.roles.get(first.role)).toMatchObject({
        name: "Migration writer",
        stage: "work",
        instructions: oneOffRoleInstructions("work"),
        oneOffFloorId: "web-shop",
      });
      expect((await stores.roles.list()).map(({ id }) => id)).not.toContain(
        first.role,
      );
      // So the Owner's direct chat with it is given AI Office's
      // instructions, not those it was handed.
      const chatPrompt = agentChatSystemPrompt({
        floor: { name: "Web shop", repository: "adrianeyre/web-shop" },
        agent: first,
        role: await stores.roles.get(first.role),
      });
      expect(chatPrompt).toContain(oneOffRoleInstructions("work"));
      expect(chatPrompt).not.toContain(writer.instructions);
      // Nor the one line the Manager's Model wrote to describe it.
      expect(chatPrompt).not.toContain(writer.description);
      expect(chatPrompt).toContain(
        "Your Role: a one-off Role, Migration writer, the Floor's Manager added you in for one Batch.",
      );
      const listed = await stores.agents.list("web-shop");
      expect(listed.find(({ id }) => id === first.id)).toMatchObject({
        stage: "work",
        aiProvider: "Claude",
        modelOverride: null,
        tokenCaps: { daily: null, monthly: null },
        contractor: { kind: "work", batchId: null, oneOffRole: true },
      });
      expect(listed.find(({ id }) => id === coder.id)?.contractor).toEqual({
        kind: "work",
        batchId: null,
        oneOffRole: false,
      });
      expect(
        (await refusal(
          agents.setTeamSize("web-shop", first.role, 3),
        )) as AgentError,
      ).toMatchObject({ code: agentErrorCodes.roleNotFound });
      expect(await events()).toContainEqual(
        expect.objectContaining({
          type: "contractor.added",
          agentId: first.id,
          name: "Migration writer",
          roleName: "Migration writer",
          oneOff: true,
          kind: "work",
        }),
      );
    },
  ],
  [
    "lets a Contractor go with its one-off Role, or keeps it on the team with its Role in the library",
    async ({ floors, agents, stores, events }) => {
      await floors.add("adrianeyre/web-shop");
      const writer = {
        name: "coder",
        description: "Writes migrations.",
        instructions: "Write the migration.",
      };
      const leaving = await agents.addContractor("web-shop", {
        oneOff: writer,
        kind: "research",
        batchId: null,
      });
      // A research Contractor's one-off Role has AI Office's instructions
      // too, never those it was given (P2-4).
      expect((await stores.roles.get(leaving.role))?.instructions).toBe(
        oneOffRoleInstructions("research"),
      );
      expect(await agents.release("web-shop", leaving.id)).toMatchObject({
        removed: true,
      });
      expect(await stores.roles.get(leaving.role)).toBeUndefined();
      expect(await events()).toContainEqual(
        expect.objectContaining({
          type: "contractor.left",
          agentId: leaving.id,
          name: leaving.name,
        }),
      );

      // Its one-off Role named "coder", as a library Role is: kept, it is
      // numbered as it joins the library.
      const staying = await agents.addContractor("web-shop", {
        oneOff: writer,
        kind: "work",
        batchId: null,
      });
      const kept = await agents.keep("web-shop", staying.id);
      expect(kept.contractor).toBeNull();
      // It joins the library with AI Office's instructions, which the
      // Owner edits there (P2-4).
      expect(await stores.roles.get(staying.role)).toMatchObject({
        name: "coder 2",
        stage: "work",
        instructions: oneOffRoleInstructions("work"),
      });
      expect(
        (await stores.roles.get(staying.role))?.oneOffFloorId,
      ).toBeUndefined();
      expect((await stores.roles.list()).map(({ name }) => name)).toContain(
        "coder 2",
      );
      expect(
        (await stores.agents.list("web-shop")).find(
          ({ id }) => id === staying.id,
        )?.contractor,
      ).toBeNull();
      // An ordinary Agent is neither kept nor let go as a Contractor.
      for (const attempt of [
        () => agents.keep("web-shop", staying.id),
        () => agents.release("web-shop", staying.id),
      ]) {
        expect(((await refusal(attempt())) as AgentError).code).toBe(
          agentErrorCodes.notAContractor,
        );
      }
    },
  ],
  [
    "gives each new Floor's coder Adrian his own look, and the others looks unlike it",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/blog");
      for (const floorId of ["web-shop", "blog"]) {
        const team = await agents.list(floorId);
        const coder = await coderOn(agents, floorId);
        expect(coder.name).toBe("Adrian");
        expect(coder.avatar).toEqual(adrian);
        for (const other of team.filter(({ id }) => id !== coder.id)) {
          expect(lookDistinct(other.avatar, adrian)).toBe(true);
        }
      }
    },
  ],
  [
    "gives a coder copied from the Role's first a random Avatar, even named Adrian",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      const first = await coderOn(agents, "web-shop");
      await agents.remove("web-shop", first.id);

      const { added } = await agents.setTeamSize("web-shop", "coder", 1);
      expect(added.map(({ name }) => name)).toEqual(["Adrian"]);
      expect(added[0]?.avatar).not.toEqual(adrian);
    },
  ],
  [
    "gives the coders named Adrian on Floors from before his look, once",
    async ({ floors, agents, stores, events }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/blog");
      // As each Floor was before Adrian had a look of his own: random.
      for (const floorId of ["web-shop", "blog"]) {
        for (const agent of await stores.agents.list(floorId)) {
          await stores.agents.update({
            ...agent,
            avatar: randomAvatar(seededRandom(`${floorId} ${agent.name}`)),
          });
        }
      }
      // A coder by another name, and a reviewer named Adrian.
      const ada = await coderOn(agents, "blog");
      await stores.agents.update({ ...ada, name: "Ada" });
      // Names are random: none other on blog may be Adrian already.
      for (const agent of await stores.agents.list("blog")) {
        if (agent.name === "Adrian") {
          await stores.agents.update({ ...agent, name: "Arlo" });
        }
      }
      await agents.add("blog", { role: "reviewer", name: "Adrian" });
      const before = new Map(
        [
          ...(await agents.list("web-shop")),
          ...(await agents.list("blog")),
        ].map((agent) => [agent.id, agent]),
      );
      const coder = await coderOn(agents, "web-shop");
      expect(coder.avatar).not.toEqual(adrian);
      const seen = (await events()).length;

      expect(await agents.giveRoleAvatars()).toEqual([coder.id]);
      for (const floorId of ["web-shop", "blog"]) {
        for (const agent of await agents.list(floorId)) {
          expect(agent).toEqual(
            agent.id === coder.id
              ? { ...before.get(agent.id), avatar: adrian }
              : before.get(agent.id),
          );
        }
      }
      expect((await events()).slice(seen)).toEqual([
        {
          type: "config.changed",
          version: 1,
          scope: "agent",
          floorId: "web-shop",
          agentId: coder.id,
          keys: ["avatar"],
        },
      ]);

      // The Owner changes his look afterwards: it is kept.
      const edited = randomAvatar(seededRandom("the Owner's choice"));
      await agents.update("web-shop", coder.id, { avatar: edited });
      expect(await agents.giveRoleAvatars()).toEqual([]);
      expect((await coderOn(agents, "web-shop")).avatar).toEqual(edited);
    },
  ],
  [
    "refuses to edit an Agent on an archived Floor",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      const [, coder] = await agents.list("web-shop");
      if (coder === undefined) {
        throw new Error("The Floor has no coder.");
      }
      await floors.archive("web-shop");

      const error = await refusal(
        agents.update("web-shop", coder.id, { enabled: false }),
      );
      expect((error as FloorError).code).toBe(floorErrorCodes.floorArchived);
    },
  ],
];

describe("Agents, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(setUp(memoryStores(), createEventBus({ store: memoryEventStore() }))),
    );
  }

  it("refuses a second Manager in the store too", async () => {
    const { floors, stores } = setUp(
      memoryStores(),
      createEventBus({ store: memoryEventStore() }),
    );
    await floors.add("adrianeyre/web-shop");
    const [manager] = await stores.agents.list("web-shop");
    if (manager === undefined) {
      throw new Error("The Floor has no Manager.");
    }
    expect(
      await stores.agents.create({
        ...manager,
        id: "another-manager",
        name: "Someone else",
      }),
    ).toBe("manager_taken");
  });
});

describe("Agents, kept in Postgres 18", () => {
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

  postgresTest(
    "gives Adrian his look once in the database's life, not once a start",
    async ({ database }) => {
      const first = setUp(
        databaseStores(database.db),
        createEventBus({ store: memoryEventStore() }),
      );
      await first.floors.add("adrianeyre/web-shop");
      const coder = await coderOn(first.agents, "web-shop");
      const before = randomAvatar(seededRandom("before"));
      await first.stores.agents.update({ ...coder, avatar: before });
      expect(await first.agents.giveRoleAvatars()).toEqual([coder.id]);
      expect(
        await database.db
          .select({ key: schemaMeta.key, value: schemaMeta.value })
          .from(schemaMeta)
          .where(eq(schemaMeta.key, "data-migration:agents.adrian-avatar")),
      ).toEqual([
        { key: "data-migration:agents.adrian-avatar", value: "applied" },
      ]);
      const edited = randomAvatar(seededRandom("the Owner's choice"));
      await first.agents.update("web-shop", coder.id, { avatar: edited });

      // AI Office starts again, on the same database.
      const again = setUp(
        databaseStores(database.db),
        createEventBus({ store: memoryEventStore() }),
      );
      expect(await again.agents.giveRoleAvatars()).toEqual([]);
      expect((await coderOn(again.agents, "web-shop")).avatar).toEqual(edited);
    },
  );

  postgresTest(
    "has the table refuse a second Manager on a Floor",
    async ({ database }) => {
      const { floors, stores } = setUp(
        databaseStores(database.db),
        createEventBus({ store: memoryEventStore() }),
      );
      await floors.add("adrianeyre/web-shop");
      const [manager] = await stores.agents.list("web-shop");
      if (manager === undefined) {
        throw new Error("The Floor has no Manager.");
      }
      // Past every check in the code, straight into the table.
      await expect(
        database.db.insert(agentsTable).values({
          id: "another-manager",
          floorId: "web-shop",
          name: "Someone else",
          role: "manager",
          aiProvider: "Claude",
          avatar: randomAvatar(),
          createdAt: start,
        }),
      ).rejects.toThrow();
      expect(
        await stores.agents.create({
          ...manager,
          id: "another-manager",
          name: "Someone else",
        }),
      ).toBe("manager_taken");
      // A Manager on another Floor is fine.
      await floors.add("adrianeyre/blog");
      expect(
        (await stores.agents.list("blog")).filter(
          ({ role }) => role === "manager",
        ),
      ).toHaveLength(1);
    },
  );
});
