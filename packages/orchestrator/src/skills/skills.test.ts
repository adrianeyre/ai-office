import { skills } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import {
  skillErrorCodes,
  type ImportSkillRequest,
  type SkillErrorCode,
  type SkillFile,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { SkillError } from "./errors.ts";
import type { FetchedSkill } from "./git.ts";
import {
  createSkillLibrary,
  skillDigest,
  type SkillLibrary,
} from "./skills.ts";
import {
  databaseSkillStore,
  memorySkillStore,
  type SkillStore,
} from "./store.ts";

// The office Skill library (PRD FR-71, FR-72, FR-76): Skills added by
// upload, from Git and in the editor; an imported Skill disabled until the
// Owner reviews its full contents; every add, change and removal an event.
// Every case runs in memory and in Postgres 18.

const skillMd = (name: string, description = `What ${name} does.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo it well.\n`;

const pdfFiles: SkillFile[] = [
  { path: "scripts/extract.py", content: "print('text')\n" },
  { path: "SKILL.md", content: skillMd("pdf-processing") },
  { path: "references/FORMS.md", content: "# Forms\n" },
];

const repositoryUrl = "https://github.com/example-org/skills";

interface Setup {
  readonly library: SkillLibrary;
  readonly store: SkillStore;
  readonly bus: EventBus;
  /** What the fake repository was asked for. */
  readonly imports: ImportSkillRequest[];
}

function setUp(
  store: SkillStore,
  bus: EventBus,
  fetched: FetchedSkill = {
    files: pdfFiles,
    folder: "pdf-processing",
    commit: "0123456789abcdef0123456789abcdef01234567",
    path: "skills/pdf-processing",
  },
): Setup {
  const imports: ImportSkillRequest[] = [];
  let tick = 0;
  let id = 0;
  return {
    library: createSkillLibrary({
      store,
      events: bus,
      repository: (request) => {
        imports.push(request);
        return Promise.resolve(fetched);
      },
      now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
      newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    }),
    store,
    bus,
    imports,
  };
}

const skillEvents = async (bus: EventBus): Promise<OfficeEvent[]> =>
  (await bus.eventsAfter(0))
    .map(({ event }) => event)
    .filter((event) => event.type.startsWith("skill."));

const refusal = async (
  promise: Promise<unknown>,
): Promise<{
  code: SkillErrorCode;
  problems: readonly string[] | undefined;
}> => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SkillError);
  const { code, problems } = error as SkillError;
  return { code, problems };
};

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "an imported Skill starts disabled, and cannot be enabled until reviewed",
    async ({ library, bus, imports }) => {
      const imported = await library.importFromGit({
        url: repositoryUrl,
        ref: "main",
        path: "skills/pdf-processing",
      });
      expect(imports).toEqual([
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
      });
      // Its full contents, SKILL.md first, for the Owner to read.
      expect(imported.files.map(({ path }) => path)).toEqual([
        "SKILL.md",
        "references/FORMS.md",
        "scripts/extract.py",
      ]);
      expect(imported.digest).toBe(skillDigest(pdfFiles));

      expect(
        await refusal(library.update(imported.id, { enabled: true })),
      ).toEqual({
        code: skillErrorCodes.skillNotReviewed,
        problems: undefined,
      });
      expect((await library.get(imported.id)).enabled).toBe(false);

      // Editing it is not reviewing it.
      const edited = await library.update(imported.id, {
        files: [
          ...pdfFiles.slice(1),
          { path: "scripts/extract.py", content: "print('edited')\n" },
        ],
      });
      expect(edited).toMatchObject({ enabled: false, reviewedAt: null });
      expect(
        (await refusal(library.update(imported.id, { enabled: true }))).code,
      ).toBe(skillErrorCodes.skillNotReviewed);

      // A review of contents read before the edit is refused.
      expect(
        (await refusal(library.review(imported.id, imported.digest))).code,
      ).toBe(skillErrorCodes.skillChanged);
      expect((await library.get(imported.id)).enabled).toBe(false);

      const reviewed = await library.review(imported.id, edited.digest);
      expect(reviewed).toMatchObject({
        enabled: true,
        reviewedAt: new Date("2026-10-09T12:00:03.000Z"),
      });

      // Once reviewed, it can be turned off and on again.
      await library.update(imported.id, { enabled: false });
      expect(
        (await library.update(imported.id, { enabled: true })).enabled,
      ).toBe(true);

      expect(await skillEvents(bus)).toEqual([
        {
          type: "skill.added",
          version: 1,
          skillId: imported.id,
          name: "pdf-processing",
          source: "git",
          enabled: false,
        },
        ...(["edited", "reviewed", "disabled", "enabled"] as const).map(
          (change) => ({
            type: "skill.changed",
            version: 1,
            skillId: imported.id,
            name: "pdf-processing",
            change,
          }),
        ),
      ]);
    },
  ],
  [
    "an uploaded Skill is imported too, and waits for review",
    async ({ library, bus }) => {
      const uploaded = await library.add({
        source: "upload",
        files: pdfFiles,
        folder: "pdf-processing",
      });
      expect(uploaded).toMatchObject({
        source: "upload",
        origin: null,
        enabled: false,
        reviewedAt: null,
      });
      expect(
        (await refusal(library.update(uploaded.id, { enabled: true }))).code,
      ).toBe(skillErrorCodes.skillNotReviewed);
      expect((await library.review(uploaded.id, uploaded.digest)).enabled).toBe(
        true,
      );
      expect((await skillEvents(bus))[0]).toEqual({
        type: "skill.added",
        version: 1,
        skillId: uploaded.id,
        name: "pdf-processing",
        source: "upload",
        enabled: false,
      });
    },
  ],
  [
    "a Skill written in the editor is the Owner's own, so starts enabled",
    async ({ library, bus }) => {
      const written = await library.add({
        source: "editor",
        files: [{ path: "SKILL.md", content: skillMd("release-notes") }],
      });
      expect(written).toMatchObject({
        name: "release-notes",
        source: "editor",
        enabled: true,
        reviewedAt: new Date("2026-10-09T12:00:00.000Z"),
      });
      expect(await skillEvents(bus)).toEqual([
        {
          type: "skill.added",
          version: 1,
          skillId: written.id,
          name: "release-notes",
          source: "editor",
          enabled: true,
        },
      ]);
    },
  ],
  [
    "refuses a Skill whose frontmatter is invalid, from any source",
    async ({ library, store }) => {
      const bad = [
        { path: "SKILL.md", content: "---\nname: Bad_Name\n---\n" },
      ] satisfies SkillFile[];
      expect(
        await refusal(library.add({ source: "editor", files: bad })),
      ).toEqual({
        code: skillErrorCodes.invalidSkill,
        problems: [
          "A Skill's name uses only lowercase letters, digits and single hyphens, and does not start or end with a hyphen.",
          "The frontmatter needs a description.",
        ],
      });
      expect(
        (
          await refusal(
            library.add({
              source: "upload",
              files: pdfFiles,
              folder: "pdf",
            }),
          )
        ).problems,
      ).toEqual([
        'The Skill is named "pdf-processing", so its folder is "pdf-processing", not "pdf".',
      ]);
      const written = await library.add({
        source: "editor",
        files: [{ path: "SKILL.md", content: skillMd("notes") }],
      });
      expect(
        (await refusal(library.update(written.id, { files: bad }))).code,
      ).toBe(skillErrorCodes.invalidSkill);
      expect(await store.list()).toHaveLength(1);
    },
  ],
  [
    "edits a Skill's files, renaming it from its frontmatter",
    async ({ library, bus }) => {
      const written = await library.add({
        source: "editor",
        files: [{ path: "SKILL.md", content: skillMd("notes") }],
      });
      // The same files again change nothing, and record nothing.
      expect(
        await library.update(written.id, { files: written.files }),
      ).toEqual(written);
      const renamed = await library.update(written.id, {
        files: [
          { path: "SKILL.md", content: skillMd("meeting-notes", "Notes.") },
          { path: "template.md", content: "## Attendees\n" },
        ],
      });
      expect(renamed).toMatchObject({
        name: "meeting-notes",
        description: "Notes.",
        enabled: true,
        files: [
          { path: "SKILL.md", content: skillMd("meeting-notes", "Notes.") },
          { path: "template.md", content: "## Attendees\n" },
        ],
      });
      expect(renamed.reviewedAt).toEqual(written.reviewedAt);
      expect(await library.list()).toEqual([renamed]);
      expect((await skillEvents(bus)).at(-1)).toEqual({
        type: "skill.changed",
        version: 1,
        skillId: written.id,
        name: "meeting-notes",
        change: "edited",
      });
    },
  ],
  [
    "refuses a second Skill of one name, however it arrives",
    async ({ library }) => {
      await library.add({ source: "upload", files: pdfFiles });
      expect(
        await refusal(library.importFromGit({ url: repositoryUrl })),
      ).toEqual({ code: skillErrorCodes.skillNameTaken, problems: undefined });
      const other = await library.add({
        source: "editor",
        files: [{ path: "SKILL.md", content: skillMd("other") }],
      });
      expect(
        (
          await refusal(
            library.update(other.id, {
              files: [{ path: "SKILL.md", content: skillMd("pdf-processing") }],
            }),
          )
        ).code,
      ).toBe(skillErrorCodes.skillNameTaken);
      expect((await library.get(other.id)).name).toBe("other");
    },
  ],
  [
    "lists Skills by name, and removes them",
    async ({ library, bus }) => {
      const zebra = await library.add({
        source: "editor",
        files: [{ path: "SKILL.md", content: skillMd("zebra") }],
      });
      await library.add({
        source: "editor",
        files: [{ path: "SKILL.md", content: skillMd("aardvark") }],
      });
      expect((await library.list()).map(({ name }) => name)).toEqual([
        "aardvark",
        "zebra",
      ]);
      await library.remove(zebra.id);
      expect((await library.list()).map(({ name }) => name)).toEqual([
        "aardvark",
      ]);
      expect((await skillEvents(bus)).at(-1)).toEqual({
        type: "skill.removed",
        version: 1,
        skillId: zebra.id,
        name: "zebra",
      });
      for (const attempt of [
        () => library.get(zebra.id),
        () => library.remove(zebra.id),
        () => library.update(zebra.id, { enabled: false }),
        () => library.review(zebra.id, zebra.digest),
      ]) {
        expect((await refusal(attempt())).code).toBe(
          skillErrorCodes.skillNotFound,
        );
      }
    },
  ],
];

describe("the Skill library, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(
        setUp(
          memorySkillStore(),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the Skill library, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        setUp(
          databaseSkillStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }

  postgresTest(
    "the table itself refuses an enabled Skill that was never reviewed",
    async ({ database }) => {
      const { library } = setUp(
        databaseSkillStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      const imported = await library.importFromGit({ url: repositoryUrl });
      await expect(
        database.db.update(skills).set({ enabled: true }),
      ).rejects.toThrow();
      await expect(
        database.db.insert(skills).values({
          id: "direct",
          name: "direct",
          description: "d",
          source: "upload",
          files: [],
          digest: imported.digest,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ).rejects.toThrow();
      expect((await library.get(imported.id)).enabled).toBe(false);
    },
  );
});

describe("importing from Git", () => {
  it("refuses a repository's Skill that is not valid", async () => {
    const { library, store } = setUp(
      memorySkillStore(),
      createEventBus({ store: memoryEventStore() }),
      {
        files: [{ path: "SKILL.md", content: "---\nname: pdf\n---\n" }],
        folder: "pdf-tools",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "pdf-tools",
      },
    );
    expect(
      await refusal(library.importFromGit({ url: repositoryUrl })),
    ).toEqual({
      code: skillErrorCodes.invalidSkill,
      problems: ["The frontmatter needs a description."],
    });
    expect(await store.list()).toEqual([]);
  });

  it("is refused without a repository to import from", async () => {
    const library = createSkillLibrary({
      store: memorySkillStore(),
      events: createEventBus({ store: memoryEventStore() }),
    });
    expect(
      (await refusal(library.importFromGit({ url: repositoryUrl }))).code,
    ).toBe(skillErrorCodes.importFailed);
  });
});
