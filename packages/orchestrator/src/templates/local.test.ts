import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  aiProviderOfModel,
  aiProviders,
  builtInRole,
  seededRandom,
  type FloorTemplate,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { memoryStores } from "../stores.ts";
import { lintFloorTemplate, readGlossary } from "./lint.ts";
import { loadFloorTemplates } from "./load.ts";

// The Local Floor Template (PRD FR-100): a software team on the Owner's
// own Models through Ollama. Every Role suggests the Ollama AI Provider and
// the same Model, so that one GPU never swaps Models between Agents; its
// Roles have ids and names of their own, beside the library's Development
// Roles; and its Manager plans small, exact issues, one change per pull
// request, as a smaller Model needs.

/** The Model every Local Role suggests. */
const sharedModel = "qwen3.6:27b";

const local = async (): Promise<FloorTemplate> => {
  const template = (await loadFloorTemplates()).find(
    ({ id }) => id === "local",
  );
  if (template === undefined) {
    throw new Error('There is no built-in "local" template.');
  }
  return template;
};

describe("the Local Floor Template", () => {
  it("passes the lint", async () => {
    expect(lintFloorTemplate(await local(), await readGlossary())).toEqual([]);
  });

  it("sends its changes to the Owner, with a Round Cap of 3 and the local reviewer required", async () => {
    const template = await local();
    expect(template).toMatchObject({
      name: "Local",
      icon: "server",
      theme: "office",
      labels: [],
    });
    expect(template.settings).toEqual({
      setupCommand: "if [ -f package.json ]; then npm install; fi",
      testCommand: "npm run check",
      mergePolicy: "send_to_me",
      roundCap: 3,
      requiredReviewers: ["local-reviewer"],
    });
  });

  it("has Roles of its own, one on each Stage, each on Ollama with the one shared Model", async () => {
    const template = await local();
    expect(
      template.roles.map(({ role, count }) => [
        role.id,
        role.name,
        role.stage,
        count,
      ]),
    ).toEqual([
      ["local-coder", "local coder", "work", 1],
      ["local-reviewer", "local reviewer", "review", 1],
      ["local-qa", "local QA", "qa", 1],
    ]);
    for (const { role } of template.roles) {
      // Not the library's Development Roles, which keep their own ids.
      expect(builtInRole(role.id)).toBeUndefined();
      expect(role.aiProvider).toBe("Ollama");
      expect(role.model).toBe(sharedModel);
    }
    // The suggestion is one the AI Gateway knows: the Ollama AI Provider,
    // and a Model Ollama names.
    expect(aiProviders).toContain("Ollama");
    expect(aiProviderOfModel(sharedModel)).toBe("Ollama");
  });

  it("has the Manager plan small issues that name their files, with acceptance criteria, one change per pull request", async () => {
    const { planningGuidance } = (await local()).manager;
    expect(planningGuidance).toContain(
      "This Floor started from the Local Floor Template.",
    );
    expect(planningGuidance).toContain("Keep each issue small");
    expect(planningGuidance).toContain("Name the files each issue changes");
    expect(planningGuidance).toContain("explicit acceptance criteria");
    expect(planningGuidance).toContain("One change per pull request");
  });

  it("starts a Floor's team on Ollama, every Agent on the shared Model", async () => {
    const stores = memoryStores();
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/local-app");
    const floors = createFloors({
      store: stores.floors,
      github,
      events: createEventBus({ store: memoryEventStore() }),
      agents: stores.agents,
      roles: stores.roles,
      skills: stores.skills,
      templates: await loadFloorTemplates(),
      random: seededRandom("local"),
      now: () => new Date("2026-11-02T09:00:00.000Z"),
    });
    const floor = await floors.add("adrianeyre/local-app", "local");
    expect(floor).toMatchObject({
      template: { id: "local", name: "Local" },
      theme: "office",
      testCommand: "npm run check",
      mergePolicy: "send_to_me",
      roundCap: 3,
    });
    const team = await stores.agents.list(floor.id);
    expect(
      team.map(({ role, stage, aiProvider, modelOverride }) => [
        role,
        stage,
        aiProvider,
        modelOverride,
      ]),
    ).toEqual([
      // The Manager is on the office default, as on every Floor.
      ["manager", null, "Claude", null],
      ["local-coder", "work", "Ollama", sharedModel],
      ["local-reviewer", "review", "Ollama", sharedModel],
      ["local-qa", "qa", "Ollama", sharedModel],
    ]);
    expect(floor.requiredReviewerAgentIds).toEqual([team[2]?.id]);
  });
});
