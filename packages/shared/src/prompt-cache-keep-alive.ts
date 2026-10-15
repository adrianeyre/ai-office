import { z } from "zod";

// Prompt-cache keep-alive (PRD FR-39): Anthropic drops a prompt cache that
// is not read within its TTL (five minutes by default), so an Agent that
// pauses longer (a long test run, a slow build) pays to write its whole
// conversation to the cache again. With keep-alive on, the AI Gateway
// re-sends an Agent's latest request shortly before its cache would
// expire, as a minimal request (`max_tokens: 0`, nothing generated), which
// reads the cache and so keeps it warm. Only active sessions are kept
// warm: a session whose Agent has made no request of its own for
// `idleMinutes` is let go. Each AI Account is sent at most
// `maxPerAccountPerHour` keep-alives in any hour. Every keep-alive is a
// request in the request history and the analytics, marked as one. Off
// until the Owner turns it on: the request is the AI Gateway's, sent on
// the agent tool's behalf (FR-35). The server and the web app share these.

/** The shortest and longest a session is kept warm without a request. */
export const minKeepAliveIdleMinutes = 5;
export const maxKeepAliveIdleMinutes = 8 * 60;
/** The most keep-alives an AI Account may be sent in an hour. */
export const maxKeepAlivesPerAccountPerHour = 600;

const whole = (what: string) =>
  z
    .number({ error: `${what} is a whole number.` })
    .int({ error: `${what} is a whole number.` });

/** `GET` and `PUT /api/office/prompt-cache-keep-alive`. */
export const promptCacheKeepAliveSettingsSchema = z.strictObject({
  enabled: z.boolean({ error: "Say whether keep-alive is on." }),
  /** How long a session is kept warm after its Agent's last request. */
  idleMinutes: whole("The idle time")
    .min(minKeepAliveIdleMinutes, {
      error: `Keep sessions warm for at least ${String(minKeepAliveIdleMinutes)} minutes.`,
    })
    .max(maxKeepAliveIdleMinutes, {
      error: `Keep sessions warm for at most ${String(maxKeepAliveIdleMinutes)} minutes (8 hours).`,
    }),
  /** The most keep-alives each AI Account is sent in any hour. */
  maxPerAccountPerHour: whole("The limit per AI Account")
    .min(1, { error: "Allow each AI Account at least 1 keep-alive an hour." })
    .max(maxKeepAlivesPerAccountPerHour, {
      error: `Allow each AI Account at most ${String(maxKeepAlivesPerAccountPerHour)} keep-alives an hour.`,
    }),
});
export type PromptCacheKeepAliveSettings = z.infer<
  typeof promptCacheKeepAliveSettingsSchema
>;

/**
 * Until the Owner chooses: off; once on, sessions are kept warm for half
 * an hour after their last request, and each account is sent at most 60
 * keep-alives an hour (four sessions on the five-minute TTL).
 */
export const defaultPromptCacheKeepAliveSettings: PromptCacheKeepAliveSettings =
  {
    enabled: false,
    idleMinutes: 30,
    maxPerAccountPerHour: 60,
  };

/**
 * How long before a session's cache would expire its keep-alive is sent:
 * late enough not to repeat what an Agent's own request does, early
 * enough to arrive in time.
 */
export const keepAliveLeadMs = 60 * 1000;
