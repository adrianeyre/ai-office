import { z } from "zod";

// Issue intake (PRD FR-8): which issues AI Office takes in, and how often it
// looks. Only the Owner's issues are taken in, or another author's issue
// the Owner labelled `ai-office` personally (PRD §4), so intake needs the
// Owner's GitHub login.

/** The Owner by default: GitHub user `adrianeyre` (as for commits, FR-68). */
export const defaultOwnerLogin = "adrianeyre";

/** Intake checks each Floor's issues this often unless the admin says. */
export const defaultIntakeIntervalSeconds = 60;
export const minIntakeIntervalSeconds = 10;
export const maxIntakeIntervalSeconds = 3600;

/** A GitHub login: letters, digits and single hyphens, at most 39. */
export const githubLoginSchema = z
  .string()
  .trim()
  .min(1, { error: "Give the Owner's GitHub login." })
  .max(39, { error: "A GitHub login is at most 39 characters." })
  .regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/, {
    error:
      "A GitHub login is letters, digits and single hyphens, neither first nor last.",
  });

/** The body of `GET` and `PUT /api/office/intake`. */
export const intakeSettingsSchema = z.object({
  /** Whose issues are taken in, and whose `ai-office` label counts. */
  ownerLogin: githubLoginSchema,
  intervalSeconds: z
    .number({ error: "The interval is a whole number of seconds." })
    .int({ error: "The interval is a whole number of seconds." })
    .min(minIntakeIntervalSeconds, {
      error: `Check at most every ${String(minIntakeIntervalSeconds)} seconds.`,
    })
    .max(maxIntakeIntervalSeconds, {
      error: `Check at least every ${String(maxIntakeIntervalSeconds)} seconds.`,
    }),
});
export type IntakeSettings = z.infer<typeof intakeSettingsSchema>;

export const defaultIntakeSettings: IntakeSettings = {
  ownerLogin: defaultOwnerLogin,
  intervalSeconds: defaultIntakeIntervalSeconds,
};
