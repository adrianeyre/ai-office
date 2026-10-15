import { readFile } from "node:fs/promises";

import { schemaFile } from "@ai-office/db";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { builtInRoles, initialDefaultModels } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { AgentError, createAgents } from "../agents/agents.ts";
import { coderPrompt } from "../coder/prompt.ts";
import { createFloors } from "../floors/floors.ts";
import { memoryStores } from "../stores.ts";
import {
  approve,
  labelsOf,
  ofType,
  scenario,
  workDone,
  type Scenario,
} from "../work/scenario.ts";
import { roleOfAgent, stageIn, startingModel } from "./roles.ts";
import { memoryRoleStore, type RoleRecord } from "./store.ts";
import { builtIn } from "./testing.ts";

// Roles are data on four fixed Stages (PRD FR-98, ADR 0003): the office
// Role library starts with today's Roles and their instructions, existing
// Agents keep theirs, the pipeline and dispatch go by a Role's Stage (so a
// new work-Stage Role is dispatched like a coder), editing a Role changes
// every Agent with it, and a Role's suggested AI Provider falls back to
// the office default when the Owner has no AI Account for it.

/** A copywriter: a work-Stage Role with a name no code knows. */
const copywriter: RoleRecord = {
  id: "copywriter",
  name: "copywriter",
  stage: "work",
  description: "Writes the product copy: names, descriptions and headings.",
  instructions:
    "- Write in British English, in the brand's voice: warm, plain and short.\n- Commit the copy you change. Work that is not committed is lost.",
  skills: [],
  deskDressing: "books",
  aiProvider: "Claude",
  model: null,
};

let setup: Scenario | undefined;

afterEach(async () => {
  await setup?.close();
  setup = undefined;
});

describe("the office Role library", () => {
  it("starts with today's Roles, each in its Stage, the Manager not among them", async () => {
    const library = await memoryRoleStore().list();
    expect(
      library.map(({ id, name, stage }) => `${id} (${name}): ${stage}`),
    ).toEqual([
      "coder (coder): work",
      "reviewer (reviewer): review",
      "qa (QA): qa",
      "docs (docs): docs",
      "designer (designer): work",
    ]);
    expect(stageIn(library, "manager")).toBeNull();
  });

  it("is seeded by the schema with exactly the built-in Roles", async () => {
    const sql = await readFile(schemaFile, "utf8");
    const literal = (text: string) => text.replaceAll("'", "''");
    const insert = sql.slice(sql.indexOf('INSERT INTO "roles"'));
    for (const role of builtInRoles) {
      const row = insert
        .split("\n")
        .find((line) => line.startsWith(`\t('${role.id}', `));
      expect(row, role.id).toBeDefined();
      // Multi-line instructions are an E'' string with `\n` for each break.
      for (const value of [
        role.name,
        role.stage,
        role.description,
        role.instructions.replaceAll("\n", "\\n"),
        role.deskDressing,
      ]) {
        expect(row).toContain(`'${literal(value)}'`);
      }
      expect(row).toContain(
        role.model === null ? "'Claude', NULL" : `'Claude', '${role.model}'`,
      );
    }
    expect(insert.match(/^\t\('/gm)).toHaveLength(builtInRoles.length);
  });

  it("keeps an existing Agent in its Role, with its Role's instructions and its own on top", async () => {
    // An Agent as it was stored before Roles were data: its Role by id.
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    const floors = createFloors({ store: stores.floors, github, events: bus });
    await floors.add("adrianeyre/web-shop");
    const agents = createAgents({
      store: stores.agents,
      floors: stores.floors,
      events: bus,
      roles: stores.roles,
    });
    const [, ada] = await stores.agents.list("web-shop");
    if (ada === undefined) {
      throw new Error("A new Floor has a coder.");
    }
    await agents.update("web-shop", ada.id, {
      extraInstructions: "Prefer small functions.",
    });
    const coder = (await stores.agents.list("web-shop"))[1];
    expect(coder).toMatchObject({ role: "coder", stage: "work" });
    const role = await roleOfAgent(stores.roles, ada);
    expect(role).toEqual(builtIn("coder"));

    const prompt = coderPrompt({
      floor: {
        name: "web-shop",
        repository: "adrianeyre/web-shop",
        defaultBranch: "main",
        setupCommand: "",
        testCommand: "pnpm test",
      },
      agent: {
        ...ada,
        model: "claude-opus-5-5",
        extraInstructions: coder?.extraInstructions ?? "",
      },
      role,
      issue: { number: 4, title: "Add a basket", body: "Shoppers need one." },
      branch: "ai-office/4-add-a-basket",
    });
    expect(prompt).toContain(
      `You are ${ada.name}, a coder Agent in AI Office, working GitHub issue #4`,
    );
    expect(prompt).toContain(
      "- Run the tests before you finish, and fix what fails: `pnpm test`\n- Make the smallest change that does what the issue asks, and commit it. Work that is not committed is lost.\n- AI Office pushes your branch",
    );
    expect(
      prompt.indexOf(
        "## The Owner's instructions for you\n\nPrefer small functions.",
      ),
    ).toBeGreaterThan(prompt.indexOf("Make the smallest change"));
  });
});

describe("a new work-Stage Role", () => {
  it("is dispatched like a coder: its Agent works the issue with its Role's instructions, then review, QA and the Merge Policy follow", async () => {
    setup = await scenario({ workRole: copywriter });
    const { model, grace, quinta, coder } = setup;
    expect(coder).toMatchObject({
      name: "Cora",
      role: "copywriter",
      stage: "work",
    });
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    // The copywriter was given the work, as its Role.
    expect(setup.prompts).toHaveLength(1);
    const [prompt = ""] = setup.prompts;
    expect(prompt).toContain(
      "You are Cora, a copywriter Agent in AI Office, working GitHub issue #1",
    );
    expect(prompt).toContain(
      "- Write in British English, in the brand's voice: warm, plain and short.",
    );
    expect(prompt).not.toContain("Make the smallest change");
    const events = await setup.events();
    expect(
      ofType(events, "issue.assigned").map(({ agentId }) => agentId),
    ).toContain(coder.id);

    // And the rest of the pipeline ran as it does for a coder's work.
    expect(await labelsOf(setup, 1)).toEqual(["ai-office", "ready-to-merge"]);
    expect(workDone(setup)).toEqual([
      "needs-work finished",
      "needs-review finished",
      "needs-qa finished",
      "ready-to-merge finished",
    ]);
  });
});

describe("editing a Role", () => {
  it("changes the next task of every Agent with it, the Agent's extra instructions still on top", async () => {
    setup = await scenario();
    const { model, grace, quinta, coder, stores } = setup;
    await stores.agents.update({
      ...coder,
      extraInstructions: "Name things after fruit.",
    });
    const before = await stores.roles.get("coder");
    if (before === undefined) {
      throw new Error("The library has the coder.");
    }
    await stores.roles.update(
      {
        ...before,
        instructions:
          "- Make the change in as few files as you can, and commit it.",
      },
      new Date(),
    );
    model.answer(grace.id, approve());
    model.answer(quinta.id, approve());
    await setup.run();

    const [prompt = ""] = setup.prompts;
    expect(prompt).toContain(
      "- Make the change in as few files as you can, and commit it.",
    );
    expect(prompt).not.toContain("Make the smallest change");
    expect(prompt).toContain(
      "## The Owner's instructions for you\n\nName things after fruit.",
    );
  });
});

describe("a Role's suggested AI Provider", () => {
  const gemini: RoleRecord = {
    ...copywriter,
    id: "seo-specialist",
    name: "SEO specialist",
    aiProvider: "Gemini",
    model: "gemini-3-pro",
  };

  const add = async (accounts: readonly string[]) => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    await createFloors({ store: stores.floors, github, events: bus }).add(
      "adrianeyre/web-shop",
    );
    await stores.roles.create(gemini, new Date());
    const agents = createAgents({
      store: stores.agents,
      floors: stores.floors,
      events: bus,
      roles: stores.roles,
      defaultModels: () =>
        Promise.resolve({ ...initialDefaultModels, Gemini: "gemini-3-flash" }),
      aiAccountProviders: () => Promise.resolve(new Set(accounts)),
    });
    return { agents, stores };
  };

  it("is a new Agent's when the Owner has an AI Account for it", async () => {
    const { agents } = await add(["Claude", "Gemini"]);
    const agent = await agents.add("web-shop", { role: "seo-specialist" });
    expect(agent).toMatchObject({
      aiProvider: "Gemini",
      modelOverride: "gemini-3-pro",
      stage: "work",
    });
  });

  it("falls back to the office default when the Owner has no AI Account for it", async () => {
    const { agents } = await add(["Claude"]);
    const agent = await agents.add("web-shop", { role: "seo-specialist" });
    expect(agent).toMatchObject({ aiProvider: "Claude", modelOverride: null });
    expect(startingModel(gemini, () => false)).toEqual({
      aiProvider: "Claude",
      modelOverride: null,
    });
    // The office default itself needs no AI Account to be suggested.
    expect(startingModel(builtIn("docs"), () => false)).toEqual({
      aiProvider: "Claude",
      modelOverride: "claude-haiku-5-5",
    });
  });

  it("is refused for a Role the library does not have", async () => {
    const { agents } = await add(["Claude"]);
    await expect(
      agents.add("web-shop", { role: "janitor" }),
    ).rejects.toMatchObject({ code: "role_not_found" });
    await expect(agents.setTeamSize("web-shop", "janitor", 1)).rejects.toThrow(
      AgentError,
    );
  });
});
