import {
  dayName,
  statusUpdateAnswerSchema,
  type StatusUpdate,
} from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

import { getJson, postJson, readApiError } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { FastForwardButton } from "./scene/fast-forward-button.tsx";
import { useMeetingFastForwardStore } from "./scene/meeting-fast-forward.ts";
import { statusUpdateTurnSeconds } from "./scene/meeting-walks.ts";
import { MovablePanel } from "./scene/movable-panel.tsx";
import { useSceneSettings } from "./scene/scene-settings.ts";
import { sessionQuery } from "./session.ts";

// A Floor's Status update (PRD FR-23a), in the Office: the Status update
// button, before Planning, gives one now, and the first time the Owner
// opens a Floor each day AI Office gives the day's own (`useDailyStatus
// Update`; the server keeps it to once a day, in the Owner's days). Either
// way the Floor walks to the meeting room from its `status_update.given`
// event (meeting-walks.ts), and this panel shows what each Agent says,
// the Manager first, each Agent's turn marked as it speaks. It is kept in
// the Manager chat too. The 2D Office shows the same panel, with no walk.
// While a Floor's Agents work, the server gives one each hour by itself,
// saying what each did in the last hour; a page hears of it from its
// event and reads it (`useGivenStatusUpdates`), as it does one given from
// another browser.

const statusUpdateUrl = (floorId: string) =>
  `/api/floors/${encodeURIComponent(floorId)}/status-update`;

/** The Status update shown, if any: one at a time, the latest. */
export const useStatusUpdateStore = create<{
  readonly shown: StatusUpdate | undefined;
  readonly show: (statusUpdate: StatusUpdate) => void;
  readonly close: () => void;
}>()((set) => ({
  shown: undefined,
  show: (statusUpdate) => {
    set({ shown: statusUpdate });
  },
  close: () => {
    set({ shown: undefined });
  },
}));

/** Asks for a Status update: the button's (`owner`) or the day's (`daily`). */
async function askFor(
  floorId: string,
  trigger: "owner" | "daily",
  csrfToken: string | undefined,
): Promise<StatusUpdate | null> {
  const response = await postJson(
    trigger === "daily"
      ? `${statusUpdateUrl(floorId)}/daily`
      : statusUpdateUrl(floorId),
    {},
    csrfToken,
  );
  if (!response.ok) {
    const error = await readApiError(response);
    throw new Error(error.message ?? "The Status update could not be given.");
  }
  return statusUpdateAnswerSchema.parse(await response.json()).statusUpdate;
}

/** The latest Status update given on the Floor, if any. */
async function latestOf(floorId: string): Promise<StatusUpdate | null> {
  return (
    await getJson(
      `${statusUpdateUrl(floorId)}/latest`,
      statusUpdateAnswerSchema,
    )
  ).statusUpdate;
}

/**
 * Shows each Status update given on the Floor (`floorId`) while the page
 * is open, whoever gave it: the hourly ones, and those asked for from
 * another browser. Each is read once its `status_update.given` event
 * arrives, and shown if it is still the latest.
 */
export function useGivenStatusUpdates(floorId: string | undefined): void {
  useEventStream(
    { floorId, types: ["status_update.given"] },
    {
      enabled: floorId !== undefined,
      onEvent: ({ id, event }) => {
        if (
          floorId === undefined ||
          event.type !== "status_update.given" ||
          event.floorId !== floorId ||
          useStatusUpdateStore.getState().shown?.eventId === id
        ) {
          return;
        }
        latestOf(floorId)
          .then((given) => {
            if (given?.eventId === id) {
              useStatusUpdateStore.getState().show(given);
            }
          })
          .catch(() => {
            // Kept in the Manager chat all the same.
          });
      },
    },
  );
}

/** The Floors the day's Status update was asked for in this page, once each. */
const askedToday = new Set<string>();

/** Forgets which Floors were asked for, as a new page would: for tests. */
export function forgetDailyStatusUpdates(): void {
  askedToday.clear();
}

/**
 * The day's Status update, asked for once when the Owner opens a Floor
 * (`floorId`, while `enabled`): shown if the server gives it, which it
 * does the first time that day only.
 */
export function useDailyStatusUpdate(
  floorId: string | undefined,
  enabled = true,
): void {
  const { data: session } = useQuery(sessionQuery);
  const csrfToken = session?.csrfToken;
  useEffect(() => {
    if (
      floorId === undefined ||
      !enabled ||
      csrfToken === undefined ||
      askedToday.has(floorId)
    ) {
      return;
    }
    askedToday.add(floorId);
    askFor(floorId, "daily", csrfToken)
      .then((given) => {
        if (given !== null) {
          useStatusUpdateStore.getState().show(given);
        }
      })
      .catch(() => {
        // Asked again on the next page; the button gives one meanwhile.
        askedToday.delete(floorId);
      });
  }, [floorId, enabled, csrfToken]);
}

/**
 * Status update, before Planning: the Floor gathers now and reports. In
 * the 3D Office (`fastForward`), a fast-forward button shows beside it
 * while the Floor walks to the meeting room.
 */
export function StatusUpdateButton({
  floorId,
  className,
  fastForward = false,
}: {
  floorId: string;
  className?: string;
  fastForward?: boolean;
}) {
  const { data: session } = useQuery(sessionQuery);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string>();
  return (
    <div className="flex flex-col items-end gap-1">
      {problem !== undefined && (
        <p
          role="alert"
          className="pointer-events-auto max-w-64 rounded-md bg-background/90 px-2 py-1 text-xs text-destructive shadow-sm"
        >
          {problem}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          className={cn("pointer-events-auto shadow-lg", className)}
          pending={asking}
          disabled={session === undefined}
          onClick={() => {
            setAsking(true);
            setProblem(undefined);
            const fastForwarding = useMeetingFastForwardStore.getState();
            if (fastForward) {
              fastForwarding.call("status-update");
            }
            askFor(floorId, "owner", session?.csrfToken)
              .then((given) => {
                if (given === null) {
                  fastForwarding.dismiss();
                  setProblem("This Floor has no Manager to give one.");
                } else {
                  useStatusUpdateStore.getState().show(given);
                }
              })
              .catch((error: unknown) => {
                fastForwarding.dismiss();
                setProblem(
                  error instanceof Error ? error.message : String(error),
                );
              })
              .finally(() => {
                setAsking(false);
              });
          }}
        >
          <Megaphone aria-hidden />
          Status update
        </Button>
        {fastForward && <FastForwardButton gathering="status-update" />}
      </div>
    </div>
  );
}

/**
 * Whose turn it is: each Agent's in turn, from the first as the update is
 * shown, then no one's (undefined) once each has spoken. With reduced
 * motion, no one is marked: the whole update reads at once.
 */
function useSpeaker(turns: number): number | undefined {
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (reducedMotion || turn >= turns) {
      return;
    }
    const timer = setTimeout(() => {
      setTurn(turn + 1);
    }, statusUpdateTurnSeconds * 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [turn, turns, reducedMotion]);
  return reducedMotion || turn >= turns ? undefined : turn;
}

/** The Status update shown for `floorId`, with each Agent's part. */
export function StatusUpdatePanel({
  floorId,
  className,
}: {
  floorId: string;
  className?: string;
}) {
  const shown = useStatusUpdateStore((state) => state.shown);
  return shown?.floorId === floorId ? (
    // Each update's turns start again from the first.
    <StatusUpdateCard
      key={shown.eventId}
      statusUpdate={shown}
      className={className}
    />
  ) : null;
}

function StatusUpdateCard({
  statusUpdate,
  className,
}: {
  statusUpdate: StatusUpdate;
  className?: string | undefined;
}) {
  const close = useStatusUpdateStore((state) => state.close);
  const speaker = useSpeaker(statusUpdate.entries.length);
  const hourly = statusUpdate.trigger === "hourly";
  const reported = hourly
    ? "in the last hour"
    : `on ${dayName(statusUpdate.reportedDay)}`;
  return (
    // Moved, resized and filling the screen as every panel over the Office
    // is (movable-panel.tsx); kept within the view, so never off its edge.
    <MovablePanel
      layoutKey="status-update"
      role="region"
      title="Status update"
      description={`${
        statusUpdate.trigger === "daily"
          ? "The first today on this Floor. "
          : hourly
            ? "Given each hour while this Floor's Agents work. "
            : ""
      }What each did ${reported}, and plans today.`}
      onClose={close}
      closeLabel="Close the Status update"
      widthClass="w-[min(26rem,calc(100vw-2rem))]"
      className={cn("pointer-events-auto max-h-full", className)}
    >
      <p role="status" className="sr-only">
        Status update: {statusUpdate.entries.length}{" "}
        {statusUpdate.entries.length === 1 ? "Agent reports" : "Agents report"}{" "}
        {reported} and today.
      </p>
      <ol
        aria-label="What each Agent says"
        tabIndex={0}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto"
      >
        {statusUpdate.entries.map((entry, index) => (
          <li
            key={entry.agentId}
            aria-current={speaker === index ? "true" : undefined}
            className={cn(
              "rounded-lg border border-transparent p-2 transition-colors",
              speaker === index && "border-primary/40 bg-accent",
            )}
          >
            <p className="font-medium">
              {entry.name}{" "}
              <span className="font-normal text-muted-foreground">
                ({entry.role})
              </span>
              {speaker === index && <span className="sr-only">, speaking</span>}
            </p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              {hourly
                ? "In the last hour"
                : `On ${dayName(statusUpdate.reportedDay)}`}
            </p>
            <ul className="list-disc pl-5">
              {entry.did.length === 0 ? (
                <li>Nothing to report.</li>
              ) : (
                entry.did.map((line) => <li key={line}>{line}</li>)
              )}
            </ul>
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              Today
            </p>
            <ul className="list-disc pl-5">
              {entry.today.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </MovablePanel>
  );
}
