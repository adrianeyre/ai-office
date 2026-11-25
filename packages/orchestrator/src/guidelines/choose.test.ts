import { parseGuideline, type Guideline } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  chooseGuidelines,
  guidelinesWithin,
  matchesPattern,
} from "./choose.ts";

// Choosing a task's Guidelines (Guidelines, Specs and Hooks PRD, FR-105,
// FR-108): `always` for every task, `fileMatch` by the Plan's files (work,
// designer) or the pull request's (review, QA, docs), `manual` by a
// `guideline:<name>` label, and the Manager told of the rest; then the
// budget, which leaves out `fileMatch` before `always`, the largest first.

const guideline = (
  name: string,
  frontMatter: readonly string[],
  body = `The ${name} rules.`,
): Guideline => {
  const text =
    frontMatter.length === 0
      ? `${body}\n`
      : ["---", ...frontMatter, "---", "", body, ""].join("\n");
  const parsed = parseGuideline(`${name}.md`, text);
  if (!parsed.ok) {
    throw new Error(parsed.refused.reason);
  }
  return parsed.guideline;
};

const tech = guideline("tech", [], "Use pnpm and strict TypeScript.");
const product = guideline("product", ["inclusion: always"]);
const migrations = guideline("migrations", [
  "inclusion: fileMatch",
  'fileMatchPattern: "packages/db/**"',
  "description: How migrations are written.",
]);
const web = guideline("web", [
  "inclusion: fileMatch",
  "fileMatchPattern:",
  '  - "apps/web/**/*.tsx"',
  '  - "apps/web/**/*.css"',
]);
const release = guideline("release", [
  "inclusion: manual",
  "description: Cutting a release.",
]);
const floor = [web, tech, release, migrations, product];

const names = (guidelines: readonly Guideline[]) =>
  guidelines.map(({ name }) => name);

describe("matching a file to a Guideline's pattern", () => {
  it("reads globs from the top of the repository", () => {
    expect(matchesPattern("packages/db/**", "packages/db/schema.ts")).toBe(
      true,
    );
    expect(matchesPattern("packages/db/**", "packages/db/sql/0001.sql")).toBe(
      true,
    );
    expect(matchesPattern("packages/db/**", "packages/dbx/schema.ts")).toBe(
      false,
    );
    expect(matchesPattern("**/*.sql", "0001.sql")).toBe(true);
    expect(matchesPattern("**/*.sql", "packages/db/0001.sql")).toBe(true);
    expect(matchesPattern("*.md", "docs/guide.md")).toBe(false);
    expect(matchesPattern("src/*.{ts,tsx}", "src/app.tsx")).toBe(true);
  });

  it("takes a path or a glob written with ./ or / at its start", () => {
    expect(matchesPattern("./packages/db/**", "packages/db/schema.ts")).toBe(
      true,
    );
    expect(matchesPattern("packages/db/**", "/packages/db/schema.ts")).toBe(
      true,
    );
    expect(matchesPattern("", "packages/db/schema.ts")).toBe(false);
    expect(matchesPattern("packages/db/**", "")).toBe(false);
  });
});

describe("choosing a task's Guidelines (FR-105)", () => {
  it("gives every task the always Guidelines, and only those with nothing else asked for", () => {
    for (const task of ["work", "review", "qa", "docs", "design"] as const) {
      const chosen = chooseGuidelines(floor, { task, files: [], labels: [] });
      expect(names(chosen.followed), task).toEqual(["product", "tech"]);
    }
  });

  it("gives the work Stage the fileMatch Guidelines the Plan's files match, and lists the rest to read before changing a matching file", () => {
    const chosen = chooseGuidelines(floor, {
      task: "work",
      files: ["packages/db/schema.ts", "README.md"],
      labels: [],
    });
    expect(names(chosen.followed)).toEqual(["migrations", "product", "tech"]);
    expect(names(chosen.listed)).toEqual(["web"]);
  });

  it("gives the designer the same, by the Plan's files", () => {
    const chosen = chooseGuidelines(floor, {
      task: "design",
      files: ["apps/web/src/basket.tsx"],
      labels: [],
    });
    expect(names(chosen.followed)).toEqual(["product", "tech", "web"]);
    expect(names(chosen.listed)).toEqual(["migrations"]);
  });

  it("lists every fileMatch Guideline to the work Stage when the Plan names no files, or there is no Plan", () => {
    const chosen = chooseGuidelines(floor, {
      task: "work",
      files: [],
      labels: [],
    });
    expect(names(chosen.followed)).toEqual(["product", "tech"]);
    expect(names(chosen.listed)).toEqual(["migrations", "web"]);
  });

  it("gives review, QA and docs the fileMatch Guidelines the pull request's files match, and lists no others", () => {
    for (const task of ["review", "qa", "docs"] as const) {
      const chosen = chooseGuidelines(floor, {
        task,
        files: ["apps/web/src/theme.css"],
        labels: [],
      });
      expect(names(chosen.followed), task).toEqual(["product", "tech", "web"]);
      expect(chosen.listed, task).toEqual([]);
    }
  });

  it("gives a manual Guideline to an issue labelled guideline:<name>, in any case, and to no other", () => {
    for (const task of ["work", "review", "qa", "docs", "design"] as const) {
      expect(
        names(
          chooseGuidelines(floor, {
            task,
            files: [],
            labels: ["ai-office", "Guideline:Release"],
          }).followed,
        ),
        task,
      ).toContain("release");
      expect(
        names(
          chooseGuidelines(floor, {
            task,
            files: [],
            labels: ["ai-office", "guideline:releases", "role:release"],
          }).followed,
        ),
        task,
      ).not.toContain("release");
    }
  });

  it("ignores a guideline:<name> label naming no manual Guideline", () => {
    for (const task of ["work", "review", "qa", "docs", "design"] as const) {
      const labels = ["guideline:nothing", "guideline:migrations"];
      expect(
        chooseGuidelines(floor, { task, files: [], labels }),
        task,
      ).toEqual(chooseGuidelines(floor, { task, files: [], labels: [] }));
    }
  });

  it("gives the Manager's triage, Plan and chat the always Guidelines, and tells them of the rest, whatever the labels and files", () => {
    for (const task of ["triage", "plan", "chat"] as const) {
      const chosen = chooseGuidelines(floor, {
        task,
        files: ["packages/db/schema.ts"],
        labels: ["guideline:release"],
      });
      expect(names(chosen.followed), task).toEqual(["product", "tech"]);
      expect(names(chosen.listed), task).toEqual([
        "migrations",
        "release",
        "web",
      ]);
    }
  });

  it("chooses nothing from a Floor without Guidelines", () => {
    expect(
      chooseGuidelines([], {
        task: "work",
        files: ["a.ts"],
        labels: ["guideline:release"],
      }),
    ).toEqual({ followed: [], listed: [] });
  });
});

describe("the Guidelines' budget (FR-108)", () => {
  const sized = (
    name: string,
    inclusion: "always" | "fileMatch" | "manual",
    characters: number,
  ): Guideline => {
    const frontMatter =
      inclusion === "always"
        ? []
        : inclusion === "manual"
          ? ["inclusion: manual"]
          : ["inclusion: fileMatch", 'fileMatchPattern: "**"'];
    const head =
      frontMatter.length === 0
        ? ""
        : ["---", ...frontMatter, "---", "", ""].join("\n");
    const made = guideline(name, frontMatter, "x");
    const content = `${head}${"x".repeat(characters - head.length)}`;
    expect(content).toHaveLength(characters);
    return { ...made, content, body: content.slice(head.length) };
  };

  it("keeps every Guideline that fits, as it is", () => {
    const followed = [
      sized("a", "always", 6000),
      sized("b", "fileMatch", 6000),
    ];
    expect(guidelinesWithin(followed, 12_000)).toEqual({
      kept: followed,
      leftOut: [],
      characters: 12_000,
    });
  });

  it("leaves out fileMatch Guidelines before always ones, the largest first, until the rest fit", () => {
    const always = sized("tech", "always", 5000);
    const small = sized("api", "fileMatch", 2000);
    const large = sized("migrations", "fileMatch", 4000);
    const larger = sized("web", "fileMatch", 4500);
    const within = guidelinesWithin([small, large, always, larger], 12_000);
    expect(names(within.leftOut)).toEqual(["web"]);
    expect(names(within.kept)).toEqual(["api", "migrations", "tech"]);
    expect(within.characters).toBe(15_500);

    const tighter = guidelinesWithin([small, large, always, larger], 6000);
    expect(names(tighter.leftOut)).toEqual(["web", "migrations", "api"]);
    expect(names(tighter.kept)).toEqual(["tech"]);
  });

  it("leaves out manual Guidelines after fileMatch ones, and always ones last", () => {
    const within = guidelinesWithin(
      [
        sized("tech", "always", 7000),
        sized("release", "manual", 3000),
        sized("api", "fileMatch", 1000),
        sized("product", "always", 6000),
      ],
      6500,
    );
    expect(names(within.leftOut)).toEqual(["api", "release", "tech"]);
    expect(names(within.kept)).toEqual(["product"]);
  });

  it("is the same every time, by name between two of a size", () => {
    const followed = [
      sized("b", "fileMatch", 5000),
      sized("a", "fileMatch", 5000),
      sized("c", "always", 5000),
    ];
    const first = guidelinesWithin(followed, 10_000);
    expect(names(first.leftOut)).toEqual(["a"]);
    for (let time = 0; time < 5; time += 1) {
      expect(guidelinesWithin([...followed].reverse(), 10_000).leftOut).toEqual(
        first.leftOut,
      );
    }
  });
});
