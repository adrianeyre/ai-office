import { z } from "zod";

// Repository memory (PRD FR-53, FR-56): what a Floor's Agents have learned
// about its repository, kept in the repository itself as
// `.agents/MEMORY.md`, one entry per line. Every Agent reads it at the
// start of a task. Agents propose entries in their Handoffs; the Floor's
// Manager curates them, at the end of a Batch and once a week, into one
// pull request that merges duplicates, drops stale entries and keeps the
// file short. Memory is untrusted input and never holds a credential. The
// server, the web app and the orchestrator share these.

/** Where a Floor's memory lives in its repository. */
export const memoryPath = ".agents/MEMORY.md";

/** The branch the Manager's curated memory is pushed to. */
export const memoryBranch = "ai-office/memory";

/** The most entries the memory file keeps. */
export const maxMemoryEntries = 40;
/** The longest one entry may be. */
export const maxMemoryEntryLength = 300;
/** The most entries one Handoff may propose. */
export const maxMemoryProposals = 3;
/** The longest summary of a curation. */
export const maxMemorySummaryLength = 1000;

/**
 * Why the Manager curated a Floor's memory:
 * - `batch`: a Batch ended (every issue in its Plan is closed);
 * - `weekly`: the periodic tidy-up, a week after the last curation.
 */
export const memoryCurationReasons = ["batch", "weekly"] as const;
export type MemoryCurationReason = (typeof memoryCurationReasons)[number];

/** Who curated it: the Manager's Model, or AI Office's own rules. */
export const memoryCurators = ["model", "rules"] as const;
export type MemoryCurator = (typeof memoryCurators)[number];

/** The curated memory the Manager's Model must answer, as one JSON object. */
export const memoryCurationSchema = z.strictObject({
  /** What changed and why, in a few sentences, for the pull request. */
  summary: z
    .string({ error: "summary says what changed and why." })
    .trim()
    .min(1, { error: "summary says what changed and why." })
    .max(maxMemorySummaryLength, {
      error: `summary is at most ${String(maxMemorySummaryLength)} characters.`,
    }),
  /** Every entry the memory keeps, in order: the whole file's entries. */
  entries: z
    .array(
      z
        .string({ error: "Each entry is one line of text." })
        .trim()
        .min(1, { error: "An entry cannot be empty." })
        .max(maxMemoryEntryLength, {
          error: `An entry is at most ${String(maxMemoryEntryLength)} characters.`,
        })
        .refine((entry) => !/[\r\n]/.test(entry), {
          error: "An entry is one line: no line breaks.",
        }),
      { error: "entries is a list of lines." },
    )
    .max(maxMemoryEntries, {
      error: `Keep at most ${String(maxMemoryEntries)} entries.`,
    }),
});
export type MemoryCuration = z.infer<typeof memoryCurationSchema>;

/** The most of the memory the bookshelf shows, as much as an Agent's prompt carries. */
export const maxShownMemoryLength = 12_000;

/**
 * `GET /api/floors/:floorId/repository-memory`: the Floor's memory as the
 * bookshelf shows it (FR-58), read from its default branch and redacted,
 * with the proposals waiting for the Manager's next curation.
 */
export const repositoryMemorySchema = z.strictObject({
  /** The Floor's repository, `owner/name`. */
  repository: z.string(),
  /** The default branch the memory was read from. */
  branch: z.string(),
  /** The memory file, redacted; null when there is none or it was not read. */
  content: z.string().nullable(),
  /** Whether `content` was cut at `maxShownMemoryLength`. */
  truncated: z.boolean(),
  /** Why the memory could not be read; null when it was. */
  readError: z.string().nullable(),
  /** Entries Agents proposed, waiting for the Manager's next curation, oldest first. */
  proposals: z.array(
    z.strictObject({
      id: z.number().int().positive(),
      text: z.string(),
      issue: z.number().int().positive(),
      agentId: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  /**
   * The pull request the Manager's latest curation opened or updated; null
   * when it changed nothing, or there has been none.
   */
  pullRequest: z.number().int().positive().nullable(),
});
export type RepositoryMemoryView = z.infer<typeof repositoryMemorySchema>;
