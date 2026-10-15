import { describe, expect, it } from "vitest";

import { maxHandoffPart } from "../review/handoff.ts";
import { parseDesignReport } from "./report.ts";

describe("parseDesignReport", () => {
  it("reads the last <design-review> block's result, summary and findings", () => {
    expect(
      parseDesignReport(
        [
          "<design-review>Result: pass</design-review>",
          "Then I took the phone screenshots.",
          "<DESIGN-REVIEW>",
          "- Result: Changes requested",
          "- Summary: The basket is off the palette:",
          "  docs/style-guide.md.",
          "- Findings:",
          "1. Basket, 390 px: the button overflows.",
          "2. Basket, 1280 px: use the primary Button.",
          "<memory>",
          "- The style guide is docs/style-guide.md.",
          "</memory>",
          "</DESIGN-REVIEW>",
        ].join("\n"),
      ),
    ).toEqual({
      result: "changes",
      summary: "The basket is off the palette:\n  docs/style-guide.md.",
      findings:
        "1. Basket, 390 px: the button overflows.\n2. Basket, 1280 px: use the primary Button.",
    });
  });

  it("keeps no findings for a pass, or for none given", () => {
    expect(
      parseDesignReport(
        "<design-review>\nResult: PASSED\nSummary: On the guide.\nFindings: 1. Nothing\n</design-review>",
      ),
    ).toEqual({ result: "pass", summary: "On the guide.", findings: "" });
    expect(
      parseDesignReport(
        "<design-review>\nResult: changes\nFindings: none.\n</design-review>",
      ),
    ).toEqual({
      result: "changes",
      summary: "No summary given.",
      findings: "",
    });
  });

  it("finds no report without a block, or without a pass or changes", () => {
    expect(parseDesignReport(null)).toBeUndefined();
    expect(parseDesignReport("Result: pass")).toBeUndefined();
    expect(
      parseDesignReport("<design-review>\nSummary: Fine.\n</design-review>"),
    ).toBeUndefined();
    expect(
      parseDesignReport("<design-review>\nResult: fail\n</design-review>"),
    ).toBeUndefined();
    expect(
      parseDesignReport("<design-review>\nResult: passable\n</design-review>"),
    ).toBeUndefined();
  });

  it("cuts long parts", () => {
    const found = parseDesignReport(
      `<design-review>\nResult: changes\nFindings: ${"x".repeat(maxHandoffPart + 50)}\n</design-review>`,
    );
    expect(found?.findings).toHaveLength(maxHandoffPart);
    expect(found?.findings.endsWith("…")).toBe(true);
  });
});
