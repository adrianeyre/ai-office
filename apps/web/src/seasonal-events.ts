import { seasonalEventsSchema } from "@ai-office/shared";
import { queryOptions } from "@tanstack/react-query";

import { getJson } from "./api.ts";

export const seasonalEventsUrl = "/api/office/seasonal-events";

/** The seasonal events (`GET /api/office/seasonal-events`). */
export const seasonalEventsQuery = queryOptions({
  queryKey: ["office", "seasonal-events"],
  queryFn: () => getJson(seasonalEventsUrl, seasonalEventsSchema),
});
