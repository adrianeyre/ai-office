import { describe, expect, it } from "vitest";

import {
  dropIssueDraft,
  grillingIssueDraftsRequestSchema,
  issueDraftsProblem,
  issueFilingOrder,
  mergeIssueDrafts,
  moveIssueDraft,
  type GrillingIssueDraftEdit,
} from "./grilling-issues.ts";

const draft = (
  id: number,
  title: string,
  blockedBy: number[] = [],
  more: Partial<GrillingIssueDraftEdit> = {},
): GrillingIssueDraftEdit => ({
  id,
  title,
  whatToBuild: `Build ${title.toLowerCase()}.`,
  acceptanceCriteria: [`${title} works`],
  blockedBy,
  prdSections: [],
  adrs: [],
  ...more,
});

const ids = (drafts: readonly { id: number }[]) => drafts.map(({ id }) => id);

describe("issueFilingOrder", () => {
  it("files each draft after those it is blocked by, otherwise in the Owner's order", () => {
    const drafts = [
      draft(1, "Email the export", [3]),
      draft(2, "Tidy the footer"),
      draft(3, "Build the CSV", [4]),
      draft(4, "Export button"),
    ];
    expect(ids(issueFilingOrder(drafts) ?? [])).toEqual([2, 4, 3, 1]);
  });

  it("answers nothing for drafts blocked by each other in a cycle", () => {
    expect(
      issueFilingOrder([draft(1, "A", [2]), draft(2, "B", [1])]),
    ).toBeUndefined();
  });
});

describe("issueDraftsProblem", () => {
  it("says why drafts cannot be filed", () => {
    expect(issueDraftsProblem([])).toBe("There are no issues to file.");
    expect(issueDraftsProblem([draft(1, "A"), draft(1, "B")])).toBe(
      "Two issues have the same number.",
    );
    expect(issueDraftsProblem([draft(1, "A", [1])])).toBe(
      '"A" is blocked by itself.',
    );
    expect(issueDraftsProblem([draft(1, "A", [2, 5])])).toBe(
      '"A" is blocked by issues not in the list (#2 and #5).',
    );
    expect(issueDraftsProblem([draft(1, "A", [2]), draft(2, "B", [1])])).toBe(
      "Some issues are blocked by each other in a cycle, so none could be filed first.",
    );
    expect(
      issueDraftsProblem([draft(1, "A"), draft(2, "B", [1])]),
    ).toBeUndefined();
  });

  it("is checked on what the Owner sends, with every issue's parts", () => {
    expect(
      grillingIssueDraftsRequestSchema.safeParse({
        drafts: [{ ...draft(1, "A"), acceptanceCriteria: [] }],
      }).success,
    ).toBe(false);
    expect(
      grillingIssueDraftsRequestSchema.safeParse({ drafts: [draft(1, "  ")] })
        .success,
    ).toBe(false);
    expect(
      grillingIssueDraftsRequestSchema.safeParse({ drafts: [] }).success,
    ).toBe(false);
  });
});

describe("editing the drafts", () => {
  it("drops a draft, those blocked by it then waiting on what it waited on", () => {
    const drafts = [
      draft(1, "Export button"),
      draft(2, "Build the CSV", [1]),
      draft(3, "Email the export", [2]),
    ];
    expect(dropIssueDraft(drafts, 2)).toEqual([
      draft(1, "Export button"),
      draft(3, "Email the export", [1]),
    ]);
    expect(dropIssueDraft(drafts, 9)).toEqual(drafts);
  });

  it("merges one draft into another, in the other's place", () => {
    const drafts = [
      draft(1, "Export button", [], {
        prdSections: ["Requirements"],
        acceptanceCriteria: ["A button exports", "It is keyboard reachable"],
      }),
      draft(2, "Tidy the footer"),
      draft(3, "Build the CSV", [2], {
        prdSections: ["requirements", "Scope"],
        adrs: ["Exports are built while the Owner waits"],
        acceptanceCriteria: ["It is keyboard reachable", "Columns are named"],
      }),
      draft(4, "Email the export", [3]),
    ];
    expect(mergeIssueDrafts(drafts, 1, 3)).toEqual([
      {
        id: 1,
        title: "Export button",
        whatToBuild: "Build export button.\n\nBuild build the csv.",
        acceptanceCriteria: [
          "A button exports",
          "It is keyboard reachable",
          "Columns are named",
        ],
        blockedBy: [2],
        prdSections: ["Requirements", "Scope"],
        adrs: ["Exports are built while the Owner waits"],
      },
      draft(2, "Tidy the footer"),
      draft(4, "Email the export", [1]),
    ]);
    // Merging a draft into one blocked by it leaves neither blocked by itself.
    expect(mergeIssueDrafts([draft(1, "A"), draft(2, "B", [1])], 2, 1)).toEqual(
      [
        {
          ...draft(2, "B"),
          whatToBuild: "Build b.\n\nBuild a.",
          acceptanceCriteria: ["B works", "A works"],
        },
      ],
    );
  });

  it("moves a draft up and down, within the list", () => {
    const drafts = [draft(1, "A"), draft(2, "B"), draft(3, "C")];
    expect(ids(moveIssueDraft(drafts, 3, -1))).toEqual([1, 3, 2]);
    expect(ids(moveIssueDraft(drafts, 1, 1))).toEqual([2, 1, 3]);
    expect(ids(moveIssueDraft(drafts, 1, -1))).toEqual([1, 2, 3]);
    expect(ids(moveIssueDraft(drafts, 3, 5))).toEqual([1, 2, 3]);
  });
});
