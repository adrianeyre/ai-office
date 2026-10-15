import { sessionIdleMs, sessionLifetimeMs } from "@ai-office/shared";

// How long a session lasts (PRD FR-2), as the login page and the cookie
// and privacy policies tell the Owner: from sign-in, and unused (A1-8).

const hours = (ms: number): number => ms / (60 * 60_000);

/** "7 days from signing in, or 24 hours unused". */
export const sessionLength = `${String(hours(sessionLifetimeMs) / 24)} days from signing in, or ${String(hours(sessionIdleMs))} hours unused`;
