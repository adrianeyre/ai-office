import { z } from "zod";

// Auto-refresh (PRD FR-39): a subscription's usage window starts with the
// first request after its last one reset, so a window that resets while
// nothing is asked of the account would start late, whenever work next
// arrives. With auto-refresh on, the AI Gateway sends the account one
// minimal request soon after each of its usage windows resets, so a new
// window starts at once. It sends one per window, and none for an account
// that reports no windows (API keys). Off until the Owner turns it on:
// the request is the AI Gateway's own, not its AI Provider's agent tool's
// (FR-35). The server and the web app share these.

/** `GET` and `PUT /api/office/auto-refresh`. */
export const autoRefreshSettingsSchema = z.strictObject({
  enabled: z.boolean({ error: "Say whether auto-refresh is on." }),
});
export type AutoRefreshSettings = z.infer<typeof autoRefreshSettingsSchema>;

export const defaultAutoRefreshSettings: AutoRefreshSettings = {
  enabled: false,
};

/**
 * How long after a window's reset its refresh waits, so the AI Provider
 * has surely started the next window: a refresh sent early would count
 * against the window that is ending.
 */
export const autoRefreshBufferMs = 60 * 1000;
