import type { SignedOutEverywhere } from "@ai-office/shared";
import { z } from "zod";

// What still signs in after "Sign out everywhere" (A1-3): ending sessions
// removes no password and no API key, so the login page tells the Owner
// which do, by name, once. Only the names are kept, for this tab only;
// never a password or a key.

const storageKey = "ai-office:still-sign-in";

/** The names of what still signs in. */
const stillSignInSchema = z.object({
  passwords: z.array(z.string()),
  apiKeys: z.array(z.string()),
});
export type StillSignIn = z.infer<typeof stillSignInSchema>;

/** Keeps the names in `body` for the login page this tab loads next. */
export function keepStillSignIn({ stillSignIn }: SignedOutEverywhere): void {
  const names: StillSignIn = {
    passwords: stillSignIn.passwords.map(({ name }) => name),
    apiKeys: stillSignIn.apiKeys.map(({ name }) => name),
  };
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(names));
  } catch {
    // Without storage, the login page has nothing to say.
  }
}

/** The names kept by `keepStillSignIn`, if any; see `forgetStillSignIn`. */
export function readStillSignIn(): StillSignIn | undefined {
  try {
    const kept = sessionStorage.getItem(storageKey);
    if (kept === null) {
      return undefined;
    }
    const parsed = stillSignInSchema.safeParse(JSON.parse(kept));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Forgets the names, so the login page says them once. */
export function forgetStillSignIn(): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing was kept.
  }
}
