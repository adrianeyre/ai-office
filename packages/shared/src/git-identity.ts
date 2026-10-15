import { z } from "zod";

// The Git identity agent commits are authored and committed as (PRD FR-68,
// ADR 0002): the Owner's, set in the office admin and overridable per
// Floor. AI Office injects it; an Agent never chooses it.

/** A commit's author (and committer): a name and an email. */
export const gitIdentitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "Give the commit author a name." })
    .max(100, { error: "Use at most 100 characters for the name." })
    // Git refuses these in a name: they delimit the email.
    .regex(/^[^<>\n\r]+$/, {
      error: "A Git name cannot contain <, > or a line break.",
    }),
  email: z
    .email({ error: "Give the commit author an email address." })
    .max(254, { error: "Use at most 254 characters for the email." }),
});
export type GitIdentity = z.infer<typeof gitIdentitySchema>;

/**
 * The Owner by default: GitHub user `adrianeyre`, with their GitHub noreply
 * email (`<id>+<login>@users.noreply.github.com`), so commits link to
 * their account without exposing an address.
 */
export const defaultGitIdentity: GitIdentity = {
  name: "adrianeyre",
  email: "21265837+adrianeyre@users.noreply.github.com",
};

/** The body of `GET` and `PUT /api/office/git-identity`. */
export const officeGitIdentitySchema = gitIdentitySchema.extend({
  /** Whether it is the default, never set in the office admin. */
  isDefault: z.boolean(),
});
export type OfficeGitIdentity = z.infer<typeof officeGitIdentitySchema>;
