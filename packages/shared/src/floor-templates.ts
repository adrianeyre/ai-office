import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { maxExtraInstructions } from "./agents.ts";
import {
  floorSettingsSchema,
  floorThemeSchema,
  floorThemes,
  mergePolicies,
  templateIdSchema,
  type FloorTheme,
} from "./floors.ts";
import { pipelineLabels } from "./pipeline.ts";
import { createRoleRequestSchema } from "./role-library.ts";
import { roleIdSchema, stages, type RoleDefinition } from "./roles.ts";
import { splitFrontmatter, type SkillFile } from "./skills.ts";

// Floor Templates (PRD §6.18, FR-97, FR-99, FR-100): the starting set-up a
// Floor is added from. A built-in template is a folder under `templates/`
// in the AI Office repository, so a new one is a pull request:
//
//   templates/<id>/template.yaml        the manifest (`floorTemplateManifestSchema`)
//   templates/<id>/roles/<role>.md      each of its Roles (`parseRoleDocument`)
//   templates/<id>/skills/<skill>/…     each of its Skills, in the Agent Skills format
//
// Adding a Floor from a template adds its Roles to the office Role library
// where they are missing, then gives the Floor its team, settings and
// labels. Everything it sets up stays editable, and nothing depends on the
// template afterwards: the Floor only remembers which one it started from.
// The server and the web app share these.

/** The manifest at the top of each template's folder. */
export const floorTemplateManifestFileName = "template.yaml";
/** The folder of a template's Roles, one `<role id>.md` each. */
export const floorTemplateRolesFolder = "roles";
/** The folder of a template's Skills, one folder each. */
export const floorTemplateSkillsFolder = "skills";

/**
 * The icons a template is shown with in the picker, by name; the web app
 * draws each one.
 */
export const floorTemplateIcons = [
  "code",
  "square",
  "shopping-bag",
  "megaphone",
  "pen-line",
  "book-open",
  "palette",
  "chart-column",
  "server",
  "smartphone",
] as const;
export type FloorTemplateIcon = (typeof floorTemplateIcons)[number];

/** The most Agents of one Role a template starts a Floor with. */
export const maxTemplateRoleCount = 10;

/** The labels AI Office itself puts on every Floor's repository. */
const officeLabels = new Set(
  pipelineLabels.map(({ name }) => name.toLowerCase()),
);

/** A label a template creates on its Floor's repository. */
export const floorTemplateLabelSchema = z.strictObject({
  name: z
    .string({ error: "Name the label." })
    .trim()
    .min(1, { error: "Name the label." })
    .max(50, { error: "GitHub allows at most 50 characters in a label." })
    .refine((name) => !officeLabels.has(name.toLowerCase()), {
      error: "AI Office makes that label on every Floor itself.",
    }),
  color: z
    .string({ error: "A label's color is six hex digits, without #." })
    .regex(/^[0-9a-fA-F]{6}$/, {
      error: "A label's color is six hex digits, without #.",
    }),
  description: z
    .string()
    .max(100, {
      error: "GitHub allows at most 100 characters in a label's description.",
    })
    .default(""),
});
export type FloorTemplateLabel = z.infer<typeof floorTemplateLabelSchema>;

const oneLine = /^[^\p{Cc}]*$/u;

/** The issue a template's Manager suggests the Owner files first (FR-99). */
export const firstIssueSchema = z.strictObject({
  title: z
    .string({ error: "Give the first issue a title." })
    .trim()
    .min(1, { error: "Give the first issue a title." })
    .max(256, { error: "Use at most 256 characters for the title." })
    .regex(oneLine, { error: "Use one line for the title." }),
  body: z.string({ error: "The first issue's body is text." }).trim(),
});
export type FirstIssue = z.infer<typeof firstIssueSchema>;

/** What a template tells its Floor's Manager (FR-99). */
export const templateManagerSchema = z.strictObject({
  /** How the Manager plans this kind of work; empty for nothing extra. */
  planningGuidance: z
    .string({ error: "The planning guidance is text." })
    .trim(),
  /** The set-up issue the Manager suggests filing first; null for none. */
  firstIssue: firstIssueSchema.nullable(),
});
export type TemplateManager = z.infer<typeof templateManagerSchema>;

/**
 * A new Floor's Manager's own instructions from its template: the planning
 * guidance, then the suggested first set-up issue. Empty when the template
 * has neither, as Development does. The Owner edits them afterwards like
 * any Agent's extra instructions.
 */
export function managerInstructionsOf(manager: TemplateManager): string {
  const parts = [manager.planningGuidance.trim()];
  if (manager.firstIssue !== null) {
    const { title, body } = manager.firstIssue;
    parts.push(
      [
        `When the Owner asks where to start, suggest they file this set-up issue first, titled "${title.trim()}":`,
        ...(body.trim() === "" ? [] : ["", body.trim()]),
      ].join("\n"),
    );
  }
  return parts.filter((part) => part !== "").join("\n\n");
}

/** One of a template's Roles, and how many Agents a new Floor has in it. */
export const templateRoleSchema = z.strictObject({
  /** The Role's id: its file is `roles/<id>.md`. */
  role: roleIdSchema,
  /** 0 brings the Role into the library without an Agent in it. */
  count: z
    .number({ error: "A Role's count is a whole number." })
    .int({ error: "A Role's count is a whole number." })
    .min(0, { error: "A Role's count is at least 0." })
    .max(maxTemplateRoleCount, {
      error: `A Role's count is at most ${String(maxTemplateRoleCount)}.`,
    }),
});

/** The Floor settings a template sets (FR-99); the rest are the defaults. */
export const templateSettingsSchema = z.strictObject({
  setupCommand: floorSettingsSchema.shape.setupCommand,
  testCommand: floorSettingsSchema.shape.testCommand,
  mergePolicy: z.enum(mergePolicies, {
    error: "The Merge Policy is send_to_me or auto_merge.",
  }),
  roundCap: floorSettingsSchema.shape.roundCap,
  /**
   * The template's review-Stage Roles whose Agents are the Floor's
   * required reviewers (FR-27).
   */
  requiredReviewers: z.array(roleIdSchema),
});
export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

/** A template's name: one line, at most 40 characters. */
export const floorTemplateNameSchema = z
  .string({ error: "Name the template." })
  .trim()
  .min(1, { error: "Name the template." })
  .max(40, { error: "Use at most 40 characters for the name." })
  .regex(oneLine, { error: "Use one line for the name." });

/** A template's description: one line, at most 200 characters. */
export const floorTemplateDescriptionSchema = z
  .string({ error: "Describe the template in one line." })
  .trim()
  .min(1, { error: "Describe the template in one line." })
  .max(200, { error: "Use at most 200 characters for the description." })
  .regex(oneLine, { error: "Use one line for the description." });

/** `template.yaml`: everything a template holds but its Roles and Skills. */
export const floorTemplateManifestSchema = z
  .strictObject({
    name: floorTemplateNameSchema,
    description: floorTemplateDescriptionSchema,
    icon: z.enum(floorTemplateIcons, {
      error: `The icon is one of ${floorTemplateIcons.join(", ")}.`,
    }),
    /** The 3D theme its Floor is dressed in (FR-57); decoration only. */
    theme: floorThemeSchema,
    /** Besides the Manager, which every Floor has one of. */
    roles: z.array(templateRoleSchema).max(20),
    settings: templateSettingsSchema,
    manager: templateManagerSchema,
    labels: z.array(floorTemplateLabelSchema).max(50),
  })
  .superRefine((manifest, context) => {
    const roleIds = manifest.roles.map(({ role }) => role);
    for (const [index, role] of roleIds.entries()) {
      if (roleIds.indexOf(role) !== index) {
        context.addIssue({
          code: "custom",
          path: ["roles", index, "role"],
          message: `"${role}" is listed twice.`,
        });
      }
    }
    for (const [index, role] of manifest.settings.requiredReviewers.entries()) {
      const listed = manifest.roles.find((entry) => entry.role === role);
      if (listed === undefined || listed.count === 0) {
        context.addIssue({
          code: "custom",
          path: ["settings", "requiredReviewers", index],
          message: `"${role}" is a required reviewer, so the template starts at least one Agent in it.`,
        });
      }
    }
    const labels = manifest.labels.map(({ name }) => name.toLowerCase());
    for (const [index, label] of labels.entries()) {
      if (labels.indexOf(label) !== index) {
        context.addIssue({
          code: "custom",
          path: ["labels", index, "name"],
          message: `The label "${manifest.labels[index]?.name ?? label}" is listed twice.`,
        });
      }
    }
    if (managerInstructionsOf(manifest.manager).length > maxExtraInstructions) {
      context.addIssue({
        code: "custom",
        path: ["manager"],
        message: `The Manager's planning guidance and first issue come to at most ${String(maxExtraInstructions)} characters, an Agent's extra instructions.`,
      });
    }
  });
export type FloorTemplateManifest = z.infer<typeof floorTemplateManifestSchema>;

/** Where in a file or a document a problem is, followed by what it is. */
const located = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0
    ? issue.message
    : `${issue.path.map(String).join(".")}: ${issue.message}`;

/** Reads a YAML text into a value, or says why it cannot. */
function readYaml(
  text: string,
  what: string,
): { ok: true; value: unknown } | { ok: false; problems: string[] } {
  try {
    return { ok: true, value: parseYaml(text, { maxAliasCount: 0 }) };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "";
    return {
      ok: false,
      problems: [
        `${what} is not valid YAML${reason === undefined || reason === "" ? "" : `: ${reason}`}`,
      ],
    };
  }
}

/** Reads a `template.yaml`, checked against the manifest's schema. */
export function parseFloorTemplateManifest(
  text: string,
):
  | { ok: true; manifest: FloorTemplateManifest }
  | { ok: false; problems: string[] } {
  const yaml = readYaml(text, floorTemplateManifestFileName);
  if (!yaml.ok) {
    return yaml;
  }
  const parsed = floorTemplateManifestSchema.safeParse(yaml.value);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map(located) };
  }
  return { ok: true, manifest: parsed.data };
}

/**
 * Reads a template's `roles/<id>.md`: YAML frontmatter with the Role's
 * name, Stage, one-line routing description, Skills, desk dressing and
 * suggested AI Provider and Model, then its instructions as Markdown,
 * exactly as its Agents are given them.
 */
export function parseRoleDocument(
  id: string,
  text: string,
): { ok: true; role: RoleDefinition } | { ok: false; problems: string[] } {
  const parsedId = roleIdSchema.safeParse(id);
  if (!parsedId.success) {
    return {
      ok: false,
      problems: parsedId.error.issues.map(
        ({ message }) => `The file's name, "${id}": ${message}`,
      ),
    };
  }
  const parts = splitFrontmatter(text);
  if (parts === undefined) {
    return {
      ok: false,
      problems: [
        "A Role's file starts with YAML frontmatter between two --- lines.",
      ],
    };
  }
  const yaml = readYaml(parts.yaml, "The frontmatter");
  if (!yaml.ok) {
    return yaml;
  }
  const frontmatter = yaml.value;
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    Array.isArray(frontmatter)
  ) {
    return {
      ok: false,
      problems: [
        "The frontmatter is a set of fields, such as name, stage and description.",
      ],
    };
  }
  if ("instructions" in frontmatter) {
    return {
      ok: false,
      problems: ["Write the Role's instructions below the frontmatter."],
    };
  }
  const instructions = parts.instructions
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd();
  const parsed = createRoleRequestSchema.safeParse({
    ...frontmatter,
    instructions,
  });
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map(located) };
  }
  return { ok: true, role: { id: parsedId.data, ...parsed.data } };
}

/** A Skill a template brings, as its folder holds it. */
export interface FloorTemplateSkill {
  readonly name: string;
  readonly description: string;
  /** Its whole folder, `SKILL.md` first. */
  readonly files: readonly SkillFile[];
}

/** A Floor Template, loaded and checked as a whole. */
export interface FloorTemplate {
  /** Its folder's name. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: FloorTemplateIcon;
  readonly theme: FloorTheme;
  /** Its Roles, in its manifest's order, each with its starting count. */
  readonly roles: readonly {
    readonly role: RoleDefinition;
    readonly count: number;
  }[];
  readonly settings: TemplateSettings;
  readonly manager: TemplateManager;
  readonly labels: readonly FloorTemplateLabel[];
  readonly skills: readonly FloorTemplateSkill[];
}

/** One Role in a template's starting team, as the picker shows it. */
export const floorTemplateTeamMemberSchema = z.object({
  /** A library Role's id, or `manager`. */
  role: z.string(),
  name: z.string(),
  /** Null for the Manager, which has no Stage. */
  stage: z.enum(stages).nullable(),
  count: z.number().int().min(0),
});

/**
 * A Floor Template as the picker and the admin list it (`GET
 * /api/floor-templates`): the built-in ones and the Owner's own.
 */
export const floorTemplateSummarySchema = z.object({
  id: templateIdSchema,
  name: z.string(),
  description: z.string(),
  icon: z.enum(floorTemplateIcons),
  theme: z.enum(floorThemes),
  /** The Manager, then each Role with Agents, in the template's order. */
  team: z.array(floorTemplateTeamMemberSchema),
  /** Shipped with AI Office under `templates/`: read-only, and duplicated to change. */
  builtIn: z.boolean(),
  /**
   * Whether a Floor can be added from it: an imported template is not
   * until the Owner has reviewed its full contents (FR-101).
   */
  enabled: z.boolean(),
});
export type FloorTemplateSummary = z.infer<typeof floorTemplateSummarySchema>;

/** The body of `GET /api/floor-templates`. */
export const floorTemplateListSchema = z.object({
  /**
   * The built-in templates, Development first, then the Owner's own, each
   * by name. The picker offers the enabled ones.
   */
  templates: z.array(floorTemplateSummarySchema),
  /** The one the picker starts on: Development. */
  defaultTemplate: templateIdSchema,
});
export type FloorTemplateList = z.infer<typeof floorTemplateListSchema>;
