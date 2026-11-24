import { defaultPromptBudgetSettings } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { planPrompt } from "../batches/prompt.ts";
import { coderPrompt } from "../coder/prompt.ts";
import { designPrompt } from "../design/prompt.ts";
import { docsPrompt } from "../docs/prompt.ts";
import { managerSystemPrompt } from "../manager/prompt.ts";
import { triagePrompt } from "../manager/triage-prompt.ts";
import { promptBudgetFor } from "../memory/budget.ts";
import type { AgentMemory } from "../memory/shared.ts";
import { qaPrompt } from "../qa/prompt.ts";
import { reviewerPrompt } from "../review/prompt.ts";
import { builtIn } from "../roles/testing.ts";

// A Floor without Guidelines behaves exactly as before (Guidelines, Specs
// and Hooks PRD, §8): every prompt a task is given without Guidelines is
// byte for byte what it was before Guidelines reached prompts. The files
// in `__fixtures__/prompts-without-guidelines/` were written by these
// same tests run against the prompts as they stood before (commit
// dfd760e), and are compared, never rewritten, here.

const fixture = (name: string): string =>
  `./__fixtures__/prompts-without-guidelines/${name}.txt`;

const floor = {
  name: "Web shop",
  repository: "adrianeyre/web-shop",
  defaultBranch: "main",
  setupCommand: "pnpm install",
  testCommand: "pnpm test",
};
const issue = {
  number: 4,
  title: "Add a basket",
  body: "Shoppers need a basket.\n\n- [ ] Add items\n- [ ] Show the total",
};
const handoff = {
  changed: "Added the basket and its total.",
  check: "The total with two of one item.",
  risks: "None.",
};
const memory = "# Memory\n\n- Run pnpm test before pushing.\n";
const agentMemory = (roleOf: string): AgentMemory => ({
  office: "# Standards\n\n- Use pnpm, never npm.",
  role: ["Write the failing test first, then the fix."],
  roleOf,
});
const budget = promptBudgetFor(defaultPromptBudgetSettings, 200_000);
const agent = (name: string, role: string) => ({
  name,
  role,
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  extraInstructions: "Keep it small.",
});

describe("every prompt without Guidelines, as it was before them", () => {
  it("the coder's (every work Role's)", async () => {
    await expect(
      coderPrompt({
        floor,
        agent: agent("Ada", "coder"),
        role: builtIn("coder"),
        issue,
        branch: "ai-office/4-add-a-basket",
        memory,
        agentMemory: agentMemory("coder"),
        budget,
      }),
    ).toMatchFileSnapshot(fixture("coder"));
  });

  it("the reviewer's", async () => {
    const prompt = reviewerPrompt({
      floor,
      agent: agent("Grace", "reviewer"),
      role: builtIn("reviewer"),
      issue,
      pullRequest: {
        number: 14,
        title: "Add a basket",
        branch: "ai-office/4-add-a-basket",
      },
      round: { number: 1, cap: 3 },
      handoff,
      files: [
        {
          path: "src/basket.ts",
          status: "added",
          patch: "@@ -0,0 +1 @@\n+export const basket = [];",
        },
      ],
      contents: [
        { path: "src/basket.ts", text: "export const basket = [];\n" },
      ],
      memory,
      agentMemory: agentMemory("reviewer"),
      budget,
    });
    await expect(`${prompt.system}\n---\n${prompt.user}`).toMatchFileSnapshot(
      fixture("reviewer"),
    );
  });

  it("QA's", async () => {
    await expect(
      qaPrompt({
        floor,
        agent: agent("Evelyn", "qa"),
        role: builtIn("qa"),
        issue,
        branch: "ai-office/4-add-a-basket",
        pullRequest: 14,
        round: { number: 1, cap: 3 },
        handoff,
        memory,
        agentMemory: agentMemory("qa"),
        budget,
      }),
    ).toMatchFileSnapshot(fixture("qa"));
  });

  it("docs'", async () => {
    await expect(
      docsPrompt({
        floor,
        agent: agent("Dot", "docs"),
        role: builtIn("docs"),
        issue,
        branch: "ai-office/4-add-a-basket",
        pullRequest: 14,
        handoff,
        memory,
        agentMemory: agentMemory("docs"),
        budget,
      }),
    ).toMatchFileSnapshot(fixture("docs"));
  });

  it("the designer's", async () => {
    await expect(
      designPrompt({
        floor,
        agent: agent("Dee", "designer"),
        issue,
        branch: "ai-office/4-add-a-basket",
        pullRequest: 14,
        afterQa: true,
        round: { number: 1, cap: 3 },
        handoff,
        memory,
        agentMemory: agentMemory("designer"),
        budget,
      }),
    ).toMatchFileSnapshot(fixture("designer"));
  });

  it("the Manager's triage", async () => {
    const prompt = triagePrompt({
      floor,
      manager: { name: "Mira", extraInstructions: "Be brief." },
      issue,
      memory,
    });
    await expect(`${prompt.system}\n---\n${prompt.user}`).toMatchFileSnapshot(
      fixture("triage"),
    );
  });

  it("the Manager's Plan", async () => {
    const prompt = planPrompt({
      floor,
      manager: { name: "Mira", extraInstructions: "Be brief." },
      coders: [
        {
          name: "Ada",
          aiProvider: "Claude",
          model: "claude-opus-5-5",
          load: 1,
        },
      ],
      issues: [issue, { number: 5, title: "Show the basket", body: "" }],
      memory,
    });
    await expect(`${prompt.system}\n---\n${prompt.user}`).toMatchFileSnapshot(
      fixture("plan"),
    );
  });

  it("the Manager's chat", async () => {
    await expect(
      managerSystemPrompt({
        floor,
        manager: { name: "Mira", extraInstructions: "Be brief." },
        team: [
          {
            name: "Ada",
            role: "coder",
            aiProvider: "Claude",
            model: "claude-opus-5-5",
            enabled: true,
          },
        ],
        memory,
        budget,
        readsRepository: true,
      }),
    ).toMatchFileSnapshot(fixture("chat"));
  });
});
