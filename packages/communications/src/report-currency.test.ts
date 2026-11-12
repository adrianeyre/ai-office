import { describe, expect, it } from "vitest";

import {
  reportData,
  reportMarkdown,
  templateReportSummary,
  usDollarCost,
  type BatchReport,
  type CostFormat,
} from "./report.ts";

// A report's costs, kept in US dollars, are written in the office's
// currency (General Settings) when it is given one; in US dollars without.

const report: BatchReport = {
  batchId: 3,
  floor: {
    id: "web-shop",
    name: "Web shop",
    repository: "adrianeyre/web-shop",
  },
  startedAt: null,
  finishedAt: new Date("2026-10-10T10:50:00.000Z"),
  planVersion: 1,
  issues: [
    {
      issue: 1,
      title: "Add a basket",
      agent: "Ada",
      dependsOn: [],
      outcome: "merged",
      pullRequest: null,
      rounds: { review: 1, qa: 1 },
      tokens: 1_000,
      estimatedCostUsd: 2,
    },
  ],
  parallel: [[1]],
  leftOut: [],
  totals: {
    merged: 1,
    closed: 0,
    blocked: 0,
    notStarted: 0,
    tokens: 1_000,
    estimatedCostUsd: 2,
  },
};

/** Pounds at 0.75 to the dollar. */
const pounds: CostFormat = (usd) => `£${(usd * 0.75).toFixed(2)}`;

describe("a report's costs", () => {
  it("are in US dollars without a currency", () => {
    expect(usDollarCost(2)).toBe("$2.00");
    expect(templateReportSummary(report, "titles_and_summaries")).toContain(
      "(about $2.00, estimated)",
    );
  });

  it("are in the office's currency when it is given", () => {
    expect(
      templateReportSummary(report, "titles_and_summaries", pounds),
    ).toContain("(about £1.50, estimated)");
    const markdown = reportMarkdown(
      report,
      "titles_and_summaries",
      "Done.",
      "https://ai-office.example/floors/web-shop",
      pounds,
    );
    expect(markdown).toContain("about £1.50 (estimated)");
    expect(markdown).not.toContain("$");
    expect(reportData(report, pounds).issues[0]).toMatchObject({
      estimatedCostUsd: 2,
      estimatedCost: "£1.50",
    });
  });
});
