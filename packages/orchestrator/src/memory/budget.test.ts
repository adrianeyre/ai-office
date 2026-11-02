import { defaultPromptBudgetSettings } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  agentMemoryWithin,
  promptBudgetFor,
  promptBudgetOf,
  skillsWithin,
} from "./budget.ts";
import { memoryFiles } from "./shared.ts";
import { longAgentMemory } from "./testing.ts";

// The prompt budgets: the Owner's settings, lowered on a small context
// window; and what is kept of a memory, or of the Skills, over budget.

describe("the prompt budget for a Model", () => {
  it("is the Owner's settings when the context window is unknown or large", () => {
    expect(promptBudgetFor(defaultPromptBudgetSettings, null)).toEqual(
      defaultPromptBudgetSettings,
    );
    expect(promptBudgetFor(defaultPromptBudgetSettings, 200_000)).toEqual(
      defaultPromptBudgetSettings,
    );
    expect(promptBudgetFor(defaultPromptBudgetSettings, 1_048_576)).toEqual(
      defaultPromptBudgetSettings,
    );
  });

  it("is lower on a small known window: a twentieth of it for each memory, a tenth for the Skills, at 3.5 characters a token", () => {
    expect(promptBudgetFor(defaultPromptBudgetSettings, 32_768)).toEqual({
      repositoryMemory: 5734,
      officeMemory: 5734,
      roleMemory: 5734,
      skills: 11_468,
    });
    // Never more than the Owner set.
    expect(
      promptBudgetFor(
        { ...defaultPromptBudgetSettings, officeMemory: 1000 },
        32_768,
      ).officeMemory,
    ).toBe(1000);
  });

  it("reads the Owner's settings and the Model's window each time", async () => {
    const budgetOf = promptBudgetOf(
      () => Promise.resolve(defaultPromptBudgetSettings),
      (aiProvider) => Promise.resolve(aiProvider === "Ollama" ? 32_768 : null),
    );
    expect(await budgetOf("Claude", "claude-opus-5-5")).toEqual(
      defaultPromptBudgetSettings,
    );
    expect((await budgetOf("Ollama", "qwen3-coder")).roleMemory).toBe(5734);
  });
});

describe("the office-wide and Role memory within a budget", () => {
  const memory = longAgentMemory("coder");

  it("is the memory as it is when it fits, or without a budget", () => {
    expect(agentMemoryWithin(memory, undefined)).toBe(memory);
    expect(agentMemoryWithin(memory, defaultPromptBudgetSettings)).toBe(memory);
  });

  it("cuts the office-wide memory, and keeps the newest Role memory entries that fit, noting both", () => {
    const budget = promptBudgetFor(defaultPromptBudgetSettings, 32_768);
    const within = agentMemoryWithin(memory, budget);
    expect(within.office).toBe(memory.office?.slice(0, 5734));
    expect(within.officeCut).toBe(5734);
    // 19 entries of 290 characters fit in 5,734; the 21 oldest go.
    expect(within.role).toEqual(memory.role.slice(21));
    expect(within.role[0]).toMatch(/^Entry 22: /);
    expect(within.roleLeftOut).toBe(21);
    // The same every time.
    expect(agentMemoryWithin(memory, budget)).toEqual(within);
  });

  it("says so in the files mounted in the sandbox", () => {
    const [office, role] = memoryFiles(
      agentMemoryWithin(
        memory,
        promptBudgetFor(defaultPromptBudgetSettings, 32_768),
      ),
    );
    expect(office?.content).toMatch(
      /\n… \(the office-wide memory cut here: it is longer than the 5,734 characters a prompt carries\)\n$/,
    );
    expect(role?.content).toContain(
      "\n(21 older entries were left out: the Role's memory is longer than the 5,734 characters a prompt carries.)\n",
    );
    expect(role?.content).not.toContain("Entry 21: ");
  });
});

describe("the Skills within a budget", () => {
  const skills = [
    { name: "pdf", description: "Reads PDFs." },
    { name: "tdd", description: "Tests first." },
    { name: "pr", description: "Writes pull requests." },
  ];

  it("keeps the first that fit, in order, saying how many were left out", () => {
    expect(skillsWithin(skills, 30)).toEqual({
      skills: skills.slice(0, 2),
      leftOut: 1,
    });
    expect(skillsWithin(skills, 0)).toEqual({ skills: [], leftOut: 3 });
  });

  it("keeps every one without a budget, or when all fit", () => {
    expect(skillsWithin(skills, undefined)).toEqual({ skills, leftOut: 0 });
    expect(skillsWithin(skills, 40_000)).toEqual({ skills, leftOut: 0 });
  });
});
