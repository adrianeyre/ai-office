import { describe, expect, it } from "vitest";

import { grillingTurnSchema } from "./grilling.ts";
import {
  newGrillingSpec,
  nextSpecPhase,
  specCriterion,
  specCriterionId,
  specDesignDocument,
  specDocument,
  specDocumentPath,
  specPhaseBefore,
  specRequirementsDocument,
  specTasksDocument,
} from "./spec.ts";

// A Spec's phases, its turn's documents and the documents plain code
// writes from them (Guidelines, Specs and Hooks PRD, FR-113).

const requirements = {
  introduction: "Shoppers keep cards to pay faster.",
  requirements: [
    {
      title: "Save a card",
      story: "As a shopper, I want to save my card, so that I pay faster.",
      criteria: [
        "R1.1 WHEN a shopper ticks Save card THE SYSTEM SHALL keep the card's token.",
        "R1.2 WHEN a card is saved THE SYSTEM SHALL show its last four digits.",
      ],
    },
  ],
};

describe("a Spec's phases", () => {
  it("go requirements, design, tasks, with nothing after the tasks", () => {
    expect(nextSpecPhase("requirements")).toBe("design");
    expect(nextSpecPhase("design")).toBe("tasks");
    expect(nextSpecPhase("tasks")).toBeUndefined();
    expect(specPhaseBefore("requirements", "tasks")).toBe(true);
    expect(specPhaseBefore("tasks", "design")).toBe(false);
    expect(specPhaseBefore("design", "design")).toBe(false);
  });

  it("start drafting the requirements, with nothing approved", () => {
    expect(newGrillingSpec("saved-cards")).toEqual({
      slug: "saved-cards",
      phase: "requirements",
      drafts: { requirements: null, design: null, tasks: null },
      approved: { requirements: null, design: null, tasks: null },
      designSkipped: false,
      confirmedAt: { requirements: null, design: null, tasks: null },
    });
  });

  it("write each document in the Spec's folder under .agents/specs/", () => {
    expect(specDocumentPath("saved-cards", "requirements")).toBe(
      ".agents/specs/saved-cards/requirements.md",
    );
    expect(specDocumentPath("saved-cards", "design")).toBe(
      ".agents/specs/saved-cards/design.md",
    );
    expect(specDocumentPath("saved-cards", "tasks")).toBe(
      ".agents/specs/saved-cards/tasks.md",
    );
  });
});

describe("a /spec turn's documents", () => {
  it("are none by default, for every other session", () => {
    expect(grillingTurnSchema.parse({}).spec).toEqual({});
  });

  it("keep user stories with their criteria, a design's four sections and tasks with what they meet", () => {
    const parsed = grillingTurnSchema.parse({
      spec: {
        requirements,
        design: {
          architecture: "A card vault behind the checkout.",
          data: "A saved_cards table.",
          errorHandling: "A declined card is never saved.",
          testing: "One test per criterion.",
        },
        tasks: [
          { title: "Save a card", description: "End to end.", meets: ["R1.1"] },
        ],
      },
    });
    expect(parsed.spec.requirements).toEqual(requirements);
    expect(parsed.spec.design).toEqual({
      overview: "",
      architecture: "A card vault behind the checkout.",
      data: "A saved_cards table.",
      errorHandling: "A declined card is never saved.",
      testing: "One test per criterion.",
    });
    expect(parsed.spec.tasks).toEqual([
      {
        title: "Save a card",
        description: "End to end.",
        meets: ["R1.1"],
        dependsOn: [],
      },
    ]);
  });

  it("refuse a story without criteria, a design without its testing, and a task meeting nothing", () => {
    const problems = (spec: unknown) => {
      const parsed = grillingTurnSchema.safeParse({ spec });
      return parsed.success
        ? []
        : parsed.error.issues.map(({ message }) => message);
    };
    expect(
      problems({
        requirements: {
          requirements: [{ title: "Save", story: "As a…", criteria: [] }],
        },
      }),
    ).toEqual(["A user story has at least one Acceptance Criterion."]);
    expect(
      problems({
        design: { architecture: "A.", data: "D.", errorHandling: "E." },
      }),
    ).toEqual(["The design's testing approach is text."]);
    expect(
      problems({ tasks: [{ title: "T", description: "D.", meets: [] }] }),
    ).toEqual(["A task names at least one Acceptance Criterion it meets."]);
  });
});

describe("a Spec's documents", () => {
  it("write requirements.md with each story and its criteria as written", () => {
    expect(
      specRequirementsDocument("checkout with saved cards", "x", requirements),
    ).toBe(
      [
        "# Requirements: checkout with saved cards",
        "",
        "Shoppers keep cards to pay faster.",
        "",
        "## Requirement 1: Save a card",
        "",
        "**User story:** As a shopper, I want to save my card, so that I pay faster.",
        "",
        "### Acceptance Criteria",
        "",
        "- R1.1 WHEN a shopper ticks Save card THE SYSTEM SHALL keep the card's token.",
        "- R1.2 WHEN a card is saved THE SYSTEM SHALL show its last four digits.",
        "",
      ].join("\n"),
    );
  });

  it("write design.md with its architecture, data, error handling and testing", () => {
    const text = specDesignDocument("", "saved-cards", {
      overview: "",
      architecture: "A vault.",
      data: "A table.",
      errorHandling: "Declines are not saved.",
      testing: "Per criterion.",
    });
    expect(text).toBe(
      "# Design: saved-cards\n\n## Architecture\n\nA vault.\n\n## Data\n\nA table.\n\n## Error handling\n\nDeclines are not saved.\n\n## Testing\n\nPer criterion.\n",
    );
  });

  it("write tasks.md in order, each with what it meets and depends on, and no status", () => {
    const text = specTasksDocument("saved cards", "saved-cards", [
      {
        title: "Save a card",
        description: "The vault and the tick box.",
        meets: ["R1.1"],
        dependsOn: [],
      },
      {
        title: "Show saved cards",
        description: "The last four digits.",
        meets: ["R1.2"],
        dependsOn: [1],
      },
    ]);
    expect(text).toContain(
      "## 1. Save a card\n\nThe vault and the tick box.\n\n- **Meets:** R1.1\n- **Depends on:** none\n",
    );
    expect(text).toContain(
      "## 2. Show saved cards\n\nThe last four digits.\n\n- **Meets:** R1.2\n- **Depends on:** task 1\n",
    );
    expect(text).not.toMatch(/status|done|\[x\]/i);
  });

  it("link each task's issue in tasks.md once it is filed, still with no status (FR-117)", () => {
    const tasks = [
      {
        title: "Save a card",
        description: "The vault and the tick box.",
        meets: ["R1.1"],
        dependsOn: [],
      },
      {
        title: "Show saved cards",
        description: "The last four digits.",
        meets: ["R1.2"],
        dependsOn: [1],
      },
    ];
    const text = specTasksDocument("saved cards", "saved-cards", tasks, [
      undefined,
      { number: 12, url: "https://github.com/adrianeyre/web-shop/issues/12" },
    ]);
    expect(text).toContain(
      "## 1. Save a card\n\nThe vault and the tick box.\n\n- **Meets:** R1.1\n- **Depends on:** none\n\n## 2.",
    );
    expect(text).toContain(
      "- **Meets:** R1.2\n- **Depends on:** task 1\n- **Issue:** [#12](https://github.com/adrianeyre/web-shop/issues/12)\n",
    );
    expect(text).not.toMatch(/status|done|open|closed|\[x\]/i);
  });

  it("are written only for a phase that has its document", () => {
    const spec = newGrillingSpec("saved-cards");
    expect(
      specDocument("t", spec, "requirements", spec.approved),
    ).toBeUndefined();
    expect(
      specDocument("t", spec, "requirements", {
        ...spec.approved,
        requirements,
      }),
    ).toContain("## Requirement 1: Save a card");
  });

  it("find a criterion by its id", () => {
    expect(specCriterionId("R2.3 WHEN …")).toBe("R2.3");
    expect(specCriterionId("**r2.3** WHEN …")).toBe("R2.3");
    expect(specCriterionId("WHEN … R2.3")).toBeUndefined();
    expect(specCriterion(requirements, "r1.2")).toBe(
      "R1.2 WHEN a card is saved THE SYSTEM SHALL show its last four digits.",
    );
    expect(specCriterion(requirements, "R9.9")).toBeUndefined();
    expect(specCriterion(null, "R1.1")).toBeUndefined();
  });
});
