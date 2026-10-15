import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { agentErrorCodes, floorErrorCodes } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createAiProviders } from "../ai-providers/ai-providers.ts";
import { FloorError } from "../floors/errors.ts";
import { createFloors, type Floors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { AgentError, createAgents, type Agents } from "./agents.ts";
import type { AgentRecord } from "./store.ts";

// A Floor's team (PRD FR-10): the Owner adds and removes Agents of any
// Role but the Manager's, and sets each Role's team size. Raising it adds
// copies of the Role's first Agent, each with its own name and Avatar;
// lowering it removes idle Agents first, and a busy one finishes its task
// before it goes. Every case runs with the Floors, Agents and work queue
// in memory, and in Postgres 18.

interface Setup {
  readonly floors: Floors;
  readonly agents: Agents;
  readonly stores: OfficeStores;
  readonly work: WorkQueueStore;
  readonly events: () => Promise<OfficeEvent[]>;
  /** Starts work for an Agent (or a review round, for none) on web-shop. */
  readonly busy: (
    agentId: string | null,
    stage?: "needs-work" | "needs-review",
  ) => Promise<number>;
  /** Ends running work, as the work queue records it. */
  readonly finish: (id: number) => Promise<void>;
}

const start = new Date("2026-10-08T12:00:00.000Z");

function setUp(
  stores: OfficeStores,
  work: WorkQueueStore,
  bus: EventBus,
): Setup {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  // Each step a second after the one before.
  let tick = 0;
  const now = () => new Date(start.getTime() + 1000 * tick++);
  const catalogue = () => Promise.resolve(["claude-sonnet-5-5"]);
  const aiProviders = createAiProviders({
    store: stores.aiProviders,
    events: bus,
    catalogue,
  });
  let issue = 0;
  return {
    floors: createFloors({
      store: stores.floors,
      github,
      events: bus,
      agents: stores.agents,
      now,
    }),
    agents: createAgents({
      store: stores.agents,
      floors: stores.floors,
      events: bus,
      defaultModels: () => aiProviders.defaultModels(),
      catalogue,
      work,
      now,
    }),
    stores,
    work,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
    async busy(agentId, stage = "needs-work") {
      issue += 1;
      await work.add(
        { floorId: "web-shop", issue, stage, agentId, priority: "normal" },
        now(),
      );
      const running = await work.claimNext(10, now());
      if (running?.issue !== issue) {
        throw new Error(`Issue #${String(issue)}'s work did not start.`);
      }
      return running.id;
    },
    finish: (id) => work.end(id, "finished", now()),
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
const look = ({ avatar }: AgentRecord) =>
  [
    avatar.presentation,
    avatar.hairstyle,
    avatar.hairColour,
    avatar.skinTone,
    avatar.outfit.style,
    avatar.outfit.primaryColour,
  ].join(" ");

const ofRole = (team: readonly AgentRecord[], role: AgentRecord["role"]) =>
  team.filter((agent) => agent.role === role);

const ids = (team: readonly { readonly id: string }[]) =>
  team.map(({ id }) => id);

/** The web-shop Floor's coder, set up as the Owner configured it. */
async function configuredCoder({
  floors,
  agents,
}: Setup): Promise<AgentRecord> {
  await floors.add("adrianeyre/web-shop");
  const [coder] = ofRole(await agents.list("web-shop"), "coder");
  if (coder === undefined) {
    throw new Error("The Floor has no coder.");
  }
  return agents.update("web-shop", coder.id, {
    modelOverride: "claude-sonnet-5-5",
    effort: "high",
    extraInstructions: "Keep diffs small.",
    tokenCaps: { daily: 50_000, monthly: null },
  });
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "raising a Role's team size adds copies of its first Agent, each its own",
    async (setup) => {
      const { agents, events } = setup;
      const coder = await configuredCoder(setup);

      const change = await agents.setTeamSize("web-shop", "coder", 3);

      expect(change.removed).toEqual([]);
      expect(change.leaving).toEqual([]);
      expect(change.added).toHaveLength(2);
      for (const copy of change.added) {
        expect(copy).toMatchObject({
          floorId: "web-shop",
          role: "coder",
          aiProvider: "Claude",
          modelOverride: "claude-sonnet-5-5",
          effort: "high",
          extraInstructions: "Keep diffs small.",
          tokenCaps: { daily: 50_000, monthly: null },
          enabled: true,
          leavingAt: null,
        });
      }
      const team = await agents.list("web-shop");
      expect(ids(ofRole(team, "coder"))).toEqual([
        coder.id,
        ...ids(change.added),
      ]);
      // Every name and every look on the Floor is its own.
      expect(new Set(team.map(({ name }) => name)).size).toBe(6);
      expect(new Set(team.map(look)).size).toBe(6);
      expect(
        (await events())
          .filter((event) => event.type === "agent.created")
          .slice(-2),
      ).toEqual(
        change.added.map((copy) => ({
          type: "agent.created",
          version: 1,
          floorId: "web-shop",
          agentId: copy.id,
          name: copy.name,
          role: "coder",
          aiProvider: "Claude",
          model: "claude-sonnet-5-5",
        })),
      );

      // The same size again changes nothing.
      expect(await agents.setTeamSize("web-shop", "coder", 3)).toEqual({
        added: [],
        removed: [],
        leaving: [],
      });
    },
  ],
  [
    "a Role with no Agent starts from the defaults, as docs does",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      const { added } = await agents.setTeamSize("web-shop", "docs", 1);
      expect(added).toMatchObject([
        {
          role: "docs",
          aiProvider: "Claude",
          // A docs Agent's small Model (FR-18).
          modelOverride: "claude-haiku-5-5",
          effort: null,
          extraInstructions: "",
          tokenCaps: { daily: null, monthly: null },
        },
      ]);
    },
  ],
  [
    "lowering it removes idle Agents first, newest first, and lets a busy one finish",
    async (setup) => {
      const { agents, busy, finish, events, stores } = setup;
      const first = await configuredCoder(setup);
      const { added } = await agents.setTeamSize("web-shop", "coder", 3);
      const [second, third] = added;
      if (second === undefined || third === undefined) {
        throw new Error("Two coders were not added.");
      }
      // The newest coder is in the middle of a task.
      const task = await busy(third.id);

      const lowered = await agents.setTeamSize("web-shop", "coder", 1);
      expect(ids(lowered.removed)).toEqual([second.id, first.id]);
      expect(lowered.leaving).toEqual([]);
      expect(ids(ofRole(await agents.list("web-shop"), "coder"))).toEqual([
        third.id,
      ]);
      expect(
        (await events()).filter((event) => event.type === "agent.removed"),
      ).toEqual(
        [second, first].map(({ id }) => ({
          type: "agent.removed",
          version: 1,
          floorId: "web-shop",
          agentId: id,
        })),
      );

      // At 0, the busy one is leaving: listed, taking no new work.
      const emptied = await agents.setTeamSize("web-shop", "coder", 0);
      expect(emptied.removed).toEqual([]);
      expect(ids(emptied.leaving)).toEqual([third.id]);
      const leavingAt = emptied.leaving[0]?.leavingAt;
      expect(leavingAt).toBeInstanceOf(Date);
      expect(
        ofRole(await agents.list("web-shop"), "coder").map((agent) => ({
          id: agent.id,
          leavingAt: agent.leavingAt,
        })),
      ).toEqual([{ id: third.id, leavingAt }]);
      expect((await events()).at(-1)).toEqual({
        type: "config.changed",
        version: 1,
        scope: "agent",
        floorId: "web-shop",
        agentId: third.id,
        keys: ["leaving"],
      });
      // A leaving Agent is not counted: the team is 0, and stays so.
      expect(await agents.setTeamSize("web-shop", "coder", 0)).toEqual({
        added: [],
        removed: [],
        leaving: [],
      });

      // Its task is not cut off: it stays while the work runs.
      expect(await agents.settle("web-shop")).toEqual([]);
      expect(ids(await agents.list("web-shop"))).toContain(third.id);

      await finish(task);
      expect(ids(await agents.settle())).toEqual([third.id]);
      expect(ofRole(await agents.list("web-shop"), "coder")).toEqual([]);
      expect((await events()).at(-1)).toEqual({
        type: "agent.removed",
        version: 1,
        floorId: "web-shop",
        agentId: third.id,
      });
      // Its row is kept, for the work and requests that name it.
      expect(await stores.agents.update(third)).toBe("not_found");
    },
  ],
  [
    "removes an idle Agent at once, and a busy one once its task ends",
    async (setup) => {
      const { agents, busy, finish, floors } = setup;
      const coder = await configuredCoder(setup);
      const [qa] = ofRole(await agents.list("web-shop"), "qa");
      if (qa === undefined) {
        throw new Error("The Floor has no QA Agent.");
      }
      const task = await busy(coder.id);

      expect(await agents.remove("web-shop", qa.id)).toEqual({
        agent: qa,
        removed: true,
      });
      const departure = await agents.remove("web-shop", coder.id);
      expect(departure.removed).toBe(false);
      expect(departure.agent.leavingAt).toBeInstanceOf(Date);
      // Asked again, it is still leaving.
      expect(await agents.remove("web-shop", coder.id)).toEqual(departure);
      expect(ids(await agents.list("web-shop"))).not.toContain(qa.id);

      // A removed Agent's name is free again.
      const again = await agents.addToTeam("web-shop", "qa", qa.name);
      expect(again).toMatchObject({ name: qa.name, role: "qa" });
      expect(again.id).not.toBe(qa.id);

      // Gone from the API's view, as from the list.
      const gone = await refusal(agents.remove("web-shop", qa.id));
      expect(gone).toBeInstanceOf(AgentError);
      expect((gone as AgentError).code).toBe(agentErrorCodes.agentNotFound);

      await finish(task);
      expect(ids(await agents.settle("web-shop"))).toEqual([coder.id]);

      // Nothing changes on an archived Floor.
      await floors.archive("web-shop");
      const archived = await refusal(agents.remove("web-shop", again.id));
      expect(archived).toBeInstanceOf(FloorError);
      expect((archived as FloorError).code).toBe(floorErrorCodes.floorArchived);
      const resized = await refusal(agents.setTeamSize("web-shop", "qa", 2));
      expect((resized as FloorError).code).toBe(floorErrorCodes.floorArchived);
    },
  ],
  [
    "never removes the Manager, nor adds a second",
    async ({ floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      const [manager] = ofRole(await agents.list("web-shop"), "manager");
      if (manager === undefined) {
        throw new Error("The Floor has no Manager.");
      }
      const refusals = [
        await refusal(agents.remove("web-shop", manager.id)),
        await refusal(agents.setTeamSize("web-shop", "manager", 0)),
        await refusal(agents.setTeamSize("web-shop", "manager", 2)),
        await refusal(agents.addToTeam("web-shop", "manager")),
      ];
      expect(
        refusals.map((error) => [(error as AgentError).code, error.message]),
      ).toEqual([
        [
          agentErrorCodes.managerNotRemovable,
          "web-shop's Manager cannot be removed: a Floor has exactly one.",
        ],
        [
          agentErrorCodes.managerNotRemovable,
          "web-shop's Manager cannot be removed: a Floor has exactly one.",
        ],
        [
          agentErrorCodes.managerExists,
          "web-shop already has its Manager: a Floor has exactly one.",
        ],
        [
          agentErrorCodes.managerExists,
          "web-shop already has its Manager: a Floor has exactly one.",
        ],
      ]);
      expect(await agents.setTeamSize("web-shop", "manager", 1)).toEqual({
        added: [],
        removed: [],
        leaving: [],
      });
      expect(ofRole(await agents.list("web-shop"), "manager")).toEqual([
        manager,
      ]);
    },
  ],
  [
    "keeps the required reviewers among the Floor's reviewers",
    async ({ floors, agents, busy, finish, events }) => {
      const floor = await floors.add("adrianeyre/web-shop");
      const [first] = floor.requiredReviewerAgentIds;
      const second = await agents.addToTeam("web-shop", "reviewer", "Grok");
      // A reviewer added beside a required one is not required itself.
      expect((await floors.get("web-shop")).requiredReviewerAgentIds).toEqual([
        first,
      ]);

      // Removing the required one leaves the other required.
      await agents.remove("web-shop", first ?? "");
      expect((await floors.get("web-shop")).requiredReviewerAgentIds).toEqual([
        second.id,
      ]);
      expect((await events()).at(-1)).toEqual({
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId: "web-shop",
        keys: ["requiredReviewerAgentIds"],
      });

      // A required reviewer in a review round finishes it first.
      const round = await busy(null, "needs-review");
      const { leaving } = await agents.setTeamSize("web-shop", "reviewer", 0);
      expect(ids(leaving)).toEqual([second.id]);
      expect((await floors.get("web-shop")).requiredReviewerAgentIds).toEqual([
        second.id,
      ]);
      await finish(round);
      await agents.settle("web-shop");
      expect((await floors.get("web-shop")).requiredReviewerAgentIds).toEqual(
        [],
      );

      // A first reviewer again is required at once.
      const { added } = await agents.setTeamSize("web-shop", "reviewer", 1);
      expect((await floors.get("web-shop")).requiredReviewerAgentIds).toEqual(
        ids(added),
      );
    },
  ],
  [
    "sets the required reviewers to the Floor's reviewers only",
    async ({ floors, agents }) => {
      const floor = await floors.add("adrianeyre/web-shop");
      const second = await agents.addToTeam("web-shop", "reviewer");
      const both = [...floor.requiredReviewerAgentIds, second.id];
      expect(
        (
          await floors.updateSettings("web-shop", {
            requiredReviewerAgentIds: both,
          })
        ).requiredReviewerAgentIds,
      ).toEqual(both);

      const [coder] = ofRole(await agents.list("web-shop"), "coder");
      for (const other of [coder?.id ?? "", "nobody"]) {
        const refused = await refusal(
          floors.updateSettings("web-shop", {
            requiredReviewerAgentIds: [other],
          }),
        );
        expect((refused as FloorError).code).toBe(floorErrorCodes.notAReviewer);
        expect(refused.message).toBe(
          `"${other}" is not one of web-shop's reviewer Agents.`,
        );
      }
      expect((await floors.get("web-shop")).requiredReviewerAgentIds).toEqual(
        both,
      );
    },
  ],
];

describe("A Floor's team, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => {
      const stores = memoryStores();
      return run(
        setUp(
          stores,
          memoryWorkQueueStore(stores.floors),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("A Floor's team, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(
        setUp(
          databaseStores(database.db),
          databaseWorkQueueStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      ),
    );
  }
});
