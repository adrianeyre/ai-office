import { z } from "zod";

// GitHub App webhooks (PRD FR-8, FR-65): when AI Office is reachable from
// GitHub, the App's webhooks tell it at once of new issues, label changes,
// pull requests and checks, and intake and the pipeline act on them then.
// Polling carries on as before, in case a delivery is lost. Off until the
// Owner turns them on in the office admin, with the secret GitHub signs
// each delivery with: a credential, so it is written, never read back.

/** Where GitHub delivers the App's webhooks, under PUBLIC_URL. */
export const githubWebhookPath = "/api/github/webhooks";

export const minWebhookSecretLength = 20;
export const maxWebhookSecretLength = 256;

/** The body of `GET /api/office/webhooks`, and of a `PUT`'s answer. */
export const webhookSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Whether a secret is kept; the secret itself is never sent back. */
  secretSet: z.boolean(),
});
export type WebhookSettings = z.infer<typeof webhookSettingsSchema>;

export const webhookSecretSchema = z
  .string({ error: "The webhook secret is text." })
  .trim()
  .min(minWebhookSecretLength, {
    error: `The webhook secret is at least ${String(minWebhookSecretLength)} characters.`,
  })
  .max(maxWebhookSecretLength, {
    error: `The webhook secret is at most ${String(maxWebhookSecretLength)} characters.`,
  });

/**
 * The body of `PUT /api/office/webhooks`: on or off, and a new secret to
 * keep. Without one, the kept secret stays; turning webhooks on needs one.
 */
export const webhookSettingsUpdateSchema = z.object({
  enabled: z.boolean({ error: "Say whether webhooks are on." }),
  secret: webhookSecretSchema.optional(),
});
export type WebhookSettingsUpdate = z.infer<typeof webhookSettingsUpdateSchema>;

export const defaultWebhookSettings: WebhookSettings = {
  enabled: false,
  secretSet: false,
};
