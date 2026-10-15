import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
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
  apiErrorSchema,
  floorSchema,
  floorTemplateBundleSchema,
  floorTemplateDetailSchema,
  floorTemplateListSchema,
  type FloorTemplate,
} from "@ai-office/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth } from "../test-support.ts";

// The Owner's own Floor Templates through the API (PRD FR-101): saving a
// Floor's set-up, exporting a template to a file and importing it back
// (disabled until reviewed), duplicating and editing, and a built-in
// template that cannot be edited in place. Each case runs with the office
// in memory, and in Postgres 18.

interface Office {
  readonly server: FastifyInstance;
  readonly bus: EventBus;
  request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse>;
}

async function start(
  stores: OfficeStores,
  bus: EventBus,
  templates: readonly FloorTemplate[],
): Promise<Office> {
  const github = createFakeGitHub();
  for (const repository of [
    "adrianeyre/web-shop",
    "adrianeyre/blog",
    "adrianeyre/corner-shop",
  ]) {
    github.installRepository(repository);
  }
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    templates,
  });
  const owner = await signIn(server);
  return {
    server,
    bus,
    request: (method, url, payload) =>
      server.inject({
        method,
        url,
        headers: owner.headers,
        ...(payload === undefined ? {} : { payload }),
      }),
  };
}

const errorOf = (response: LightMyRequestResponse) =>
  apiErrorSchema.parse(response.json());

const detailOf = (response: LightMyRequestResponse) =>
  floorTemplateDetailSchema.parse(response.json());

const rolesOf = async (office: Office, floorId: string) => {
  const response = await office.request("GET", `/api/floors/${floorId}/agents`);
  expect(response.statusCode).toBe(200);
  return agentListSchema.parse(response.json()).agents.map(({ role }) => role);
};

const templateEventsOf = async (office: Office) =>
  (await office.bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter(({ type }) => type.startsWith("floor_template."))
    .map((event) => [
      event.type,
      "templateId" in event ? event.templateId : "",
      "enabled" in event
        ? event.enabled
        : "change" in event
          ? event.change
          : "",
    ]);

type Case = [name: string, run: (office: Office) => Promise<void>];

const cases: Case[] = [
  [
    "saves a Floor as a template, exports it to a file and imports it back, disabled until it is reviewed",
    async (office) => {
      const floor = floorSchema.parse(
        (
          await office.request("POST", "/api/floors", {
            repository: "adrianeyre/corner-shop",
            template: "corner-shop",
          })
        ).json(),
      );
      const saved = await office.request("POST", "/api/floor-templates", {
        floorId: floor.id,
        name: "My shop",
        description: "My shop's team, as it works.",
      });
      expect(saved.statusCode).toBe(201);
      const template = detailOf(saved);
      expect(template).toMatchObject({
        id: "my-shop",
        name: "My shop",
        builtIn: false,
        enabled: true,
        source: "floor",
        theme: "stockroom",
        clashes: [],
        team: [
          { role: "manager", name: "Manager", stage: null, count: 1 },
          {
            role: "merchandiser",
            name: "merchandiser",
            stage: "work",
            count: 2,
          },
          {
            role: "brand-reviewer",
            name: "brand reviewer",
            stage: "review",
            count: 1,
          },
        ],
      });

      // Exported as a file, with its Roles and Skills…
      const exported = await office.request(
        "GET",
        "/api/floor-templates/my-shop/export",
      );
      expect(exported.statusCode).toBe(200);
      expect(exported.headers["content-disposition"]).toBe(
        'attachment; filename="my-shop.floor-template.json"',
      );
      const bundle = floorTemplateBundleSchema.parse(exported.json());
      expect(bundle.files.map(({ path }) => path)).toEqual([
        "template.yaml",
        "roles/merchandiser.md",
        "roles/brand-reviewer.md",
        "skills/price-check/SKILL.md",
      ]);

      // …deleted here, then imported back: its full contents, for review.
      expect(
        (await office.request("DELETE", "/api/floor-templates/my-shop"))
          .statusCode,
      ).toBe(204);
      const imported = await office.request(
        "POST",
        "/api/floor-templates/import",
        { bundle },
      );
      expect(imported.statusCode).toBe(201);
      const waiting = detailOf(imported);
      expect(waiting).toMatchObject({
        id: "my-shop",
        source: "file",
        enabled: false,
        reviewedAt: null,
        digest: template.digest,
      });
      expect(waiting.roles).toEqual(template.roles);
      expect(waiting.roles[0]?.role.instructions).toBe(
        "- Keep every price in pence.",
      );
      expect(waiting.skills).toEqual(template.skills);
      expect(waiting.skills[0]?.files[0]?.content).toContain("# Price check");
      expect(waiting.settings).toEqual(template.settings);
      expect(waiting.manager).toEqual(template.manager);
      expect(waiting.labels).toEqual(template.labels);
      const list = floorTemplateListSchema.parse(
        (await office.request("GET", "/api/floor-templates")).json(),
      );
      expect(
        list.templates.map(({ id, builtIn, enabled }) => [
          id,
          builtIn,
          enabled,
        ]),
      ).toEqual([
        ["development", true, true],
        ["blank", true, true],
        ["corner-shop", true, true],
        ["my-shop", false, false],
      ]);

      // No Floor from it until it is reviewed, naming what was read.
      const notYet = await office.request("POST", "/api/floors", {
        repository: "adrianeyre/blog",
        template: "my-shop",
      });
      expect(notYet.statusCode).toBe(422);
      expect(errorOf(notYet).error).toBe("template_not_found");
      const stale = await office.request(
        "POST",
        "/api/floor-templates/my-shop/review",
        { digest: "0".repeat(64) },
      );
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).error).toBe("template_changed");
      const reviewed = await office.request(
        "POST",
        "/api/floor-templates/my-shop/review",
        { digest: waiting.digest },
      );
      expect(reviewed.statusCode).toBe(200);
      expect(detailOf(reviewed).enabled).toBe(true);

      const added = await office.request("POST", "/api/floors", {
        repository: "adrianeyre/blog",
        template: "my-shop",
      });
      expect(added.statusCode).toBe(201);
      const blog = floorSchema.parse(added.json());
      expect(blog.template).toEqual({ id: "my-shop", name: "My shop" });
      expect(await rolesOf(office, blog.id)).toEqual([
        "manager",
        "merchandiser",
        "merchandiser",
        "brand-reviewer",
      ]);

      // Every add, change and removal is in the Activity Feed.
      expect(await templateEventsOf(office)).toEqual([
        ["floor_template.added", "my-shop", true],
        ["floor_template.removed", "my-shop", ""],
        ["floor_template.added", "my-shop", false],
        ["floor_template.changed", "my-shop", "reviewed"],
      ]);
    },
  ],
  [
    "a built-in template cannot be edited in place; a duplicate of it can",
    async (office) => {
      const development = detailOf(
        await office.request("GET", "/api/floor-templates/development"),
      );
      expect(development).toMatchObject({
        builtIn: true,
        enabled: true,
        source: "built-in",
        createdAt: null,
      });
      expect(development.roles.map(({ role }) => role.id)).toEqual([
        "coder",
        "reviewer",
        "qa",
      ]);
      for (const [method, url, payload] of [
        [
          "PATCH",
          "/api/floor-templates/development",
          { roles: [{ role: "coder", count: 2 }] },
        ],
        [
          "PATCH",
          "/api/floor-templates/development",
          { description: "Ours now." },
        ],
        ["DELETE", "/api/floor-templates/development", undefined],
        [
          "POST",
          "/api/floor-templates/development/review",
          { digest: development.digest },
        ],
      ] as const) {
        const response = await office.request(method, url, payload);
        expect(response.statusCode).toBe(409);
        expect(errorOf(response)).toEqual({
          error: "template_built_in",
          message:
            "Development is a built-in Floor Template, so it is read-only: duplicate it, then change the copy.",
        });
      }
      expect(
        detailOf(
          await office.request("GET", "/api/floor-templates/development"),
        ),
      ).toEqual(development);

      const copied = await office.request(
        "POST",
        "/api/floor-templates/development/duplicate",
        {},
      );
      expect(copied.statusCode).toBe(201);
      const copy = detailOf(copied);
      expect(copy).toMatchObject({
        id: "development-copy",
        name: "Development copy",
        builtIn: false,
        enabled: true,
        source: "duplicate",
      });
      const edited = await office.request(
        "PATCH",
        "/api/floor-templates/development-copy",
        {
          roles: [
            { role: "coder", count: 2 },
            { role: "reviewer", count: 1 },
          ],
          settings: { ...copy.settings, roundCap: 4 },
          manager: {
            planningGuidance: "Plan small pull requests.",
            firstIssue: null,
          },
          labels: [{ name: "chore", color: "cccccc", description: "Upkeep" }],
          theme: "studio",
        },
      );
      expect(edited.statusCode).toBe(200);
      expect(detailOf(edited)).toMatchObject({
        theme: "studio",
        settings: { roundCap: 4 },
        team: [
          { role: "manager", count: 1 },
          { role: "coder", count: 2 },
          { role: "reviewer", count: 1 },
        ],
      });
      // One that does not hold together is refused, naming why.
      const invalid = await office.request(
        "PATCH",
        "/api/floor-templates/development-copy",
        { roles: [{ role: "coder", count: 1 }] },
      );
      expect(invalid.statusCode).toBe(422);
      expect(errorOf(invalid)).toEqual({
        error: "invalid_template",
        message: "That is not a valid Floor Template.",
        problems: [
          'template.yaml: settings.requiredReviewers.0: "reviewer" is a required reviewer, so the template starts at least one Agent in it.',
        ],
      });
      const taken = await office.request(
        "PATCH",
        "/api/floor-templates/development-copy",
        { name: "blank" },
      );
      expect(taken.statusCode).toBe(409);
      expect(errorOf(taken).error).toBe("template_name_taken");

      const floor = floorSchema.parse(
        (
          await office.request("POST", "/api/floors", {
            repository: "adrianeyre/web-shop",
            template: "development-copy",
          })
        ).json(),
      );
      expect(floor).toMatchObject({ roundCap: 4, theme: "studio" });
      expect(await rolesOf(office, floor.id)).toEqual([
        "manager",
        "coder",
        "coder",
        "reviewer",
      ]);
      expect(await templateEventsOf(office)).toEqual([
        ["floor_template.added", "development-copy", true],
        ["floor_template.changed", "development-copy", "edited"],
      ]);
    },
  ],
  [
    "refuses what it cannot do: an unknown template, a clashing name, a malformed file, and anyone signed out",
    async (office) => {
      const unknown = await office.request(
        "GET",
        "/api/floor-templates/garden-centre",
      );
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).error).toBe("template_not_found");
      const noFloor = await office.request("POST", "/api/floor-templates", {
        floorId: "nowhere",
        name: "Nowhere",
        description: "A Floor there is not.",
      });
      expect(noFloor.statusCode).toBe(404);
      expect(errorOf(noFloor).error).toBe("floor_not_found");

      const bundle = floorTemplateBundleSchema.parse(
        (
          await office.request("GET", "/api/floor-templates/blank/export")
        ).json(),
      );
      const clash = await office.request(
        "POST",
        "/api/floor-templates/import",
        { bundle },
      );
      expect(clash.statusCode).toBe(409);
      expect(errorOf(clash)).toEqual({
        error: "template_name_taken",
        message:
          'Another Floor Template is called "Blank": give this one another name.',
      });
      const renamed = await office.request(
        "POST",
        "/api/floor-templates/import",
        { bundle, name: "Empty" },
      );
      expect(renamed.statusCode).toBe(201);
      expect(detailOf(renamed)).toMatchObject({
        id: "blank-2",
        name: "Empty",
        enabled: false,
      });

      const broken = await office.request(
        "POST",
        "/api/floor-templates/import",
        {
          bundle: {
            ...bundle,
            files: [...bundle.files, { path: "notes.txt", content: "Hi" }],
          },
          name: "Broken",
        },
      );
      expect(broken.statusCode).toBe(422);
      expect(errorOf(broken).problems).toEqual([
        "notes.txt: Not part of a Floor Template: a template holds template.yaml, roles/<role>.md and skills/<skill>/SKILL.md.",
      ]);
      const notAFile = await office.request(
        "POST",
        "/api/floor-templates/import",
        { bundle: { format: "ai-office.configuration" } },
      );
      expect(notAFile.statusCode).toBe(400);
      const notHttps = await office.request(
        "POST",
        "/api/floor-templates/import/git",
        { url: "http://example.com/templates.git" },
      );
      expect(notHttps.statusCode).toBe(400);

      for (const [method, url] of [
        ["GET", "/api/floor-templates"],
        ["GET", "/api/floor-templates/blank"],
        ["GET", "/api/floor-templates/blank/export"],
        ["POST", "/api/floor-templates/blank/duplicate"],
        ["POST", "/api/floor-templates/import"],
        ["PATCH", "/api/floor-templates/blank-2"],
        ["DELETE", "/api/floor-templates/blank-2"],
      ] as const) {
        const response = await office.server.inject({ method, url });
        expect(response.statusCode).toBe(401);
      }
    },
  ],
];

describe("the Owner's own Floor Templates through the API", () => {
  let folder: TemplateFolder;
  let templates: readonly FloorTemplate[];
  beforeEach(async () => {
    folder = await templateFolder({ only: cornerShopNeighbours });
    await folder.write(cornerShopFiles);
    templates = await loadFloorTemplates(folder.root);
  });
  afterEach(() => folder.remove());

  describe("in memory", () => {
    for (const [name, run] of cases) {
      it(name, async () => {
        const office = await start(
          memoryStores(),
          createEventBus({ store: memoryEventStore() }),
          templates,
        );
        try {
          await run(office);
        } finally {
          await office.server.close();
        }
      });
    }
  });

  describe("in Postgres 18", () => {
    for (const [name, run] of cases) {
      postgresTest(name, async ({ database }) => {
        const office = await start(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
          templates,
        );
        try {
          await run(office);
        } finally {
          await office.server.close();
        }
      });
    }
  });
});
