import { z } from "zod";

// The office-wide limit on running sandboxes (PRD FR-22): work beyond it
// waits in the queue. Each Floor may set a lower limit of its own.

export const defaultSandboxConcurrencyLimit = 3;
export const maxSandboxConcurrencyLimit = 50;

/** The body of `GET` and `PUT /api/office/sandboxes`. */
export const sandboxSettingsSchema = z.object({
  /** How many sandboxes may run at once, office-wide. */
  concurrencyLimit: z
    .number({ error: "The limit is a whole number of sandboxes." })
    .int({ error: "The limit is a whole number of sandboxes." })
    .min(1, { error: "Allow at least 1 sandbox at once." })
    .max(maxSandboxConcurrencyLimit, {
      error: `Allow at most ${String(maxSandboxConcurrencyLimit)} sandboxes at once.`,
    }),
});
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;
