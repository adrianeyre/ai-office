import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  grillingSkillDescription,
  databaseStores,
  memoryStores,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  floorSkillDetailSchema,
  floorSkillListSchema,
  mattPocockSkillNames,
  repositorySkillDetailSchema,
  skillErrorCodes,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// A Floor's Skills API (PRD FR-72, FR-75): the office library's enabled
// Skills and the Floor repository's own, the repository's overriding the
// office's of the same name, each turned on or off per Role, once the
// Owner has read and reviewed it (P1-10). Each case runs in memory and in
// Postgres 18.

const skillMd = (name: string, description = `What ${name} does.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly fake: FakeGitHub;
  readonly bus: EventBus;
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const fake = createFakeGitHub();
  fake.installRepository("adrianeyre/web-shop");
  fake.pushCommit("adrianeyre/web-shop", "main", {
    files: {
      ".claude/skills/pdf/SKILL.md": skillMd("pdf", "The repository's pdf."),
      ".claude/skills/pdf/scripts/extract.py": "print('text')\n",
      ".claude/skills/pdf/REFERENCE.md": "# Reference\n",
    },
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github: fake,
  });
  const owner = await signIn(server);
  const added = await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  expect(added.statusCode).toBe(201);
  for (const name of ["pdf", "release-notes"]) {
    const skill = await server.inject({
      method: "POST",
      url: "/api/skills",
      headers: owner.headers,
      payload: {
        source: "editor",
        files: [
          { path: "SKILL.md", content: skillMd(name, `The office's ${name}.`) },
        ],
      },
    });
    expect(skill.statusCode).toBe(201);
  }
  return { server, owner, fake, bus };
}

const request = (
  { server, owner }: Setup,
  method: "GET" | "PUT" | "POST",
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

const pdfFolder = ".claude/skills/pdf";

/** The Owner reads the repository's pdf Skill and reviews what they read. */
const reviewPdf = async (setup: Setup) => {
  const read = repositorySkillDetailSchema.parse(
    (
      await request(
        setup,
        "GET",
        `/api/floors/web-shop/repository-skills?folder=${encodeURIComponent(pdfFolder)}`,
      )
    ).json(),
  );
  const reviewed = await request(
    setup,
    "POST",
    "/api/floors/web-shop/repository-skills/review",
    { folder: pdfFolder, digest: read.digest },
  );
  expect(reviewed.statusCode).toBe(200);
};

const cases: Case[] = [
  [
    "keeps a repository Skill waiting until the Owner reviews exactly the files they read, the office's in its place meanwhile (P1-10)",
    async (setup) => {
      const listed = async () =>
        floorSkillListSchema.parse(
          (await request(setup, "GET", "/api/floors/web-shop/skills")).json(),
        );
      const before = await listed();
      expect(before.skills.find(({ name }) => name === "pdf")?.source).toBe(
        "office",
      );
      expect(before.awaitingReview).toEqual([
        expect.objectContaining({
          name: "pdf",
          folder: pdfFolder,
          overridesOffice: true,
          changed: false,
        }),
      ]);

      const read = await request(
        setup,
        "GET",
        `/api/floors/web-shop/repository-skills?folder=${encodeURIComponent(pdfFolder)}`,
      );
      expect(read.statusCode).toBe(200);
      const skill = repositorySkillDetailSchema.parse(read.json());
      expect(skill.digest).toBe(before.awaitingReview[0]?.digest);
      expect(skill.files.map(({ path }) => path)).toEqual([
        "SKILL.md",
        "REFERENCE.md",
        "scripts/extract.py",
      ]);
      // Another folder, or contents other than those there now, refused.
      expect(
        (
          await request(
            setup,
            "GET",
            "/api/floors/web-shop/repository-skills?folder=.claude%2Fskills%2Fnone",
          )
        ).statusCode,
      ).toBe(404);
      const stale = await request(
        setup,
        "POST",
        "/api/floors/web-shop/repository-skills/review",
        { folder: pdfFolder, digest: "0".repeat(64) },
      );
      expect(stale.statusCode).toBe(409);
      expect(apiErrorSchema.parse(stale.json()).error).toBe(
        skillErrorCodes.skillChanged,
      );
      expect(
        (
          await request(
            setup,
            "POST",
            "/api/floors/web-shop/repository-skills/review",
            { folder: "../etc", digest: skill.digest },
          )
        ).statusCode,
      ).toBe(400);
      expect((await listed()).awaitingReview).toHaveLength(1);

      const reviewed = await request(
        setup,
        "POST",
        "/api/floors/web-shop/repository-skills/review",
        { folder: pdfFolder, digest: skill.digest },
      );
      expect(reviewed.statusCode).toBe(200);
      const after = await listed();
      expect(after.awaitingReview).toEqual([]);
      expect(after.skills.find(({ name }) => name === "pdf")).toMatchObject({
        source: "repository",
        overridesOffice: true,
      });
    },
  ],
  [
    "lists the Floor's Skills, the repository's overriding the office's, each on for every Role",
    async (setup) => {
      await reviewPdf(setup);
      const response = await request(
        setup,
        "GET",
        "/api/floors/web-shop/skills",
      );
      expect(response.statusCode).toBe(200);
      const list = floorSkillListSchema.parse(response.json());
      expect(list.repositoryError).toBeNull();
      // AI Office's own adapted from Matt Pocock's skills, on every Floor
      // (FR-83b).
      expect(
        list.skills.flatMap(({ name, source }) =>
          source === "built-in" && name !== "grilling" ? [name] : [],
        ),
      ).toEqual([...mattPocockSkillNames].sort());
      expect(
        list.skills
          .filter(
            ({ name, source }) => source !== "built-in" || name === "grilling",
          )
          .map(({ name, source, overridesOffice, description }) => ({
            name,
            source,
            overridesOffice,
            description,
          })),
      ).toEqual([
        // AI Office's own, on every Floor (FR-77).
        {
          name: "grilling",
          source: "built-in",
          overridesOffice: false,
          description: grillingSkillDescription,
        },
        {
          name: "pdf",
          source: "repository",
          overridesOffice: true,
          description: "The repository's pdf.",
        },
        {
          name: "release-notes",
          source: "office",
          overridesOffice: false,
          description: "The office's release-notes.",
        },
      ]);
      // Each on for every Role; a built-in Skill is in no sandbox.
      for (const { source, roles } of list.skills) {
        expect(
          Object.values(roles).every((on) => on === (source !== "built-in")),
        ).toBe(true);
      }
    },
  ],
  [
    "gives one Skill in full, SKILL.md first, as it applies on the Floor",
    async (setup) => {
      await reviewPdf(setup);
      const response = await request(
        setup,
        "GET",
        "/api/floors/web-shop/skills/pdf",
      );
      expect(response.statusCode).toBe(200);
      const pdf = floorSkillDetailSchema.parse(response.json());
      expect(pdf).toMatchObject({
        name: "pdf",
        description: "The repository's pdf.",
        source: "repository",
        folder: ".claude/skills/pdf",
        overridesOffice: true,
      });
      expect(pdf.files.map(({ path }) => path)).toEqual([
        "SKILL.md",
        "REFERENCE.md",
        "scripts/extract.py",
      ]);
      expect(pdf.files[2]?.content).toBe("print('text')\n");
      const notes = floorSkillDetailSchema.parse(
        (
          await request(
            setup,
            "GET",
            "/api/floors/web-shop/skills/release-notes",
          )
        ).json(),
      );
      expect(notes).toMatchObject({
        source: "office",
        folder: null,
        files: [
          {
            path: "SKILL.md",
            content: skillMd("release-notes", "The office's release-notes."),
          },
        ],
      });
    },
  ],
  [
    "answers 404 for a Skill the Floor does not have, and for an unknown Floor",
    async (setup) => {
      const missing = await request(
        setup,
        "GET",
        "/api/floors/web-shop/skills/nothing-here",
      );
      expect(missing.statusCode).toBe(404);
      expect(apiErrorSchema.parse(missing.json()).error).toBe(
        skillErrorCodes.skillNotFound,
      );
      const floor = await request(
        setup,
        "GET",
        "/api/floors/elsewhere/skills/pdf",
      );
      expect(floor.statusCode).toBe(404);
      expect(apiErrorSchema.parse(floor.json()).error).toBe("floor_not_found");
    },
  ],
  [
    "turns a Skill off for one Role, recorded as a configuration change",
    async (setup) => {
      const response = await request(
        setup,
        "PUT",
        "/api/floors/web-shop/skills/release-notes/roles/qa",
        { enabled: false },
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        name: "release-notes",
        role: "qa",
        enabled: false,
      });
      const list = floorSkillListSchema.parse(
        (await request(setup, "GET", "/api/floors/web-shop/skills")).json(),
      );
      expect(
        list.skills.find(({ name }) => name === "release-notes")?.roles,
      ).toEqual({
        coder: true,
        qa: false,
        docs: true,
        designer: true,
      });
      const changes = (await setup.bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (event) => event.type === "config.changed" && event.scope === "floor",
        );
      expect(changes.at(-1)).toMatchObject({
        floorId: "web-shop",
        keys: ["skills.release-notes.qa"],
      });
    },
  ],
  [
    "refuses a Role without a sandbox, a bad body and an unknown Floor",
    async (setup) => {
      const reviewer = await request(
        setup,
        "PUT",
        "/api/floors/web-shop/skills/pdf/roles/reviewer",
        { enabled: false },
      );
      expect(reviewer.statusCode).toBe(422);
      expect(apiErrorSchema.parse(reviewer.json()).error).toBe(
        skillErrorCodes.notSandboxRole,
      );
      const body = await request(
        setup,
        "PUT",
        "/api/floors/web-shop/skills/pdf/roles/coder",
        { enabled: "no" },
      );
      expect(body.statusCode).toBe(400);
      const floor = await request(setup, "GET", "/api/floors/elsewhere/skills");
      expect(floor.statusCode).toBe(404);
      expect(
        (
          await request(
            setup,
            "PUT",
            "/api/floors/elsewhere/skills/pdf/roles/coder",
            {
              enabled: false,
            },
          )
        ).statusCode,
      ).toBe(404);
    },
  ],
];

describe("the Floor Skills API, in memory", () => {
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

describe("the Floor Skills API, in Postgres", () => {
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
