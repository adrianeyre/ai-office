import { describe, expect, it } from "vitest";

import {
  batchPullRequestBody,
  batchPullRequestTitle,
  baseOf,
  closes,
  endOf,
  oneAtATime,
  type BatchBranch,
  type BatchPullRequestIssue,
} from "./one-pull-request.ts";

// A Batch handed over "in one PR" (ADR 0010): where each issue's work
// begins and ends on its shared branch, its Plan run one issue at a time,
// and its one pull request's title and body, in the `pr` Skill's shape.

const batch: BatchBranch = {
  batchId: 7,
  branch: "ai-office/batch-7",
  issues: [
    { issue: 1, title: "Add a basket", started: true, base: null },
    { issue: 3, title: "Add a wish list", started: true, base: "a".repeat(40) },
    { issue: 2, title: "Show the total", started: false, base: null },
  ],
};

const issue = (
  number: number,
  title: string,
  state: BatchPullRequestIssue["state"],
  review: BatchPullRequestIssue["review"] = { round: 0, approved: false },
  qa: BatchPullRequestIssue["qa"] = null,
): BatchPullRequestIssue => ({ issue: number, title, state, review, qa });

describe("an issue's work on a shared branch", () => {
  it("begins where the branch stood as it started, and ends where the next began", () => {
    expect(baseOf(batch, 1)).toBeUndefined();
    expect(baseOf(batch, 3)).toBe("a".repeat(40));
    expect(endOf(batch, 1)).toBe("a".repeat(40));
    // No later issue has started: its work runs to the head.
    expect(endOf(batch, 3)).toBeUndefined();
    expect(endOf(batch, 2)).toBeUndefined();
  });

  it("runs the Plan one issue at a time, in its order", () => {
    expect(
      oneAtATime({
        draftedBy: "rules",
        summary: "",
        items: [
          {
            issue: 1,
            title: "",
            dependsOn: [],
            files: [],
            agentId: null,
            note: "",
          },
          {
            issue: 3,
            title: "",
            dependsOn: [],
            files: [],
            agentId: null,
            note: "",
          },
        ],
        overlaps: [],
        parallel: [[1, 3]],
        leftOut: [],
      }).parallel,
    ).toEqual([[1], [3]]);
  });
});

describe("the one pull request", () => {
  it("is titled by its Batch and issues", () => {
    expect(batchPullRequestTitle(7, [1, 3, 2])).toBe("Batch 7: #1, #3 and #2");
    expect(batchPullRequestTitle(7, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(
      "Batch 7: 10 issues, #1 to #10",
    );
  });

  it("has a Summary, Evidence and the Merge Danger, closing each issue that has joined it", () => {
    const body = batchPullRequestBody({
      batchId: 7,
      branch: "ai-office/batch-7",
      issues: [
        issue(
          1,
          "Add a basket",
          "ready-to-merge",
          { round: 2, approved: true },
          "pass",
        ),
        issue(3, "Add a wish list", "needs-review", {
          round: 1,
          approved: false,
        }),
        issue(2, "Show the total", null),
      ],
      files: [
        { path: "src/basket.ts", status: "added" },
        { path: "src/shop.ts", status: "modified" },
        { path: "old.ts", status: "removed" },
      ],
      ownerOnly: [],
    });
    expect(body).toBe(
      [
        "## Summary",
        "",
        "Batch 7's issues, worked one after another on one branch, each building on the one before:",
        "",
        "```text",
        "ai-office/batch-7",
        "├── #1 Add a basket: ready to merge",
        "├── #3 Add a wish list: in review",
        "└── #2 Show the total: not started",
        "```",
        "",
        "```diff",
        "+src/basket.ts",
        " src/shop.ts",
        "-old.ts",
        "```",
        "",
        "Closes #1",
        "Closes #3",
        "",
        "## Evidence",
        "",
        "- **Before:** #1 open: Add a basket",
        "  **After:** approved in review round 2; QA passed; ready to merge",
        "- **Before:** #3 open: Add a wish list",
        "  **After:** changes asked for in review round 1; in review",
        "- **Before:** #2 open: Show the total",
        "  **After:** not started",
        "",
        "## Merge Danger",
        "",
        "**Door:** two-way",
        "",
        "Reverting its merge commit undoes #1 and #3 together.",
        "",
        "**Blast Radius:** small",
        "",
        "2 issues and 3 files change in one merge, which waits until every issue of the Batch is ready to merge.",
        "",
      ].join("\n"),
    );
    expect(closes(body, 1)).toBe(true);
    expect(closes(body, 3)).toBe(true);
    expect(closes(body, 2)).toBe(false);
    expect(closes(body, 13)).toBe(false);
  });

  it("is a one-way door when it changes migrations, and says why it goes to the Owner", () => {
    const body = batchPullRequestBody({
      batchId: 7,
      branch: "ai-office/batch-7",
      issues: [issue(1, "Add a basket", "needs-review")],
      files: Array.from({ length: 40 }, (_, at) => ({
        path:
          at === 0
            ? "db/migrations/0001_add_basket.sql"
            : `src/file-${String(at)}.ts`,
        status: "added",
      })),
      ownerOnly: ["it changes what CI runs"],
    });
    expect(body).toContain(
      "**Door:** one-way\n\nIt changes database migrations, which reverting the merge does not undo.",
    );
    expect(body).toContain("**Blast Radius:** wide");
    expect(body).toContain(" … and 10 more\n");
    expect(body).toContain(
      "1 issue and 40 files change in one merge, which waits until every issue of the Batch is ready to merge. It goes to you whatever the Merge Policy, as it changes what CI runs.",
    );
  });
});
