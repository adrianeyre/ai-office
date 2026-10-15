import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createSkillLibrary,
  databaseSkillStore,
  memorySkillStore,
  SkillError,
  type FetchedSkill,
  type SkillStore,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  skillErrorCodes,
  skillListSchema,
  skillSchema,
  type ImportSkillRequest,
  type SkillFile,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// The office Skill library API (PRD FR-71, FR-72, FR-76): adding Skills by
// upload, by import from Git and in the editor; an imported Skill
// disabled until the Owner reviews its full contents; every add, change
// and removal an event. Each case runs in memory and in Postgres 18.

const skillMd = (name: string, description = `What ${name} does.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps.\n`;

const pdfFiles: SkillFile[] = [
  { path: "SKILL.md", content: skillMd("pdf-processing") },
  { path: "scripts/extract.py", content: "print('text')\n" },
];

const repositoryUrl = "https://github.com/example-org/skills";

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly bus: EventBus;
  /** What the fake repository was asked for. */
  readonly imports: ImportSkillRequest[];
}

/** A repository holding `pdf-processing`, and `release-notes` beside it. */
const fakeRepository =
  (imports: ImportSkillRequest[]) =>
  (request: ImportSkillRequest): Promise<FetchedSkill> => {
    imports.push(request);
    if (request.path === undefined) {
      return Promise.reject(
        new SkillError(
          skillErrorCodes.skillPathRequired,
          "The repository holds several Skills: name the folder of the one to import.",
          ["skills/pdf-processing", "skills/release-notes"],
        ),
      );
    }
    return Promise.resolve({
      files: pdfFiles,
      folder: "pdf-processing",
      commit: "0123456789abcdef0123456789abcdef01234567",
      path: request.path,
    });
  };

async function setUp(store: SkillStore, bus: EventBus): Promise<Setup> {
  const imports: ImportSkillRequest[] = [];
  let tick = 0;
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    skills: createSkillLibrary({
      store,
      events: bus,
      repository: fakeRepository(imports),
      now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
    }),
  });
  return { server, owner: await signIn(server), bus, imports };
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

const created = async (
  setup: Setup,
  url: string,
  body: object,
): Promise<ReturnType<typeof skillSchema.parse>> => {
  const response = await request(setup, "POST", url, body);
  expect(response.statusCode, response.body).toBe(201);
  return skillSchema.parse(response.json());
};

const skillEvents = async (bus: EventBus) =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type.startsWith("skill."));

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "imports a Skill from Git, disabled until its full contents are reviewed",
    async (setup) => {
      const imported = await created(setup, "/api/skills/import", {
        url: repositoryUrl,
        ref: "main",
        path: "skills/pdf-processing/",
      });
      expect(setup.imports).toEqual([
        { url: repositoryUrl, ref: "main", path: "skills/pdf-processing" },
      ]);
      expect(imported).toMatchObject({
        name: "pdf-processing",
        description: "What pdf-processing does.",
        source: "git",
        origin: {
          url: repositoryUrl,
          ref: "main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          path: "skills/pdf-processing",
        },
        enabled: false,
        reviewedAt: null,
        files: pdfFiles,
      });

      // The list gives each file's size; the Skill itself, every byte.
      const listed = await request(setup, "GET", "/api/skills");
      expect(skillListSchema.parse(listed.json()).skills).toEqual([
        {
          ...imported,
          files: [
            {
              path: "SKILL.md",
              bytes: Buffer.byteLength(skillMd("pdf-processing")),
            },
            { path: "scripts/extract.py", bytes: 14 },
          ],
        },
      ]);
      const read = await request(setup, "GET", `/api/skills/${imported.id}`);
      expect(skillSchema.parse(read.json())).toEqual(imported);

      const enable = await request(
        setup,
        "PATCH",
        `/api/skills/${imported.id}`,
        { enabled: true },
      );
      expect(enable.statusCode).toBe(409);
      expect(apiErrorSchema.parse(enable.json()).error).toBe(
        skillErrorCodes.skillNotReviewed,
      );

      const reviewed = await request(
        setup,
        "POST",
        `/api/skills/${imported.id}/review`,
        { digest: imported.digest },
      );
      expect(reviewed.statusCode).toBe(200);
      expect(skillSchema.parse(reviewed.json())).toMatchObject({
        enabled: true,
        reviewedAt: "2026-10-09T12:00:01.000Z",
      });

      expect(await skillEvents(setup.bus)).toEqual([
        {
          type: "skill.added",
          version: 1,
          skillId: imported.id,
          name: "pdf-processing",
          source: "git",
          enabled: false,
        },
        {
          type: "skill.changed",
          version: 1,
          skillId: imported.id,
          name: "pdf-processing",
          change: "reviewed",
        },
      ]);
    },
  ],
  [
    "refuses a review of contents that have changed since",
    async (setup) => {
      const uploaded = await created(setup, "/api/skills", {
        source: "upload",
        files: pdfFiles,
        folder: "pdf-processing",
      });
      expect(uploaded).toMatchObject({ enabled: false, reviewedAt: null });
      const edited = await request(
        setup,
        "PATCH",
        `/api/skills/${uploaded.id}`,
        { files: [pdfFiles[0], { path: "scripts/extract.py", content: "x" }] },
      );
      expect(edited.statusCode).toBe(200);
      const stale = await request(
        setup,
        "POST",
        `/api/skills/${uploaded.id}/review`,
        { digest: uploaded.digest },
      );
      expect(stale.statusCode).toBe(409);
      expect(apiErrorSchema.parse(stale.json())).toEqual({
        error: skillErrorCodes.skillChanged,
        message:
          "The Skill changed after the contents you reviewed. Review it again.",
      });
      const read = await request(setup, "GET", `/api/skills/${uploaded.id}`);
      expect(skillSchema.parse(read.json()).enabled).toBe(false);
    },
  ],
  [
    "writes a Skill in the editor, edits it, turns it off and removes it",
    async (setup) => {
      const written = await created(setup, "/api/skills", {
        source: "editor",
        files: [{ path: "SKILL.md", content: skillMd("release-notes") }],
      });
      expect(written).toMatchObject({
        source: "editor",
        origin: null,
        enabled: true,
        reviewedAt: "2026-10-09T12:00:00.000Z",
      });
      const edited = await request(
        setup,
        "PATCH",
        `/api/skills/${written.id}`,
        {
          files: [
            { path: "SKILL.md", content: skillMd("release-notes", "Notes.") },
            { path: "template.md", content: "## Changes\n" },
          ],
        },
      );
      expect(skillSchema.parse(edited.json())).toMatchObject({
        description: "Notes.",
        files: [{ path: "SKILL.md" }, { path: "template.md" }],
      });
      const off = await request(setup, "PATCH", `/api/skills/${written.id}`, {
        enabled: false,
      });
      expect(skillSchema.parse(off.json()).enabled).toBe(false);

      const removed = await request(
        setup,
        "DELETE",
        `/api/skills/${written.id}`,
      );
      expect(removed.statusCode).toBe(204);
      const gone = await request(setup, "GET", `/api/skills/${written.id}`);
      expect(gone.statusCode).toBe(404);
      expect(apiErrorSchema.parse(gone.json()).error).toBe(
        skillErrorCodes.skillNotFound,
      );
      expect(
        (await skillEvents(setup.bus)).map((event) =>
          event.type === "skill.changed" ? event.change : event.type,
        ),
      ).toEqual(["skill.added", "edited", "disabled", "skill.removed"]);
    },
  ],
  [
    "says what is wrong with a Skill, and refuses a second of one name",
    async (setup) => {
      const invalid = await request(setup, "POST", "/api/skills", {
        source: "editor",
        files: [{ path: "SKILL.md", content: "---\nname: Bad Name\n---\n" }],
      });
      expect(invalid.statusCode).toBe(400);
      expect(apiErrorSchema.parse(invalid.json())).toEqual({
        error: "invalid_request",
        problems: [
          "A Skill's name uses only lowercase letters, digits and single hyphens, and does not start or end with a hyphen.",
          "The frontmatter needs a description.",
        ],
      });
      const noSkillMd = await request(setup, "POST", "/api/skills", {
        source: "upload",
        files: [{ path: "README.md", content: "# Hi" }],
      });
      expect(apiErrorSchema.parse(noSkillMd.json()).problems).toEqual([
        "A Skill has a SKILL.md at the top of its folder.",
      ]);

      await created(setup, "/api/skills", {
        source: "upload",
        files: pdfFiles,
      });
      const again = await request(setup, "POST", "/api/skills/import", {
        url: repositoryUrl,
        path: "skills/pdf-processing",
      });
      expect(again.statusCode).toBe(409);
      expect(apiErrorSchema.parse(again.json()).error).toBe(
        skillErrorCodes.skillNameTaken,
      );
      expect(await skillEvents(setup.bus)).toHaveLength(1);
    },
  ],
  [
    "asks which Skill to import, and refuses a URL it will not clone",
    async (setup) => {
      const several = await request(setup, "POST", "/api/skills/import", {
        url: repositoryUrl,
      });
      expect(several.statusCode).toBe(422);
      expect(apiErrorSchema.parse(several.json())).toEqual({
        error: skillErrorCodes.skillPathRequired,
        message:
          "The repository holds several Skills: name the folder of the one to import.",
        problems: ["skills/pdf-processing", "skills/release-notes"],
      });
      for (const url of [
        "http://github.com/example-org/skills",
        "file:///etc",
        "https://user:secret@github.com/example-org/skills",
      ]) {
        const refused = await request(setup, "POST", "/api/skills/import", {
          url,
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.body).not.toContain("secret");
      }
      expect(setup.imports).toHaveLength(1);
    },
  ],
  [
    "takes a Skill of up to 4 MB",
    async (setup) => {
      const large = await created(setup, "/api/skills", {
        source: "upload",
        files: [
          { path: "SKILL.md", content: skillMd("large") },
          // Escaped as JSON, this is well over Fastify's default 1 MiB.
          { path: "data.md", content: "\n\t".repeat(1_900_000) },
        ],
      });
      expect(large.files[1]?.content).toHaveLength(3_800_000);
    },
  ],
];

describe("the Skill library API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        await setUp(
          memorySkillStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the Skill library API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseSkillStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});

describe("the Skill library API's access", () => {
  it("needs a session, and the CSRF token to change anything", async () => {
    const setup = await setUp(
      memorySkillStore(),
      createEventBus({ store: memoryEventStore() }),
    );
    const anonymous = await setup.server.inject({
      method: "GET",
      url: "/api/skills",
    });
    expect(anonymous.statusCode).toBe(401);
    const withoutCsrf = await setup.server.inject({
      method: "POST",
      url: "/api/skills",
      headers: { cookie: setup.owner.cookie },
      payload: { source: "editor", files: pdfFiles },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    const list = await request(setup, "GET", "/api/skills");
    expect(skillListSchema.parse(list.json()).skills).toEqual([]);
  });
});
