import { describe, expect, it } from "vitest";

import { maxHandoffPart } from "../review/handoff.ts";
import { parseQaReport } from "./report.ts";

describe("parseQaReport", () => {
  it("reads the last <qa-report> block's result, summary and steps", () => {
    expect(
      parseQaReport(
        [
          "<qa-report>Result: pass</qa-report>",
          "Then I looked again.",
          "<QA-REPORT>",
          "- Result: Failed",
          "- Summary: pnpm test fails:",
          "  basket.test.ts.",
          "- Steps:",
          "1. pnpm test",
          "2. See basket.test.ts fail",
          "</QA-REPORT>",
        ].join("\n"),
      ),
    ).toEqual({
      result: "fail",
      summary: "pnpm test fails:\n  basket.test.ts.",
      steps: "1. pnpm test\n2. See basket.test.ts fail",
    });
  });

  it("keeps no steps for a pass, or for none given", () => {
    expect(
      parseQaReport(
        "<qa-report>\nResult: PASS\nSummary: All green.\nSteps: 1. Nothing\n</qa-report>",
      ),
    ).toEqual({ result: "pass", summary: "All green.", steps: "" });
    expect(
      parseQaReport("<qa-report>\nResult: fail\nSteps: none.\n</qa-report>"),
    ).toEqual({ result: "fail", summary: "No summary given.", steps: "" });
  });

  it("finds no report without a block, or without a pass or fail", () => {
    expect(parseQaReport(null)).toBeUndefined();
    expect(parseQaReport("Result: pass")).toBeUndefined();
    expect(
      parseQaReport("<qa-report>\nSummary: Fine.\n</qa-report>"),
    ).toBeUndefined();
    expect(
      parseQaReport("<qa-report>\nResult: mostly\n</qa-report>"),
    ).toBeUndefined();
    expect(
      parseQaReport("<qa-report>\nResult: passable\n</qa-report>"),
    ).toBeUndefined();
  });

  it("cuts long parts", () => {
    const found = parseQaReport(
      `<qa-report>\nResult: fail\nSummary: ${"x".repeat(maxHandoffPart + 50)}\n</qa-report>`,
    );
    expect(found?.summary).toHaveLength(maxHandoffPart);
    expect(found?.summary.endsWith("…")).toBe(true);
  });
});
