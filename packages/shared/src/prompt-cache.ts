import { z } from "zod";

// The prompt-cache TTL (PRD §6.8): how long Anthropic keeps each prompt-cache
// breakpoint of a request the AI Gateway forwards to Anthropic's API. Five
// minutes is Anthropic's default; an hour costs more to write but keeps a
// cache warm across longer pauses. "As sent" leaves each request's own.

export const promptCacheTtls = ["as_sent", "5m", "1h"] as const;
export type PromptCacheTtl = (typeof promptCacheTtls)[number];

export const promptCacheTtlLabels: Record<PromptCacheTtl, string> = {
  as_sent: "As sent",
  "5m": "5 minutes",
  "1h": "1 hour",
};

/** `GET` and `PUT /api/office/prompt-cache`. */
export const promptCacheSettingsSchema = z.strictObject({
  ttl: z.enum(promptCacheTtls, {
    error: "Choose a TTL: as_sent, 5m or 1h.",
  }),
});
export type PromptCacheSettings = z.infer<typeof promptCacheSettingsSchema>;

export const defaultPromptCacheSettings: PromptCacheSettings = {
  ttl: "as_sent",
};
