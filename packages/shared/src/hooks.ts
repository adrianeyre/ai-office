import { z } from "zod";

import { managerRole, roleIdSchema, stageLabels, stages } from "./roles.ts";
import { skillNamePattern } from "./skills.ts";

// Hooks (Guidelines, Specs and Hooks PRD, FR-118 to FR-121; ADR 0016): the
// Owner's own rules on a Floor. When a chosen event happens (an issue
// moving to a Stage, a pull request opened, a push to the default branch
// touching matching files, a Batch's Wrap-up, a Spec's issues filed, or
// the Owner pressing Run now), optionally narrowed by label or file
// pattern, a named Agent (or any Agent in a named Role) runs one Skill of
// the Floor's library, given the event's details as untrusted data. Kept
// in AI Office's database, made and changed only by the Owner. The
// server, the web app and the orchestrator share these.

/** What sets a Hook off (FR-118). */
export const hookTriggers = [
  "stage",
  "pull_request_opened",
  "push",
  "wrap_up",
  "spec_filed",
  "run_now",
] as const;
export type HookTrigger = (typeof hookTriggers)[number];

/** Each trigger as the Hooks card offers it. */
export const hookTriggerLabels: Readonly<Record<HookTrigger, string>> = {
  stage: "An issue moves to a Stage",
  pull_request_opened: "A pull request is opened",
  push: "A push to the default branch touches matching files",
  wrap_up: "A Batch's Wrap-up",
  spec_filed: "A Spec's issues are filed",
  run_now: "Run now",
};

/**
 * Which filters narrow each trigger: labels the issue (or one of the
 * Batch's issues) carries, and files the pull request (or push) changes.
 * Run now is the Owner's own press, so nothing narrows it.
 */
export const hookTriggerFilters: Readonly<
  Record<HookTrigger, { readonly labels: boolean; readonly files: boolean }>
> = {
  stage: { labels: true, files: true },
  pull_request_opened: { labels: true, files: true },
  push: { labels: false, files: true },
  wrap_up: { labels: true, files: false },
  spec_filed: { labels: true, files: false },
  run_now: { labels: false, files: false },
};

/** The Stage labels an issue can move to that a Hook can watch (FR-18). */
export const hookStages = stages.map((stage) => stageLabels[stage]);
export type HookStage = (typeof hookStages)[number];

/** How many runs an hour a Hook makes at most, unless the Owner sets it. */
export const defaultHookRunsPerHour = 12;
/** The most runs an hour the Owner can let a Hook make. */
export const maxHookRunsPerHour = 60;
/** How many failed runs in a row turn a Hook off. */
export const hookFailuresToTurnOff = 3;
/** The most labels, and the most file patterns, one Hook filters by. */
export const maxHookFilters = 20;
/** The most characters of a run's answer kept with the run. */
export const maxHookResultLength = 8000;
/** How many of a Hook's latest runs the Hooks card shows. */
export const hookRecentRuns = 5;

/** The Floor admin card's anchor, which Hooks' Notices link to. */
export const hooksCardId = "hooks";

/** The Floor admin's Hooks card. */
export const floorHooksPath = (floorId: string): string =>
  `/floor-settings/${encodeURIComponent(floorId)}#${hooksCardId}`;

const trimmedList = (item: z.ZodString, what: string) =>
  z
    .array(item)
    .max(maxHookFilters, {
      error: `A Hook filters by at most ${String(maxHookFilters)} ${what}.`,
    })
    .transform((items) => [...new Set(items)]);

/**
 * A Hook as the Owner makes or changes it (`POST` and `PUT`): the whole of
 * it each time. Exactly one of `agentId` and `role` says who runs it.
 */
export const hookInputSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: "Give the Hook a name." })
      .max(60, { error: "Use at most 60 characters for a Hook's name." }),
    trigger: z.enum(hookTriggers),
    /** The Stage label watched, for a `stage` Hook; null otherwise. */
    stage: z.enum(hookStages).nullable().default(null),
    /** Runs only when the issue carries one of these labels; none: any. */
    labels: trimmedList(
      z
        .string()
        .trim()
        .min(1, { error: "A label is not blank." })
        .max(50, { error: "A label is at most 50 characters." }),
      "labels",
    ).default([]),
    /** Runs only when a changed file matches one of these globs; none: any. */
    filePatterns: trimmedList(
      z
        .string()
        .trim()
        .min(1, { error: "A file pattern is not blank." })
        .max(200, { error: "A file pattern is at most 200 characters." }),
      "file patterns",
    ).default([]),
    /** The Agent that runs it; null when any Agent in `role` does. */
    agentId: z.string().min(1).nullable().default(null),
    /** The Role any of whose Agents runs it; null when `agentId` does. */
    role: roleIdSchema.nullable().default(null),
    /** The Skill of the Floor's library it runs. */
    skillName: z.string().regex(skillNamePattern, {
      error: "A Skill's name is lowercase words joined by hyphens.",
    }),
    runsPerHour: z
      .number()
      .int({ error: "Runs an hour is a whole number." })
      .min(1, { error: "A Hook makes at least 1 run an hour." })
      .max(maxHookRunsPerHour, {
        error: `A Hook makes at most ${String(maxHookRunsPerHour)} runs an hour.`,
      })
      .default(defaultHookRunsPerHour),
    enabled: z.boolean().default(true),
  })
  .superRefine((hook, context) => {
    const problem = (message: string, path: string) => {
      context.addIssue({ code: "custom", message, path: [path] });
    };
    if (hook.trigger === "stage" && hook.stage === null) {
      problem("Choose the Stage the Hook watches.", "stage");
    }
    if (hook.trigger !== "stage" && hook.stage !== null) {
      problem("Only a Hook on an issue moving to a Stage names one.", "stage");
    }
    const filters = hookTriggerFilters[hook.trigger];
    if (!filters.labels && hook.labels.length > 0) {
      problem(
        `"${hookTriggerLabels[hook.trigger]}" is not narrowed by label.`,
        "labels",
      );
    }
    if (!filters.files && hook.filePatterns.length > 0) {
      problem(
        `"${hookTriggerLabels[hook.trigger]}" is not narrowed by file pattern.`,
        "filePatterns",
      );
    }
    if (hook.trigger === "push" && hook.filePatterns.length === 0) {
      problem(
        "A Hook on a push names the files it watches, such as **/*.sql.",
        "filePatterns",
      );
    }
    if ((hook.agentId === null) === (hook.role === null)) {
      problem("Choose an Agent, or a Role whose Agents run it.", "agentId");
    }
    if (hook.agentId !== null && hook.agentId.length > 100) {
      problem("That is not an Agent.", "agentId");
    }
    if (hook.role === managerRole) {
      problem("The Manager does not run Hooks.", "role");
    }
  });
export type HookInput = z.infer<typeof hookInputSchema>;
/** What `hookInputSchema` takes before its defaults are filled in. */
export type HookInputRequest = z.input<typeof hookInputSchema>;

/** How a Hook's run ended; `running` until it does. */
export const hookRunStatuses = ["running", "succeeded", "failed"] as const;
export type HookRunStatus = (typeof hookRunStatuses)[number];

/** Why an event that matched a Hook did not run it. */
export const hookSkipReasons = ["rate_limited", "already_running"] as const;
export type HookSkipReason = (typeof hookSkipReasons)[number];

/** One run of a Hook, as the Hooks card shows it. */
export const hookRunSchema = z.object({
  id: z.number().int().positive(),
  /**
   * The Agent that ran it: null when none could be found to; `agentName`
   * is null once it left the Floor.
   */
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  trigger: z.enum(hookTriggers),
  /** The issue, and the pull request, the event was about. */
  issue: z.number().int().positive().nullable(),
  pullRequest: z.number().int().positive().nullable(),
  status: z.enum(hookRunStatuses),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Why it failed, for a failed run; never a credential. */
  error: z.string().nullable(),
  /** The Agent's answer, redacted, cut to `maxHookResultLength`. */
  result: z.string().nullable(),
  /** The comment the GitHub App posted it as, when there was one. */
  commentUrl: z.string().nullable(),
});
export type HookRun = z.infer<typeof hookRunSchema>;

/** A Hook, as `GET /api/floors/:floorId/hooks` lists it. */
export const hookSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  trigger: z.enum(hookTriggers),
  stage: z.enum(hookStages).nullable(),
  labels: z.array(z.string()),
  filePatterns: z.array(z.string()),
  agentId: z.string().nullable(),
  role: z.string().nullable(),
  skillName: z.string(),
  runsPerHour: z.number().int().positive(),
  enabled: z.boolean(),
  /** Its failed runs in a row since its last success, or since it changed. */
  failures: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Its latest runs, newest first. */
  runs: z.array(hookRunSchema),
});
export type Hook = z.infer<typeof hookSchema>;

/** A Skill a Hook can run: one of the Floor's own, or a built-in one. */
export const hookSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["office", "repository", "built-in"]),
});
export type HookSkill = z.infer<typeof hookSkillSchema>;

/** `GET /api/floors/:floorId/hooks`, and what each change answers. */
export const hookListSchema = z.object({
  hooks: z.array(hookSchema),
  /**
   * The Skills a Hook can run on the Floor; the repository's only when
   * GitHub could be read (`skillsError` says why not).
   */
  skills: z.array(hookSkillSchema),
  skillsError: z.string().nullable(),
});
export type HookList = z.infer<typeof hookListSchema>;

/** `POST /api/floors/:floorId/hooks/:id/run`: the run Run now started. */
export const startedHookRunSchema = z.object({
  run: hookRunSchema,
  hooks: hookListSchema,
});
export type StartedHookRun = z.infer<typeof startedHookRunSchema>;

/** Why a Hooks request was refused, beside `floorErrorCodes`. */
export const hookErrorCodes = {
  /** The Floor has no such Hook. */
  hookNotFound: "hook_not_found",
  /** Another of the Floor's Hooks has that name, whatever its case. */
  hookNameTaken: "hook_name_taken",
  /** Its Agent, Role or Skill is not one the Floor has. */
  hookInvalid: "hook_invalid",
  /** Run now runs only a Hook whose trigger is Run now. */
  hookNotRunNow: "hook_not_run_now",
  /** The Hook is off. */
  hookDisabled: "hook_disabled",
  /** It made as many runs in the last hour as it may. */
  hookRateLimited: "hook_rate_limited",
  /** A run of it is going already. */
  hookRunning: "hook_running",
} as const;
export type HookErrorCode =
  (typeof hookErrorCodes)[keyof typeof hookErrorCodes];

/** What a Hook does, in words: "Ada runs /migration-check". */
export const hookActionText = (
  hook: Pick<HookInput, "skillName" | "agentId" | "role">,
  names: {
    readonly agent?: string | undefined;
    readonly role?: string | undefined;
  } = {},
): string =>
  `${
    hook.agentId === null
      ? `Any ${names.role ?? hook.role ?? "Agent"}`
      : (names.agent ?? "An Agent no longer on the Floor")
  } runs /${hook.skillName}`;

/** When a Hook runs, in words: "A pull request is opened, touching migrations/**". */
export function hookTriggerText(
  hook: Pick<HookInput, "trigger" | "stage" | "labels" | "filePatterns">,
): string {
  const parts = [
    hook.trigger === "stage" && hook.stage !== null
      ? `An issue moves to ${hook.stage}`
      : hook.trigger === "push"
        ? "A push to the default branch"
        : hookTriggerLabels[hook.trigger],
  ];
  if (hook.labels.length > 0) {
    parts.push(`labelled ${hook.labels.join(" or ")}`);
  }
  if (hook.filePatterns.length > 0) {
    parts.push(`touching ${hook.filePatterns.join(" or ")}`);
  }
  return parts.join(", ");
}
