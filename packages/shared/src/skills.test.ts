import { describe, expect, it } from "vitest";

import {
  addSkillRequestSchema,
  describeSkill,
  importSkillRequestSchema,
  maxSkillBytes,
  maxSkillFiles,
  parseSkillDocument,
  skillFilesSchema,
  skillProblems,
  skillTemplate,
  skillUpdateSchema,
  type SkillFile,
} from "./skills.ts";

// The Agent Skills format (PRD FR-71): a folder with a SKILL.md whose YAML
// frontmatter has a name and a description, then instructions, plus any
// supporting files.

const skillMd = (frontmatter: string, body = "\nDo the thing.\n"): string =>
  `---\n${frontmatter}\n---\n${body}`;

const pdf = skillMd(
  "name: pdf-processing\ndescription: Extract PDF text and fill forms. Use when handling PDFs.",
);

const files = (content: string, more: SkillFile[] = []): SkillFile[] => [
  { path: "SKILL.md", content },
  ...more,
];

const problemsOf = (content: string): string[] => {
  const parsed = parseSkillDocument(content);
  return parsed.ok ? [] : parsed.problems;
};

describe("SKILL.md frontmatter", () => {
  it("reads the name, description, other fields and instructions", () => {
    const parsed = parseSkillDocument(
      skillMd(
        [
          "name: pdf-processing",
          "description: >-",
          "  Extract PDF text and fill forms.",
          "  Use when handling PDFs.",
          "license: Apache-2.0",
          "compatibility: Requires Python 3.14+",
          "metadata:",
          "  author: example-org",
          '  version: "1.0"',
          "allowed-tools: Bash(git:*) Read",
          // Fields beyond the format's, such as Claude Code's, are kept.
          "disable-model-invocation: true",
        ].join("\n"),
        "\n# PDF\n\nSteps.\n",
      ),
    );
    expect(parsed).toEqual({
      ok: true,
      document: {
        name: "pdf-processing",
        description: "Extract PDF text and fill forms. Use when handling PDFs.",
        frontmatter: {
          name: "pdf-processing",
          description:
            "Extract PDF text and fill forms. Use when handling PDFs.",
          license: "Apache-2.0",
          compatibility: "Requires Python 3.14+",
          metadata: { author: "example-org", version: "1.0" },
          "allowed-tools": "Bash(git:*) Read",
          "disable-model-invocation": true,
        },
        instructions: "\n# PDF\n\nSteps.\n",
      },
    });
  });

  it("takes Windows line endings, a byte-order mark and an empty body", () => {
    const parsed = parseSkillDocument(
      "\uFEFF---\r\nname: a\r\ndescription: b\r\n---",
    );
    expect(parsed.ok && parsed.document).toMatchObject({
      name: "a",
      description: "b",
      instructions: "",
    });
  });

  it("names valid Skills as the format allows", () => {
    for (const name of [
      "a",
      "pdf",
      "pdf-processing",
      "data-analysis-2",
      "x".repeat(64),
    ]) {
      expect(problemsOf(skillMd(`name: ${name}\ndescription: d`))).toEqual([]);
    }
  });

  it("refuses names the format does not allow", () => {
    const nameRule =
      "A Skill's name uses only lowercase letters, digits and single hyphens, and does not start or end with a hyphen.";
    for (const name of [
      "PDF-Processing",
      "-pdf",
      "pdf-",
      "pdf--processing",
      "pdf_processing",
      "pdf processing",
      "café",
    ]) {
      expect(problemsOf(skillMd(`name: "${name}"\ndescription: d`))).toEqual([
        nameRule,
      ]);
    }
    expect(
      problemsOf(skillMd(`name: ${"x".repeat(65)}\ndescription: d`)),
    ).toEqual(["A Skill's name is at most 64 characters."]);
    expect(problemsOf(skillMd("description: d"))).toEqual([
      "The frontmatter needs a name.",
    ]);
    expect(problemsOf(skillMd('name: ""\ndescription: d'))).toContain(
      "The frontmatter needs a name.",
    );
    expect(problemsOf(skillMd("name: 42\ndescription: d"))).toEqual([
      "The frontmatter needs a name.",
    ]);
  });

  it("needs a description of 1 to 1024 characters", () => {
    expect(problemsOf(skillMd("name: a"))).toEqual([
      "The frontmatter needs a description.",
    ]);
    expect(problemsOf(skillMd('name: a\ndescription: "   "'))).toEqual([
      "The frontmatter needs a description.",
    ]);
    expect(problemsOf(skillMd("name: a\ndescription: [1, 2]"))).toEqual([
      "The frontmatter needs a description.",
    ]);
    expect(
      problemsOf(skillMd(`name: a\ndescription: ${"d".repeat(1024)}`)),
    ).toEqual([]);
    expect(
      problemsOf(skillMd(`name: a\ndescription: ${"d".repeat(1025)}`)),
    ).toEqual(["A Skill's description is at most 1024 characters."]);
  });

  it("checks the optional fields the format defines", () => {
    const base = "name: a\ndescription: d\n";
    expect(problemsOf(skillMd(`${base}compatibility: ""`))).toEqual([
      "Compatibility, when given, is not empty.",
    ]);
    expect(
      problemsOf(skillMd(`${base}compatibility: ${"c".repeat(501)}`)),
    ).toEqual(["Compatibility is at most 500 characters."]);
    expect(problemsOf(skillMd(`${base}metadata:\n  version: 1`))).toEqual([
      "Metadata maps names to text.",
    ]);
    expect(problemsOf(skillMd(`${base}metadata: [a]`))).toEqual([
      "Metadata maps names to text.",
    ]);
    expect(problemsOf(skillMd(`${base}allowed-tools: [Read]`))).toEqual([
      "Allowed tools are one line of text.",
    ]);
    expect(problemsOf(skillMd(`${base}license: 2`))).toEqual([
      "The license is text.",
    ]);
  });

  it("needs frontmatter between two --- lines, as a set of fields", () => {
    const missing = [
      "SKILL.md starts with YAML frontmatter between two --- lines.",
    ];
    expect(problemsOf("# Just Markdown\n")).toEqual(missing);
    expect(problemsOf("---\nname: a\ndescription: d\n")).toEqual(missing);
    expect(problemsOf("\n---\nname: a\ndescription: d\n---\n")).toEqual(
      missing,
    );
    expect(problemsOf("---\n---\n")).toEqual([
      "The frontmatter of SKILL.md is a set of fields, such as name and description.",
    ]);
    expect(problemsOf("---\n- name: a\n---\n")).toEqual([
      "The frontmatter of SKILL.md is a set of fields, such as name and description.",
    ]);
    expect(problemsOf(skillMd("name: a\nname: b\ndescription: d"))[0]).toMatch(
      /^The frontmatter of SKILL\.md is not valid YAML: /,
    );
    expect(problemsOf(skillMd("name: [a\ndescription: d"))[0]).toMatch(
      /^The frontmatter of SKILL\.md is not valid YAML/,
    );
  });

  it("refuses YAML aliases, so a small file cannot expand", () => {
    expect(
      problemsOf(skillMd("x: &x [1, 2]\nname: a\ndescription: d\ny: *x"))[0],
    ).toMatch(/^The frontmatter of SKILL\.md is not valid YAML/);
  });

  it("starts the editor with a valid Skill", () => {
    expect(skillProblems(files(skillTemplate))).toEqual([]);
    expect(describeSkill(files(skillTemplate)).name).toBe("my-skill");
  });
});

describe("a Skill's files", () => {
  it("are a SKILL.md and any supporting files", () => {
    const skill = files(pdf, [
      { path: "scripts/extract.py", content: "print('hi')\n" },
      { path: "references/REFERENCE.md", content: "# Reference\n" },
      { path: "assets/template.txt", content: "" },
    ]);
    expect(skillProblems(skill)).toEqual([]);
    expect(skillFilesSchema.parse(skill)).toEqual(skill);
    expect(describeSkill(skill)).toMatchObject({
      name: "pdf-processing",
      description: "Extract PDF text and fill forms. Use when handling PDFs.",
    });
  });

  it("must include a valid SKILL.md at the top of the folder", () => {
    expect(skillProblems([{ path: "README.md", content: "# Hi" }])).toEqual([
      "A Skill has a SKILL.md at the top of its folder.",
    ]);
    expect(skillProblems([{ path: "pdf/SKILL.md", content: pdf }])).toEqual([
      "A Skill has a SKILL.md at the top of its folder.",
    ]);
    expect(skillProblems(files(skillMd("name: Bad\ndescription: d")))).toEqual([
      "A Skill's name uses only lowercase letters, digits and single hyphens, and does not start or end with a hyphen.",
    ]);
    expect(skillFilesSchema.safeParse([]).success).toBe(false);
  });

  it("keeps every path relative and inside the folder", () => {
    for (const path of [
      "/etc/passwd",
      "../outside.md",
      "scripts/../../outside.md",
      "./SKILL2.md",
      "scripts//x.py",
      "scripts/",
      "scripts\\x.py",
      "bad\nname.md",
      "",
      "x".repeat(301),
    ]) {
      expect(
        skillFilesSchema.safeParse(files(pdf, [{ path, content: "x" }]))
          .success,
        path,
      ).toBe(false);
    }
  });

  it("refuses repeated paths, paths that differ only in case, and a file used as a folder", () => {
    expect(
      skillProblems(
        files(pdf, [
          { path: "notes.md", content: "a" },
          { path: "notes.md", content: "b" },
        ]),
      ),
    ).toEqual(['"notes.md" is in the Skill twice.']);
    expect(
      skillProblems(
        files(pdf, [
          { path: "Notes.md", content: "a" },
          { path: "notes.md", content: "b" },
        ]),
      ),
    ).toEqual(['"Notes.md" and "notes.md" differ only in case.']);
    expect(
      skillProblems(
        files(pdf, [
          { path: "scripts", content: "a" },
          { path: "scripts/x.py", content: "b" },
        ]),
      ),
    ).toEqual(['"scripts" is a file, so it cannot also be a folder.']);
  });

  it("holds only text", () => {
    expect(
      skillFilesSchema.safeParse(
        files(pdf, [{ path: "logo.png", content: "\u0089PNG\u0000\u0000" }]),
      ).error?.issues[0]?.message,
    ).toBe("Skills hold text files only.");
  });

  it("stays within the file count and size limits", () => {
    const many = files(
      pdf,
      Array.from({ length: maxSkillFiles }, (_, index) => ({
        path: `notes/${String(index)}.md`,
        content: "x",
      })),
    );
    expect(skillProblems(many)).toEqual([
      `A Skill holds at most 200 files; this has ${String(maxSkillFiles + 1)}.`,
    ]);
    expect(skillProblems(many.slice(0, maxSkillFiles))).toEqual([]);

    const large = files(pdf, [
      { path: "big.md", content: "é".repeat(maxSkillBytes / 2) },
    ]);
    expect(skillProblems(large)[0]).toMatch(
      /^A Skill's files come to at most 4 MB; these are 4\.0 MB\.$/,
    );
  });

  it("must be named as its folder, when the folder is known", () => {
    expect(skillProblems(files(pdf), { folder: "pdf-processing" })).toEqual([]);
    expect(skillProblems(files(pdf), { folder: "pdf" })).toEqual([
      'The Skill is named "pdf-processing", so its folder is "pdf-processing", not "pdf".',
    ]);
  });
});

describe("requests", () => {
  it("adds a Skill by upload or from the editor, checking its folder's name", () => {
    expect(
      addSkillRequestSchema.safeParse({
        source: "upload",
        files: files(pdf),
        folder: "pdf-processing",
      }).success,
    ).toBe(true);
    expect(
      addSkillRequestSchema.safeParse({ source: "editor", files: files(pdf) })
        .success,
    ).toBe(true);
    const misnamed = addSkillRequestSchema.safeParse({
      source: "upload",
      files: files(pdf),
      folder: "pdf",
    });
    expect(misnamed.error?.issues.map(({ message }) => message)).toEqual([
      'The Skill is named "pdf-processing", so its folder is "pdf-processing", not "pdf".',
    ]);
    // Git imports have their own route.
    expect(
      addSkillRequestSchema.safeParse({ source: "git", files: files(pdf) })
        .success,
    ).toBe(false);
    expect(
      addSkillRequestSchema.safeParse({
        source: "upload",
        files: files(pdf),
        folder: "a/b",
      }).success,
    ).toBe(false);
  });

  it("imports from a public https repository, without credentials", () => {
    const ok = (body: object) =>
      importSkillRequestSchema.safeParse(body).success;
    expect(ok({ url: "https://github.com/anthropics/skills" })).toBe(true);
    expect(
      importSkillRequestSchema.parse({
        url: "https://github.com/anthropics/skills.git",
        ref: "main",
        path: "/skills/pdf/",
      }),
    ).toEqual({
      url: "https://github.com/anthropics/skills.git",
      ref: "main",
      path: "skills/pdf",
    });
    expect(ok({ url: "http://github.com/anthropics/skills" })).toBe(false);
    expect(ok({ url: "file:///etc" })).toBe(false);
    expect(ok({ url: "ssh://git@github.com/anthropics/skills" })).toBe(false);
    expect(ok({ url: "https://token@github.com/anthropics/skills" })).toBe(
      false,
    );
    expect(ok({ url: "https://u:p@github.com/anthropics/skills" })).toBe(false);
    expect(ok({ url: "https://github.com/a/b?x=1" })).toBe(false);
    for (const ref of ["v1.2.0", "release/2026-10", "main"]) {
      expect(ok({ url: "https://github.com/a/b", ref })).toBe(true);
    }
    for (const ref of ["--upload-pack=x", "a..b", "a b", "a/", "a//b", ""]) {
      expect(ok({ url: "https://github.com/a/b", ref }), ref).toBe(false);
    }
    expect(ok({ url: "https://github.com/a/b", path: "../x" })).toBe(false);
    expect(
      importSkillRequestSchema.parse({
        url: "https://github.com/a/b",
        path: "/",
      }).path,
    ).toBe("");
  });

  it("changes a Skill's files, or turns it on or off", () => {
    expect(skillUpdateSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(skillUpdateSchema.safeParse({ files: files(pdf) }).success).toBe(
      true,
    );
    expect(skillUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      skillUpdateSchema.safeParse({ files: [{ path: "a.md", content: "" }] })
        .success,
    ).toBe(false);
    expect(skillUpdateSchema.safeParse({ reviewedAt: "now" }).success).toBe(
      false,
    );
  });
});
