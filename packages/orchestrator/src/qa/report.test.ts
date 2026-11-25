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

describe("parseQaReport, for an issue filed from a Spec (FR-116)", () => {
  const criteria = [
    "R1.1 WHEN a shopper ticks Save card THE SYSTEM SHALL keep the card's token.",
    "R1.2 IF the card is declined THEN THE SYSTEM SHALL not keep it.",
    "R2.1 WHEN a shopper removes a saved card THE SYSTEM SHALL stop offering it at checkout.",
  ];
  const report = (result: string, listed: readonly string[]): string =>
    [
      "<qa-report>",
      `Result: ${result}`,
      "Summary: pnpm test, with a property test per criterion.",
      "Criteria:",
      ...listed,
      "Steps: none",
      "</qa-report>",
    ].join("\n");

  it("passes when every criterion is listed as passed", () => {
    expect(
      parseQaReport(
        report("pass", ["- R1.1 pass", "- r1.2: passed", "- **R2.1** — PASS"]),
        criteria,
      ),
    ).toEqual({
      result: "pass",
      summary: "pnpm test, with a property test per criterion.",
      steps: "",
      criteria: [
        { id: "R1.1", result: "pass", untested: false },
        { id: "R1.2", result: "pass", untested: false },
        { id: "R2.1", result: "pass", untested: false },
      ],
    });
  });

  it('reads them on one line too, as "R1.1 pass, R1.2 pass, R2.1 fail"', () => {
    expect(
      parseQaReport(
        report("fail", ["R1.1 pass, R1.2 pass, R2.1 fail"]),
        criteria,
      )?.criteria,
    ).toEqual([
      { id: "R1.1", result: "pass", untested: false },
      { id: "R1.2", result: "pass", untested: false },
      { id: "R2.1", result: "fail", untested: false },
    ]);
  });

  it("fails when one criterion failed, whatever its Result says", () => {
    const found = parseQaReport(
      report("pass", [
        "R1.1 pass",
        "R1.2 fail: a declined card is kept",
        "R2.1 pass",
      ]),
      criteria,
    );
    expect(found?.result).toBe("fail");
    expect(found?.criteria).toEqual([
      { id: "R1.1", result: "pass", untested: false },
      { id: "R1.2", result: "fail", untested: false },
      { id: "R2.1", result: "pass", untested: false },
    ]);
  });

  it("fails a criterion missing from the report as untested, and the report with it", () => {
    const found = parseQaReport(
      report("pass", ["R1.1 pass", "R2.1 pass"]),
      criteria,
    );
    expect(found?.result).toBe("fail");
    expect(found?.criteria).toEqual([
      { id: "R1.1", result: "pass", untested: false },
      { id: "R1.2", result: "fail", untested: true },
      { id: "R2.1", result: "pass", untested: false },
    ]);
  });

  it("fails as untested a criterion listed with neither pass nor fail", () => {
    const found = parseQaReport(
      report("pass", ["R1.1 pass", "R1.2 no test yet", "R2.1 skipped"]),
      criteria,
    );
    expect(found?.result).toBe("fail");
    expect(found?.criteria?.filter(({ untested }) => untested)).toEqual([
      { id: "R1.2", result: "fail", untested: true },
      { id: "R2.1", result: "fail", untested: true },
    ]);
  });

  it("fails every criterion when the report has no Criteria part", () => {
    const found = parseQaReport(
      "<qa-report>\nResult: pass\nSummary: All green.\n</qa-report>",
      criteria,
    );
    expect(found?.result).toBe("fail");
    expect(found?.criteria?.every(({ untested }) => untested)).toBe(true);
  });

  it("lets a failure said anywhere outweigh a pass, and ignores ids the issue does not have", () => {
    const found = parseQaReport(
      report("pass", [
        "R1.1 pass",
        "R1.2 pass",
        "R2.1 pass",
        "R1.2 fail",
        "R9.9 fail",
      ]),
      criteria,
    );
    expect(found?.result).toBe("fail");
    expect(found?.criteria?.map(({ id, result }) => `${id} ${result}`)).toEqual(
      ["R1.1 pass", "R1.2 fail", "R2.1 pass"],
    );
  });

  it("reads criteria only from the Criteria part", () => {
    const found = parseQaReport(
      [
        "<qa-report>",
        "Result: pass",
        "Summary: R1.1 pass, R1.2 pass.",
        "Criteria:",
        "R2.1 pass",
        "</qa-report>",
      ].join("\n"),
      criteria,
    );
    expect(found?.criteria?.map(({ id, result }) => `${id} ${result}`)).toEqual(
      ["R1.1 fail", "R1.2 fail", "R2.1 pass"],
    );
  });
});

describe("parseQaReport, for an issue filed from no Spec", () => {
  it("reads the report as it did, with no criteria and no Criteria part", () => {
    const text = [
      "<qa-report>",
      "Result: pass",
      "Summary: All green.",
      "Criteria: R1.1 fail",
      "Steps: none",
      "</qa-report>",
    ].join("\n");
    expect(parseQaReport(text)).toEqual({
      result: "pass",
      summary: "All green.\nCriteria: R1.1 fail",
      steps: "",
    });
  });
});
