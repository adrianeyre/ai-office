import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  coderPrompt,
  databaseStores,
  memoryStores,
  roleOfAgent,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  agentSchema,
  apiErrorSchema,
  roleErrorCodes,
  roleListSchema,
  roleSchema,
  type Agent,
  type CreateRoleRequest,
  type LibraryRole,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The Role library's admin through the API, as the server runs it (PRD
// FR-98, FR-65, FR-10): a Role is made, duplicated, edited and deleted; a
// Role an Agent fills cannot be deleted; an edit reaches every Agent with
// the Role, on every Floor, from its next task, its own extra instructions
// still on top; and every change is in the Activity Feed. Each case runs in
// memory and in Postgres 18.

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  readonly stores: OfficeStores;
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
  });
  return { server, owner: await signIn(server), bus, stores };
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

const copywriter: CreateRoleRequest = {
  name: "copywriter",
  stage: "work",
  description: "Writes the product copy: names, descriptions and headings.",
  instructions: "- Write in British English, in the brand's voice.",
  skills: [],
  deskDressing: "books",
  aiProvider: "Claude",
  model: null,
};

async function roles(setup: Setup): Promise<LibraryRole[]> {
  const response = await request(setup, "GET", "/api/roles");
  expect(response.statusCode).toBe(200);
  return roleListSchema.parse(response.json()).roles;
}

async function made(setup: Setup, body: object): Promise<LibraryRole> {
  const response = await request(setup, "POST", "/api/roles", body);
  expect(response.statusCode, response.body).toBe(201);
  return roleSchema.parse(response.json());
}

async function addFloor(setup: Setup, repository: string): Promise<string> {
  const response = await request(setup, "POST", "/api/floors", { repository });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

/** Adds an Agent in `role` to a Floor, as the Floor admin does. */
async function addAgent(
  setup: Setup,
  floorId: string,
  role: string,
  name: string,
): Promise<Agent> {
  const response = await request(
    setup,
    "POST",
    `/api/floors/${floorId}/agents`,
    {
      role,
      name,
    },
  );
  expect(response.statusCode, response.body).toBe(201);
  return agentSchema.parse(response.json());
}

async function agentsOn(setup: Setup, floorId: string): Promise<Agent[]> {
  const response = await request(setup, "GET", `/api/floors/${floorId}/agents`);
  return agentListSchema.parse(response.json()).agents;
}

/** The Role library's events, as the Activity Feed lists them, oldest first. */
async function roleEvents(setup: Setup) {
  const response = await request(
    setup,
    "GET",
    "/api/events?type=role.created,role.changed,role.removed",
  );
  expect(response.statusCode).toBe(200);
  return response
    .json<{ events: { event: unknown }[] }>()
    .events.map(({ event }) => event)
    .reverse();
}

/** The work prompt an Agent's next task is given, as the coder flow builds it. */
async function nextPrompt(setup: Setup, agent: Agent): Promise<string> {
  const role = await roleOfAgent(setup.stores.roles, agent);
  return coderPrompt({
    role,
    floor: {
      name: agent.floorId,
      repository: `adrianeyre/${agent.floorId}`,
      defaultBranch: "main",
      setupCommand: "",
      testCommand: "pnpm test",
    },
    agent: {
      name: agent.name,
      role: agent.role,
      aiProvider: agent.aiProvider,
      model: agent.model,
      extraInstructions: agent.extraInstructions,
    },
    issue: { number: 1, title: "Autumn range", body: "Add the autumn range." },
    branch: "ai-office/1-autumn-range",
  });
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "lists the library's Roles with their Stage and how many Agents fill each",
    async (setup) => {
      expect(
        (await roles(setup)).map(({ id, stage, agents }) => [
          id,
          stage,
          agents,
        ]),
      ).toEqual([
        ["coder", "work", 0],
        ["reviewer", "review", 0],
        ["qa", "qa", 0],
        ["docs", "docs", 0],
        ["designer", "work", 0],
      ]);
      await addFloor(setup, "adrianeyre/web-shop");
      await addFloor(setup, "adrianeyre/blog");
      await addAgent(setup, "web-shop", "coder", "Hopper");
      const listed = await roles(setup);
      expect(listed.map(({ id, agents }) => [id, agents])).toEqual([
        ["coder", 3],
        ["reviewer", 2],
        ["qa", 2],
        ["docs", 0],
        ["designer", 0],
      ]);
      expect(listed.find(({ id }) => id === "coder")).toMatchObject({
        name: "coder",
        inStartingTeam: true,
      });
      // Design system starts Floors with a designer.
      expect(listed.find(({ id }) => id === "designer")?.inStartingTeam).toBe(
        true,
      );
      expect(listed.find(({ id }) => id === "docs")?.inStartingTeam).toBe(
        false,
      );
    },
  ],
  [
    "a Role in use cannot be deleted; once no Agent fills it, it can",
    async (setup) => {
      // A Role no Floor Template starts Floors with.
      const role = await made(setup, { ...copywriter, name: "proofreader" });
      expect(role).toMatchObject({ id: "proofreader", agents: 0 });
      const floorId = await addFloor(setup, "adrianeyre/web-shop");
      const cora = await addAgent(setup, floorId, "proofreader", "Cora");
      expect(cora).toMatchObject({ role: "proofreader", stage: "work" });

      const refused = await request(setup, "DELETE", "/api/roles/proofreader");
      expect(refused.statusCode).toBe(409);
      expect(apiErrorSchema.parse(refused.json())).toEqual({
        error: roleErrorCodes.roleInUse,
        message:
          "1 Agent fills proofreader: remove it from its Floor before deleting the Role.",
      });
      expect((await roles(setup)).map(({ id }) => id)).toContain("proofreader");
      expect(await agentsOn(setup, floorId)).toContainEqual(
        expect.objectContaining({ name: "Cora", role: "proofreader" }),
      );

      // A built-in Role no Agent fills can go; one a template starts
      // Floors with stays, even with no Agent.
      const docs = await request(setup, "DELETE", "/api/roles/docs");
      expect(docs.statusCode).toBe(204);
      const designer = await request(setup, "DELETE", "/api/roles/designer");
      expect(designer.statusCode).toBe(409);
      expect(apiErrorSchema.parse(designer.json())).toEqual({
        error: roleErrorCodes.roleInStartingTeam,
        message:
          "The Design system Floor Template starts Floors with a designer Agent, so designer stays in the library.",
      });
      const kept = await request(setup, "DELETE", "/api/roles/reviewer");
      expect(kept.statusCode).toBe(409);
      expect(apiErrorSchema.parse(kept.json()).error).toBe(
        roleErrorCodes.roleInStartingTeam,
      );
      // So does a copywriter, which Online store and Website & marketing
      // start Floors with.
      await made(setup, copywriter);
      const starting = await request(setup, "DELETE", "/api/roles/copywriter");
      expect(starting.statusCode).toBe(409);
      expect(apiErrorSchema.parse(starting.json())).toEqual({
        error: roleErrorCodes.roleInStartingTeam,
        message:
          "The Online store and Website & marketing Floor Templates start Floors with a copywriter Agent, so copywriter stays in the library.",
      });

      // Cora goes: her row is kept, but no longer keeps the Role.
      const removed = await request(
        setup,
        "DELETE",
        `/api/floors/${floorId}/agents/${cora.id}`,
      );
      expect(removed.statusCode, removed.body).toBe(200);
      expect(
        (await roles(setup)).find(({ id }) => id === "proofreader")?.agents,
      ).toBe(0);
      const deleted = await request(setup, "DELETE", "/api/roles/proofreader");
      expect(deleted.statusCode, deleted.body).toBe(204);
      expect((await roles(setup)).map(({ id }) => id)).toEqual([
        "coder",
        "reviewer",
        "qa",
        "designer",
        "copywriter",
      ]);
      const gone = await request(setup, "GET", "/api/roles/proofreader");
      expect(gone.statusCode).toBe(404);
      // And no Agent can be added in it now.
      const add = await request(
        setup,
        "POST",
        `/api/floors/${floorId}/agents`,
        {
          role: "proofreader",
        },
      );
      expect(add.statusCode).toBe(404);
      expect(apiErrorSchema.parse(add.json()).error).toBe("role_not_found");
    },
  ],
  [
    "an edit reaches every Agent with the Role, on every Floor, from its next task",
    async (setup) => {
      await made(setup, copywriter);
      const shop = await addFloor(setup, "adrianeyre/web-shop");
      const blog = await addFloor(setup, "adrianeyre/blog");
      const cora = await addAgent(setup, shop, "copywriter", "Cora");
      const cass = await addAgent(setup, shop, "copywriter", "Cass");
      const bram = await addAgent(setup, blog, "copywriter", "Bram");
      // Bram's own extra instructions apply on top of his Role's.
      const own = await request(
        setup,
        "PATCH",
        `/api/floors/${blog}/agents/${bram.id}`,
        {
          extraInstructions: "Keep headings under six words.",
        },
      );
      expect(own.statusCode, own.body).toBe(200);
      for (const agent of [cora, cass, bram]) {
        expect(await nextPrompt(setup, agent)).toContain(
          "- Write in British English, in the brand's voice.",
        );
      }

      const edited = await request(setup, "PATCH", "/api/roles/copywriter", {
        instructions:
          "- Write in American English, short and plain.\n- Commit the copy you change.",
        description: "Writes product names, descriptions and headings.",
      });
      expect(edited.statusCode, edited.body).toBe(200);
      // It says how many Agents the change reaches.
      expect(roleSchema.parse(edited.json())).toMatchObject({
        id: "copywriter",
        agents: 3,
        instructions:
          "- Write in American English, short and plain.\n- Commit the copy you change.",
      });

      // Each one's next task has the new instructions, not the old.
      for (const [floorId, name] of [
        [shop, "Cora"],
        [shop, "Cass"],
        [blog, "Bram"],
      ] as const) {
        const agent = (await agentsOn(setup, floorId)).find(
          (each) => each.name === name,
        );
        if (agent === undefined) {
          throw new Error(`${name} is on ${floorId}.`);
        }
        const prompt = await nextPrompt(setup, agent);
        expect(prompt).toContain(
          `You are ${name}, a copywriter Agent in AI Office`,
        );
        expect(prompt).toContain(
          "- Write in American English, short and plain.\n- Commit the copy you change.",
        );
        expect(prompt).not.toContain("British English");
        if (name === "Bram") {
          expect(prompt).toContain(
            "## The Owner's instructions for you\n\nKeep headings under six words.",
          );
          expect(prompt.indexOf("Keep headings")).toBeGreaterThan(
            prompt.indexOf("American English"),
          );
        }
      }

      // Its Stage stays while Agents fill it.
      const stage = await request(setup, "PATCH", "/api/roles/copywriter", {
        stage: "review",
      });
      expect(stage.statusCode).toBe(409);
      expect(apiErrorSchema.parse(stage.json()).error).toBe(
        roleErrorCodes.stageInUse,
      );
      expect(
        (await agentsOn(setup, shop)).find(({ id }) => id === cora.id)?.stage,
      ).toBe("work");
    },
  ],
  [
    "records every change in the Activity Feed: made, duplicated, edited and deleted",
    async (setup) => {
      await made(setup, copywriter);
      const copy = await request(
        setup,
        "POST",
        "/api/roles/copywriter/duplicate",
        {},
      );
      expect(copy.statusCode, copy.body).toBe(201);
      expect(roleSchema.parse(copy.json())).toMatchObject({
        id: "copywriter-copy",
        name: "copywriter copy",
        stage: "work",
        instructions: copywriter.instructions,
        agents: 0,
      });
      const renamed = await request(
        setup,
        "PATCH",
        "/api/roles/copywriter-copy",
        {
          name: "brand reviewer",
          stage: "review",
          deskDressing: "printouts",
        },
      );
      expect(renamed.statusCode, renamed.body).toBe(200);
      // An edit that changes nothing is not a change.
      const same = await request(setup, "PATCH", "/api/roles/copywriter", {
        stage: "work",
      });
      expect(same.statusCode).toBe(200);
      const deleted = await request(
        setup,
        "DELETE",
        "/api/roles/copywriter-copy",
      );
      expect(deleted.statusCode).toBe(204);
      // A name taken in another case is refused, and is not a change.
      const taken = await request(setup, "POST", "/api/roles", {
        ...copywriter,
        name: "Copywriter",
      });
      expect(taken.statusCode).toBe(409);
      expect(apiErrorSchema.parse(taken.json()).error).toBe(
        roleErrorCodes.roleNameTaken,
      );

      expect(await roleEvents(setup)).toEqual([
        {
          type: "role.created",
          version: 1,
          roleId: "copywriter",
          name: "copywriter",
          stage: "work",
          duplicatedFrom: null,
        },
        {
          type: "role.created",
          version: 1,
          roleId: "copywriter-copy",
          name: "copywriter copy",
          stage: "work",
          duplicatedFrom: "copywriter",
        },
        {
          type: "role.changed",
          version: 1,
          roleId: "copywriter-copy",
          name: "brand reviewer",
          keys: ["name", "stage", "deskDressing"],
          agents: 0,
        },
        {
          type: "role.removed",
          version: 1,
          roleId: "copywriter-copy",
          name: "brand reviewer",
        },
      ]);
      // Which fields changed, never what they say.
      expect(JSON.stringify(await roleEvents(setup))).not.toContain(
        "British English",
      );
    },
  ],
  [
    "refuses Skills the Skill library does not have, and Models not in the catalogue",
    async (setup) => {
      const skill = await request(setup, "POST", "/api/roles", {
        ...copywriter,
        skills: ["brand-voice"],
      });
      expect(skill.statusCode).toBe(400);
      expect(apiErrorSchema.parse(skill.json())).toEqual({
        error: roleErrorCodes.skillNotFound,
        message: 'The office Skill library has no Skill "brand-voice".',
      });
      const written = await request(setup, "POST", "/api/skills", {
        source: "editor",
        files: [
          {
            path: "SKILL.md",
            content:
              "---\nname: brand-voice\ndescription: Writes in the brand's voice.\n---\n\nSteps.\n",
          },
        ],
      });
      expect(written.statusCode, written.body).toBe(201);
      expect(
        (await made(setup, { ...copywriter, skills: ["brand-voice"] })).skills,
      ).toEqual(["brand-voice"]);

      const model = await request(setup, "PATCH", "/api/roles/copywriter", {
        model: "claude-imaginary-1",
      });
      expect(model.statusCode).toBe(400);
      expect(apiErrorSchema.parse(model.json()).error).toBe(
        roleErrorCodes.modelNotInCatalogue,
      );
      const manager = await request(setup, "POST", "/api/roles", {
        ...copywriter,
        name: "Manager",
      });
      expect(manager.statusCode).toBe(400);
    },
  ],
];

describe("the Role library through the API, in memory", () => {
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

describe("the Role library through the API, in Postgres 18", () => {
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
