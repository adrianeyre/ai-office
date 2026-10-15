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
  roleErrorCodes,
  roleIdOf,
  type CreateRoleRequest,
  type RoleErrorCode,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createAgents, type Agents } from "../agents/agents.ts";
import { createFloors, type Floors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createRoleLibrary, RoleError, type RoleLibrary } from "./library.ts";
import type { RoleRecord } from "./store.ts";

// The Role library's admin (PRD FR-98): Roles made from scratch or
// duplicated, edited and deleted; how many Agents fill each; a Role an
// Agent fills, or one every new Floor starts with, kept; a Role's Stage
// kept while Agents fill it; Skills from the Skill library and Models from
// the catalogue; and an event for every change. Every case runs in memory
// and in Postgres 18.

interface Setup {
  readonly library: RoleLibrary;
  readonly floors: Floors;
  readonly agents: Agents;
  readonly stores: OfficeStores;
  readonly events: () => Promise<OfficeEvent[]>;
}

function setUp(stores: OfficeStores, bus: EventBus): Setup {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const catalogue = (aiProvider: string) =>
    Promise.resolve(
      aiProvider === "Gemini" ? ["gemini-3-pro"] : ["claude-sonnet-5-5"],
    );
  return {
    library: createRoleLibrary({
      store: stores.roles,
      agents: stores.agents,
      skills: stores.skills,
      catalogue,
      events: bus,
    }),
    floors: createFloors({
      store: stores.floors,
      github,
      events: bus,
      roles: stores.roles,
    }),
    agents: createAgents({
      store: stores.agents,
      floors: stores.floors,
      events: bus,
      roles: stores.roles,
      catalogue,
    }),
    stores,
    events: async () =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter((event) => event.type.startsWith("role.")),
  };
}

const merchandiser: CreateRoleRequest = {
  name: "Merchandiser",
  stage: "work",
  description: "Arranges the catalogue: collections, prices and product data.",
  instructions: "- Keep every price in pence.",
  skills: [],
  deskDressing: "monitor",
  aiProvider: "Claude",
  model: "claude-sonnet-5-5",
};

/** The code of the `RoleError` `promise` is refused with. */
async function refusal(promise: Promise<unknown>): Promise<RoleErrorCode> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof RoleError)) {
    throw new Error(`Expected a RoleError, got ${String(error)}.`);
  }
  return error.code;
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "makes a Role whose id comes from its name, numbered when the id is taken",
    async ({ library, stores, events }) => {
      const role = await library.create(merchandiser);
      expect(role).toEqual({
        id: "merchandiser",
        ...merchandiser,
        skills: [],
        agents: 0,
        inStartingTeam: false,
      });
      expect(await stores.roles.get("merchandiser")).toEqual({
        id: "merchandiser",
        ...merchandiser,
        skills: [],
      });
      // `Merchandiser!` is a new name with a taken id.
      expect(
        (await library.create({ ...merchandiser, name: "Merchandiser!" })).id,
      ).toBe("merchandiser-2");
      expect(
        await refusal(
          library.create({ ...merchandiser, name: "merchandiser" }),
        ),
      ).toBe(roleErrorCodes.roleNameTaken);
      expect(
        (await events()).map((event) =>
          event.type === "role.created" ? event.roleId : event.type,
        ),
      ).toEqual(["merchandiser", "merchandiser-2"]);
    },
  ],
  [
    "duplicates a Role under a free name, or the one given",
    async ({ library, events }) => {
      const copy = await library.duplicate("coder");
      expect(copy).toMatchObject({
        id: "coder-copy",
        name: "coder copy",
        stage: "work",
        agents: 0,
        inStartingTeam: false,
      });
      expect(copy.instructions).toBe((await library.get("coder")).instructions);
      expect((await library.duplicate("coder")).name).toBe("coder copy 2");
      expect((await library.duplicate("qa", "store QA")).id).toBe("store-qa");
      expect(await refusal(library.duplicate("qa", "Coder copy"))).toBe(
        roleErrorCodes.roleNameTaken,
      );
      expect(await refusal(library.duplicate("nobody"))).toBe(
        roleErrorCodes.roleNotFound,
      );
      expect(
        (await events()).map((event) =>
          event.type === "role.created" ? event.duplicatedFrom : null,
        ),
      ).toEqual(["coder", "coder", "qa"]);
    },
  ],
  [
    "counts the Agents that fill each Role, leaving ones too, removed ones not",
    async ({ library, floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      await floors.add("adrianeyre/blog");
      await library.create(merchandiser);
      const mia = await agents.add("web-shop", { role: "merchandiser" });
      await agents.add("blog", { role: "merchandiser" });
      const counts = async () =>
        Object.fromEntries(
          (await library.list()).map(({ id, agents: count }) => [id, count]),
        );
      expect(await counts()).toEqual({
        coder: 2,
        reviewer: 2,
        qa: 2,
        docs: 0,
        designer: 0,
        merchandiser: 2,
      });
      await agents.remove("web-shop", mia.id);
      expect((await counts())["merchandiser"]).toBe(1);
      expect((await library.get("merchandiser")).agents).toBe(1);
    },
  ],
  [
    "edits a Role, saying which fields changed and how many Agents it reaches",
    async ({ library, floors, agents, events }) => {
      await floors.add("adrianeyre/web-shop");
      await library.create(merchandiser);
      await agents.add("web-shop", { role: "merchandiser" });
      await agents.add("web-shop", { role: "merchandiser" });

      const edited = await library.update("merchandiser", {
        instructions: "- Keep every price in pence, VAT included.",
        skills: [],
      });
      expect(edited).toMatchObject({
        instructions: "- Keep every price in pence, VAT included.",
        agents: 2,
      });
      // A new AI Provider with no Model of its own suggests its default.
      expect(
        await library.update("merchandiser", { aiProvider: "Gemini" }),
      ).toMatchObject({ aiProvider: "Gemini", model: null });
      // Nothing changed, nothing recorded.
      await library.update("merchandiser", {
        stage: "work",
        name: "Merchandiser",
      });
      expect(
        (await events()).filter(({ type }) => type === "role.changed"),
      ).toEqual([
        {
          type: "role.changed",
          version: 1,
          roleId: "merchandiser",
          name: "Merchandiser",
          keys: ["instructions"],
          agents: 2,
        },
        {
          type: "role.changed",
          version: 1,
          roleId: "merchandiser",
          name: "Merchandiser",
          keys: ["aiProvider", "model"],
          agents: 2,
        },
      ]);
    },
  ],
  [
    "keeps a Role's Stage while Agents fill it",
    async ({ library, floors, agents }) => {
      await floors.add("adrianeyre/web-shop");
      expect(await refusal(library.update("coder", { stage: "review" }))).toBe(
        roleErrorCodes.stageInUse,
      );
      expect((await library.get("coder")).stage).toBe("work");
      // A Role no Agent fills changes Stage, and its next Agent is in it.
      expect(
        (await library.update("designer", { stage: "review" })).stage,
      ).toBe("review");
      const reviewer = await agents.add("web-shop", { role: "designer" });
      expect(reviewer.stage).toBe("review");
    },
  ],
  [
    "takes Skills from the Skill library and Models from the catalogue",
    async ({ library }) => {
      expect(
        await refusal(
          library.create({ ...merchandiser, skills: ["price-check"] }),
        ),
      ).toBe(roleErrorCodes.skillNotFound);
      expect(
        await refusal(
          library.create({ ...merchandiser, model: "claude-imaginary" }),
        ),
      ).toBe(roleErrorCodes.modelNotInCatalogue);
      await library.create(merchandiser);
      expect(
        await refusal(
          library.update("merchandiser", {
            aiProvider: "Gemini",
            model: "claude-sonnet-5-5",
          }),
        ),
      ).toBe(roleErrorCodes.modelNotInCatalogue);
      // A Model the Role already suggests stays, catalogue or not.
      expect(
        (await library.update("docs", { description: "Documents the change." }))
          .model,
      ).toBe("claude-haiku-5-5");
      expect(
        await refusal(
          library.update("merchandiser", {
            aiProvider: null,
            model: "claude-sonnet-5-5",
          }),
        ),
      ).toBe(roleErrorCodes.invalidRole);
    },
  ],
  [
    "deletes a Role no Agent fills, with its Role memory, and keeps the rest",
    async ({ library, floors, agents, stores, events }) => {
      await floors.add("adrianeyre/web-shop");
      await library.create(merchandiser);
      const mia = await agents.add("web-shop", { role: "merchandiser" });
      const [coder] = (await agents.list("web-shop")).filter(
        ({ role }) => role === "coder",
      );
      if (coder === undefined) {
        throw new Error("The Floor has its coder.");
      }
      await stores.officeMemory.propose([
        {
          floorId: "web-shop",
          role: "merchandiser",
          text: "Prices are in pence.",
          issue: 3,
          agentId: mia.id,
          createdAt: new Date(),
        },
        {
          floorId: "web-shop",
          role: "coder",
          text: "Run the linter first.",
          issue: 3,
          agentId: coder.id,
          createdAt: new Date(),
        },
      ]);

      expect(await refusal(library.remove("merchandiser"))).toBe(
        roleErrorCodes.roleInUse,
      );
      expect(await refusal(library.remove("coder"))).toBe(
        roleErrorCodes.roleInStartingTeam,
      );
      expect(await refusal(library.remove("nobody"))).toBe(
        roleErrorCodes.roleNotFound,
      );
      expect(await stores.roles.get("merchandiser")).toBeDefined();

      await agents.remove("web-shop", mia.id);
      await library.remove("merchandiser");
      expect(await stores.roles.get("merchandiser")).toBeUndefined();
      expect(
        (await stores.officeMemory.entries("web-shop", ["proposed"])).map(
          ({ role }) => role,
        ),
      ).toEqual(["coder"]);
      expect((await events()).at(-1)).toEqual({
        type: "role.removed",
        version: 1,
        roleId: "merchandiser",
        name: "Merchandiser",
      });
    },
  ],
  [
    "the store itself refuses to delete a Role an Agent fills",
    async ({ floors, agents, stores }) => {
      await floors.add("adrianeyre/web-shop");
      const role: RoleRecord = {
        id: "merchandiser",
        ...merchandiser,
        skills: [],
      };
      await stores.roles.create(role, new Date());
      await agents.add("web-shop", { role: "merchandiser" });
      expect(await stores.roles.remove("merchandiser")).toBe("in_use");
      expect(await stores.roles.get("merchandiser")).toEqual(role);
      expect(await stores.roles.remove("nobody")).toBeUndefined();
    },
  ],
];

describe("roleIdOf", () => {
  it("makes a Role's id from its name", () => {
    expect(roleIdOf("Brand reviewer")).toBe("brand-reviewer");
    expect(roleIdOf("  SEO / content  ")).toBe("seo-content");
    expect(roleIdOf("Café owner")).toBe("cafe-owner");
    expect(roleIdOf("¿?")).toBe("role");
    expect(roleIdOf("a".repeat(50))).toHaveLength(40);
  });
});

describe("the Role library, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(setUp(memoryStores(), createEventBus({ store: memoryEventStore() }))),
    );
  }
});

describe("the Role library, in Postgres 18", () => {
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
