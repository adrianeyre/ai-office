import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  builtInRoles,
  floorErrorCodes,
  seededRandom,
  type FloorTemplate,
} from "@ai-office/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgents } from "../agents/agents.ts";
import { skillDigest } from "../skills/skills.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { loadFloorTemplates } from "../templates/load.ts";
import {
  cornerShopFiles,
  cornerShopNeighbours,
  templateFolder,
  type TemplateFolder,
} from "../templates/testing.ts";
import { FloorError } from "./errors.ts";
import { createFloors, type Floors } from "./floors.ts";
import type { FloorRecord } from "./store.ts";

// Adding a Floor from a Floor Template (PRD FR-6, FR-10, FR-97, FR-99,
// FR-100): Development sets a Floor up exactly as Floors were set up before
// templates; Blank gives it a Manager only; another template adds its
// Roles and Skills to the libraries where missing, then gives the Floor its
// team, settings, labels and Manager's instructions. Nothing depends on the
// template afterwards. Every case runs in memory and in Postgres 18.

const start = new Date("2026-10-10T09:00:00.000Z");

interface Setup {
  readonly stores: OfficeStores;
  readonly github: FakeGitHub;
  /** Floors added from these templates (all of them by default). */
  readonly floors: (templates?: readonly FloorTemplate[]) => Floors;
  /** Floors as AI Office added them before Floor Templates. */
  readonly floorsBeforeTemplates: () => Floors;
  readonly templates: readonly FloorTemplate[];
  /** Every event so far. */
  readonly events: () => Promise<OfficeEvent[]>;
}

function setUp(
  stores: OfficeStores,
  bus: EventBus,
  templates: readonly FloorTemplate[],
): Setup {
  const github = createFakeGitHub();
  for (const repository of [
    "adrianeyre/web-shop",
    "adrianeyre/blog",
    "adrianeyre/corner-shop",
    "adrianeyre/market-stall",
  ]) {
    github.installRepository(repository);
  }
  const options = {
    store: stores.floors,
    github,
    events: bus,
    agents: stores.agents,
    roles: stores.roles,
    skills: stores.skills,
    // Each Floors makes the same names and Avatars, at the same time.
    now: () => start,
  };
  return {
    stores,
    github,
    templates,
    floors: (only = templates) =>
      createFloors({
        ...options,
        templates: only,
        random: seededRandom("team"),
      }),
    floorsBeforeTemplates: () =>
      createFloors({ ...options, random: seededRandom("team") }),
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const refusal = async (promise: Promise<unknown>): Promise<FloorError> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(FloorError);
  return error as FloorError;
};

/** A Floor's Agents, as what they are rather than which they are. */
const teamOf = async (stores: OfficeStores, floorId: string) =>
  (await stores.agents.list(floorId)).map((agent) => ({
    ...agent,
    id: "",
    floorId: "",
  }));

/**
 * A Floor's set-up: its settings and template, its required reviewers by
 * name, without what is the repository's.
 */
const setUpOf = async (stores: OfficeStores, floor: FloorRecord) => {
  const agents = await stores.agents.list(floor.id);
  return {
    ...floor,
    id: "",
    githubRepositoryId: 0,
    repository: "",
    name: "",
    requiredReviewerAgentIds: floor.requiredReviewerAgentIds.map(
      (agentId) => agents.find(({ id }) => id === agentId)?.name,
    ),
  };
};

/**
 * A Floor's events, without what differs from Floor to Floor: its id,
 * name and repository, and its Agents' ids (their names are the same).
 */
const eventsOf = (events: readonly OfficeEvent[], floorId: string) =>
  events
    .filter((event) => "floorId" in event && event.floorId === floorId)
    .map((event) => ({
      ...event,
      floorId: "",
      ...("agentId" in event ? { agentId: "" } : {}),
      ...(event.type === "floor.created" ? { name: "", repository: "" } : {}),
    }));

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "a Floor added from Development matches a Floor added before templates existed",
    async (setup) => {
      const { stores, github } = setup;
      const before = await setup
        .floorsBeforeTemplates()
        .add("adrianeyre/web-shop");
      const eventsBefore = await setup.events();
      const after = await setup.floors().add("adrianeyre/blog", "development");
      const events = await setup.events();

      // The same settings and template, and the reviewer required.
      expect(await setUpOf(stores, after)).toEqual(
        await setUpOf(stores, before),
      );
      expect(after.template).toEqual({
        id: "development",
        name: "Development",
      });
      expect(after.requiredReviewerAgentIds).toHaveLength(1);
      // Dressed as the office every Floor was before themes.
      expect(after.theme).toBe("office");
      expect(before.theme).toBe("office");
      // The same Manager, coder, reviewer and QA Agent: names, Avatars,
      // Roles, Stages, AI Providers, Models and instructions.
      const team = await teamOf(stores, after.id);
      expect(team).toEqual(await teamOf(stores, before.id));
      expect(team.map(({ role }) => role)).toEqual([
        "manager",
        "coder",
        "reviewer",
        "qa",
      ]);
      expect(team.map(({ extraInstructions }) => extraInstructions)).toEqual([
        "",
        "",
        "",
        "",
      ]);
      // The same events; no Role was added to the library, which is as
      // it was; and no label was made on the repository.
      expect(eventsOf(events, after.id)).toEqual(
        eventsOf(eventsBefore, before.id),
      );
      expect(events.filter(({ type }) => type === "role.created")).toEqual([]);
      expect(await stores.roles.list()).toEqual(builtInRoles);
      expect(github.labels("adrianeyre/blog")).toEqual(
        github.labels("adrianeyre/web-shop"),
      );

      // Added without a choice, a Floor is Development's too.
      const unchosen = await setup.floors().add("adrianeyre/corner-shop");
      expect(await setUpOf(stores, unchosen)).toEqual(
        await setUpOf(stores, before),
      );
      expect(await teamOf(stores, unchosen.id)).toEqual(team);
    },
  ],
  [
    "a Blank Floor has only a Manager",
    async ({ floors, stores, events }) => {
      const floor = await floors().add("adrianeyre/blog", "blank");
      expect(floor).toMatchObject({
        template: { id: "blank", name: "Blank" },
        // Blank's 3D theme is Development's office.
        theme: "office",
        setupCommand: "",
        testCommand: "",
        mergePolicy: "send_to_me",
        roundCap: 3,
        requiredReviewerAgentIds: [],
      });
      const [manager, ...others] = await stores.agents.list(floor.id);
      expect(others).toEqual([]);
      expect(manager).toMatchObject({ role: "manager", stage: null });
      // The template's planning guidance, as its own instructions.
      expect(manager?.extraInstructions).toMatch(
        /^This Floor started from the Blank Floor Template, so it has no Agents but you/,
      );
      expect((await events()).map(({ type }) => type)).toEqual([
        "floor.created",
        "agent.created",
      ]);
      expect(await stores.roles.list()).toEqual(builtInRoles);
    },
  ],
  [
    "a template's missing Roles join the library, then the Floor gets its team, settings, labels and Manager's instructions",
    async ({ floors, stores, github, events }) => {
      const added = await floors().add("adrianeyre/corner-shop", "corner-shop");
      expect(added).toMatchObject({
        template: { id: "corner-shop", name: "Corner shop" },
        // Its 3D theme, kept on the Floor, which never reads the template again.
        theme: "stockroom",
        setupCommand: "pnpm install",
        testCommand: "pnpm theme-check",
        mergePolicy: "auto_merge",
        roundCap: 2,
        planApproval: true,
      });

      const team = await stores.agents.list(added.id);
      expect(
        team.map(({ role, stage, aiProvider, modelOverride }) => [
          role,
          stage,
          aiProvider,
          modelOverride,
        ]),
      ).toEqual([
        ["manager", null, "Claude", null],
        ["merchandiser", "work", "Claude", "claude-sonnet-5-5"],
        ["merchandiser", "work", "Claude", "claude-sonnet-5-5"],
        // Its Role suggests no AI Provider: the office default's.
        ["brand-reviewer", "review", "Claude", null],
      ]);
      expect(new Set(team.map(({ name }) => name)).size).toBe(4);
      expect(added.requiredReviewerAgentIds).toEqual([team[3]?.id]);
      expect(team[0]?.extraInstructions).toBe(
        [
          "Plan catalogue changes before the copy that describes them.",
          "",
          'When the Owner asks where to start, suggest they file this set-up issue first, titled "Check every product has a price":',
          "",
          "List the products without a price, and add one to each.",
        ].join("\n"),
      );
      expect(github.labels("adrianeyre/corner-shop")).toEqual([
        { name: "product", color: "c2e0c6", description: "A product's data" },
      ]);

      // Its three Roles are in the library now, the copywriter without
      // an Agent, each recorded as coming from the template.
      const library = await stores.roles.list();
      expect(library.map(({ id }) => id)).toEqual([
        ...builtInRoles.map(({ id }) => id),
        "brand-reviewer",
        "copywriter",
        "merchandiser",
      ]);
      expect(library.find(({ id }) => id === "merchandiser")).toMatchObject({
        name: "merchandiser",
        stage: "work",
        instructions: "- Keep every price in pence.",
        skills: ["price-check"],
      });
      const all = await events();
      expect(all.filter(({ type }) => type === "role.created")).toEqual(
        ["merchandiser", "brand-reviewer", "copywriter"].map((roleId) => ({
          type: "role.created",
          version: 1,
          roleId,
          name: roleId === "brand-reviewer" ? "brand reviewer" : roleId,
          stage: roleId === "brand-reviewer" ? "review" : "work",
          duplicatedFrom: null,
          template: { id: "corner-shop", name: "Corner shop" },
        })),
      );
      expect(all.find(({ type }) => type === "floor.created")).toEqual({
        type: "floor.created",
        version: 1,
        floorId: "corner-shop",
        name: "corner-shop",
        repository: "adrianeyre/corner-shop",
        template: { id: "corner-shop", name: "Corner shop" },
      });

      // The Owner edits the merchandiser. A second Floor from the template
      // keeps the edit, and adds no Role again.
      const merchandiser = library.find(({ id }) => id === "merchandiser");
      expect(merchandiser).toBeDefined();
      if (merchandiser !== undefined) {
        await stores.roles.update(
          { ...merchandiser, instructions: "- Keep every price in euros." },
          start,
        );
      }
      const second = await floors().add(
        "adrianeyre/market-stall",
        "corner-shop",
      );
      expect(
        (await events()).filter(({ type }) => type === "role.created"),
      ).toHaveLength(3);
      expect((await stores.roles.get("merchandiser"))?.instructions).toBe(
        "- Keep every price in euros.",
      );
      expect(
        (await stores.agents.list(second.id)).map(({ role }) => role),
      ).toEqual(["manager", "merchandiser", "merchandiser", "brand-reviewer"]);
    },
  ],
  [
    "a template's missing Skills join the Skill library, enabled, so its Agents are given them; one the library has is kept",
    async ({ floors, stores, templates, events }) => {
      // Development ships no Skills.
      await floors().add("adrianeyre/web-shop");
      expect(await stores.skills.list()).toEqual([]);

      await floors().add("adrianeyre/corner-shop", "corner-shop");
      const shipped = templates.find(({ id }) => id === "corner-shop")
        ?.skills[0];
      const [added, ...others] = await stores.skills.list();
      expect(others).toEqual([]);
      expect(added).toMatchObject({
        name: "price-check",
        description: "Checks that every product has a price in pence.",
        source: "template",
        origin: null,
        files: shipped?.files,
        digest: skillDigest(shipped?.files ?? []),
        // Built in, so reviewed as part of AI Office.
        enabled: true,
        reviewedAt: start,
      });
      expect(
        (await events()).filter(({ type }) => type === "skill.added"),
      ).toEqual([
        {
          type: "skill.added",
          version: 1,
          skillId: added?.id,
          name: "price-check",
          source: "template",
          enabled: true,
          template: { id: "corner-shop", name: "Corner shop" },
        },
      ]);

      // The Owner edits it. A second Floor from the template keeps the
      // edit, and adds no Skill again.
      const edited = [
        {
          path: "SKILL.md",
          content:
            "---\nname: price-check\ndescription: Prices in euros.\n---\n\nCheck prices.\n",
        },
      ];
      await stores.skills.update(added?.id ?? "", {
        files: edited,
        description: "Prices in euros.",
        updatedAt: start,
      });
      await floors().add("adrianeyre/market-stall", "corner-shop");
      expect(await stores.skills.list()).toEqual([
        expect.objectContaining({ id: added?.id, files: edited }),
      ]);
      expect(
        (await events()).filter(({ type }) => type === "skill.added"),
      ).toHaveLength(1);
    },
  ],
  [
    "nothing depends on the template after the Floor is added",
    async ({ floors, stores, templates }) => {
      const added = await floors().add("adrianeyre/corner-shop", "corner-shop");
      const team = await stores.agents.list(added.id);

      // AI Office starts again without the template.
      const without = floors(
        templates.filter(({ id }) => id !== "corner-shop"),
      );
      expect(await without.get(added.id)).toEqual(added);
      expect(await without.list()).toEqual([added]);
      expect(await stores.agents.list(added.id)).toEqual(team);

      // Everything it set up is still the Owner's to change.
      const changed = await without.updateSettings(added.id, {
        testCommand: "pnpm test",
        mergePolicy: "send_to_me",
        roundCap: 4,
      });
      expect(changed).toMatchObject({
        testCommand: "pnpm test",
        mergePolicy: "send_to_me",
        roundCap: 4,
        template: { id: "corner-shop", name: "Corner shop" },
      });
      const agents = createAgents({
        store: stores.agents,
        floors: stores.floors,
        events: createEventBus({ store: memoryEventStore() }),
        roles: stores.roles,
        random: seededRandom("more"),
      });
      const third = await agents.addToTeam(added.id, "merchandiser");
      expect(third).toMatchObject({
        role: "merchandiser",
        stage: "work",
        aiProvider: "Claude",
        modelOverride: "claude-sonnet-5-5",
      });
      const copywriter = await agents.addToTeam(added.id, "copywriter");
      expect(copywriter.stage).toBe("work");
      expect(
        await agents.update(added.id, team[0]?.id ?? "", {
          extraInstructions: "Plan the copy first.",
        }),
      ).toMatchObject({ extraInstructions: "Plan the copy first." });

      // And a new Floor from it is refused, as there is no such template.
      const error = await refusal(
        without.add("adrianeyre/market-stall", "corner-shop"),
      );
      expect(error.code).toBe(floorErrorCodes.templateNotFound);
    },
  ],
  [
    "refuses a template there is not, or whose Role's name the library has under another id, changing nothing",
    async ({ floors, stores, github, events }) => {
      const unknown = await refusal(
        floors().add("adrianeyre/corner-shop", "online-store"),
      );
      expect(unknown.code).toBe(floorErrorCodes.templateNotFound);
      expect(unknown.message).toBe(
        'There is no Floor Template "online-store".',
      );

      // The Owner's own Role is called copywriter.
      expect(
        await stores.roles.create(
          {
            id: "writer",
            name: "Copywriter",
            stage: "work",
            description: "Writes the copy.",
            instructions: "",
            skills: [],
            deskDressing: "books",
            aiProvider: null,
            model: null,
          },
          start,
        ),
      ).toBe(true);
      const clash = await refusal(
        floors().add("adrianeyre/corner-shop", "corner-shop"),
      );
      expect(clash.code).toBe(floorErrorCodes.templateRoleNameTaken);
      expect(clash.message).toBe(
        'The Corner shop Floor Template brings a Role called "copywriter", and the Role library has another Role of that name. Rename it, then add the Floor.',
      );
      expect(await stores.floors.list()).toEqual([]);
      expect((await stores.roles.list()).map(({ id }) => id)).toEqual([
        ...builtInRoles.map(({ id }) => id),
        "writer",
      ]);
      expect(github.labels("adrianeyre/corner-shop")).toEqual([]);
      expect(await events()).toEqual([]);
    },
  ],
];

describe("adding a Floor from a Floor Template", () => {
  let folder: TemplateFolder;
  let templates: readonly FloorTemplate[];
  beforeEach(async () => {
    folder = await templateFolder({ only: cornerShopNeighbours });
    await folder.write(cornerShopFiles);
    templates = await loadFloorTemplates(folder.root);
  });
  afterEach(() => folder.remove());

  describe("kept in memory", () => {
    for (const [name, run] of cases) {
      it(name, () =>
        run(
          setUp(
            memoryStores(),
            createEventBus({ store: memoryEventStore() }),
            templates,
          ),
        ),
      );
    }
  });

  describe("kept in Postgres 18", () => {
    for (const [name, run] of cases) {
      postgresTest(name, ({ database }) =>
        run(
          setUp(
            databaseStores(database.db),
            createEventBus({ store: databaseEventStore(database.db) }),
            templates,
          ),
        ),
      );
    }
  });
});
