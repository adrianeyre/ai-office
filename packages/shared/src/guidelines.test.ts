import { describe, expect, it } from "vitest";

import {
  isGuidelineFileName,
  maxGuidelineLength,
  parseGuideline,
  type Guideline,
  type RefusedGuideline,
} from "./guidelines.ts";
import { createRedactor } from "./redact.ts";

// Reading one Guideline (Guidelines, Specs and Hooks PRD, FR-102, FR-112):
// its front matter's inclusion, patterns and description, its name from
// its file name, its length, and the credential check. A file that breaks
// a rule is refused with its reason, which never repeats what a line holds.

const accepted = (fileName: string, text: string): Guideline => {
  const parsed = parseGuideline(fileName, text);
  if (!parsed.ok) {
    throw new Error(`Refused: ${parsed.refused.reason}`);
  }
  return parsed.guideline;
};

const refused = (fileName: string, text: string): RefusedGuideline => {
  const parsed = parseGuideline(fileName, text);
  if (parsed.ok) {
    throw new Error(`Accepted ${parsed.guideline.name}`);
  }
  return parsed.refused;
};

const file = (...lines: string[]): string => lines.join("\n");

describe("a Guideline's defaults", () => {
  it("is always included, with no patterns or description, without front matter", () => {
    const text = file("# Tech", "", "Use pnpm, never npm.", "");
    expect(accepted("tech.md", text)).toEqual({
      name: "tech",
      path: ".agents/guidelines/tech.md",
      inclusion: "always",
      fileMatchPatterns: [],
      description: null,
      content: text,
      body: "# Tech\n\nUse pnpm, never npm.",
    });
  });

  it("takes the defaults from empty front matter, and fields left without a value", () => {
    for (const text of [
      file("---", "---", "Use pnpm."),
      file("---", "inclusion:", "description:", "---", "Use pnpm."),
    ]) {
      expect(accepted("tech.md", text)).toMatchObject({
        inclusion: "always",
        fileMatchPatterns: [],
        description: null,
        body: "Use pnpm.",
      });
    }
  });

  it("keeps the whole file as content and the rules after the front matter as body", () => {
    const text = file(
      "---",
      "description: How we write things",
      "---",
      "",
      "Copy is in British English.",
      "",
    );
    const guideline = accepted("product.md", text);
    expect(guideline.content).toBe(text);
    expect(guideline.body).toBe("Copy is in British English.");
  });

  it("reads Windows line endings and a byte order mark", () => {
    const text = "\uFEFF---\r\ninclusion: manual\r\n---\r\nRules.\r\n";
    expect(accepted("tech.md", text)).toMatchObject({
      inclusion: "manual",
      body: "Rules.",
    });
  });
});

describe("each inclusion", () => {
  it("reads inclusion: always", () => {
    expect(
      accepted("tech.md", file("---", "inclusion: always", "---", "Rules.")),
    ).toMatchObject({ inclusion: "always", fileMatchPatterns: [] });
  });

  it("reads inclusion: fileMatch with one glob", () => {
    const guideline = accepted(
      "migrations.md",
      file(
        "---",
        "inclusion: fileMatch",
        'fileMatchPattern: "packages/db/**"',
        "description: How migrations and the schema are written",
        "---",
        "Every schema change is a new migration.",
      ),
    );
    expect(guideline).toMatchObject({
      name: "migrations",
      inclusion: "fileMatch",
      fileMatchPatterns: ["packages/db/**"],
      description: "How migrations and the schema are written",
      body: "Every schema change is a new migration.",
    });
  });

  it("reads inclusion: fileMatch with a list of globs", () => {
    expect(
      accepted(
        "web.md",
        file(
          "---",
          "inclusion: fileMatch",
          "fileMatchPattern:",
          '  - "apps/web/**/*.tsx"',
          "  - apps/web/**/*.css",
          "---",
          "Every page has a skip link.",
        ),
      ).fileMatchPatterns,
    ).toEqual(["apps/web/**/*.tsx", "apps/web/**/*.css"]);
  });

  it("reads inclusion: manual", () => {
    expect(
      accepted(
        "release-notes.md",
        file(
          "---",
          "inclusion: manual",
          "description: Only when an issue asks for it",
          "---",
          "Rules.",
        ),
      ),
    ).toMatchObject({
      inclusion: "manual",
      fileMatchPatterns: [],
      description: "Only when an issue asks for it",
    });
  });

  it("refuses any other inclusion", () => {
    for (const inclusion of ["sometimes", "FileMatch", "1", "[always]"]) {
      expect(
        refused(
          "tech.md",
          file("---", `inclusion: ${inclusion}`, "---", "Rules."),
        ),
      ).toMatchObject({
        refusal: "invalid",
        reason: "inclusion is always, fileMatch or manual.",
      });
    }
  });
});

describe("the file pattern", () => {
  it("is required for fileMatch", () => {
    expect(
      refused("db.md", file("---", "inclusion: fileMatch", "---", "Rules.")),
    ).toEqual({
      name: "db",
      path: ".agents/guidelines/db.md",
      refusal: "invalid",
      reason:
        "inclusion: fileMatch needs a fileMatchPattern: one glob, or a list of globs.",
      secretLines: [],
    });
  });

  it("is refused when empty, an empty list, or not text", () => {
    for (const pattern of [
      '""',
      "[]",
      '["packages/**", ""]',
      "3",
      "{ a: b }",
    ]) {
      expect(
        refused(
          "db.md",
          file(
            "---",
            "inclusion: fileMatch",
            `fileMatchPattern: ${pattern}`,
            "---",
            "Rules.",
          ),
        ).reason,
      ).toBe(
        "fileMatchPattern is one glob, or a list of globs, each one line of text.",
      );
    }
  });

  it("is refused without inclusion: fileMatch, so it never applies to every task", () => {
    for (const inclusion of [
      [],
      ["inclusion: always"],
      ["inclusion: manual"],
    ]) {
      expect(
        refused(
          "db.md",
          file(
            "---",
            ...inclusion,
            'fileMatchPattern: "packages/db/**"',
            "---",
            "Rules.",
          ),
        ).reason,
      ).toBe(
        "fileMatchPattern applies only with inclusion: fileMatch, which it does not say.",
      );
    }
  });
});

describe("the description", () => {
  it("is one line, trimmed", () => {
    expect(
      accepted("tech.md", file("---", "description: '  Our stack  '", "---"))
        .description,
    ).toBe("Our stack");
  });

  it("is refused across lines, or when not text", () => {
    for (const description of ['"one\\ntwo"', "|\n  one\n  two", "[a, b]"]) {
      expect(
        refused(
          "tech.md",
          file("---", `description: ${description}`, "---", "Rules."),
        ).reason,
      ).toBe("description is one line of text.");
    }
  });
});

describe("the front matter", () => {
  it("refuses a field a Guideline does not take, naming the field", () => {
    expect(
      refused(
        "db.md",
        file(
          "---",
          "inclusion: fileMatch",
          'fileMatchPatterns: "packages/db/**"',
          "---",
          "Rules.",
        ),
      ).reason,
    ).toBe(
      'Its front matter has "fileMatchPatterns", which a Guideline does not take: only inclusion, fileMatchPattern and description.',
    );
  });

  it("refuses front matter that is not a set of fields", () => {
    for (const yaml of ["- always", "always", "42"]) {
      expect(
        refused("tech.md", file("---", yaml, "---", "Rules.")).reason,
      ).toBe(
        "Its front matter is a set of fields: inclusion, fileMatchPattern and description.",
      );
    }
  });

  it("refuses front matter that is never closed", () => {
    expect(
      refused("tech.md", file("---", "inclusion: always", "Rules.")).reason,
    ).toBe(
      "Its front matter opens with a --- line but has no closing --- line.",
    );
  });
});

describe("bad YAML", () => {
  it("is refused, saying where in the file without quoting it", () => {
    const found = refused(
      "tech.md",
      file(
        "---",
        "inclusion: always",
        'description: "never closed',
        "---",
        "Rules.",
      ),
    );
    expect(found.refusal).toBe("invalid");
    expect(found.reason).toMatch(
      /^Its front matter is not valid YAML at line \d+, column \d+\.$/,
    );
    expect(found.reason).not.toContain("never closed");
  });

  it("counts the line from the top of the file", () => {
    expect(
      refused(
        "tech.md",
        file("---", "inclusion: always", "inclusion: manual", "---"),
      ).reason,
    ).toBe("Its front matter is not valid YAML at line 3, column 1.");
  });

  it("refuses aliases, which could blow up as they are read", () => {
    expect(
      refused(
        "tech.md",
        file("---", "description: &d hello", "inclusion: *d", "---"),
      ).reason,
    ).toMatch(/^Its front matter is not valid YAML/);
  });
});

describe("the name", () => {
  it("is the file name without .md", () => {
    expect(accepted("api-v2.md", "Rules.").name).toBe("api-v2");
  });

  it.each([
    ["README.md", "README"],
    ["Tech.md", "Tech"],
    ["my_rules.md", "my_rules"],
    ["two words.md", "two words"],
    ["tech.MD", "tech"],
    ["tech.v2.md", "tech.v2"],
  ])("refuses %s, keeping it with its reason", (fileName, name) => {
    expect(refused(fileName, "Rules.")).toEqual({
      name,
      path: `.agents/guidelines/${fileName}`,
      refusal: "invalid",
      reason:
        "A Guideline's name is its file name without .md, in lowercase letters, digits and dashes, such as migrations.md.",
      secretLines: [],
    });
  });

  it("knows a Guideline's file by its name", () => {
    expect(isGuidelineFileName("tech.md")).toBe(true);
    expect(isGuidelineFileName("README.MD")).toBe(true);
    expect(isGuidelineFileName(".md")).toBe(false);
    expect(isGuidelineFileName("notes.txt")).toBe(false);
    expect(isGuidelineFileName("tech.md.bak")).toBe(false);
  });
});

describe("the length", () => {
  it("takes a Guideline of exactly 12,000 characters", () => {
    expect(maxGuidelineLength).toBe(12_000);
    const text = file("---", "inclusion: always", "---", "");
    const full = text + "a".repeat(maxGuidelineLength - text.length);
    expect(full).toHaveLength(12_000);
    expect(accepted("tech.md", full).content).toBe(full);
  });

  it("refuses one over 12,000 characters, front matter and all", () => {
    expect(refused("tech.md", "a".repeat(12_001))).toMatchObject({
      refusal: "invalid",
      reason: "A Guideline is at most 12,000 characters; this one has 12,001.",
    });
  });
});

describe("the credential check (FR-112)", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

  it("refuses a Guideline with a line that looks like a credential, naming the line and never its text", () => {
    const text = file(
      "---",
      "inclusion: always",
      "---",
      "Deploy with the shared token:",
      `    ${token}`,
      "and nothing else.",
    );
    const found = refused("deploy.md", text);
    expect(found).toEqual({
      name: "deploy",
      path: ".agents/guidelines/deploy.md",
      refusal: "holds_secret",
      reason:
        "Line 5 looks like it holds a credential, which a Guideline never does: take it out.",
      secretLines: [5],
    });
    expect(JSON.stringify(found)).not.toContain(token);
    expect(JSON.stringify(found)).not.toContain("ghp_");
  });

  it("names every such line", () => {
    const found = refused(
      "deploy.md",
      file(
        "The database password: hunter2-staging",
        "Fine.",
        "DEPLOY_TOKEN=f3a9c2e1b7d04a6f9e8c3b2a1d0e9f8c",
        `Push with ${token}`,
      ),
    );
    expect(found.secretLines).toEqual([1, 3, 4]);
    expect(found.reason).toBe(
      "Lines 1, 3 and 4 look like they hold a credential, which a Guideline never does: take them out.",
    );
    for (const secret of ["hunter2", "f3a9c2e1", token]) {
      expect(JSON.stringify(found)).not.toContain(secret);
    }
  });

  it("finds one in the front matter, ahead of any other problem", () => {
    // Bad YAML, a bad name and too long as well: the credential comes first,
    // so no other reason can come near the line.
    const text = file(
      "---",
      `description: "${token}`,
      "---",
      "a".repeat(maxGuidelineLength),
    );
    const found = refused("Deploy.md", text);
    expect(found.refusal).toBe("holds_secret");
    expect(found.secretLines).toEqual([2]);
    expect(found.reason).not.toContain(token);
  });

  it("refuses what the Office's own redactor knows is a secret", () => {
    const redactor = createRedactor({ secrets: ["correct-horse-battery"] });
    const parsed = parseGuideline(
      "tech.md",
      file("Rules.", "Sign in as correct-horse-battery."),
      { redactor },
    );
    expect(parsed).toMatchObject({
      ok: false,
      refused: { refusal: "holds_secret", secretLines: [2] },
    });
    expect(JSON.stringify(parsed)).not.toContain("correct-horse");
  });

  it("takes rules that only talk about credentials", () => {
    expect(
      accepted(
        "secrets.md",
        file(
          "Never commit a credential.",
          "Read API keys from the environment, never from a file.",
        ),
      ).inclusion,
    ).toBe("always");
  });
});
