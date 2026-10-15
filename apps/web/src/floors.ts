import {
  agentListSchema,
  floorListSchema,
  floorSchema,
  floorTemplateListSchema,
  installedRepositoryListSchema,
} from "@ai-office/shared";
import {
  subjectOf,
  type EventType,
  type OfficeEvent,
} from "@ai-office/events/schema";
import {
  queryOptions,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import { getJson } from "./api.ts";

// The Floors and the repositories they come from (PRD §6.2), as queries.

/** The Floors in use (`GET /api/floors`). */
export const floorsQuery = queryOptions({
  queryKey: ["floors"],
  queryFn: async () => (await getJson("/api/floors", floorListSchema)).floors,
});

/**
 * Each Floor's name as the Owner chose it, by its id (FR-7): what the app
 * shows for a Floor wherever it names one. The id stands in while the
 * Floors load, and for a Floor no longer in use.
 */
export function useFloorNames(): (floorId: string) => string {
  const { data: floors } = useQuery(floorsQuery);
  return (floorId) => floors?.find(({ id }) => id === floorId)?.name ?? floorId;
}

/** The office-wide events after which the Floors in use are read again. */
export const floorChangeEventTypes: readonly EventType[] = [
  "floor.created",
  "floor.archived",
  "floor.renamed",
];

/**
 * Reads the Floors in use again, and one Floor, when `event` changes them:
 * a Floor added, archived or renamed, or its settings changed, such as its
 * name (FR-7). Open pages show a renamed Floor's name at once.
 */
export function refreshFloorsOn(event: OfficeEvent, client: QueryClient): void {
  const changed =
    floorChangeEventTypes.includes(event.type) ||
    (event.type === "config.changed" && event.scope === "floor");
  const { floorId } = subjectOf(event);
  if (!changed || floorId === null) {
    return;
  }
  void client.invalidateQueries({
    queryKey: floorsQuery.queryKey,
    exact: true,
  });
  void client.invalidateQueries({
    queryKey: floorQuery(floorId).queryKey,
    exact: true,
  });
}

/** One Floor, archived or not (`GET /api/floors/:floorId`). */
export const floorQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId],
    queryFn: () =>
      getJson(`/api/floors/${encodeURIComponent(floorId)}`, floorSchema),
  });

/** The repositories the App is installed on (`GET /api/github/repositories`). */
export const installedRepositoriesQuery = queryOptions({
  queryKey: ["github", "repositories"],
  queryFn: async () =>
    (await getJson("/api/github/repositories", installedRepositoryListSchema))
      .repositories,
  // A GitHub that is not configured or not reachable is said at once.
  retry: false,
});

/** The Floor Templates a Floor is added from (`GET /api/floor-templates`). */
export const floorTemplatesQuery = queryOptions({
  queryKey: ["floor-templates"],
  queryFn: () => getJson("/api/floor-templates", floorTemplateListSchema),
  // They are loaded once, as AI Office starts.
  staleTime: Infinity,
});

/** A Floor's Agents (`GET /api/floors/:floorId/agents`). */
export const agentsQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "agents"],
    queryFn: async () =>
      (
        await getJson(
          `/api/floors/${encodeURIComponent(floorId)}/agents`,
          agentListSchema,
        )
      ).agents,
  });
