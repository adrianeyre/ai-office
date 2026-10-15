import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { floorSkillToggles, repositorySkillReviews } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  defaultFloorSettings,
  floorErrorCodes,
  grillingSkillNames,
  mattPocockSkillNames,
  parseSkillDocument,
  skillErrorCodes,
  type SkillFile,
} from "@ai-office/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FloorError } from "../floors/errors.ts";
import {
  grillingSkillDescription,
  grillingSkillDocument,
} from "../grilling/skill.ts";
import { databaseFloorStore, type FloorRecord } from "../floors/store.ts";
import {
  builtInSkills,
  builtInSkillsDir,
  loadBuiltInSkill,
} from "./built-in.ts";
import { SkillError } from "./errors.ts";
import { createFloorSkills, resolveFloorSkills } from "./floor.ts";
import {
  discoverRepositorySkills,
  fileSystemSkillReader,
  readGitHubSkillFolder,
  type FolderEntry,
} from "./repository.ts";
import {
  databaseRepositorySkillReviewStore,
  memoryRepositorySkillReviewStore,
} from "./reviews.ts";
import { memorySkillStore, type SkillRecord } from "./store.ts";
import {
  databaseFloorSkillToggleStore,
  memoryFloorSkillToggleStore,
} from "./toggles.ts";

// A Floor's Skills (PRD FR-72, FR-75): the office library's enabled
// Skills plus the repository's own under `.agents/skills/` and
// `.claude/skills/`, a repository Skill overriding the office Skill of its
// name on that Floor; each turned on or off per Role by the Floor admin.

const skillMd = (name: string, description = `What ${name} does.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const repository = "adrianeyre/web-shop";

const floor: FloorRecord = {
  ...defaultFloorSettings,
  template: { id: "development", name: "Development" },
  theme: "office",
  id: "web-shop",
  name: "Web shop",
  defaultBranch: "main",
  githubRepositoryId: 1,
  repository,
  createdAt: new Date(Date.UTC(2026, 9, 1)),
  archivedAt: null,
};

let at = 0;
const officeSkill = (
  name: string,
  options: { enabled?: boolean; files?: SkillFile[] } = {},
): SkillRecord => ({
  id: `skill-${name}`,
  name,
  description: `The office's ${name}.`,
  source: "editor",
  origin: null,
  files: options.files ?? [
    { path: "SKILL.md", content: skillMd(name, `The office's ${name}.`) },
  ],
  digest: "0".repeat(64),
  enabled: options.enabled ?? true,
  reviewedAt: new Date(Date.UTC(2026, 9, 1)),
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, at++)),
  updatedAt: new Date(Date.UTC(2026, 9, 1)),
});

/** Writes `files` (path to text) under `root`. */
async function write(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

describe("resolveFloorSkills", () => {
  it("lets a repository Skill override the office Skill of its name, keeping the rest", () => {
    const office = [officeSkill("release-notes"), officeSkill("pdf")];
    const resolved = resolveFloorSkills(office, [
      {
        name: "pdf",
        description: "The repository's pdf.",
        folder: ".claude/skills/pdf",
        files: [
          {
            path: "SKILL.md",
            content: skillMd("pdf", "The repository's pdf."),
          },
        ],
      },
      {
        name: "brand-voice",
        description: "Ours.",
        folder: ".agents/skills/brand-voice",
        files: [{ path: "SKILL.md", content: skillMd("brand-voice", "Ours.") }],
      },
    ]);
    expect(
      resolved.map(
        ({ name, source, folder, overridesOffice, description }) => ({
          name,
          source,
          folder,
          overridesOffice,
          description,
        }),
      ),
    ).toEqual([
      {
        name: "brand-voice",
        source: "repository",
        folder: ".agents/skills/brand-voice",
        overridesOffice: false,
        description: "Ours.",
      },
      {
        name: "pdf",
        source: "repository",
        folder: ".claude/skills/pdf",
        overridesOffice: true,
        description: "The repository's pdf.",
      },
      {
        name: "release-notes",
        source: "office",
        folder: null,
        overridesOffice: false,
        description: "The office's release-notes.",
      },
    ]);
    // The override's files are the repository's, not the office's.
    expect(resolved[1]?.files[0]?.content).toContain("The repository's pdf.");
  });
});

describe("repository Skills in a clone", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-office-repo-skills-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds each folder's Skill under .agents/skills and .claude/skills, with its supporting files", async () => {
    await write(root, {
      ".agents/skills/brand-voice/SKILL.md": skillMd("brand-voice"),
      ".agents/skills/brand-voice/references/tone.md": "# Tone\n",
      ".claude/skills/pdf/SKILL.md": skillMd("pdf"),
      ".claude/skills/pdf/scripts/extract.py": "print('text')\n",
      ".claude/skills/README.md": "Our Skills.\n",
    });
    const found = await discoverRepositorySkills(fileSystemSkillReader(root));
    expect(found.ignored).toEqual([]);
    expect(found.skills).toEqual([
      {
        name: "brand-voice",
        description: "What brand-voice does.",
        folder: ".agents/skills/brand-voice",
        files: [
          { path: "SKILL.md", content: skillMd("brand-voice") },
          { path: "references/tone.md", content: "# Tone\n" },
        ],
      },
      {
        name: "pdf",
        description: "What pdf does.",
        folder: ".claude/skills/pdf",
        files: [
          { path: "SKILL.md", content: skillMd("pdf") },
          { path: "scripts/extract.py", content: "print('text')\n" },
        ],
      },
    ]);
  });

  it("takes a Skill in both folders from .agents/skills, and leaves out what is not a valid Skill, saying why", async () => {
    await write(root, {
      ".agents/skills/pdf/SKILL.md": skillMd("pdf", "From .agents."),
      ".claude/skills/pdf/SKILL.md": skillMd("pdf", "From .claude."),
      ".claude/skills/misnamed/SKILL.md": skillMd("other-name"),
      ".claude/skills/no-frontmatter/SKILL.md": "# Just text\n",
      ".claude/skills/empty/notes.md": "No SKILL.md here.\n",
    });
    await mkdir(join(root, ".claude/skills/binary"));
    await writeFile(
      join(root, ".claude/skills/binary/SKILL.md"),
      skillMd("binary"),
    );
    await writeFile(
      join(root, ".claude/skills/binary/logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]),
    );
    const found = await discoverRepositorySkills(fileSystemSkillReader(root));
    expect(
      found.skills.map(({ name, description }) => ({ name, description })),
    ).toEqual([{ name: "pdf", description: "From .agents." }]);
    expect(found.ignored.map(({ folder }) => folder)).toEqual([
      ".claude/skills/binary",
      ".claude/skills/empty",
      ".claude/skills/misnamed",
      ".claude/skills/no-frontmatter",
      ".claude/skills/pdf",
    ]);
    const why = Object.fromEntries(
      found.ignored.map(({ folder, problems }) => [folder, problems.join(" ")]),
    );
    expect(why[".claude/skills/binary"]).toMatch(/not text/);
    expect(why[".claude/skills/empty"]).toMatch(/SKILL\.md/);
    expect(why[".claude/skills/misnamed"]).toMatch(/named "other-name"/);
    expect(why[".claude/skills/pdf"]).toMatch(/\.agents\/skills\/pdf/);
  });

  it("follows no symbolic link, so a repository cannot point a Skill at the host's files", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ai-office-outside-"));
    try {
      await write(outside, {
        "secret.txt": "host secret\n",
        "linked-skill/SKILL.md": skillMd("linked-skill"),
      });
      await write(root, {
        ".agents/skills/leaky/SKILL.md": skillMd("leaky"),
        "README.md": "# Web shop\n",
      });
      await symlink(
        join(outside, "secret.txt"),
        join(root, ".agents/skills/leaky/secret.txt"),
      );
      await symlink(
        join(outside, "linked-skill"),
        join(root, ".agents/skills/linked-skill"),
      );
      // A Skills folder that is itself a link counts as none.
      await mkdir(join(root, ".claude"));
      await symlink(outside, join(root, ".claude/skills"));

      const found = await discoverRepositorySkills(fileSystemSkillReader(root));
      expect(found.skills).toEqual([]);
      expect(found.ignored).toEqual([
        {
          folder: ".agents/skills/leaky",
          problems: [
            '"secret.txt" is a symbolic link, which AI Office does not follow.',
          ],
        },
        {
          folder: ".agents/skills/linked-skill",
          problems: ["It is a symbolic link, which AI Office does not follow."],
        },
      ]);
      expect(JSON.stringify(found)).not.toContain("host secret");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("leaves out a Skill beyond the format's limits", async () => {
    const files: Record<string, string> = {
      ".agents/skills/huge/SKILL.md": skillMd("huge"),
    };
    for (let index = 0; index < 200; index += 1) {
      files[`.agents/skills/huge/notes/${String(index).padStart(3, "0")}.md`] =
        "x\n";
    }
    await write(root, files);
    const found = await discoverRepositorySkills(fileSystemSkillReader(root));
    expect(found.skills).toEqual([]);
    expect(found.ignored).toEqual([
      {
        folder: ".agents/skills/huge",
        problems: ["A Skill holds at most 200 files."],
      },
    ]);
  });
});

interface Setup {
  readonly floorSkills: ReturnType<typeof createFloorSkills>;
  readonly bus: EventBus;
  readonly github: ReturnType<typeof createFakeGitHub>;
  readonly events: () => Promise<OfficeEvent[]>;
}

function setUp(
  options: { office?: SkillRecord[]; floor?: FloorRecord } = {},
): Setup {
  const library = memorySkillStore();
  for (const skill of options.office ?? []) {
    library.skills.set(skill.id, skill);
  }
  const bus = createEventBus({ store: memoryEventStore() });
  const github = createFakeGitHub();
  github.installRepository(repository);
  const current = options.floor ?? floor;
  return {
    floorSkills: createFloorSkills({
      floors: {
        get: (id) => Promise.resolve(id === current.id ? current : undefined),
      },
      library,
      toggles: memoryFloorSkillToggleStore(),
      reviews: memoryRepositorySkillReviewStore(),
      events: bus,
      github,
      now: () => new Date(Date.UTC(2026, 9, 9, 12)),
    }),
    bus,
    github,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

/**
 * The Owner reads and reviews each of the repository's Skills waiting on
 * the Floor, as GitHub has them: only then are they used (P1-10).
 */
const reviewAll = async (floorSkills: Setup["floorSkills"]): Promise<void> => {
  for (const { folder } of (await floorSkills.list("web-shop"))
    .awaitingReview) {
    const read = await floorSkills.repositorySkill("web-shop", folder);
    await floorSkills.reviewRepositorySkill("web-shop", folder, read.digest);
  }
};

const allOn = { coder: true, qa: true, docs: true, designer: true };
const allOff = { coder: false, qa: false, docs: false, designer: false };

/**
 * The Floor's own Skills and `/grilling`, without the built-in Skills
 * adapted from Matt Pocock's, which every Floor has.
 */
const withoutMattPococks = <Skill extends { name: string; source: string }>(
  skills: readonly Skill[],
): Skill[] =>
  skills.filter(
    ({ name, source }) => source !== "built-in" || name === "grilling",
  );

describe("a Floor's Skills", () => {
  it("lists the office's enabled Skills and the repository's from GitHub, the repository's overriding", async () => {
    const { floorSkills, github } = setUp({
      office: [
        officeSkill("pdf"),
        officeSkill("release-notes"),
        officeSkill("unreviewed-import", { enabled: false }),
      ],
    });
    github.pushCommit(repository, "main", {
      files: {
        ".agents/skills/brand-voice/SKILL.md": skillMd("brand-voice"),
        ".claude/skills/pdf/SKILL.md": skillMd("pdf", "The repository's pdf."),
        ".claude/skills/pdf/scripts/extract.py": "print('text')\n",
        ".claude/skills/broken/SKILL.md": "no frontmatter\n",
      },
    });
    // Another branch's Skills are not the Floor's.
    github.pushCommit(repository, "ai-office/4-basket", {
      files: { ".agents/skills/wip/SKILL.md": skillMd("wip") },
    });
    await reviewAll(floorSkills);

    const list = await floorSkills.list("web-shop");
    expect(list.repositoryError).toBeNull();
    // Every built-in Skill is on the Floor, and in no sandbox.
    expect(
      list.skills.flatMap(({ name, source, roles }) =>
        source === "built-in" ? [[name, roles]] : [],
      ),
    ).toEqual(
      [...mattPocockSkillNames, "grilling"]
        .sort()
        .map((name) => [name, allOff]),
    );
    expect(withoutMattPococks(list.skills)).toEqual([
      {
        name: "brand-voice",
        description: "What brand-voice does.",
        source: "repository",
        folder: ".agents/skills/brand-voice",
        overridesOffice: false,
        roles: allOn,
      },
      // AI Office's own, on every Floor and in no sandbox.
      {
        name: "grilling",
        description: grillingSkillDescription,
        source: "built-in",
        folder: null,
        overridesOffice: false,
        roles: allOff,
      },
      {
        name: "pdf",
        description: "The repository's pdf.",
        source: "repository",
        folder: ".claude/skills/pdf",
        overridesOffice: true,
        roles: allOn,
      },
      {
        name: "release-notes",
        description: "The office's release-notes.",
        source: "office",
        folder: null,
        overridesOffice: false,
        roles: allOn,
      },
    ]);
    expect(list.ignored.map(({ folder }) => folder)).toEqual([
      ".claude/skills/broken",
    ]);
  });

  it("opens one Skill in full: a repository Skill's whole folder from GitHub, an office Skill's files, SKILL.md first", async () => {
    const { floorSkills, github } = setUp({
      office: [
        officeSkill("pdf"),
        officeSkill("release-notes", {
          files: [
            {
              path: "SKILL.md",
              content: skillMd("release-notes", "The office's release-notes."),
            },
            { path: "TEMPLATE.md", content: "# Release x.y\n" },
          ],
        }),
      ],
    });
    github.pushCommit(repository, "main", {
      files: {
        ".claude/skills/pdf/SKILL.md": skillMd("pdf", "The repository's pdf."),
        ".claude/skills/pdf/scripts/extract.py": "print('text')\n",
        ".claude/skills/pdf/REFERENCE.md": "# Reference\n",
      },
    });
    await reviewAll(floorSkills);

    const pdf = await floorSkills.get("web-shop", "pdf");
    expect(pdf).toMatchObject({
      source: "repository",
      folder: ".claude/skills/pdf",
      overridesOffice: true,
    });
    expect(pdf.files).toEqual([
      { path: "SKILL.md", content: skillMd("pdf", "The repository's pdf.") },
      { path: "REFERENCE.md", content: "# Reference\n" },
      { path: "scripts/extract.py", content: "print('text')\n" },
    ]);
    const notes = await floorSkills.get("web-shop", "release-notes");
    expect(notes.files.map(({ path }) => path)).toEqual([
      "SKILL.md",
      "TEMPLATE.md",
    ]);
    const available = await floorSkills.available("web-shop");
    expect(
      withoutMattPococks(available.skills).map(({ name, source }) => [
        name,
        source,
      ]),
    ).toEqual([
      ["grilling", "built-in"],
      ["pdf", "repository"],
      ["release-notes", "office"],
    ]);
    expect(available.repositoryError).toBeNull();
    await expect(floorSkills.get("web-shop", "nothing")).rejects.toMatchObject({
      code: skillErrorCodes.skillNotFound,
    });
    await expect(floorSkills.get("elsewhere", "pdf")).rejects.toMatchObject({
      code: floorErrorCodes.floorNotFound,
    });
  });

  it("reads a repository Skill's folder from GitHub as warily as a clone", async () => {
    const folderOf =
      (tree: Record<string, readonly FolderEntry[]>) =>
      (files: Record<string, string>) => ({
        listDirectory: (path: string) =>
          Promise.resolve(
            tree[path]?.map(({ name, type }) => ({
              name,
              path: `${path}/${name}`,
              type: type === "other" ? ("submodule" as const) : type,
            })),
          ),
        getFileContent: (path: string) => Promise.resolve(files[path]),
      });
    const linked = folderOf({
      "s/pdf": [
        { name: "SKILL.md", type: "file" },
        { name: "secrets", type: "symlink" },
      ],
    })({ "s/pdf/SKILL.md": skillMd("pdf") });
    expect(await readGitHubSkillFolder(linked, "main", "s/pdf")).toEqual({
      problems: [
        '"secrets" is a symbolic link, which AI Office does not follow.',
      ],
    });
    const binary = folderOf({
      "s/pdf": [
        { name: "SKILL.md", type: "file" },
        { name: "logo.png", type: "file" },
      ],
    })({ "s/pdf/SKILL.md": skillMd("pdf"), "s/pdf/logo.png": "\u0000PNG" });
    expect(await readGitHubSkillFolder(binary, "main", "s/pdf")).toEqual({
      problems: ["Skills hold text files only."],
    });
    const many = folderOf({
      "s/pdf": Array.from({ length: 201 }, (_, index) => ({
        name: `${String(index).padStart(3, "0")}.md`,
        type: "file" as const,
      })),
    })(
      Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [
          `s/pdf/${String(index).padStart(3, "0")}.md`,
          "x",
        ]),
      ),
    );
    expect(await readGitHubSkillFolder(many, "main", "s/pdf")).toEqual({
      problems: ["A Skill holds at most 200 files."],
    });
    expect(
      await readGitHubSkillFolder(folderOf({})({}), "main", "s/gone"),
    ).toEqual({ problems: ["It is not a folder."] });
  });

  it("still lists the office's Skills when GitHub cannot be read, saying why", async () => {
    const { floorSkills } = setUp({
      office: [officeSkill("pdf")],
      floor: { ...floor, repository: "adrianeyre/not-installed" },
    });
    const list = await floorSkills.list("web-shop");
    expect(withoutMattPococks(list.skills).map(({ name }) => name)).toEqual([
      "grilling",
      "pdf",
    ]);
    expect(list.repositoryError).toMatch(/could not be read from GitHub/);
  });

  it("has the built-in /grilling Skill, which no office or repository Skill of its name overrides", async () => {
    const { floorSkills, github } = setUp({
      office: [officeSkill("grilling")],
    });
    github.pushCommit(repository, "main", {
      files: {
        ".claude/skills/grilling/SKILL.md": skillMd("grilling", "Mine."),
      },
    });
    const available = await floorSkills.available("web-shop");
    expect(
      withoutMattPococks(available.skills).map(({ name, source }) => [
        name,
        source,
      ]),
    ).toEqual([["grilling", "built-in"]]);
    const grilling = await floorSkills.get("web-shop", "grilling");
    expect(grilling).toMatchObject({ source: "built-in", folder: null });
    expect(grilling.files).toEqual([
      { path: "SKILL.md", content: grillingSkillDocument },
    ]);
  });

  it("has the built-in Skills adapted from Matt Pocock's, as real Skills with their supporting files: those that start a Grilling Session keep their place, and the rest give way to the Floor's own", async () => {
    const { floorSkills, github } = setUp({
      office: [officeSkill("wayfinder"), officeSkill("pr")],
    });
    github.pushCommit(repository, "main", {
      files: {
        ".claude/skills/to-tickets/SKILL.md": skillMd("to-tickets", "Mine."),
        ".claude/skills/tdd/SKILL.md": skillMd("tdd", "Ours."),
      },
    });
    await reviewAll(floorSkills);
    const sources = new Map(
      (await floorSkills.available("web-shop")).skills.map(
        ({ name, source }) => [name, source],
      ),
    );
    // Starting a session, they keep their place.
    for (const name of grillingSkillNames) {
      expect(sources.get(name)).toBe("built-in");
    }
    // Loading instructions, they give way to the office's and the
    // repository's of their name.
    expect(sources.get("pr")).toBe("office");
    expect(sources.get("tdd")).toBe("repository");
    expect(sources.get("domain-modeling")).toBe("built-in");

    const modeling = await floorSkills.get("web-shop", "domain-modeling");
    expect(modeling.files.map(({ path }) => path)).toEqual([
      "SKILL.md",
      "ADR-FORMAT.md",
      "GLOSSARY-FORMAT.md",
    ]);
    // Each a SKILL.md in the Agent Skills format, crediting Matt Pocock,
    // and writing ADRs and PRDs only where AI Office keeps them.
    for (const name of mattPocockSkillNames) {
      const skill = builtInSkills.find((each) => each.name === name);
      const document = parseSkillDocument(
        skill?.files.find(({ path }) => path === "SKILL.md")?.content ?? "",
      );
      expect(document.ok && document.document.name).toBe(name);
      const text = (skill?.files ?? []).map(({ content }) => content).join("");
      expect(text).toContain("Adapted from Matt Pocock's skills, MIT");
      expect(text).not.toContain("setup-matt-pocock-skills");
    }
    for (const name of [...grillingSkillNames.slice(1), "domain-modeling"]) {
      const text = (
        builtInSkills.find((each) => each.name === name)?.files ?? []
      )
        .map(({ content }) => content)
        .join("");
      expect(text).toContain("docs/product-requirements-document");
      expect(text).toContain("docs/architectural-decision-record");
    }
    expect(
      (await floorSkills.get("web-shop", "pr")).files.map(({ path }) => path),
    ).toEqual(["SKILL.md"]);
  });

  it("will not load a built-in Skill that is not a valid Skill", () => {
    expect(() => loadBuiltInSkill(builtInSkillsDir, "missing")).toThrow();
    expect(
      loadBuiltInSkill(builtInSkillsDir, "pr").files.map(({ path }) => path),
    ).toEqual(["SKILL.md", "CREDITS.md"]);
  });

  it("turns a Skill off and on per Role, as a configuration change naming the Skill and Role", async () => {
    const { floorSkills, events } = setUp({ office: [officeSkill("pdf")] });
    await floorSkills.setEnabled("web-shop", "pdf", "qa", false);
    // Setting what is already set changes nothing.
    await floorSkills.setEnabled("web-shop", "pdf", "qa", false);
    const pdfOf = async () =>
      (await floorSkills.list("web-shop")).skills.find(
        ({ name }) => name === "pdf",
      );
    expect((await pdfOf())?.roles).toEqual({
      ...allOn,
      qa: false,
    });
    await floorSkills.setEnabled("web-shop", "pdf", "qa", true);
    expect((await pdfOf())?.roles).toEqual(allOn);
    expect(
      (await events()).filter(({ type }) => type === "config.changed"),
    ).toEqual([
      {
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId: "web-shop",
        keys: ["skills.pdf.qa"],
      },
      {
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId: "web-shop",
        keys: ["skills.pdf.qa"],
      },
    ]);
  });

  it("refuses a Role that works in no sandbox, a name that is no Skill's, and a Floor that is archived or missing", async () => {
    const { floorSkills } = setUp();
    await expect(
      floorSkills.setEnabled("web-shop", "pdf", "reviewer", false),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof SkillError &&
        error.code === skillErrorCodes.notSandboxRole,
    );
    await expect(
      floorSkills.setEnabled("web-shop", "../etc", "coder", false),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof SkillError &&
        error.code === skillErrorCodes.skillNotFound,
    );
    await expect(
      floorSkills.setEnabled("elsewhere", "pdf", "coder", false),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof FloorError &&
        error.code === floorErrorCodes.floorNotFound,
    );
    const archived = setUp({ floor: { ...floor, archivedAt: new Date() } });
    await expect(
      archived.floorSkills.setEnabled("web-shop", "pdf", "coder", false),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof FloorError &&
        error.code === floorErrorCodes.floorArchived,
    );
  });

  describe("for a sandbox", () => {
    const files = {
      ".claude/skills/pdf/SKILL.md": skillMd("pdf", "The repository's pdf."),
      ".claude/skills/pdf/scripts/extract.py": "print('text')\n",
      ".agents/skills/brand-voice/SKILL.md": skillMd("brand-voice"),
    };
    let clone: string;
    beforeEach(async () => {
      clone = await mkdtemp(join(tmpdir(), "ai-office-clone-"));
      await write(clone, files);
    });
    /** The Floor, with the Owner's review of the repository's Skills. */
    const reviewed = async (options: Parameters<typeof setUp>[0]) => {
      const setup = setUp(options);
      setup.github.pushCommit(repository, "main", { files });
      await reviewAll(setup.floorSkills);
      return setup;
    };
    afterEach(async () => {
      await rm(clone, { recursive: true, force: true });
    });

    it("gives each Role the Skills on for it, the repository's read in full from the clone and overriding the office's", async () => {
      const { floorSkills } = await reviewed({
        office: [
          officeSkill("pdf"),
          officeSkill("release-notes"),
          officeSkill("draft", { enabled: false }),
        ],
      });
      await floorSkills.setEnabled("web-shop", "release-notes", "qa", false);
      await floorSkills.setEnabled("web-shop", "pdf", "docs", false);

      const coder = await floorSkills.forSandbox("web-shop", "coder", clone);
      expect(
        coder.skills.map(({ name, source }) => `${name} (${source})`),
      ).toEqual([
        "brand-voice (repository)",
        "pdf (repository)",
        "release-notes (office)",
      ]);
      expect(coder.skills[1]?.files).toEqual([
        { path: "SKILL.md", content: skillMd("pdf", "The repository's pdf.") },
        { path: "scripts/extract.py", content: "print('text')\n" },
      ]);
      expect(
        (await floorSkills.forSandbox("web-shop", "qa", clone)).skills.map(
          ({ name }) => name,
        ),
      ).toEqual(["brand-voice", "pdf"]);
      expect(
        (await floorSkills.forSandbox("web-shop", "docs", clone)).skills.map(
          ({ name }) => name,
        ),
      ).toEqual(["brand-voice", "release-notes"]);
      // A reviewer and the Manager work in no sandbox.
      expect(
        (await floorSkills.forSandbox("web-shop", "reviewer", clone)).skills,
      ).toEqual([]);
    });

    it("turning off an overridden Skill turns off the repository's copy, which is what the Floor has", async () => {
      const { floorSkills } = await reviewed({ office: [officeSkill("pdf")] });
      await floorSkills.setEnabled("web-shop", "pdf", "coder", false);
      expect(
        (await floorSkills.forSandbox("web-shop", "coder", clone)).skills.map(
          ({ name }) => name,
        ),
      ).toEqual(["brand-voice"]);
    });

    it("gives no repository Skill the Owner has not reviewed as the clone has it, the office's of its name in its place (P1-10)", async () => {
      const { floorSkills, github } = setUp({ office: [officeSkill("pdf")] });
      const names = async () =>
        (await floorSkills.forSandbox("web-shop", "coder", clone)).skills.map(
          ({ name, source }) => `${name} (${source})`,
        );
      expect(await names()).toEqual(["pdf (office)"]);
      // Reviewed as GitHub has them, which the clone matches.
      github.pushCommit(repository, "main", { files });
      await reviewAll(floorSkills);
      expect(await names()).toEqual([
        "brand-voice (repository)",
        "pdf (repository)",
      ]);
      // A supporting file the clone holds that the Owner never read.
      await write(clone, { ".claude/skills/pdf/scripts/more.sh": "curl x\n" });
      expect(await names()).toEqual([
        "brand-voice (repository)",
        "pdf (office)",
      ]);
    });
  });
});

postgresTest(
  "the Floor's Skill settings are kept in floor_skill_toggles, a Skill on until turned off",
  async ({ database }) => {
    await databaseFloorStore(database.db).create(floor, []);
    const store = databaseFloorSkillToggleStore(database.db);
    const when = new Date(Date.UTC(2026, 9, 9, 12));
    expect(await store.list("web-shop")).toEqual([]);
    expect(
      await store.set(
        "web-shop",
        { skillName: "pdf", role: "qa", enabled: false },
        when,
      ),
    ).toBe(true);
    expect(
      await store.set(
        "web-shop",
        { skillName: "pdf", role: "qa", enabled: false },
        when,
      ),
    ).toBe(false);
    expect(
      await store.set(
        "web-shop",
        { skillName: "pdf", role: "coder", enabled: true },
        when,
      ),
    ).toBe(false);
    expect(
      (await store.list("web-shop")).sort((a, b) =>
        a.role.localeCompare(b.role),
      ),
    ).toEqual([
      { skillName: "pdf", role: "coder", enabled: true },
      { skillName: "pdf", role: "qa", enabled: false },
    ]);
    // Only sandbox Roles, and Skill names.
    await expect(
      database.db.insert(floorSkillToggles).values({
        floorId: "web-shop",
        skillName: "pdf",
        role: "reviewer",
        enabled: false,
        updatedAt: when,
      }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(floorSkillToggles).values({
        floorId: "web-shop",
        skillName: "../pdf",
        role: "coder",
        enabled: false,
        updatedAt: when,
      }),
    ).rejects.toThrow();
  },
);

postgresTest(
  "the Owner's reviews of repository Skills are kept in repository_skill_reviews, one per folder (P1-10)",
  async ({ database }) => {
    await databaseFloorStore(database.db).create(floor, []);
    const store = databaseRepositorySkillReviewStore(database.db);
    const when = new Date(Date.UTC(2026, 9, 11, 12));
    expect(await store.list("web-shop")).toEqual([]);
    await store.review(
      "web-shop",
      { folder: ".claude/skills/pdf", digest: "a".repeat(64) },
      when,
    );
    // A later review replaces the folder's earlier one.
    await store.review(
      "web-shop",
      { folder: ".claude/skills/pdf", digest: "b".repeat(64) },
      when,
    );
    expect(await store.list("web-shop")).toEqual([
      { folder: ".claude/skills/pdf", digest: "b".repeat(64) },
    ]);
    // Only Skill folders, and digests.
    await expect(
      database.db.insert(repositorySkillReviews).values({
        floorId: "web-shop",
        folder: "../../etc",
        digest: "c".repeat(64),
        reviewedAt: when,
      }),
    ).rejects.toThrow();
    await expect(
      database.db.insert(repositorySkillReviews).values({
        floorId: "web-shop",
        folder: ".agents/skills/release",
        digest: "not a digest",
        reviewedAt: when,
      }),
    ).rejects.toThrow();
  },
);
