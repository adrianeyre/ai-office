import { parse as parseYaml, YAMLError } from "yaml";
import { z } from "zod";

import { secretLikeLines } from "./office-memory.ts";
import type { PipelineLabel } from "./pipeline.ts";
import { createRedactor, type Redactor } from "./redact.ts";

// Guidelines (Guidelines, Specs and Hooks PRD, FR-102, FR-112; ADR 0014):
// the Owner's written rules for a Floor's repository, one Markdown file
// each in `.agents/guidelines/` on its default branch, with an optional
// front matter header saying when the Guideline applies.
//
// This is how one file is read and checked. A file that breaks the rules
// is kept with its reason, so the Floor admin can say what is wrong, and
// reaches no Agent. A Guideline never holds a credential: a file with a
// line that looks like one is refused, naming the line and never what it
// holds, so no reason ever repeats a secret. The server, the web app and
// the orchestrator share these.

/** Where a Floor's Guidelines live, from the top of its repository. */
export const guidelinesFolder = ".agents/guidelines";

/** The longest a Guideline's file may be, front matter and all. */
export const maxGuidelineLength = 12_000;

/**
 * When a Guideline applies:
 * - `always` (the default): to every task;
 * - `fileMatch`: to work on files matching its `fileMatchPattern`;
 * - `manual`: only to an issue labelled `guideline:<name>`.
 */
export const guidelineInclusions = ["always", "fileMatch", "manual"] as const;
export type GuidelineInclusion = (typeof guidelineInclusions)[number];

/** A Guideline's name: lowercase letters, digits and dashes. */
export const guidelineNamePattern = /^[a-z0-9-]+$/;

/** The fields a Guideline's front matter may have. */
export const guidelineFrontMatterFields = [
  "inclusion",
  "fileMatchPattern",
  "description",
] as const;

/**
 * How the Owner approved a version of a Guideline (FR-103; ADR 0014):
 * - `owner_merge`: the last commit that changed it reached the default
 *   branch through a pull request the Owner merged, on GitHub or with
 *   **Approve and merge** in AI Office;
 * - `owner_push`: the Owner pushed that commit;
 * - `owner_admin`: the Owner approved it in the Floor admin.
 */
export const guidelineApprovals = [
  "owner_merge",
  "owner_push",
  "owner_admin",
] as const;
export type GuidelineApproval = (typeof guidelineApprovals)[number];

/**
 * The most characters of Guidelines one prompt carries, together (FR-108):
 * over it, `fileMatch` Guidelines are left out before `always` ones, the
 * largest first. As long as one Guideline may be, so one always fits.
 */
export const guidelinesBudget = maxGuidelineLength;

/**
 * Where a sandbox Agent's Guidelines are mounted, read-only, beside its
 * memory and never in its clone (FR-106): one file each, `<name>.md`.
 */
export const sandboxGuidelinesDirectory = "/home/agent/.ai-office/guidelines";

/**
 * The tasks Guidelines are chosen for (FR-105): the four Stages' work, the
 * designer's, and the Manager's triage, Plan and chat.
 */
export const guidelineTasks = [
  "work",
  "review",
  "qa",
  "docs",
  "design",
  "triage",
  "plan",
  "chat",
] as const;
export type GuidelineTask = (typeof guidelineTasks)[number];

/** The prefix of the label that asks for a `manual` Guideline. */
export const guidelineLabelPrefix = "guideline:";

/**
 * The label that gives an issue's tasks a `manual` Guideline (FR-105):
 * `guideline:` and its name, such as `guideline:release`.
 */
export const guidelineLabelName = (name: string): string =>
  `${guidelineLabelPrefix}${name}`;

/**
 * The `guideline:<name>` label intake makes on a Floor's repository for
 * each of its `manual` Guidelines, as it does `role:<name>` labels.
 */
export const guidelineLabel = (name: string): PipelineLabel => ({
  name: guidelineLabelName(name),
  color: "d4c5f9",
  description: `AI Office: follow the Owner's ${name} Guideline`.slice(0, 100),
});

/**
 * The names of the Guidelines `labels` ask for, by `guideline:<name>`
 * labels in any case, each once, in the labels' order.
 */
export const guidelinesLabelled = (labels: readonly string[]): string[] => [
  ...new Set(
    labels
      .map((label) => label.trim().toLowerCase())
      .filter((label) => label.startsWith(guidelineLabelPrefix))
      .map((label) => label.slice(guidelineLabelPrefix.length).trim())
      .filter((name) => guidelineNamePattern.test(name)),
  ),
];

/** The id of the Floor admin's Guidelines card, which links name with `#`. */
export const guidelinesCardId = "guidelines";

/** Where the Owner sees a Floor's Guidelines: its Floor admin's card. */
export const floorGuidelinesPath = (floorId: string): string =>
  `/floor-settings/${encodeURIComponent(floorId)}#${guidelinesCardId}`;

/** A Guideline that keeps the rules. */
export interface Guideline {
  /** Its file name without `.md`, such as `migrations`. */
  readonly name: string;
  /** Its file from the top of the repository. */
  readonly path: string;
  readonly inclusion: GuidelineInclusion;
  /**
   * The globs a `fileMatch` Guideline applies to, as written; empty for
   * any other.
   */
  readonly fileMatchPatterns: readonly string[];
  /** Its one line of description, or null when it has none. */
  readonly description: string | null;
  /** The whole file, front matter and all, exactly as it was read. */
  readonly content: string;
  /** Its rules: the Markdown after the front matter. */
  readonly body: string;
}

/**
 * Why a file in the Guidelines folder reaches no Agent:
 * - `holds_secret`: a line looks like it holds a credential (FR-112);
 * - `invalid`: it breaks another of FR-102's rules.
 */
export const guidelineRefusals = ["holds_secret", "invalid"] as const;
export type GuidelineRefusal = (typeof guidelineRefusals)[number];

/** A file in the Guidelines folder that reaches no Agent, and why. */
export interface RefusedGuideline {
  /** Its file name without `.md`, as it is, whether it fits or not. */
  readonly name: string;
  /** Its file from the top of the repository. */
  readonly path: string;
  readonly refusal: GuidelineRefusal;
  /** What is wrong, for the Owner: never a word of what a line holds. */
  readonly reason: string;
  /** The lines (from 1) that look like a credential; empty otherwise. */
  readonly secretLines: readonly number[];
}

/** A Floor's Guidelines, as read from its default branch. */
export interface FloorGuidelines {
  /** Those that keep the rules, by name. */
  readonly guidelines: readonly Guideline[];
  /** Those that break them, by path, each with its reason. */
  readonly refused: readonly RefusedGuideline[];
}

/** A Floor with no Guidelines folder, or nothing in it. */
export const noGuidelines: FloorGuidelines = { guidelines: [], refused: [] };

/** Whether a file in the Guidelines folder is one, by its name: `*.md`. */
export const isGuidelineFileName = (fileName: string): boolean =>
  /\.md$/i.test(fileName) && fileName.length > 3;

/** A Guideline's name from its file name: without `.md`. */
export const guidelineNameOf = (fileName: string): string =>
  fileName.replace(/\.md$/i, "");

const listed = (items: readonly string[]): string =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/** Why lines that look like a credential refuse a Guideline. */
export function secretLinesReason(lines: readonly number[]): string {
  const which = listed(lines.map(String));
  return lines.length === 1
    ? `Line ${which} looks like it holds a credential, which a Guideline never does: take it out.`
    : `Lines ${which} look like they hold a credential, which a Guideline never does: take them out.`;
}

type FrontMatterRead =
  | {
      readonly ok: true;
      readonly fields: Record<string, unknown>;
      readonly body: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Splits off the front matter, between a first line `---` and the next,
 * and reads it as YAML. A file without one has no fields. No reason quotes
 * the file: a YAML error is told by where it is, never by what is there.
 */
function readFrontMatter(text: string): FrontMatterRead {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") {
    return { ok: true, fields: {}, body: lines.join("\n").trim() };
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === "---",
  );
  if (end === -1) {
    return {
      ok: false,
      reason:
        "Its front matter opens with a --- line but has no closing --- line.",
    };
  }
  let yaml: unknown;
  try {
    yaml = parseYaml(lines.slice(1, end).join("\n"), { maxAliasCount: 0 });
  } catch (error) {
    const at = error instanceof YAMLError ? error.linePos?.[0] : undefined;
    return {
      ok: false,
      reason:
        at === undefined
          ? "Its front matter is not valid YAML."
          : // The front matter starts on the file's second line.
            `Its front matter is not valid YAML at line ${String(at.line + 1)}, column ${String(at.col)}.`,
    };
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  if (yaml === null || yaml === undefined) {
    return { ok: true, fields: {}, body };
  }
  if (typeof yaml !== "object" || Array.isArray(yaml)) {
    return {
      ok: false,
      reason: `Its front matter is a set of fields: ${listed(guidelineFrontMatterFields)}.`,
    };
  }
  return { ok: true, fields: yaml as Record<string, unknown>, body };
}

const isOneLine = (value: unknown): value is string =>
  typeof value === "string" && !/[\r\n]/.test(value);

type FieldsRead =
  | {
      readonly ok: true;
      readonly inclusion: GuidelineInclusion;
      readonly fileMatchPatterns: readonly string[];
      readonly description: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/** Checks the front matter's fields against FR-102. */
function readFields(fields: Record<string, unknown>): FieldsRead {
  const unknown = Object.keys(fields).filter(
    (field) =>
      !(guidelineFrontMatterFields as readonly string[]).includes(field),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `Its front matter has ${listed(unknown.map((field) => `"${field}"`))}, which a Guideline does not take: only ${listed(guidelineFrontMatterFields)}.`,
    };
  }
  // A field written with no value (`description:`) is as good as none.
  const {
    inclusion = null,
    fileMatchPattern = null,
    description = null,
  } = fields;

  if (
    inclusion !== null &&
    !(guidelineInclusions as readonly unknown[]).includes(inclusion)
  ) {
    return {
      ok: false,
      reason: "inclusion is always, fileMatch or manual.",
    };
  }
  const chosen: GuidelineInclusion =
    (inclusion as GuidelineInclusion | null) ?? "always";

  let patterns: string[] = [];
  if (fileMatchPattern !== null) {
    const given = Array.isArray(fileMatchPattern)
      ? (fileMatchPattern as unknown[])
      : [fileMatchPattern];
    if (
      given.length === 0 ||
      !given.every((pattern) => isOneLine(pattern) && pattern.trim() !== "")
    ) {
      return {
        ok: false,
        reason:
          "fileMatchPattern is one glob, or a list of globs, each one line of text.",
      };
    }
    patterns = (given as string[]).map((pattern) => pattern.trim());
  }
  if (chosen === "fileMatch" && patterns.length === 0) {
    return {
      ok: false,
      reason:
        "inclusion: fileMatch needs a fileMatchPattern: one glob, or a list of globs.",
    };
  }
  if (chosen !== "fileMatch" && patterns.length > 0) {
    // Otherwise a Guideline meant for some files would apply to every task.
    return {
      ok: false,
      reason:
        "fileMatchPattern applies only with inclusion: fileMatch, which it does not say.",
    };
  }

  if (description !== null && !isOneLine(description)) {
    return { ok: false, reason: "description is one line of text." };
  }
  const line = description?.trim() ?? "";

  return {
    ok: true,
    inclusion: chosen,
    fileMatchPatterns: patterns,
    description: line === "" ? null : line,
  };
}

/** One file of the Guidelines folder, read: a Guideline, or why it is not. */
export type ParsedGuideline =
  | { readonly ok: true; readonly guideline: Guideline }
  | { readonly ok: false; readonly refused: RefusedGuideline };

/**
 * Reads one file of a Floor's Guidelines folder, `fileName` (such as
 * `migrations.md`) holding `text`, against FR-102 and FR-112. A line that
 * looks like a credential refuses it first, before anything else is read,
 * so that no other reason can come near what the line holds; then its
 * length, its name and its front matter.
 */
export function parseGuideline(
  fileName: string,
  text: string,
  options: { readonly redactor?: Redactor } = {},
): ParsedGuideline {
  const name = guidelineNameOf(fileName);
  const path = `${guidelinesFolder}/${fileName}`;
  const refuse = (
    reason: string,
    refusal: GuidelineRefusal = "invalid",
    secretLines: readonly number[] = [],
  ): ParsedGuideline => ({
    ok: false,
    refused: { name, path, refusal, reason, secretLines },
  });

  const secrets = secretLikeLines(text, options.redactor ?? createRedactor());
  if (secrets.length > 0) {
    return refuse(secretLinesReason(secrets), "holds_secret", secrets);
  }
  if (text.length > maxGuidelineLength) {
    return refuse(
      `A Guideline is at most ${maxGuidelineLength.toLocaleString("en-GB")} characters; this one has ${text.length.toLocaleString("en-GB")}.`,
    );
  }
  if (!fileName.endsWith(".md") || !guidelineNamePattern.test(name)) {
    return refuse(
      "A Guideline's name is its file name without .md, in lowercase letters, digits and dashes, such as migrations.md.",
    );
  }
  const frontMatter = readFrontMatter(text);
  if (!frontMatter.ok) {
    return refuse(frontMatter.reason);
  }
  const fields = readFields(frontMatter.fields);
  if (!fields.ok) {
    return refuse(fields.reason);
  }
  return {
    ok: true,
    guideline: {
      name,
      path,
      inclusion: fields.inclusion,
      fileMatchPatterns: fields.fileMatchPatterns,
      description: fields.description,
      content: text,
      body: frontMatter.body,
    },
  };
}

// The Floor admin's Guidelines card (FR-103, FR-111): `GET
// /api/floors/:floorId/guidelines` lists each Guideline on the Floor's
// default branch, the version the Owner approved and any awaiting
// approval, or why the file reaches no Agent; `POST …/guidelines/:name/
// approve` and `…/dismiss` name the version the Owner saw by its hash, and
// are refused with a 409 when it is no longer the one waiting.

/** A version, by the SHA-256 of its whole file. */
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  error: "Give the content hash of the version you saw.",
});

/** The version of a Guideline Agents get: the one the Owner approved. */
export const approvedGuidelineVersionSchema = z.object({
  contentHash: z.string(),
  approval: z.enum(guidelineApprovals),
  /** The whole file, as approved. */
  content: z.string(),
  /**
   * Whether it is the version on the default branch: false while a later
   * one waits or breaks the rules there.
   */
  current: z.boolean(),
});
export type ApprovedGuidelineVersion = z.infer<
  typeof approvedGuidelineVersionSchema
>;

/** What a version the Owner has not approved waits for. */
export const guidelineVersionStatuses = ["awaiting", "dismissed"] as const;

/** The version on the default branch the Owner has not approved. */
export const awaitingGuidelineVersionSchema = z.object({
  contentHash: z.string(),
  /** `awaiting` the Owner's approval, or `dismissed` by the Owner. */
  status: z.enum(guidelineVersionStatuses),
  /** The whole file, as it is on the default branch. */
  content: z.string(),
  /** The last commit that changed it, when GitHub said. */
  commitSha: z.string().nullable(),
});
export type AwaitingGuidelineVersion = z.infer<
  typeof awaitingGuidelineVersionSchema
>;

/** Why the file on the default branch reaches no Agent (FR-102, FR-112). */
export const guidelineErrorSchema = z.object({
  refusal: z.enum(guidelineRefusals),
  /** For the Owner: never a word of what a line holds. */
  reason: z.string(),
  secretLines: z.array(z.number().int()),
});

/** One Guideline of a Floor, as its admin card shows it. */
export const floorGuidelineSchema = z.object({
  name: z.string(),
  path: z.string(),
  /**
   * When it applies, its patterns and description: as Agents get it, or,
   * with no version approved, as the one awaiting approval says; null and
   * empty when neither is readable.
   */
  inclusion: z.enum(guidelineInclusions).nullable(),
  fileMatchPatterns: z.array(z.string()),
  description: z.string().nullable(),
  /** What Agents get; null when the Owner has approved no version. */
  approved: approvedGuidelineVersionSchema.nullable(),
  /** The version on the default branch, when the Owner has not approved it. */
  awaiting: awaitingGuidelineVersionSchema.nullable(),
  /** Why the file on the default branch breaks the rules; null when it keeps them. */
  error: guidelineErrorSchema.nullable(),
});
export type FloorGuideline = z.infer<typeof floorGuidelineSchema>;

export const floorGuidelineListSchema = z.object({
  /** By name. */
  guidelines: z.array(floorGuidelineSchema),
  /** How many versions await the Owner's approval. */
  awaitingCount: z.number().int(),
});
export type FloorGuidelineList = z.infer<typeof floorGuidelineListSchema>;

/** The body of `POST …/guidelines/:name/approve` and `…/dismiss`. */
export const guidelineVersionRequestSchema = z.strictObject({
  contentHash: contentHashSchema,
});
export type GuidelineVersionRequest = z.infer<
  typeof guidelineVersionRequestSchema
>;

export const guidelineErrorCodes = {
  /** The Floor's default branch has no Guideline of that name. */
  guidelineNotFound: "guideline_not_found",
  /**
   * The version named is not the one waiting: it changed meanwhile, or was
   * approved or dismissed already.
   */
  guidelineChanged: "guideline_changed",
} as const;
export type GuidelineErrorCode =
  (typeof guidelineErrorCodes)[keyof typeof guidelineErrorCodes];
