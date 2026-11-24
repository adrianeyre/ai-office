import { z } from "zod";

import { maxGrillingIssues } from "./grilling-issues.ts";

// Specs (Guidelines, Specs and Hooks PRD, FR-113; ADR 0015): a feature's
// requirements, design and tasks, agreed with the Owner one step at a time
// in a Grilling Session started with `/spec <words>`. The session goes
// through three phases, in order, each ending with the Owner's own words:
// 1. **requirements**: user stories, each with its Acceptance Criteria;
//    "confirm requirements".
// 2. **design**: architecture, data, error handling and testing; "confirm
//    design", or "skip design" on any Floor.
// 3. **tasks**: ordered tasks, each naming the criteria it meets and the
//    tasks it depends on; "confirm tasks". They become the session's issue
//    drafts.
// The Manager's Model drafts the phase's document as structured data; a
// confirmation keeps that draft as the approved copy, which plain code
// writes as `.agents/specs/<slug>/<phase>.md` on the session's branch.
// Reopening an earlier phase drops the approved copies from it on, and the
// drafts of the later phases, which are drafted again. Later prompts and
// Agents read the approved copy kept with the session, never the file as
// it stands. The server, the web app and the orchestrator share these.

/** Where a Floor's Specs are kept, one folder each: `.agents/specs/<slug>/`. */
export const specsFolder = ".agents/specs";

/** A Spec session's phases, in order. */
export const specPhases = ["requirements", "design", "tasks"] as const;
export type SpecPhase = (typeof specPhases)[number];

/** Each phase's document, in the Spec's folder. */
export const specDocumentNames: Readonly<Record<SpecPhase, string>> = {
  requirements: "requirements.md",
  design: "design.md",
  tasks: "tasks.md",
};

/** A Spec's folder: `.agents/specs/checkout-with-saved-cards`. */
export const specFolder = (slug: string): string => `${specsFolder}/${slug}`;

/** A phase's document: `.agents/specs/<slug>/requirements.md`. */
export const specDocumentPath = (slug: string, phase: SpecPhase): string =>
  `${specFolder(slug)}/${specDocumentNames[phase]}`;

/** The phase after `phase`; none after the tasks. */
export const nextSpecPhase = (phase: SpecPhase): SpecPhase | undefined =>
  specPhases[specPhases.indexOf(phase) + 1];

/** Whether `phase` comes before `other`. */
export const specPhaseBefore = (phase: SpecPhase, other: SpecPhase): boolean =>
  specPhases.indexOf(phase) < specPhases.indexOf(other);

/** The most user stories one Spec's requirements hold. */
export const maxSpecRequirements = 20;
/** The most Acceptance Criteria one user story holds. */
export const maxSpecCriteria = 20;
/** The most tasks one Spec holds: each becomes one issue draft. */
export const maxSpecTasks = maxGrillingIssues;
/** The most criteria one task names. */
export const maxSpecTaskCriteria = 30;
/** The longest title, story or criterion. */
export const maxSpecLineLength = 2000;
/** The longest section of a Spec's document. */
export const maxSpecTextLength = 8000;
/**
 * The most characters of a Spec one Agent's prompt quotes (FR-116): the
 * issue's Acceptance Criteria first, then the approved `design.md`, cut
 * at what is left, the prompt saying so.
 */
export const specBudget = 12_000;

const timestampSchema = z.iso.datetime({ offset: true });

/** One user story and its Acceptance Criteria, each a line with its id. */
export const specRequirementSchema = z.object({
  title: z.string(),
  /** "As a shopper, I want …, so that …". */
  story: z.string(),
  /** Its Acceptance Criteria, each "R1.2 WHEN … THE SYSTEM SHALL …". */
  criteria: z.array(z.string()),
});
export type SpecRequirement = z.infer<typeof specRequirementSchema>;

/** `requirements.md`: what the feature is for, then its user stories. */
export const specRequirementsSchema = z.object({
  introduction: z.string(),
  requirements: z.array(specRequirementSchema),
});
export type SpecRequirements = z.infer<typeof specRequirementsSchema>;

/** `design.md`: how it is built, section by section. */
export const specDesignSchema = z.object({
  overview: z.string(),
  architecture: z.string(),
  data: z.string(),
  errorHandling: z.string(),
  testing: z.string(),
});
export type SpecDesign = z.infer<typeof specDesignSchema>;

/** One task of `tasks.md`, numbered by its place. */
export const specTaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  /** The Acceptance Criteria it meets, by id: `R2.3`. */
  meets: z.array(z.string()),
  /** The earlier tasks it depends on, by number. */
  dependsOn: z.array(z.number().int().positive()),
});
export type SpecTask = z.infer<typeof specTaskSchema>;

/** Each phase's document, or null for none. */
const byPhase = {
  requirements: specRequirementsSchema.nullable(),
  design: specDesignSchema.nullable(),
  tasks: z.array(specTaskSchema).nullable(),
};

/**
 * A Spec session's own state, kept with the session: its folder's slug,
 * the phase it is in, the Manager's draft of each document, the copy the
 * Owner approved of each, and when each was confirmed.
 */
export const grillingSpecSchema = z.object({
  /** The Spec's folder in `.agents/specs/`. */
  slug: z.string(),
  phase: z.enum(specPhases),
  /** The Manager's latest draft of each document; null until drafted. */
  drafts: z.object(byPhase),
  /** Each document as the Owner confirmed it; null until confirmed. */
  approved: z.object(byPhase),
  /** The Owner said "skip design": the Spec has no design.md. */
  designSkipped: z.boolean(),
  /** When each phase was confirmed (or the design skipped); null until then. */
  confirmedAt: z.object({
    requirements: timestampSchema.nullable(),
    design: timestampSchema.nullable(),
    tasks: timestampSchema.nullable(),
  }),
});
export type GrillingSpec = z.infer<typeof grillingSpecSchema>;

/** A Spec just started: drafting its requirements, nothing approved. */
export const newGrillingSpec = (slug: string): GrillingSpec => ({
  slug,
  phase: "requirements",
  drafts: { requirements: null, design: null, tasks: null },
  approved: { requirements: null, design: null, tasks: null },
  designSkipped: false,
  confirmedAt: { requirements: null, design: null, tasks: null },
});

// A Spec's part of one of the Manager's turns, as its Model writes it as
// JSON: the current phase's document, in full. AI Office keeps only the
// current phase's, replacing the draft before it.
const line = (what: string) =>
  z
    .string({ error: `${what} is text.` })
    .trim()
    .min(1, { error: `${what} is not empty.` })
    .max(maxSpecLineLength, {
      error: `${what} is at most ${String(maxSpecLineLength)} characters.`,
    });
const section = (what: string) =>
  z
    .string({ error: `${what} is text.` })
    .trim()
    .min(1, { error: `${what} is not empty.` })
    .max(maxSpecTextLength, {
      error: `${what} is at most ${String(maxSpecTextLength)} characters.`,
    });
const optionalSection = z.string().trim().max(maxSpecTextLength).default("");

export const specTurnSchema = z.object({
  requirements: z
    .object({
      introduction: optionalSection,
      requirements: z
        .array(
          z.object({
            title: line("A requirement's title").max(200),
            story: line("A user story"),
            criteria: z
              .array(line("An Acceptance Criterion"))
              .min(1, {
                error: "A user story has at least one Acceptance Criterion.",
              })
              .max(maxSpecCriteria),
          }),
        )
        .min(1, { error: "The requirements hold at least one user story." })
        .max(maxSpecRequirements),
    })
    .optional(),
  design: z
    .object({
      overview: optionalSection,
      architecture: section("The design's architecture"),
      data: section("The design's data"),
      errorHandling: section("The design's error handling"),
      testing: section("The design's testing approach"),
    })
    .optional(),
  tasks: z
    .array(
      z.object({
        title: line("A task's title").max(200),
        description: section("A task's description"),
        meets: z
          .array(line("A criterion's id").max(20))
          .min(1, {
            error: "A task names at least one Acceptance Criterion it meets.",
          })
          .max(maxSpecTaskCriteria),
        dependsOn: z
          .array(z.number().int().positive())
          .max(maxSpecTasks)
          .default([]),
      }),
    )
    .min(1, { error: "The tasks hold at least one task." })
    .max(maxSpecTasks)
    .optional(),
});
export type SpecTurn = z.infer<typeof specTurnSchema>;

/** A criterion's id, at its start: "R2.3" of "R2.3 WHEN …"; none without. */
export function specCriterionId(criterion: string): string | undefined {
  return /^\s*\**\s*(R\d+\.\d+)\b/i.exec(criterion)?.[1]?.toUpperCase();
}

/** The criterion of `id` in `requirements`, as written; none if none has it. */
export function specCriterion(
  requirements: SpecRequirements | null,
  id: string,
): string | undefined {
  const wanted = id.trim().toUpperCase();
  return requirements?.requirements
    .flatMap(({ criteria }) => criteria)
    .find((criterion) => specCriterionId(criterion) === wanted);
}

/** The Spec's title in its documents: what `/spec` was given, or its slug. */
const titleOf = (topic: string, slug: string): string =>
  topic.trim() === "" ? slug : topic.trim();

/** `requirements.md`, from the requirements as kept. */
export function specRequirementsDocument(
  topic: string,
  slug: string,
  requirements: SpecRequirements,
): string {
  return [
    `# Requirements: ${titleOf(topic, slug)}`,
    "",
    ...(requirements.introduction.trim() === ""
      ? []
      : [requirements.introduction.trim(), ""]),
    ...requirements.requirements.flatMap(
      ({ title, story, criteria }, index) => [
        `## Requirement ${String(index + 1)}: ${title}`,
        "",
        `**User story:** ${story.trim()}`,
        "",
        "### Acceptance Criteria",
        "",
        ...criteria.map((criterion) => `- ${criterion.trim()}`),
        "",
      ],
    ),
  ].join("\n");
}

/** `design.md`, from the design as kept. */
export function specDesignDocument(
  topic: string,
  slug: string,
  design: SpecDesign,
): string {
  return [
    `# Design: ${titleOf(topic, slug)}`,
    "",
    ...(design.overview.trim() === "" ? [] : [design.overview.trim(), ""]),
    "## Architecture",
    "",
    design.architecture.trim(),
    "",
    "## Data",
    "",
    design.data.trim(),
    "",
    "## Error handling",
    "",
    design.errorHandling.trim(),
    "",
    "## Testing",
    "",
    design.testing.trim(),
    "",
  ].join("\n");
}

/** The issue filed for a task (FR-117): `tasks.md` links it. */
export interface SpecTaskIssue {
  readonly number: number;
  readonly url: string;
}

/**
 * `tasks.md`, from the tasks as kept, in their order, each linking the
 * issue filed for it once there is one (`issues`, by the task's place;
 * FR-117). It holds no status: progress is read from the issues.
 */
export function specTasksDocument(
  topic: string,
  slug: string,
  tasks: readonly SpecTask[],
  issues: readonly (SpecTaskIssue | undefined)[] = [],
): string {
  return [
    `# Tasks: ${titleOf(topic, slug)}`,
    "",
    "In the order they are built. Each task becomes one issue; its progress is read from the issue.",
    "",
    ...tasks.flatMap(({ title, description, meets, dependsOn }, index) => [
      `## ${String(index + 1)}. ${title}`,
      "",
      description.trim(),
      "",
      `- **Meets:** ${meets.join(", ")}`,
      `- **Depends on:** ${dependsOn.length === 0 ? "none" : dependsOn.map((number) => `task ${String(number)}`).join(", ")}`,
      ...linkOf(issues[index]),
      "",
    ]),
  ].join("\n");
}

/** A task's issue, as `tasks.md` links it; none before it is filed. */
const linkOf = (issue: SpecTaskIssue | undefined): string[] =>
  issue === undefined
    ? []
    : [`- **Issue:** [#${String(issue.number)}](${issue.url})`];

/** A phase's document as written from `document`, the phase's kept copy. */
export function specDocument(
  topic: string,
  spec: Pick<GrillingSpec, "slug">,
  phase: SpecPhase,
  document: GrillingSpec["drafts"],
): string | undefined {
  const { slug } = spec;
  if (phase === "requirements") {
    return document.requirements === null
      ? undefined
      : specRequirementsDocument(topic, slug, document.requirements);
  }
  if (phase === "design") {
    return document.design === null
      ? undefined
      : specDesignDocument(topic, slug, document.design);
  }
  return document.tasks === null
    ? undefined
    : specTasksDocument(topic, slug, document.tasks);
}
