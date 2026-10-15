import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Role } from "./agents.ts";
import { ownerUrl } from "./internal-hosts.ts";

// Skills (PRD §6.14, FR-71, FR-72, FR-76) in the Agent Skills format
// (https://agentskills.io/specification): a folder with a `SKILL.md`, whose
// YAML frontmatter names and describes the Skill above its instructions,
// plus any supporting files. The office Skill library takes them by
// upload, by import from a Git repository, or from the editor. The server
// and the web app share these, so the editor can say what is wrong before
// anything is sent.
//
// Skills are instructions, so every file is text the Owner can read in
// full: an imported Skill is reviewed before it can be enabled (FR-76).

/** The file every Skill has, at the top of its folder. */
export const skillFileName = "SKILL.md";

/** At most this many files in one Skill, `SKILL.md` included. */
export const maxSkillFiles = 200;
/** At most this many bytes (UTF-8) across one Skill's files. */
export const maxSkillBytes = 4_000_000;
const maxPathLength = 300;

/** Lowercase letters, digits and single hyphens, neither first nor last. */
export const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const maxSkillNameLength = 64;
export const maxSkillDescriptionLength = 1024;
const maxCompatibilityLength = 500;

/**
 * How a Skill came into the library: uploaded, imported from Git, written
 * in the editor, or brought by a built-in Floor Template as a Floor was
 * added from it.
 */
export const skillSources = ["upload", "git", "editor", "template"] as const;
export type SkillSource = (typeof skillSources)[number];

/** Each source, as the Owner reads it. */
export const skillSourceLabels: Record<SkillSource, string> = {
  upload: "Uploaded",
  git: "Imported from Git",
  editor: "Written in the editor",
  template: "From a Floor Template",
};

/**
 * Skills that came from outside AI Office. They start disabled, and are
 * enabled only once the Owner has reviewed their full contents (FR-76).
 */
export const importedSkillSources: readonly SkillSource[] = ["upload", "git"];

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).length;

/**
 * What is wrong with a path inside a Skill's folder, if anything: it must
 * be relative, use `/`, and stay inside the folder.
 */
export function skillPathProblem(path: string): string | undefined {
  if (path === "") {
    return "A file needs a path.";
  }
  if (path.length > maxPathLength) {
    return `Keep each file's path to ${String(maxPathLength)} characters.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) {
    return `"${path}" may not hold a backslash or a control character.`;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) {
    return `"${path}" is not a relative path inside the Skill's folder.`;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `"${path}" may not use . or .. to leave its folder.`;
  }
  return undefined;
}

const skillPath = z
  .string({ error: "A file's path is text." })
  .superRefine((path, context) => {
    const problem = skillPathProblem(path);
    if (problem !== undefined) {
      context.addIssue({ code: "custom", message: problem });
    }
  });

export const skillFileSchema = z.strictObject({
  /** Relative to the Skill's folder, such as `scripts/extract.py`. */
  path: skillPath,
  /** The file's text. */
  content: z
    .string({ error: "A file's content is text." })
    .refine((content) => !content.includes("\u0000"), {
      error: "Skills hold text files only.",
    }),
});
export type SkillFile = z.infer<typeof skillFileSchema>;

/** A `SKILL.md`, split into its frontmatter and its instructions. */
export interface SkillDocument {
  readonly name: string;
  readonly description: string;
  /** Every field of the frontmatter, as YAML gave it. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** The Markdown after the frontmatter. */
  readonly instructions: string;
}

const frontmatterSchema = z.looseObject({
  name: z
    .string({ error: "The frontmatter needs a name." })
    .min(1, { error: "The frontmatter needs a name." })
    .max(maxSkillNameLength, {
      error: `A Skill's name is at most ${String(maxSkillNameLength)} characters.`,
    })
    .regex(skillNamePattern, {
      error:
        "A Skill's name uses only lowercase letters, digits and single hyphens, and does not start or end with a hyphen.",
    }),
  description: z
    .string({ error: "The frontmatter needs a description." })
    .refine((description) => description.trim() !== "", {
      error: "The frontmatter needs a description.",
    })
    .refine((description) => description.length <= maxSkillDescriptionLength, {
      error: `A Skill's description is at most ${String(maxSkillDescriptionLength)} characters.`,
    }),
  license: z.string({ error: "The license is text." }).optional(),
  compatibility: z
    .string({ error: "Compatibility is text." })
    .min(1, { error: "Compatibility, when given, is not empty." })
    .max(maxCompatibilityLength, {
      error: `Compatibility is at most ${String(maxCompatibilityLength)} characters.`,
    })
    .optional(),
  metadata: z
    .record(z.string(), z.string({ error: "Metadata maps names to text." }), {
      error: "Metadata maps names to text.",
    })
    .optional(),
  "allowed-tools": z
    .string({ error: "Allowed tools are one line of text." })
    .optional(),
});

/** Splits off the frontmatter, between a first line `---` and the next. */
export function splitFrontmatter(
  text: string,
): { yaml: string; instructions: string } | undefined {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") {
    return undefined;
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === "---",
  );
  if (end === -1) {
    return undefined;
  }
  return {
    yaml: lines.slice(1, end).join("\n"),
    instructions: lines.slice(end + 1).join("\n"),
  };
}

/**
 * Reads a `SKILL.md`: its YAML frontmatter, checked against the Agent
 * Skills format, then its instructions. Fields beyond the format's (such
 * as Claude Code's) are kept, and shown in review with the rest.
 */
export function parseSkillDocument(
  text: string,
): { ok: true; document: SkillDocument } | { ok: false; problems: string[] } {
  const parts = splitFrontmatter(text);
  if (parts === undefined) {
    return {
      ok: false,
      problems: [
        `${skillFileName} starts with YAML frontmatter between two --- lines.`,
      ],
    };
  }
  let yaml: unknown;
  try {
    yaml = parseYaml(parts.yaml, { maxAliasCount: 0 });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "";
    return {
      ok: false,
      problems: [
        `The frontmatter of ${skillFileName} is not valid YAML${reason === undefined || reason === "" ? "" : `: ${reason}`}`,
      ],
    };
  }
  if (typeof yaml !== "object" || yaml === null || Array.isArray(yaml)) {
    return {
      ok: false,
      problems: [
        `The frontmatter of ${skillFileName} is a set of fields, such as name and description.`,
      ],
    };
  }
  const parsed = frontmatterSchema.safeParse(yaml);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(({ message }) => message),
    };
  }
  return {
    ok: true,
    document: {
      name: parsed.data.name,
      description: parsed.data.description.trim(),
      frontmatter: parsed.data,
      instructions: parts.instructions,
    },
  };
}

/**
 * What is wrong with a Skill's files, if anything: one line each. Its
 * `SKILL.md` must be valid, its paths distinct and inside the folder, and
 * the whole within the size limits. When the folder's name is known, the
 * Skill's name must match it, as the format asks.
 */
export function skillProblems(
  files: readonly SkillFile[],
  options: { readonly folder?: string | undefined } = {},
): string[] {
  const problems: string[] = [];
  if (files.length > maxSkillFiles) {
    problems.push(
      `A Skill holds at most ${String(maxSkillFiles)} files; this has ${String(files.length)}.`,
    );
  }
  const bytes = files.reduce(
    (total, file) => total + byteLength(file.content),
    0,
  );
  if (bytes > maxSkillBytes) {
    problems.push(
      `A Skill's files come to at most ${String(maxSkillBytes / 1_000_000)} MB; these are ${(bytes / 1_000_000).toFixed(1)} MB.`,
    );
  }
  // Distinct even where case does not count, as on macOS and Windows; and
  // no file where another needs a folder.
  const seen = new Map<string, string>();
  for (const { path } of files) {
    const key = path.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      problems.push(
        earlier === path
          ? `"${path}" is in the Skill twice.`
          : `"${earlier}" and "${path}" differ only in case.`,
      );
    }
    seen.set(key, path);
  }
  for (const key of seen.keys()) {
    const segments = key.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      const folder = segments.slice(0, end).join("/");
      const file = seen.get(folder);
      if (file !== undefined) {
        problems.push(`"${file}" is a file, so it cannot also be a folder.`);
      }
    }
  }
  const skillMd = files.find(({ path }) => path === skillFileName);
  if (skillMd === undefined) {
    problems.push(`A Skill has a ${skillFileName} at the top of its folder.`);
  } else {
    const parsed = parseSkillDocument(skillMd.content);
    if (!parsed.ok) {
      problems.push(...parsed.problems);
    } else if (
      options.folder !== undefined &&
      parsed.document.name !== options.folder
    ) {
      problems.push(
        `The Skill is named "${parsed.document.name}", so its folder is "${parsed.document.name}", not "${options.folder}".`,
      );
    }
  }
  return [...new Set(problems)];
}

/** A Skill's files, checked as a whole by `skillProblems`. */
export const skillFilesSchema = z
  .array(skillFileSchema, { error: "A Skill's files are a list." })
  .min(1, { error: `A Skill has a ${skillFileName} at the top of its folder.` })
  .superRefine((files, context) => {
    for (const message of skillProblems(files)) {
      context.addIssue({ code: "custom", message });
    }
  });

/** A Skill's files, `SKILL.md` first, then by path: how a Skill reads. */
export const skillFilesInOrder = <File extends { readonly path: string }>(
  files: readonly File[],
): File[] =>
  [...files].sort((a, b) =>
    a.path === b.path
      ? 0
      : a.path === skillFileName
        ? -1
        : b.path === skillFileName
          ? 1
          : a.path < b.path
            ? -1
            : 1,
  );

/**
 * The name and description of a Skill whose files `skillProblems` passed.
 * Throws if they did not.
 */
export function describeSkill(files: readonly SkillFile[]): SkillDocument {
  const parsed = parseSkillDocument(
    files.find(({ path }) => path === skillFileName)?.content ?? "",
  );
  if (!parsed.ok) {
    throw new TypeError(parsed.problems.join(" "));
  }
  return parsed.document;
}

/** A new Skill's `SKILL.md`, as the editor starts it. */
export const skillTemplate = `---
name: my-skill
description: What this Skill does, and when to use it.
---

# My Skill

Step-by-step instructions for the Agent.
`;

const folderName = z
  .string({ error: "The folder's name is text." })
  .min(1, { error: "The folder's name is not empty." })
  .max(255, { error: "The folder's name is at most 255 characters." })
  .refine((folder) => skillPathProblem(folder) === undefined, {
    error: "The folder's name is one plain name.",
  })
  .refine((folder) => !folder.includes("/"), {
    error: "The folder's name is one plain name.",
  });

/** The body of `POST /api/skills`: an uploaded Skill, or one written here. */
export const addSkillRequestSchema = z
  .strictObject({
    source: z.enum(["upload", "editor"], {
      error: "A Skill is added by upload or from the editor.",
    }),
    files: z.array(skillFileSchema, { error: "A Skill's files are a list." }),
    /** The uploaded folder's name: the Skill's name must match it. */
    folder: folderName.optional(),
  })
  .superRefine(({ files, folder }, context) => {
    for (const message of skillProblems(files, { folder })) {
      context.addIssue({ code: "custom", message, path: ["files"] });
    }
  });
export type AddSkillRequest = z.infer<typeof addSkillRequestSchema>;

/**
 * A Git repository to import from: public, over HTTPS. The URL is shown
 * back to the Owner and recorded with the Skill, so it may not carry a
 * credential. It may not name an internal host the Owner did not allow
 * (ADR 0007). Floor Templates are imported from the same.
 */
export const skillRepositoryUrlSchema = z
  .url({
    protocol: /^https$/,
    error: "The repository is an https:// URL.",
  })
  .max(2000, { error: "That URL is too long." })
  .refine(
    (value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    },
    {
      error:
        "Leave credentials out of the URL: only public repositories can be imported.",
    },
  )
  .refine((value) => !/[?#]/.test(value), {
    error: "The repository URL takes no query or fragment.",
  })
  // Cloning it must not probe the stack's own network (ADR 0007, I1-3).
  // Plain http:// is refused above, for every host.
  .superRefine(ownerUrl("The repository", { plainHttp: true }));

/** A branch or tag, as `git clone --branch` takes it. */
const gitRef = z
  .string({ error: "The branch or tag is text." })
  .trim()
  .min(1, { error: "Leave the branch or tag empty for the default branch." })
  .max(255, { error: "That branch or tag is too long." })
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w.\-/]+(?<![/.])$/, {
    error: "That is not a branch or tag name.",
  });

/** The body of `POST /api/skills/import`. */
export const importSkillRequestSchema = z.strictObject({
  url: skillRepositoryUrlSchema,
  /** The default branch when absent. */
  ref: gitRef.optional(),
  /**
   * The Skill's folder in the repository, such as `skills/pdf`. Absent:
   * the repository's only Skill.
   */
  path: z
    .string({ error: "The folder is text." })
    .trim()
    .transform((path) => path.replace(/^\/+|\/+$/g, ""))
    .superRefine((path, context) => {
      const problem = path === "" ? undefined : skillPathProblem(path);
      if (problem !== undefined) {
        context.addIssue({ code: "custom", message: problem });
      }
    })
    .optional(),
});
export type ImportSkillRequest = z.infer<typeof importSkillRequestSchema>;

/** The body of `PATCH /api/skills/:id`: new files, or enabled on or off. */
export const skillUpdateSchema = z
  .strictObject({
    files: skillFilesSchema.optional(),
    enabled: z.boolean({ error: "Enabled is true or false." }).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, {
    error: "Change the files, or turn the Skill on or off.",
  });
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;

/** A SHA-256 of a Skill's files, in hex. */
export const skillDigestSchema = z
  .string({ error: "Send the digest of the contents reviewed." })
  .regex(/^[0-9a-f]{64}$/, {
    error: "Send the digest of the contents reviewed.",
  });

/**
 * The body of `POST /api/skills/:id/review`: the digest of the contents
 * the Owner read. If the Skill changed since, the review is refused.
 */
export const reviewSkillRequestSchema = z.strictObject({
  digest: skillDigestSchema,
});
export type ReviewSkillRequest = z.infer<typeof reviewSkillRequestSchema>;

/** Where an imported Skill came from in its Git repository. */
export const skillOriginSchema = z.object({
  url: z.string(),
  /** The branch or tag asked for; null for the default branch. */
  ref: z.string().nullable(),
  /** The commit the files were read at. */
  commit: z.string(),
  /** The Skill's folder in the repository; "" for its top. */
  path: z.string(),
});
export type SkillOrigin = z.infer<typeof skillOriginSchema>;

const skillShape = {
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(skillSources),
  /** For a Skill imported from Git; null otherwise. */
  origin: skillOriginSchema.nullable(),
  /** The SHA-256 of its files, which a review names. */
  digest: z.string(),
  enabled: z.boolean(),
  /** When the Owner reviewed it; null for an imported Skill not yet reviewed. */
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
};

/** A Skill as `GET /api/skills` lists it: its files' paths and sizes. */
export const skillSummarySchema = z.object({
  ...skillShape,
  files: z.array(z.object({ path: z.string(), bytes: z.number().int() })),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

/** A Skill with its full contents (`GET /api/skills/:id`). */
export const skillSchema = z.object({
  ...skillShape,
  files: z.array(skillFileSchema),
});
export type Skill = z.infer<typeof skillSchema>;

/** The body of `GET /api/skills`: by name. */
export const skillListSchema = z.object({
  skills: z.array(skillSummarySchema),
});

// A Floor's Skills (PRD FR-72, FR-75): the office library's enabled Skills
// plus the Floor repository's own, where a repository Skill of the same
// name overrides the office one on that Floor. Each is mounted read-only
// into the sandboxes of the Floor's Agents, and the Floor admin turns
// each on or off per Role.

/**
 * Where a Floor's repository keeps its Skills, one folder each, in the
 * order they are looked for: a Skill in both is taken from the first.
 */
export const repositorySkillFolders = [".agents/skills", ".claude/skills"];

/**
 * Where a Floor's Skill comes from: the office library, the Floor's
 * repository, or AI Office itself (`built-in`, such as `/grilling`, which
 * starts a Grilling Session, FR-77, or `/pr`, adapted from Matt Pocock's
 * skills, FR-83b). A built-in Skill is the Manager's: it is never mounted
 * into a sandbox. No other Skill of its name overrides one that starts a
 * Grilling Session; one that only loads instructions gives way to an
 * office or repository Skill of its name.
 */
export const floorSkillSources = ["office", "repository", "built-in"] as const;
export type FloorSkillSource = (typeof floorSkillSources)[number];

/**
 * The built-in Roles whose Agents work in sandboxes (their Stage is work,
 * QA or docs; FR-19), which the Floor admin toggles Skills per. A Role
 * the Owner adds to the library has every Skill on until it can be
 * toggled too.
 */
export const sandboxRoles = [
  "coder",
  "qa",
  "docs",
  "designer",
] as const satisfies readonly Role[];
export type SandboxRole = (typeof sandboxRoles)[number];

export const isSandboxRole = (role: string): role is SandboxRole =>
  (sandboxRoles as readonly string[]).includes(role);

/** A Skill on a Floor, as `GET /api/floors/:floorId/skills` lists it. */
export const floorSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(floorSkillSources),
  /** A repository Skill's folder, such as `.claude/skills/pdf`; null for an office Skill. */
  folder: z.string().nullable(),
  /** Whether this repository Skill overrides an office Skill of its name. */
  overridesOffice: z.boolean(),
  /** Whether it is mounted for each Role's Agents: on unless turned off. */
  roles: z.record(z.enum(sandboxRoles), z.boolean()),
});
export type FloorSkill = z.infer<typeof floorSkillSchema>;

/**
 * One of a Floor's Skills in full, as the Available Skills list opens it
 * (`GET /api/floors/:floorId/skills/:name`, FR-73): its `SKILL.md` and
 * every supporting file, as they apply on that Floor.
 */
export const floorSkillDetailSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(floorSkillSources),
  folder: z.string().nullable(),
  overridesOffice: z.boolean(),
  /** `SKILL.md` first, then by path. */
  files: z.array(skillFileSchema),
});
export type FloorSkillDetail = z.infer<typeof floorSkillDetailSchema>;

/** A repository Skill folder that is not a valid Skill, so is left out. */
export const ignoredSkillSchema = z.object({
  folder: z.string(),
  problems: z.array(z.string()),
});
export type IgnoredSkill = z.infer<typeof ignoredSkillSchema>;

/** The body of `GET /api/floors/:floorId/skills`: by name. */
/**
 * A repository Skill waiting for the Owner's review (FR-76, P1-10): it
 * reaches no Agent and not the Manager's chat, nor takes an office Skill's
 * place, until the Owner has reviewed exactly the files it has now.
 */
export const awaitingSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Its folder, such as `.claude/skills/pdf`. */
  folder: z.string(),
  /** The SHA-256 of its files as read, which a review must name. */
  digest: z.string(),
  /** Whether an office Skill of its name is used in its place meanwhile. */
  overridesOffice: z.boolean(),
  /** Whether the Owner reviewed it before it changed. */
  changed: z.boolean(),
});
export type AwaitingSkill = z.infer<typeof awaitingSkillSchema>;

export const floorSkillListSchema = z.object({
  skills: z.array(floorSkillSchema),
  /** The repository's Skills that wait for the Owner's review (P1-10). */
  awaitingReview: z.array(awaitingSkillSchema).default([]),
  ignored: z.array(ignoredSkillSchema),
  /** Why the repository's Skills could not be read; null when they were. */
  repositoryError: z.string().nullable(),
});
export type FloorSkillList = z.infer<typeof floorSkillListSchema>;

/**
 * A repository Skill in full, for the Owner to review (`GET
 * /api/floors/:floorId/repository-skills?folder=…`, P1-10): every file of
 * its folder, and the digest a review of them names.
 */
export const repositorySkillDetailSchema = z.object({
  name: z.string(),
  description: z.string(),
  folder: z.string(),
  digest: z.string(),
  /** `SKILL.md` first, then by path. */
  files: z.array(skillFileSchema),
});
export type RepositorySkillDetail = z.infer<typeof repositorySkillDetailSchema>;

/**
 * The body of `POST /api/floors/:floorId/repository-skills/review`: the
 * folder the Owner read, and the digest of the files they read in it.
 */
export const repositorySkillReviewSchema = z.strictObject({
  folder: z
    .string()
    .regex(/^\.(agents|claude)\/skills\/[^/]+$/, {
      error: "Name one of the repository's Skill folders.",
    })
    .max(200),
  digest: z.string().regex(/^[0-9a-f]{64}$/, {
    error: "Give the digest of the Skill's files you read.",
  }),
});
export type RepositorySkillReviewRequest = z.infer<
  typeof repositorySkillReviewSchema
>;

/** The body of `PUT /api/floors/:floorId/skills/:name/roles/:role`. */
export const floorSkillToggleSchema = z.strictObject({
  enabled: z.boolean({
    error: "Say whether the Skill is on (true) or off (false).",
  }),
});
export type FloorSkillToggle = z.infer<typeof floorSkillToggleSchema>;

export const skillErrorCodes = {
  skillNotFound: "skill_not_found",
  /** Another Skill in the library has that name. */
  skillNameTaken: "skill_name_taken",
  /** An imported Skill is enabled only once reviewed (FR-76). */
  skillNotReviewed: "skill_not_reviewed",
  /** The Skill changed after the contents the Owner reviewed. */
  skillChanged: "skill_changed",
  /** The repository could not be cloned. */
  importFailed: "skill_import_failed",
  /** The repository (or the folder named) holds no Skill. */
  noSkillInRepository: "no_skill_in_repository",
  /** The repository holds several Skills: name the folder of one. */
  skillPathRequired: "skill_path_required",
  /** What the repository holds is not a valid Skill. */
  invalidSkill: "invalid_skill",
  /** Skills are toggled only for Roles whose Agents work in sandboxes. */
  notSandboxRole: "not_sandbox_role",
} as const;
export type SkillErrorCode =
  (typeof skillErrorCodes)[keyof typeof skillErrorCodes];
