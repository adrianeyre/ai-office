import { z } from "zod";

import type { PipelineStage } from "./pipeline.ts";

// Roles are data on four fixed Stages (PRD FR-98, ADR 0003). A Role is a
// name, its Stage, a one-line routing description, instructions, its
// Skills, desk dressing and a suggested AI Provider and Model, kept in the
// office Role library. Every Agent but the Manager (and the Communications
// Agent) fills one. The pipeline, the Review Loop, Round Caps, the Merge
// Policy and the Manager's dispatch are written once against Stages, never
// against a Role's name. The server, the web app and the orchestrator share
// these.

/** The four Stages every issue passes through on a Floor, in order (FR-18). */
export const stages = ["work", "review", "qa", "docs"] as const;
export type Stage = (typeof stages)[number];

/** Each Stage's label: the label is where an issue waits for it (FR-18). */
export const stageLabels = {
  work: "needs-work",
  review: "needs-review",
  qa: "needs-qa",
  docs: "needs-docs",
} as const satisfies Readonly<Record<Stage, PipelineStage>>;

/** The Stage whose Agents work an issue labelled `label`, if any. */
export const stageOfLabel = (label: PipelineStage): Stage | undefined =>
  stages.find((stage) => stageLabels[stage] === label);

/** The Stages whose Agents work in sandboxes (FR-19); review does not (FR-20). */
export const sandboxStages: readonly Stage[] = ["work", "qa", "docs"];

/**
 * The Manager's Role. The Manager is built in, exactly one per Floor, and
 * is not a library Role (ADR 0003), so it has no Stage.
 */
export const managerRole = "manager";

/**
 * The built-in designer Role. Its Agents work at the work Stage like any
 * work Role, and, on a Floor with one, a designer also reviews a pull
 * request's UI at the QA Stage's label once QA has passed it (FR-10): a
 * design review, which only designers do, kept to the four Stages (ADR
 * 0003) by naming its Role on the work (`work_queue.role`).
 */
export const designerRole = "designer";

/** A library Role's id: lowercase words joined by hyphens. */
export const roleIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    error: "A Role's id is lowercase letters and digits, joined by hyphens.",
  })
  .max(40, { error: "A Role's id is at most 40 characters." })
  .refine((id) => id !== managerRole, {
    error: "The Manager is built in, not a library Role.",
  });

/**
 * What sits on a Role's desk in the Office (FR-57): decoration only. A
 * monitor; a designer's two; a reviewer's printouts; QA's test devices; a
 * writer's books and notebook; a copywriter's notebooks; a merchandiser's
 * product samples.
 */
export const deskDressings = [
  "monitor",
  "dual-monitors",
  "printouts",
  "test-devices",
  "books",
  "notebooks",
  "product-samples",
] as const;
export type DeskDressing = (typeof deskDressings)[number];

/** The most characters a Role's instructions may have. */
export const maxRoleInstructions = 8000;

/** A Role in the office Role library (FR-98), as the API sends it. */
export const roleDefinitionSchema = z.object({
  id: roleIdSchema,
  /** Its name, as people read it, such as `QA`; unique in the library. */
  name: z.string().trim().min(1).max(40),
  stage: z.enum(stages),
  /** One line the Manager routes work by, when a Floor has several work Roles. */
  description: z.string().trim().min(1).max(200),
  /**
   * What its Agents are told about their work, in their Stage's prompt. An
   * Agent's own extra instructions apply on top.
   */
  instructions: z.string().max(maxRoleInstructions),
  /** The Skills its Agents are given, by name. */
  skills: z.array(z.string()),
  deskDressing: z.enum(deskDressings),
  /**
   * The AI Provider a new Agent in it starts with, and the Model it
   * overrides that AI Provider's default with (null for the default). The
   * office default AI Provider stands in when the Owner has no AI Account
   * for the suggested one.
   */
  aiProvider: z.string().nullable(),
  model: z.string().nullable(),
});
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

/**
 * The Roles AI Office starts its library with: today's coder, reviewer,
 * QA, docs and designer, each with the instructions its Stage's prompt
 * has always given it. Their ids are the Roles' ids from before Roles were
 * data, so existing Agents keep theirs.
 *
 * Instructions are put in their Stage's prompt as they are written: a
 * work Role's in its list of how to work, a QA Role's in its numbered list
 * of what to check (after running the tests), a docs Role's in its
 * numbered list of what to do (after reading the diff), and a review
 * Role's as a paragraph of what to review for.
 */
export const builtInRoles: readonly RoleDefinition[] = [
  {
    id: "coder",
    name: "coder",
    stage: "work",
    description:
      "Changes the code: features, fixes and refactors, with their tests.",
    instructions:
      "- Make the smallest change that does what the issue asks, and commit it. Work that is not committed is lost.",
    skills: [],
    deskDressing: "monitor",
    aiProvider: "Claude",
    model: null,
  },
  {
    id: "reviewer",
    name: "reviewer",
    stage: "review",
    description:
      "Reviews a pull request's diff against its issue and gives a verdict.",
    instructions:
      "Review the change against the issue: does it do what the issue asks, correctly, safely, with tests where they are due, and in keeping with the code around it?",
    skills: [],
    deskDressing: "printouts",
    aiProvider: "Claude",
    model: null,
  },
  {
    id: "qa",
    name: "QA",
    stage: "qa",
    description:
      "Runs the tests, adds the missing ones and tries the change as a user would.",
    instructions: [
      "2. Where the change has no tests that cover it, add them, and commit them. Do not change the code under test: report what fails instead.",
      "3. If the repository has a web UI, start it and exercise the change in a browser with Playwright (for example `pnpm dlx playwright`), as a user would. Otherwise skip this step.",
    ].join("\n"),
    skills: [],
    deskDressing: "test-devices",
    aiProvider: "Claude",
    model: null,
  },
  {
    id: "docs",
    name: "docs",
    stage: "docs",
    description:
      "Documents the change: the README, the changelog and docstrings.",
    instructions: [
      "2. Update the README where the change affects what it says.",
      "3. Add an entry for the change to the changelog (such as `CHANGELOG.md`), if the repository keeps one.",
      "4. Add or update the docstrings of the code the change adds or changes.",
      "5. Change documentation only: never change behaviour, tests or configuration. If nothing needs documenting, change nothing.",
    ].join("\n"),
    skills: [],
    deskDressing: "books",
    // Updating documentation needs no large Model.
    aiProvider: "Claude",
    model: "claude-haiku-5-5",
  },
  {
    id: "designer",
    name: "designer",
    stage: "work",
    description:
      "Changes how it looks and feels: layouts, styles, components and images.",
    instructions:
      "- Make the smallest change that does what the issue asks, in keeping with the design the repository already has (its layout, type, colours and components), and commit it. Work that is not committed is lost.",
    skills: [],
    deskDressing: "dual-monitors",
    aiProvider: "Claude",
    model: null,
  },
];

/** The built-in Roles' ids, in the library's order. */
export const builtInRoleIds: readonly string[] = builtInRoles.map(
  ({ id }) => id,
);

/** A built-in Role, by id. */
export const builtInRole = (id: string): RoleDefinition | undefined =>
  builtInRoles.find((role) => role.id === id);

/**
 * How a Role is written for people: its name in `library` (the built-in
 * Roles' when none is given), `manager` for the Manager, or else its id.
 */
export const roleName = (
  role: string,
  library: readonly Pick<RoleDefinition, "id" | "name">[] = builtInRoles,
): string =>
  role === managerRole
    ? managerRole
    : (library.find(({ id }) => id === role)?.name ?? role);

/**
 * An Agent as people are told who is who: its name with its Role after it,
 * such as "Adrian (Coder)" or "Alan (Manager)". A Contractor, named after
 * its Role ("Migration writer 2"), is its name alone.
 */
export const agentWithRole = (
  agent: {
    readonly name: string;
    readonly role: string;
    /** Set for a Contractor, which is named after its Role already. */
    readonly contractor?: unknown;
  },
  library: readonly Pick<RoleDefinition, "id" | "name">[] = builtInRoles,
): string => {
  const role = roleName(agent.role, library);
  if (
    (agent.contractor !== undefined && agent.contractor !== null) ||
    agent.name.toLowerCase().startsWith(role.toLowerCase())
  ) {
    return agent.name;
  }
  return `${agent.name} (${role.charAt(0).toUpperCase()}${role.slice(1)})`;
};

/**
 * Each of `roles` once, in the library's order: the built-in Roles first,
 * as the library lists them, then the rest by id.
 */
export const inLibraryOrder = (roles: Iterable<string>): string[] => {
  const rank = (role: string) => {
    const index = builtInRoleIds.indexOf(role);
    return index === -1 ? builtInRoleIds.length : index;
  };
  return [...new Set(roles)].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
};
