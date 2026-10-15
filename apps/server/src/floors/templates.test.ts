import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  cornerShopFiles,
  cornerShopNeighbours,
  databaseStores,
  loadFloorTemplates,
  memoryStores,
  templateFolder,
  type OfficeStores,
  type TemplateFolder,
} from "@ai-office/orchestrator";
import {
  agentListSchema,
  floorListSchema,
  floorSchema,
  floorTemplateListSchema,
  roleListSchema,
  type FloorTemplate,
} from "@ai-office/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// Floor Templates through the API (PRD FR-6, FR-97, FR-100): the picker's
// list, adding a Floor from the template chosen (Development when none
// is), and a Floor that keeps working once its template has gone. Each
// case runs with the office in memory, and in Postgres 18.

interface Setup {
  readonly stores: OfficeStores;
  readonly bus: EventBus;
  readonly github: FakeGitHub;
  /** The app, as AI Office starts with `templates` (the built-in ones by default). */
  start(templates?: readonly FloorTemplate[]): Promise<Office>;
  /** Corner shop, beside the built-in Development and Blank. */
  readonly withCornerShop: readonly FloorTemplate[];
}

interface Office {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  request(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse>;
}

function setUp(
  stores: OfficeStores,
  bus: EventBus,
  withCornerShop: readonly FloorTemplate[],
): Setup {
  const github = createFakeGitHub();
  for (const repository of [
    "adrianeyre/web-shop",
    "adrianeyre/blog",
    "adrianeyre/corner-shop",
  ]) {
    github.installRepository(repository);
  }
  return {
    stores,
    bus,
    github,
    withCornerShop,
    async start(templates?: readonly FloorTemplate[]) {
      const server = await buildApp({
        logger: createLogger({ level: "silent", secrets: [] }),
        checkDatabase: () => Promise.resolve(true),
        webDistDir: "/nonexistent",
        auth: await testAuth(),
        events: bus,
        stores,
        github,
        ...(templates === undefined ? {} : { templates }),
      });
      const owner = await signIn(server);
      return {
        server,
        owner,
        request: (method, url, payload) =>
          server.inject({
            method,
            url,
            headers: owner.headers,
            ...(payload === undefined ? {} : { payload }),
          }),
      };
    },
  };
}

const agentsOf = async (office: Office, floorId: string) => {
  const response = await office.request("GET", `/api/floors/${floorId}/agents`);
  expect(response.statusCode).toBe(200);
  return agentListSchema.parse(response.json()).agents;
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "the picker lists the built-in templates, Development first, with each one's starting team",
    async (setup) => {
      const office = await setup.start();
      const response = await office.request("GET", "/api/floor-templates");
      expect(response.statusCode).toBe(200);
      expect(floorTemplateListSchema.parse(response.json())).toEqual({
        defaultTemplate: "development",
        templates: [
          {
            id: "development",
            name: "Development",
            description:
              "A software team that changes the code, reviews each pull request and tests it.",
            icon: "code",
            theme: "office",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              { role: "coder", name: "coder", stage: "work", count: 1 },
              { role: "reviewer", name: "reviewer", stage: "review", count: 1 },
              { role: "qa", name: "QA", stage: "qa", count: 1 },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "blank",
            name: "Blank",
            description:
              "Only a Manager, for a Floor whose team you put together yourself.",
            icon: "square",
            theme: "office",
            team: [{ role: "manager", name: "Manager", stage: null, count: 1 }],
            builtIn: true,
            enabled: true,
          },
          {
            id: "content-and-blog",
            name: "Content & blog",
            description:
              "A writing team that drafts and revises the posts and pages in the blog's repository, edits each change and checks its facts.",
            icon: "pen-line",
            theme: "editorial",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              { role: "writer", name: "writer", stage: "work", count: 1 },
              {
                role: "seo-specialist",
                name: "SEO specialist",
                stage: "work",
                count: 1,
              },
              { role: "editor", name: "editor", stage: "review", count: 1 },
              {
                role: "fact-checker",
                name: "fact-checker",
                stage: "qa",
                count: 1,
              },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "data-and-analytics",
            name: "Data & analytics",
            description:
              "A data team that changes the dbt models, tests and docs in the repository, reviews each change's logic and checks its data on sample data.",
            icon: "chart-column",
            theme: "observatory",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              {
                role: "analytics-engineer",
                name: "analytics engineer",
                stage: "work",
                count: 1,
              },
              {
                role: "data-reviewer",
                name: "data reviewer",
                stage: "review",
                count: 1,
              },
              {
                role: "data-quality-qa",
                name: "data-quality QA",
                stage: "qa",
                count: 1,
              },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "design-system",
            name: "Design system",
            description:
              "A design team that changes the design tokens, styles and components in the design system's repository, reviews each change for accessibility and checks how it looks.",
            icon: "palette",
            theme: "atelier",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              { role: "designer", name: "designer", stage: "work", count: 1 },
              {
                role: "front-end-developer",
                name: "front-end developer",
                stage: "work",
                count: 1,
              },
              {
                role: "accessibility-reviewer",
                name: "accessibility reviewer",
                stage: "review",
                count: 1,
              },
              { role: "visual-qa", name: "visual QA", stage: "qa", count: 1 },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "documentation",
            name: "Documentation",
            description:
              "A docs team that writes and revises the guides, tutorials and reference in the repository, reviews each change and runs its examples.",
            icon: "book-open",
            theme: "library",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              {
                role: "technical-writer",
                name: "technical writer",
                stage: "work",
                count: 1,
              },
              {
                role: "docs-reviewer",
                name: "docs reviewer",
                stage: "review",
                count: 1,
              },
              {
                role: "example-checker",
                name: "example checker",
                stage: "qa",
                count: 1,
              },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "infrastructure",
            name: "Infrastructure",
            description:
              "A platform team that changes the Terraform in the repository, reviews each change for security and checks its plan and policies, without ever applying it.",
            icon: "server",
            theme: "data-centre",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              {
                role: "platform-engineer",
                name: "platform engineer",
                stage: "work",
                count: 1,
              },
              {
                role: "security-reviewer",
                name: "security reviewer",
                stage: "review",
                count: 1,
              },
              { role: "plan-qa", name: "plan QA", stage: "qa", count: 1 },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "mobile-app",
            name: "Mobile app",
            description:
              "A mobile team that changes the app's screens and code in its repository, reviews each pull request and tests it on simulators.",
            icon: "smartphone",
            theme: "device-lab",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              {
                role: "mobile-developer",
                name: "mobile developer",
                stage: "work",
                count: 1,
              },
              { role: "reviewer", name: "reviewer", stage: "review", count: 1 },
              {
                role: "device-test-qa",
                name: "device-test QA",
                stage: "qa",
                count: 1,
              },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "online-store",
            name: "Online store",
            description:
              "A store team that changes the product data, copy and theme in the store's repository, reviews each change for the brand and checks it.",
            icon: "shopping-bag",
            theme: "stockroom",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              {
                role: "merchandiser",
                name: "merchandiser",
                stage: "work",
                count: 1,
              },
              {
                role: "copywriter",
                name: "copywriter",
                stage: "work",
                count: 1,
              },
              {
                role: "storefront-developer",
                name: "storefront developer",
                stage: "work",
                count: 1,
              },
              {
                role: "brand-reviewer",
                name: "brand reviewer",
                stage: "review",
                count: 1,
              },
              { role: "store-qa", name: "store QA", stage: "qa", count: 1 },
            ],
            builtIn: true,
            enabled: true,
          },
          {
            id: "website-and-marketing",
            name: "Website & marketing",
            description:
              "A web team that changes the website's pages, copy and search listings in its repository, and reviews each change for visitors who should act on it.",
            icon: "megaphone",
            theme: "studio",
            team: [
              { role: "manager", name: "Manager", stage: null, count: 1 },
              {
                role: "web-developer",
                name: "web developer",
                stage: "work",
                count: 1,
              },
              {
                role: "copywriter",
                name: "copywriter",
                stage: "work",
                count: 1,
              },
              {
                role: "seo-specialist",
                name: "SEO specialist",
                stage: "work",
                count: 1,
              },
              {
                role: "conversion-reviewer",
                name: "conversion reviewer",
                stage: "review",
                count: 1,
              },
            ],
            builtIn: true,
            enabled: true,
          },
        ],
      });
      // Signed out, it is refused like every other route.
      const signedOut = await office.server.inject({
        method: "GET",
        url: "/api/floor-templates",
      });
      expect(signedOut.statusCode).toBe(401);
    },
  ],
  [
    "adds a Floor from the template chosen, and from Development when none is",
    async (setup) => {
      const office = await setup.start();
      const blank = await office.request("POST", "/api/floors", {
        repository: "adrianeyre/blog",
        template: "blank",
      });
      expect(blank.statusCode).toBe(201);
      expect(floorSchema.parse(blank.json())).toMatchObject({
        id: "blog",
        template: { id: "blank", name: "Blank" },
        theme: "office",
        requiredReviewerAgentIds: [],
      });
      expect((await agentsOf(office, "blog")).map(({ role }) => role)).toEqual([
        "manager",
      ]);

      const unchosen = await office.request("POST", "/api/floors", {
        repository: "adrianeyre/web-shop",
      });
      expect(unchosen.statusCode).toBe(201);
      const webShop = floorSchema.parse(unchosen.json());
      expect(webShop.template).toEqual({
        id: "development",
        name: "Development",
      });
      expect(webShop.theme).toBe("office");
      const team = await agentsOf(office, "web-shop");
      expect(team.map(({ role }) => role)).toEqual([
        "manager",
        "coder",
        "reviewer",
        "qa",
      ]);
      expect(webShop.requiredReviewerAgentIds).toEqual([team[2]?.id]);

      // Each Floor shows the template it started from.
      const list = await office.request("GET", "/api/floors");
      expect(
        floorListSchema
          .parse(list.json())
          .floors.map(({ id, template }) => [id, template.name]),
      ).toEqual([
        ["blog", "Blank"],
        ["web-shop", "Development"],
      ]);
    },
  ],
  [
    "refuses a template there is not, and a malformed one",
    async (setup) => {
      const office = await setup.start();
      const unknown = await office.request("POST", "/api/floors", {
        repository: "adrianeyre/blog",
        template: "garden-centre",
      });
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json()).toEqual({
        error: "template_not_found",
        message: 'There is no Floor Template "garden-centre".',
      });
      const malformed = await office.request("POST", "/api/floors", {
        repository: "adrianeyre/blog",
        template: "Garden centre",
      });
      expect(malformed.statusCode).toBe(400);
      const list = await office.request("GET", "/api/floors");
      expect(floorListSchema.parse(list.json()).floors).toEqual([]);
    },
  ],
  [
    "a Floor keeps working once its template has gone",
    async (setup) => {
      const before = await setup.start(setup.withCornerShop);
      const added = await before.request("POST", "/api/floors", {
        repository: "adrianeyre/corner-shop",
        template: "corner-shop",
      });
      expect(added.statusCode).toBe(201);
      const floor = floorSchema.parse(added.json());
      // Its 3D theme is the Floor's own, so it stays when the template goes.
      expect(floor.theme).toBe("stockroom");
      const team = await agentsOf(before, floor.id);
      // While Corner shop is a template, its merchandiser stays in the
      // library.
      const roles = roleListSchema.parse(
        (await before.request("GET", "/api/roles")).json(),
      ).roles;
      expect(
        roles.find(({ id }) => id === "merchandiser")?.inStartingTeam,
      ).toBe(true);
      await before.server.close();

      // AI Office starts again without Corner shop. (Development and Blank
      // only: Online store, built in, starts Floors with a merchandiser too.)
      const after = await setup.start(
        setup.withCornerShop.filter(({ id }) => id !== "corner-shop"),
      );
      const templates = floorTemplateListSchema.parse(
        (await after.request("GET", "/api/floor-templates")).json(),
      ).templates;
      expect(templates.map(({ id }) => id)).toEqual(["development", "blank"]);
      const read = await after.request("GET", `/api/floors/${floor.id}`);
      expect(floorSchema.parse(read.json())).toEqual(floor);
      expect(await agentsOf(after, floor.id)).toEqual(team);

      // Its settings, its team and its Roles are still the Owner's to change.
      const patched = await after.request("PATCH", `/api/floors/${floor.id}`, {
        testCommand: "pnpm test",
        roundCap: 4,
      });
      expect(patched.statusCode).toBe(200);
      expect(floorSchema.parse(patched.json())).toMatchObject({
        testCommand: "pnpm test",
        roundCap: 4,
        mergePolicy: "auto_merge",
        template: { id: "corner-shop", name: "Corner shop" },
      });
      const added2 = await after.request(
        "POST",
        `/api/floors/${floor.id}/agents`,
        { role: "copywriter" },
      );
      expect(added2.statusCode).toBe(201);
      const library = roleListSchema.parse(
        (await after.request("GET", "/api/roles")).json(),
      ).roles;
      expect(library.find(({ id }) => id === "merchandiser")).toMatchObject({
        agents: 2,
        inStartingTeam: false,
      });
      const edited = await after.request("PATCH", "/api/roles/merchandiser", {
        instructions: "- Keep every price in euros.",
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ agents: 2 });
    },
  ],
];

describe("Floor Templates through the API", () => {
  let folder: TemplateFolder;
  let withCornerShop: readonly FloorTemplate[];
  beforeEach(async () => {
    folder = await templateFolder({ only: cornerShopNeighbours });
    await folder.write(cornerShopFiles);
    withCornerShop = await loadFloorTemplates(folder.root);
  });
  afterEach(() => folder.remove());

  describe("in memory", () => {
    for (const [name, run] of cases) {
      it(name, () =>
        run(
          setUp(
            memoryStores(),
            createEventBus({ store: memoryEventStore() }),
            withCornerShop,
          ),
        ),
      );
    }
  });

  describe("in Postgres 18", () => {
    for (const [name, run] of cases) {
      postgresTest(name, ({ database }) =>
        run(
          setUp(
            databaseStores(database.db),
            createEventBus({ store: databaseEventStore(database.db) }),
            withCornerShop,
          ),
        ),
      );
    }
  });
});
