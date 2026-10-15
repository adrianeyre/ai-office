import {
  allowInternalHosts,
  apiErrorCodes,
  sessionResponseSchema,
  totpStatusSchema,
  type SessionResponse,
  type TotpStatus,
} from "@ai-office/shared";
import { queryOptions } from "@tanstack/react-query";

import { readApiError } from "./api.ts";

/** The server will not serve the app: sign in (or set up) at `page`. */
export class SignedOutError extends Error {
  readonly page: "/login" | "/setup";

  constructor(page: "/login" | "/setup") {
    super(`Not signed in; go to ${page}.`);
    this.name = "SignedOutError";
    this.page = page;
  }
}

/** The signed-in session (`GET /api/session`), with its CSRF token. */
export async function fetchSession(): Promise<SessionResponse> {
  const response = await fetch("/api/session");
  if (response.status === 401 || response.status === 403) {
    const { error } = await readApiError(response);
    throw new SignedOutError(
      error === apiErrorCodes.setupRequired ? "/setup" : "/login",
    );
  }
  if (!response.ok) {
    throw new Error(`GET /api/session answered ${String(response.status)}.`);
  }
  const session = sessionResponseSchema.parse(await response.json());
  // The forms check an address the Owner gives as the server will.
  allowInternalHosts(session.allowedInternalHosts);
  return session;
}

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: fetchSession,
  // Notices that the session ended elsewhere ("sign out everywhere").
  refetchInterval: 60_000,
  retry: (failures, error) =>
    !(error instanceof SignedOutError) && failures < 3,
});

/** The Owner's TOTP status (`GET /api/totp`). */
export const totpQuery = queryOptions({
  queryKey: ["totp"],
  queryFn: async (): Promise<TotpStatus> => {
    const response = await fetch("/api/totp");
    if (!response.ok) {
      throw new Error(`GET /api/totp answered ${String(response.status)}.`);
    }
    return totpStatusSchema.parse(await response.json());
  },
});
