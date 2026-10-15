import { z } from "zod";

// Retries and the circuit breaker (PRD FR-39): how the AI Gateway answers
// an AI Account that is rate-limited, overloaded or failing. It tries the
// request again, on another account when there is one, waiting longer
// each time it goes back to an account it already tried; and it stops
// using an account that keeps failing for a while. Set at runtime in the
// office admin. The server and the web app share these.

/** The fewest and most attempts a request gets, the first included. */
export const minRetryAttempts = 1;
export const maxRetryAttempts = 10;
/** The longest first wait before trying an account again, in milliseconds. */
export const maxRetryDelayMs = 60_000;
/** The most each wait is multiplied by the next time. */
export const maxRetryMultiplier = 10;
/** The most failures in a row before an account's circuit opens. */
export const maxCircuitBreakerThreshold = 100;
/** The longest an open circuit keeps its account out, in seconds. */
export const maxCircuitBreakerCooldownSeconds = 60 * 60;

const whole = (what: string) =>
  z
    .number({ error: `${what} is a whole number.` })
    .int({ error: `${what} is a whole number.` });

/** `GET` and `PUT /api/office/retries`. */
export const gatewayRetrySettingsSchema = z.strictObject({
  /** How many times a request is sent at most, the first time included. */
  attempts: whole("The number of attempts")
    .min(minRetryAttempts, {
      error: `Make at least ${String(minRetryAttempts)} attempt.`,
    })
    .max(maxRetryAttempts, {
      error: `Make at most ${String(maxRetryAttempts)} attempts.`,
    }),
  /** The first wait before an account is tried again. */
  delayMs: whole("The delay")
    .min(0, { error: "The delay is 0 milliseconds or more." })
    .max(maxRetryDelayMs, {
      error: `The delay is at most ${String(maxRetryDelayMs)} milliseconds.`,
    }),
  /** Each wait is the one before times this (exponential backoff). */
  multiplier: z
    .number({ error: "The multiplier is a number." })
    .min(1, { error: "The multiplier is at least 1." })
    .max(maxRetryMultiplier, {
      error: `The multiplier is at most ${String(maxRetryMultiplier)}.`,
    }),
  /** Failures in a row (errors, or no answer) that open the circuit. */
  circuitBreakerThreshold: whole("The circuit breaker's threshold")
    .min(1, { error: "The circuit breaker opens after at least 1 failure." })
    .max(maxCircuitBreakerThreshold, {
      error: `The circuit breaker opens after at most ${String(maxCircuitBreakerThreshold)} failures.`,
    }),
  /** How long an open circuit keeps its account out. */
  circuitBreakerCooldownSeconds: whole("The cooldown")
    .min(1, { error: "The cooldown is at least 1 second." })
    .max(maxCircuitBreakerCooldownSeconds, {
      error: `The cooldown is at most ${String(maxCircuitBreakerCooldownSeconds)} seconds (an hour).`,
    }),
});
export type GatewayRetrySettings = z.infer<typeof gatewayRetrySettingsSchema>;

/**
 * Until the Owner chooses: three attempts, waiting half a second, then a
 * second; a circuit opens after five failures in a row, for a minute.
 */
export const defaultGatewayRetrySettings: GatewayRetrySettings = {
  attempts: 3,
  delayMs: 500,
  multiplier: 2,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownSeconds: 60,
};

/** How long to wait before the `retry`th retry of an account (1 first). */
export const retryDelayMs = (
  settings: Pick<GatewayRetrySettings, "delayMs" | "multiplier">,
  retry: number,
): number =>
  Math.round(settings.delayMs * settings.multiplier ** Math.max(0, retry - 1));
