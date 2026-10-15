import { floorStopSchema, type FloorStopState } from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePause, CirclePlay } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

import { getJson, postJson, readApiError } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { sessionQuery } from "./session.ts";

// "Stop everything" in the Meeting Room: the Owner stops every Agent on
// the Floor at once. Their running work goes back in the queue and none
// starts, until "Continue working" lets them carry on where they were.

const stopUrl = (floorId: string) =>
  `/api/floors/${encodeURIComponent(floorId)}/stop`;

/** Whether everything is stopped on the Floor (`GET /api/floors/:floorId/stop`). */
export const floorStopQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "stop"],
    queryFn: () => getJson(stopUrl(floorId), floorStopSchema),
  });

/**
 * "Stop everything", or once stopped "Continue working", kept in step
 * with the Floor's stops and continues from any browser.
 */
export function StopEverything({ floorId }: { floorId: string }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const { data: state, isPending } = useQuery(floorStopQuery(floorId));
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  useEventStream(
    { floorId, types: ["floor.stopped", "floor.continued"] },
    {
      onEvent: () => {
        void queryClient.invalidateQueries(floorStopQuery(floorId));
      },
    },
  );
  const stopped = state !== undefined && state.stoppedAt !== null;

  const send = async () => {
    setSending(true);
    setProblem(undefined);
    try {
      const response = await postJson(
        stopped
          ? `/api/floors/${encodeURIComponent(floorId)}/continue`
          : stopUrl(floorId),
        {},
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblem(
          error.message ??
            (stopped
              ? "The Agents could not carry on."
              : "Everything could not be stopped."),
        );
        return;
      }
      const next: FloorStopState = floorStopSchema.parse(await response.json());
      queryClient.setQueryData(floorStopQuery(floorId).queryKey, next);
    } catch {
      setProblem("AI Office could not be reached.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-2">
      {stopped && (
        <p role="status" className="text-sm">
          Everything is stopped: no Agent works until you continue.
        </p>
      )}
      <Button
        type="button"
        variant={stopped ? "default" : "destructive"}
        disabled={isPending || sending}
        onClick={() => {
          void send();
        }}
      >
        {sending ? (
          <Spinner aria-hidden />
        ) : stopped ? (
          <CirclePlay aria-hidden />
        ) : (
          <CirclePause aria-hidden />
        )}
        {stopped ? "Continue working" : "Stop everything"}
      </Button>
      {problem !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
