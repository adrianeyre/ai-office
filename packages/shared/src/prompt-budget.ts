import { z } from "zod";

// Prompt budgets: how many characters of the repository's memory (FR-53),
// the office-wide memory (FR-54), the Role's memory (FR-55) and the
// Floor's Skills listing (FR-75) an Agent's prompt carries at most, so
// that on a small context window they do not crowd out the issue and the
// diff. A part over its budget is truncated, saying so: the head of a
// memory file, the newest Role memory entries, the first Skills. The
// defaults hold all of each that AI Office keeps, so prompts on a large
// context window do not change; a small known window lowers each budget
// further. Set at runtime in General Settings. The server and the web app
// share these.

/** The most characters any part's budget may be. */
export const maxPromptBudget = 1_000_000;

const budget = (what: string) =>
  z
    .number({ error: `${what}'s budget is a whole number of characters.` })
    .int({ error: `${what}'s budget is a whole number of characters.` })
    .min(0, { error: `${what}'s budget is 0 characters or more.` })
    .max(maxPromptBudget, {
      error: `${what}'s budget is at most ${maxPromptBudget.toLocaleString("en-GB")} characters.`,
    });

/** `GET` and `PUT /api/office/prompt-budget`: characters, each. */
export const promptBudgetSettingsSchema = z.strictObject({
  /** The repository's memory, `.agents/MEMORY.md`. */
  repositoryMemory: budget("The repository's memory"),
  /** The office-wide memory. */
  officeMemory: budget("The office-wide memory"),
  /** The Role's memory: its entries' text, together. */
  roleMemory: budget("The Role's memory"),
  /** The Floor's Skills listing: each Skill's name and description. */
  skills: budget("The Skills listing"),
});
export type PromptBudgetSettings = z.infer<typeof promptBudgetSettingsSchema>;

/**
 * Until the Owner chooses: as much of each memory as AI Office keeps or
 * shows (12,000 characters; a Role's 40 entries of 300), and 40,000
 * characters of Skills.
 */
export const defaultPromptBudgetSettings: PromptBudgetSettings = {
  repositoryMemory: 12_000,
  officeMemory: 12_000,
  roleMemory: 12_000,
  skills: 40_000,
};
