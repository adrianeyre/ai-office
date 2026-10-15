import type { FloorTemplate } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { commandSteps, lintFloorTemplate, readGlossary } from "./lint.ts";
import { loadFloorTemplates } from "./load.ts";

// The Infrastructure Floor Template (PRD FR-100) checks a change with a
// plan, never an apply: its commands, and the commands its Skill and first
// issue show, plan from no state with no cloud credentials, and none of
// them applies, deploys or changes state. Live infrastructure is the
// Owner's own pipeline's (PRD §4).

const infrastructure = async (): Promise<FloorTemplate> => {
  const template = (await loadFloorTemplates()).find(
    ({ id }) => id === "infrastructure",
  );
  if (template === undefined) {
    throw new Error('There is no built-in "infrastructure" template.');
  }
  return template;
};

/**
 * What changes live infrastructure, or its state: Terraform's apply,
 * destroy, import, state, taint and force-unlock, and any deploy.
 */
const changesLiveInfrastructure =
  /\b(?:apply|destroy|import|state|taint|untaint|force-unlock|deploy)\b|-auto-approve/;

/** Each line of every shell code block in `text`. */
const shellLines = (text: string): string[] =>
  [...text.matchAll(/^```(?:sh|bash|shell|console)\n([\s\S]*?)^```$/gm)]
    .flatMap(([, code]) => (code ?? "").split("\n"))
    .filter((line) => line.trim() !== "");

describe("the Infrastructure Floor Template", () => {
  it("its commands contain no apply or deploy step: the check plans, from no state", async () => {
    const { settings } = await infrastructure();
    const steps = [
      ...commandSteps(settings.setupCommand),
      ...commandSteps(settings.testCommand),
    ];
    expect(steps).toEqual([
      "terraform fmt -check -recursive",
      "terraform init -input=false -backend=false",
      "terraform validate",
      "terraform plan -input=false -lock=false -refresh=false",
      "checkov --directory . --quiet",
    ]);
    for (const step of steps) {
      expect(step).not.toMatch(changesLiveInfrastructure);
    }
    // The dry run is a plan, which never reaches the remote state: init
    // leaves the backend out, and the plan neither locks nor refreshes.
    expect(steps).toContainEqual(expect.stringMatching(/^terraform plan /));
    for (const step of steps.filter((each) => each.startsWith("terraform "))) {
      expect(step).not.toMatch(/-backend=true|-backend-config/);
    }
    expect(steps.find((step) => step.startsWith("terraform init "))).toContain(
      "-backend=false",
    );
    expect(steps.find((step) => step.startsWith("terraform plan "))).toMatch(
      /-lock=false.*-refresh=false/,
    );
  });

  it("nor do the commands its Skill and first issue show", async () => {
    const template = await infrastructure();
    const shown = [
      ...shellLines(template.manager.firstIssue?.body ?? ""),
      ...template.skills.flatMap((skill) =>
        skill.files.flatMap(({ content }) => shellLines(content)),
      ),
    ];
    // The Skill shows the check command.
    expect(shown).toContain(template.settings.testCommand);
    for (const line of shown) {
      for (const step of commandSteps(line)) {
        expect(step).not.toMatch(changesLiveInfrastructure);
      }
    }
  });

  it("the lint refuses one that would apply, in either command", async () => {
    const template = await infrastructure();
    const glossary = await readGlossary();
    expect(lintFloorTemplate(template, glossary)).toEqual([]);
    for (const [setting, step] of [
      ["setupCommand", "terraform apply -auto-approve"],
      ["testCommand", "terraform deploy"],
      ["testCommand", "terraform destroy"],
    ] as const) {
      const command = template.settings[setting];
      const problems = lintFloorTemplate(
        {
          ...template,
          settings: {
            ...template.settings,
            [setting]: command === "" ? step : `${command} && ${step}`,
          },
        },
        glossary,
      );
      expect(problems).toContain(
        `infrastructure/template.yaml: settings.${setting}'s "${step}" would apply, deploy or publish something: a Floor's commands only check its repository.`,
      );
    }
  });

  it("tells every Role, and the Manager, never to apply a plan or act on live infrastructure", async () => {
    const template = await infrastructure();
    expect(template.manager.planningGuidance).toContain(
      "nothing on this Floor applies a plan",
    );
    for (const { role } of template.roles) {
      expect(role.instructions).toMatch(
        /live infrastructure or a cloud account/,
      );
    }
    for (const id of ["platform-engineer", "plan-qa"]) {
      expect(
        template.roles.find(({ role }) => role.id === id)?.role.instructions,
      ).toContain("Never apply a plan");
    }
  });
});
