import type { PullRequestFile } from "@ai-office/github";
import { describe, expect, it } from "vitest";

import { memoryPath, repositorySkillFolders } from "@ai-office/shared";

import {
  maxListedFiles,
  ownerOnly,
  readByAgents,
  runByCi,
} from "./owner-only.ts";

// What the Merge Policy never merges without the Owner (pen-test findings
// P1-2, P1-3): the paths that say what CI runs, and those later Agents
// read as memory, Skills or instructions, as plain rules.

const changed = (path: string, previousPath?: string): PullRequestFile => ({
  path,
  status: previousPath === undefined ? "modified" : "renamed",
  patch: "@@ -1 +1 @@\n-a\n+b",
  ...(previousPath === undefined ? {} : { previousPath }),
});

describe("what CI runs (P1-2)", () => {
  it("is its definitions, scripts, dependencies and tools' settings, at any depth and in any case", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
      "Jenkinsfile",
      ".husky/pre-commit",
      "package.json",
      "packages/api/package.json",
      "Package.JSON",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "pnpm-workspace.yaml",
      ".npmrc",
      "packages/api/.npmrc",
      ".yarnrc.yml",
      ".yarn/plugins/plugin.cjs",
      ".nvmrc",
      "vitest.config.ts",
      "vite.config.mts",
      "vitest.workspace.ts",
      "playwright.config.ts",
      "eslint.config.js",
      ".eslintrc.cjs",
      ".prettierrc",
      "tsconfig.json",
      "tsconfig.build.json",
      "scripts/ci-setup.sh",
      "scripts/release.mjs",
      "tools/release.sh",
      "bin/test",
      "Makefile",
      "Dockerfile",
      "docker-compose.yml",
      "pyproject.toml",
      "requirements-dev.txt",
      "conftest.py",
      "Cargo.toml",
      "go.mod",
      "gradle/wrapper/gradle-wrapper.properties",
      "dbt_project.yml",
      ".gitmodules",
      // A folder replaced by a file (a symbolic link, say).
      ".github",
    ]) {
      expect(runByCi(path), path).toBe(true);
    }
  });

  it("is not the code under test, its tests or its documentation", () => {
    for (const path of [
      "src/basket.ts",
      "src/basket.test.ts",
      "test/basket.test.ts",
      "README.md",
      "docs/basket.md",
      "src/config.ts",
      "src/scripted.ts",
      "public/package.png",
      "CHANGELOG.md",
    ]) {
      expect(runByCi(path), path).toBe(false);
    }
  });
});

describe("what later Agents read (P1-3)", () => {
  it("is the repository's memory and Skills, and every agent tool's instructions and settings, at any depth and in any case", () => {
    for (const path of [
      memoryPath,
      ...repositorySkillFolders.map((folder) => `${folder}/test/SKILL.md`),
      ".agents/skills/test/scripts/run.py",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/commands/ship.md",
      ".claude/agents/reviewer.md",
      "CLAUDE.md",
      "claude.md",
      "CLAUDE.local.md",
      "packages/web/CLAUDE.md",
      "AGENTS.md",
      "packages/web/AGENTS.md",
      "AGENTS.override.md",
      ".mcp.json",
      ".codex/config.toml",
      ".opencode/plugin/hook.ts",
      "opencode.json",
      "opencode.jsonc",
      // A folder replaced by a file (a symbolic link, say).
      ".claude",
    ]) {
      expect(readByAgents(path), path).toBe(true);
    }
  });

  it("is not the code, the tests or other documentation", () => {
    for (const path of [
      "src/basket.ts",
      "README.md",
      "docs/agents.md.txt",
      "docs/claude.mdx",
      "src/agents/basket.ts",
      "MEMORY.md",
    ]) {
      expect(readByAgents(path), path).toBe(false);
    }
  });
});

describe("ownerOnly", () => {
  it("names nothing for a pull request that changes no such file", () => {
    expect(ownerOnly([changed("src/basket.ts"), changed("README.md")])).toEqual(
      [],
    );
  });

  it("names what CI runs, once, however many such files change", () => {
    expect(
      ownerOnly([
        changed("src/basket.ts"),
        changed("package.json"),
        changed(".npmrc"),
      ]),
    ).toEqual(["it changes what CI runs"]);
  });

  it("counts a renamed file's old path: moving package.json away changes what CI runs", () => {
    expect(
      ownerOnly([changed("old/package.json.bak", "package.json")]),
    ).toEqual(["it changes what CI runs"]);
  });

  it("names what later Agents read, beside what CI runs", () => {
    expect(ownerOnly([changed(memoryPath)])).toEqual([
      "it changes what later Agents read as memory, Skills or instructions",
    ]);
    expect(
      ownerOnly([changed("package.json"), changed(".claude/settings.json")]),
    ).toEqual([
      "it changes what CI runs",
      "it changes what later Agents read as memory, Skills or instructions",
    ]);
    // Moving the memory away changes it too.
    expect(ownerOnly([changed("notes.md", memoryPath)])).toEqual([
      "it changes what later Agents read as memory, Skills or instructions",
    ]);
  });

  it("sends a pull request to the Owner when GitHub cannot list every file it changes", () => {
    const files = Array.from({ length: maxListedFiles }, (_, index) =>
      changed(`src/file-${String(index)}.ts`),
    );
    expect(ownerOnly(files)).toContain(
      "it changes more files than GitHub lists (3,000)",
    );
    expect(ownerOnly(files.slice(1))).not.toContain(
      "it changes more files than GitHub lists (3,000)",
    );
  });

  it("sends a pull request to the Owner when no reviewer can be shown it in full, whenever an approval was given (P1-11)", () => {
    expect(
      ownerOnly([
        changed("src/basket.ts"),
        { ...changed("logo.png"), patch: null },
      ]),
    ).toEqual([
      "no reviewer can be shown it in full (GitHub shows no diff of one of its files (binary, or too large))",
    ]);
    const long = `@@ -0,0 +1 @@\n+${"x".repeat(100_000)}`;
    expect(ownerOnly([{ ...changed("catalogue.json"), patch: long }])).toEqual([
      expect.stringMatching(
        /^no reviewer can be shown it in full \(its diff is [\d,]+ characters, more than the 100,000 a reviewer is shown\)$/,
      ),
    ]);
  });
});
