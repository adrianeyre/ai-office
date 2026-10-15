import type { EventType } from "@ai-office/events/schema";
import { noticeListSchema } from "@ai-office/shared";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { getJson } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { floorChangeEventTypes, refreshFloorsOn } from "./floors.ts";

// The Notices (PRD §6.9) as queries, kept live by the event stream.

/** The events that change what is on a Notice Board. */
export const noticeEventTypes: readonly EventType[] = [
  "notice.raised",
  "notice.dismissed",
  "notice.acted_on",
];

/** Every query of Notices starts with this key. */
export const noticesKey = ["notices"] as const;

/** The open Notices, every Floor's or one Floor's (`GET /api/notices`). */
export const noticesQuery = (floorId?: string) =>
  queryOptions({
    queryKey: [...noticesKey, { floorId: floorId ?? null }],
    queryFn: async () =>
      (
        await getJson(
          floorId === undefined
            ? "/api/notices"
            : `/api/notices?floorId=${encodeURIComponent(floorId)}`,
          noticeListSchema,
        )
      ).notices,
  });

/**
 * Keeps every Notices query current while mounted: each Notice event
 * refetches them, and so does each (re)connection of the stream, in case
 * something changed while it was down. A Floor added, archived or renamed
 * reads the Floors again, for the names Notices and filters show.
 */
export function useLiveNotices(): void {
  const queryClient = useQueryClient();
  const { status } = useEventStream(
    { types: [...noticeEventTypes, ...floorChangeEventTypes] },
    {
      onEvent: ({ event }, client) => {
        if (noticeEventTypes.includes(event.type)) {
          void client.invalidateQueries({ queryKey: noticesKey });
        }
        // The Floors' names, which the Notices are shown with.
        refreshFloorsOn(event, client);
      },
    },
  );
  useEffect(() => {
    if (status === "open") {
      void queryClient.invalidateQueries({ queryKey: noticesKey });
    }
  }, [status, queryClient]);
}
