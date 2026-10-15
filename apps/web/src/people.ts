import { lobbyCastSchema, ownerProfileSchema } from "@ai-office/shared";
import { queryOptions } from "@tanstack/react-query";

import { getJson } from "./api.ts";

// The Owner's profile and the lobby's cast, as queries: the profile card
// and Agent Settings edit them, and the lobby shows them.

/** The Owner's profile (`GET /api/office/profile`). */
export const ownerProfileQuery = queryOptions({
  queryKey: ["office", "profile"],
  queryFn: () => getJson("/api/office/profile", ownerProfileSchema),
});

/** The lobby's cast (`GET /api/office/lobby-cast`). */
export const lobbyCastQuery = queryOptions({
  queryKey: ["office", "lobby-cast"],
  queryFn: () => getJson("/api/office/lobby-cast", lobbyCastSchema),
});
