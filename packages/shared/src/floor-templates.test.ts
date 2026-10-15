import { describe, expect, it } from "vitest";

import {
  floorTemplateManifestSchema,
  managerInstructionsOf,
  parseFloorTemplateManifest,
  parseRoleDocument,
} from "./floor-templates.ts";

// The Floor Template format (PRD FR-99): a manifest checked as a whole, and
// each Role's file read into a library Role.

const manifest = {
  name: "Corner shop",
  description: "A small online shop.",
  icon: "shopping-bag",
  theme: "stockroom",
  roles: [
    { role: "merchandiser", count: 2 },
    { role: "brand-reviewer", count: 1 },
  ],
  settings: {
    setupCommand: "",
    testCommand: "pnpm theme-check",
    mergePolicy: "send_to_me",
    roundCap: 3,
    requiredReviewers: ["brand-reviewer"],
  },
  manager: { planningGuidance: "", firstIssue: null },
  labels: [{ name: "product", color: "c2e0c6" }],
};

const problems = (value: unknown): string[] => {
  const parsed = floorTemplateManifestSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map(
        ({ path, message }) => `${path.map(String).join(".")}: ${message}`,
      );
};

describe("a Floor Template's manifest", () => {
  it("takes a valid one, a label's description defaulting to none", () => {
    expect(floorTemplateManifestSchema.parse(manifest).labels).toEqual([
      { name: "product", color: "c2e0c6", description: "" },
    ]);
  });

  it("refuses a Role listed twice, and a required reviewer it starts no Agent in", () => {
    expect(
      problems({
        ...manifest,
        roles: [
          { role: "merchandiser", count: 2 },
          { role: "merchandiser", count: 1 },
          { role: "brand-reviewer", count: 0 },
        ],
      }),
    ).toEqual([
      'roles.1.role: "merchandiser" is listed twice.',
      'settings.requiredReviewers.0: "brand-reviewer" is a required reviewer, so the template starts at least one Agent in it.',
    ]);
  });

  it("refuses AI Office's own labels, a label twice, and an unknown field", () => {
    expect(
      problems({
        ...manifest,
        labels: [
          { name: "needs-work", color: "1d76db" },
          { name: "Product", color: "c2e0c6" },
          { name: "product", color: "#c2e0c6" },
        ],
      }),
    ).toEqual([
      "labels.0.name: AI Office makes that label on every Floor itself.",
      "labels.2.color: A label's color is six hex digits, without #.",
      'labels.2.name: The label "product" is listed twice.',
    ]);
    expect(
      problems({
        ...manifest,
        labels: [
          { name: "Product", color: "c2e0c6" },
          { name: "product", color: "c2e0c6" },
        ],
      }),
    ).toEqual(['labels.1.name: The label "product" is listed twice.']);
    expect(problems({ ...manifest, colour: "red" })).toEqual([
      ': Unrecognized key: "colour"',
    ]);
  });

  it("refuses a 3D theme the Office cannot draw", () => {
    expect(problems({ ...manifest, theme: "jungle" })).toEqual([
      "theme: The 3D theme is one of office, stockroom, studio, editorial, library, atelier, observatory, data-centre, device-lab.",
    ]);
  });

  it("refuses Manager's instructions longer than an Agent's extra instructions", () => {
    expect(
      problems({
        ...manifest,
        manager: { planningGuidance: "x".repeat(4001), firstIssue: null },
      }),
    ).toEqual([
      "manager: The Manager's planning guidance and first issue come to at most 4000 characters, an Agent's extra instructions.",
    ]);
  });

  it("reads YAML, saying where it is wrong", () => {
    expect(parseFloorTemplateManifest("name: [Blank\n")).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/^template\.yaml is not valid YAML: /)],
    });
    const parsed = parseFloorTemplateManifest("icon: rocket\n");
    expect(parsed.ok ? [] : parsed.problems).toContain(
      "icon: The icon is one of code, square, shopping-bag, megaphone, pen-line, book-open, palette, chart-column, server, smartphone.",
    );
  });
});

describe("the Manager's instructions from a template", () => {
  it("are empty with neither guidance nor a first issue", () => {
    expect(
      managerInstructionsOf({ planningGuidance: "", firstIssue: null }),
    ).toBe("");
  });

  it("give the guidance, then the first issue to suggest", () => {
    expect(
      managerInstructionsOf({
        planningGuidance: "Plan the catalogue first.",
        firstIssue: { title: "Price everything", body: "" },
      }),
    ).toBe(
      'Plan the catalogue first.\n\nWhen the Owner asks where to start, suggest they file this set-up issue first, titled "Price everything":',
    );
  });
});

describe("a Role's file", () => {
  const file = (frontmatter: string, body = "\n- Keep prices in pence.\n") =>
    `---\n${frontmatter}\n---\n${body}`;
  const fields = `name: merchandiser
stage: work
description: Arranges the catalogue.
skills: []
deskDressing: printouts
aiProvider: Claude
model: null`;

  it("is a library Role, its instructions the Markdown below the frontmatter", () => {
    expect(parseRoleDocument("merchandiser", file(fields))).toEqual({
      ok: true,
      role: {
        id: "merchandiser",
        name: "merchandiser",
        stage: "work",
        description: "Arranges the catalogue.",
        instructions: "- Keep prices in pence.",
        skills: [],
        deskDressing: "printouts",
        aiProvider: "Claude",
        model: null,
      },
    });
  });

  it("refuses a bad file name, missing frontmatter, instructions in it, and bad fields", () => {
    expect(parseRoleDocument("Merchandiser", file(fields))).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/^The file's name, "Merchandiser": /)],
    });
    expect(parseRoleDocument("manager", file(fields))).toMatchObject({
      ok: false,
    });
    expect(parseRoleDocument("merchandiser", "- Keep prices.\n")).toEqual({
      ok: false,
      problems: [
        "A Role's file starts with YAML frontmatter between two --- lines.",
      ],
    });
    expect(
      parseRoleDocument(
        "merchandiser",
        file(`${fields}\ninstructions: Keep prices.`),
      ),
    ).toEqual({
      ok: false,
      problems: ["Write the Role's instructions below the frontmatter."],
    });
    expect(
      parseRoleDocument(
        "merchandiser",
        file(
          fields
            .replace("aiProvider: Claude", "aiProvider: null")
            .replace("model: null", "model: claude-sonnet-5-5"),
        ),
      ),
    ).toEqual({
      ok: false,
      problems: ["Suggest an AI Provider for the Model."],
    });
  });
});
