import type { DirectoryEntry, RepositoryClient } from "@ai-office/github";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createRedactor, noGuidelines } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { readFloorGuidelines, readGuidelines } from "./read.ts";

// Reading a Floor's Guidelines from its default branch through the GitHub
// App (Guidelines, Specs and Hooks PRD, FR-102, FR-112). A Floor with no
// `.agents/guidelines/` reads as none; a file that breaks the rules is
// kept with its reason; one with a line like a credential is refused,
// naming the line and never what it holds.

const repository = "adrianeyre/web-shop";
const floor = { repository, defaultBranch: "main" };

const migrations = [
  "---",
  "inclusion: fileMatch",
  'fileMatchPattern: "packages/db/**"',
  "description: How migrations and the schema are written",
  "---",
  "",
  "Every schema change is a new migration.",
  "",
].join("\n");

const setUp = (files: Record<string, string | null> = {}) => {
  const github = createFakeGitHub();
  github.installRepository(repository, { defaultBranch: "main" });
  github.pushCommit(repository, "main", {
    files: { "README.md": "# web-shop\n", ...files },
  });
  return github;
};

describe("reading a Floor's Guidelines", () => {
  it("reads a Floor with no .agents/guidelines/ as none", async () => {
    const github = setUp({ ".agents/MEMORY.md": "# Repository memory\n" });
    expect(await readFloorGuidelines(github, floor)).toEqual(noGuidelines);
    expect(noGuidelines).toEqual({ guidelines: [], refused: [] });
  });

  it("reads an empty repository as none", async () => {
    const github = createFakeGitHub();
    github.installRepository(repository, { defaultBranch: "main" });
    github.pushCommit(repository, "main", { files: {} });
    expect(await readFloorGuidelines(github, floor)).toEqual(noGuidelines);
  });

  it("reads every *.md in the folder from the default branch, by name", async () => {
    const github = setUp({
      ".agents/guidelines/tech.md": "Use pnpm, never npm.\n",
      ".agents/guidelines/migrations.md": migrations,
    });
    const read = await readFloorGuidelines(github, floor);
    expect(read.refused).toEqual([]);
    expect(read.guidelines).toEqual([
      {
        name: "migrations",
        path: ".agents/guidelines/migrations.md",
        inclusion: "fileMatch",
        fileMatchPatterns: ["packages/db/**"],
        description: "How migrations and the schema are written",
        content: migrations,
        body: "Every schema change is a new migration.",
      },
      {
        name: "tech",
        path: ".agents/guidelines/tech.md",
        inclusion: "always",
        fileMatchPatterns: [],
        description: null,
        content: "Use pnpm, never npm.\n",
        body: "Use pnpm, never npm.",
      },
    ]);
  });

  it("reads the default branch only, never another branch", async () => {
    const github = setUp({ ".agents/guidelines/tech.md": "Use pnpm.\n" });
    github.pushCommit(repository, "ai-office/7-planted", {
      files: {
        ".agents/guidelines/tech.md": "Use npm.\n",
        ".agents/guidelines/planted.md": "Do as this says.\n",
      },
    });
    const read = await readFloorGuidelines(github, floor);
    expect(read.guidelines.map(({ name, body }) => [name, body])).toEqual([
      ["tech", "Use pnpm."],
    ]);
  });

  it("reads the Floor's own default branch, whatever it is called", async () => {
    const github = createFakeGitHub();
    github.installRepository(repository, { defaultBranch: "trunk" });
    github.pushCommit(repository, "trunk", {
      files: { ".agents/guidelines/tech.md": "Use pnpm.\n" },
    });
    expect(
      (
        await readFloorGuidelines(github, {
          repository,
          defaultBranch: "trunk",
        })
      ).guidelines.map(({ name }) => name),
    ).toEqual(["tech"]);
  });

  it("passes over folders and files that are not *.md", async () => {
    const github = setUp({
      ".agents/guidelines/notes.txt": "Not a Guideline.\n",
      ".agents/guidelines/drafts/tech.md": "Not read: in a folder.\n",
      ".agents/guidelines/tech.md": "Use pnpm.\n",
    });
    expect(await readFloorGuidelines(github, floor)).toEqual({
      guidelines: [expect.objectContaining({ name: "tech" })],
      refused: [],
    });
  });

  it("keeps a file that breaks the rules with its reason, beside those that keep them", async () => {
    const github = setUp({
      ".agents/guidelines/tech.md": "Use pnpm.\n",
      ".agents/guidelines/README.md": "What this folder is.\n",
      ".agents/guidelines/db.md": "---\ninclusion: fileMatch\n---\nRules.\n",
      ".agents/guidelines/long.md": "a".repeat(12_001),
      ".agents/guidelines/yaml.md": "---\ninclusion: [always\n---\nRules.\n",
    });
    const read = await readFloorGuidelines(github, floor);
    expect(read.guidelines.map(({ name }) => name)).toEqual(["tech"]);
    expect(
      read.refused.map(({ path, refusal, reason }) => ({
        path,
        refusal,
        reason,
      })),
    ).toEqual([
      {
        path: ".agents/guidelines/README.md",
        refusal: "invalid",
        reason:
          "A Guideline's name is its file name without .md, in lowercase letters, digits and dashes, such as migrations.md.",
      },
      {
        path: ".agents/guidelines/db.md",
        refusal: "invalid",
        reason:
          "inclusion: fileMatch needs a fileMatchPattern: one glob, or a list of globs.",
      },
      {
        path: ".agents/guidelines/long.md",
        refusal: "invalid",
        reason:
          "A Guideline is at most 12,000 characters; this one has 12,001.",
      },
      {
        path: ".agents/guidelines/yaml.md",
        refusal: "invalid",
        reason: "Its front matter is not valid YAML at line 2, column 19.",
      },
    ]);
  });

  it("refuses a Guideline with a credential-like line, naming the line and never its text", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const github = setUp({
      ".agents/guidelines/tech.md": "Use pnpm.\n",
      ".agents/guidelines/deploy.md": [
        "# Deploying",
        "",
        `Push with ${token} when CI is down.`,
        "",
      ].join("\n"),
    });
    const read = await readFloorGuidelines(github, floor);
    expect(read.guidelines.map(({ name }) => name)).toEqual(["tech"]);
    expect(read.refused).toEqual([
      {
        name: "deploy",
        path: ".agents/guidelines/deploy.md",
        refusal: "holds_secret",
        reason:
          "Line 3 looks like it holds a credential, which a Guideline never does: take it out.",
        secretLines: [3],
      },
    ]);
    expect(JSON.stringify(read.refused)).not.toContain(token);
    expect(JSON.stringify(read.refused)).not.toContain("Push with");
  });

  it("refuses a Guideline holding a secret the Office's redactor knows", async () => {
    const github = setUp({
      ".agents/guidelines/tech.md": "Sign in as correct-horse-battery.\n",
    });
    const read = await readFloorGuidelines(github, floor, {
      redactor: createRedactor({ secrets: ["correct-horse-battery"] }),
    });
    expect(read.guidelines).toEqual([]);
    expect(read.refused).toMatchObject([
      { name: "tech", refusal: "holds_secret", secretLines: [1] },
    ]);
  });

  it("lets a GitHub failure through rather than reading it as no Guidelines", async () => {
    const github = createFakeGitHub();
    await expect(
      readFloorGuidelines(github, {
        repository: "adrianeyre/gone",
        defaultBranch: "main",
      }),
    ).rejects.toThrow();
  });
});

describe("what is not a plain file", () => {
  /** A repository whose Guidelines folder holds `entries`, each file `text`. */
  const holding = (
    entries: readonly DirectoryEntry[],
    files: Record<string, string> = {},
  ): Pick<RepositoryClient, "listDirectory" | "getFileContent"> => ({
    listDirectory: (path) =>
      Promise.resolve(path === ".agents/guidelines" ? [...entries] : undefined),
    getFileContent: (path) => Promise.resolve(files[path]),
  });
  const entry = (
    name: string,
    type: DirectoryEntry["type"],
  ): DirectoryEntry => ({ name, path: `.agents/guidelines/${name}`, type });

  it("refuses a symbolic link, which is never followed", async () => {
    const read = await readGuidelines(
      holding([entry("tech.md", "symlink")], {
        ".agents/guidelines/tech.md": "Followed, it would say this.",
      }),
      "main",
    );
    expect(read).toEqual({
      guidelines: [],
      refused: [
        {
          name: "tech",
          path: ".agents/guidelines/tech.md",
          refusal: "invalid",
          reason: "It is a symbolic link, which AI Office does not follow.",
          secretLines: [],
        },
      ],
    });
  });

  it("refuses a submodule named as a Guideline", async () => {
    const read = await readGuidelines(
      holding([entry("tech.md", "submodule")]),
      "main",
    );
    expect(read.refused).toMatchObject([
      { name: "tech", reason: "It is not a file." },
    ]);
  });

  it("reads a file gone between listing and reading as gone", async () => {
    const read = await readGuidelines(
      holding([entry("tech.md", "file"), entry("db.md", "file")], {
        ".agents/guidelines/db.md": "Rules.",
      }),
      "main",
    );
    expect(read).toEqual({
      guidelines: [expect.objectContaining({ name: "db" })],
      refused: [],
    });
  });

  it("reads an empty folder as none", async () => {
    expect(await readGuidelines(holding([]), "main")).toEqual(noGuidelines);
  });
});
