import { describe, expect, it } from "vitest";

import {
  defaultHookRunsPerHour,
  hookActionText,
  hookInputSchema,
  hookTriggerText,
  maxHookFilters,
  maxHookRunsPerHour,
  type HookInputRequest,
} from "./hooks.ts";

// A Hook as the Owner makes it (Guidelines, Specs and Hooks PRD, FR-118 to
// FR-120): its trigger, the filters that trigger takes, exactly one of an
// Agent and a Role, a Skill, and its runs an hour.

const migrationCheck: HookInputRequest = {
  name: "Migration check",
  trigger: "pull_request_opened",
  filePatterns: ["**/*.sql"],
  role: "reviewer",
  skillName: "migration-check",
};

const problemsOf = (input: unknown): string[] => {
  const parsed = hookInputSchema.safeParse(input);
  return parsed.success
    ? []
    : parsed.error.issues.map(({ message }) => message);
};

describe("a Hook as the Owner makes it", () => {
  it("fills in no Stage, no filters, 12 runs an hour and on", () => {
    expect(hookInputSchema.parse(migrationCheck)).toEqual({
      name: "Migration check",
      trigger: "pull_request_opened",
      stage: null,
      labels: [],
      filePatterns: ["**/*.sql"],
      agentId: null,
      role: "reviewer",
      skillName: "migration-check",
      runsPerHour: defaultHookRunsPerHour,
      enabled: true,
    });
    expect(defaultHookRunsPerHour).toBe(12);
  });

  it("trims its name and filters, and keeps each filter once", () => {
    expect(
      hookInputSchema.parse({
        ...migrationCheck,
        name: "  Migration check ",
        labels: [" db ", "db"],
        filePatterns: ["**/*.sql", " **/*.sql"],
      }),
    ).toMatchObject({
      name: "Migration check",
      labels: ["db"],
      filePatterns: ["**/*.sql"],
    });
  });

  it("names a Stage for a Stage Hook, and only then", () => {
    expect(problemsOf({ ...migrationCheck, trigger: "stage" })).toEqual([
      "Choose the Stage the Hook watches.",
    ]);
    expect(
      problemsOf({ ...migrationCheck, trigger: "stage", stage: "needs-qa" }),
    ).toEqual([]);
    expect(problemsOf({ ...migrationCheck, stage: "needs-qa" })).toEqual([
      "Only a Hook on an issue moving to a Stage names one.",
    ]);
    expect(
      problemsOf({ ...migrationCheck, trigger: "stage", stage: "needs-human" }),
    ).not.toEqual([]);
  });

  it("takes only the filters its trigger is narrowed by", () => {
    expect(
      problemsOf({ ...migrationCheck, trigger: "push", labels: ["db"] }),
    ).toEqual([
      '"A push to the default branch touches matching files" is not narrowed by label.',
    ]);
    expect(
      problemsOf({
        ...migrationCheck,
        trigger: "wrap_up",
        labels: ["db"],
      }),
    ).toEqual([`"A Batch's Wrap-up" is not narrowed by file pattern.`]);
    expect(
      problemsOf({ ...migrationCheck, trigger: "run_now", filePatterns: [] }),
    ).toEqual([]);
    expect(
      problemsOf({ ...migrationCheck, trigger: "run_now", labels: ["db"] }),
    ).toHaveLength(2);
  });

  it("asks a push Hook for the files it watches", () => {
    expect(
      problemsOf({ ...migrationCheck, trigger: "push", filePatterns: [] }),
    ).toEqual([
      "A Hook on a push names the files it watches, such as **/*.sql.",
    ]);
  });

  it("is run by exactly one of an Agent and a Role, never the Manager", () => {
    expect(problemsOf({ ...migrationCheck, role: null })).toEqual([
      "Choose an Agent, or a Role whose Agents run it.",
    ]);
    expect(problemsOf({ ...migrationCheck, agentId: "agent-1" })).toEqual([
      "Choose an Agent, or a Role whose Agents run it.",
    ]);
    expect(
      problemsOf({ ...migrationCheck, role: null, agentId: "agent-1" }),
    ).toEqual([]);
    expect(problemsOf({ ...migrationCheck, role: "manager" })).not.toEqual([]);
  });

  it("bounds its runs an hour, its filters and its name", () => {
    expect(problemsOf({ ...migrationCheck, runsPerHour: 0 })).toEqual([
      "A Hook makes at least 1 run an hour.",
    ]);
    expect(
      problemsOf({ ...migrationCheck, runsPerHour: maxHookRunsPerHour + 1 }),
    ).toEqual([
      `A Hook makes at most ${String(maxHookRunsPerHour)} runs an hour.`,
    ]);
    expect(
      problemsOf({
        ...migrationCheck,
        filePatterns: Array.from(
          { length: maxHookFilters + 1 },
          (_, index) => `${String(index)}/**`,
        ),
      }),
    ).toEqual([
      `A Hook filters by at most ${String(maxHookFilters)} file patterns.`,
    ]);
    expect(problemsOf({ ...migrationCheck, name: " " })).toEqual([
      "Give the Hook a name.",
    ]);
    expect(problemsOf({ ...migrationCheck, skillName: "Not A Skill" })).toEqual(
      ["A Skill's name is lowercase words joined by hyphens."],
    );
    expect(problemsOf({ ...migrationCheck, shell: "rm -rf /" })).not.toEqual(
      [],
    );
  });
});

describe("a Hook in words", () => {
  it("says when it runs", () => {
    const hook = hookInputSchema.parse(migrationCheck);
    expect(hookTriggerText(hook)).toBe(
      "A pull request is opened, touching **/*.sql",
    );
    expect(
      hookTriggerText(
        hookInputSchema.parse({
          ...migrationCheck,
          trigger: "stage",
          stage: "needs-review",
          labels: ["db", "api"],
          filePatterns: [],
        }),
      ),
    ).toBe("An issue moves to needs-review, labelled db or api");
    expect(
      hookTriggerText(
        hookInputSchema.parse({ ...migrationCheck, trigger: "push" }),
      ),
    ).toBe("A push to the default branch, touching **/*.sql");
  });

  it("says who runs which Skill", () => {
    const hook = hookInputSchema.parse(migrationCheck);
    expect(hookActionText(hook)).toBe("Any reviewer runs /migration-check");
    expect(hookActionText(hook, { role: "Reviewer" })).toBe(
      "Any Reviewer runs /migration-check",
    );
    const named = { ...hook, agentId: "agent-1", role: null };
    expect(hookActionText(named, { agent: "Ada" })).toBe(
      "Ada runs /migration-check",
    );
    expect(hookActionText(named)).toBe(
      "An Agent no longer on the Floor runs /migration-check",
    );
  });
});
