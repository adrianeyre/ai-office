import { describe, expect, it } from "vitest";

import { createFakeModel } from "../models/fake-model.ts";
import { askAgain, askAgainMessage } from "./ask-again.ts";
import { qaReportForm } from "./prompt.ts";
import { parseQaReport } from "./report.ts";

const input = (model: ReturnType<typeof createFakeModel>) => ({
  models: model,
  agent: { id: "agent-q", name: "Quill" },
  model: "claude-opus-5-5",
  issue: 7,
  pullRequest: 9,
  tag: "qa-report",
  form: qaReportForm,
  lastText: "Checked. Everything passes.",
  parse: parseQaReport,
});

describe("askAgain", () => {
  it("asks once, as the Agent, on its issue and pull request, quoting its last message", async () => {
    const model = createFakeModel();
    model.answer(
      "agent-q",
      "<qa-report>\nResult: pass\nSummary: pnpm test passes.\nSteps: none\n</qa-report>",
    );

    expect(await askAgain(input(model))).toEqual({
      result: "pass",
      summary: "pnpm test passes.",
      steps: "",
    });
    const [request, ...more] = model.requests;
    expect(more).toEqual([]);
    expect(request).toMatchObject({
      agentId: "agent-q",
      model: "claude-opus-5-5",
      issue: 7,
      pullRequest: 9,
    });
    expect(request?.system).toContain("You are Quill, an Agent in AI Office.");
    expect(request?.messages).toEqual([
      {
        role: "user",
        content: askAgainMessage(
          "qa-report",
          qaReportForm,
          "Checked. Everything passes.",
        ),
      },
    ]);
  });

  it("is undefined when the answer has no valid block either", async () => {
    const model = createFakeModel();
    model.answer("agent-q", "Result: pass");

    expect(await askAgain(input(model))).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });
});

describe("askAgainMessage", () => {
  it("quotes the last message and gives the block's form", () => {
    expect(askAgainMessage("qa-report", qaReportForm, " Checked. ")).toBe(
      [
        "Your run has ended, but your last message, quoted below, has no valid `<qa-report>` block.",
        "",
        "<last-message>",
        "Checked.",
        "</last-message>",
        "",
        "Answer again with only the `<qa-report>` block, from what you found, in this form:",
        "",
        "    <qa-report>",
        "    Result: pass or fail",
        "    Summary: what you ran and what you found, in a sentence or two.",
        "    Steps: for a fail, numbered steps that reproduce it; for a pass, none.",
        "    </qa-report>",
      ].join("\n"),
    );
  });

  it("quotes the end of a long message, and says when there was none", () => {
    const long = `${"a".repeat(30_000)}THE END`;
    const message = askAgainMessage("qa-report", qaReportForm, long);
    expect(message).toContain("THE END\n</last-message>");
    expect(message).toContain("<last-message>\n…a");
    expect(message.length).toBeLessThan(21_000);
    expect(askAgainMessage("qa-report", qaReportForm, null)).toContain(
      "<last-message>\n(No message.)\n</last-message>",
    );
  });
});
