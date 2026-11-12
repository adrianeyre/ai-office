import { CircleCheck, CircleX } from "lucide-react";
import { useEffect, useState } from "react";

import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

import { useActivities, type Activity } from "./activity.ts";

// The Activity indicator: whenever the Owner is waiting on something they
// asked for (a save, an add, a delete, an action, a Refresh), a progress
// bar runs along the top of the page, and a panel in the corner says what
// each thing is doing, the request behind it, how long it has taken, and
// how it ended. Work answered within a moment shows nothing, so nothing
// flashes; a failure always shows, however quick. Neither the server nor
// the browser says how far a request has got, so the bars show time
// passing (filling quickly at first, then slowly, never reaching the end
// until the answer comes) and are indeterminate to assistive technology.
// A screen reader hears what started and how it ended, once each, from a
// live region of its own, never the ticking time.

/** How long work runs before it is shown: quicker work never flashes. */
export const showAfterMs = 400;

/** After this long, the panel says the work can take a while. */
const slowAfterMs = 8000;

/** How far a bar has filled after `ms`: towards 90%, never past it. */
const filled = (ms: number): number => 90 * (1 - Math.exp(-ms / 3000));

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Whether an activity is on show at `at`. */
const onShow = (activity: Activity, at: number): boolean =>
  activity.status === "failed" ||
  (activity.finishedAt ?? at) - activity.startedAt >= showAfterMs;

function ActivityRow({ activity, at }: { activity: Activity; at: number }) {
  const took = Math.max(0, (activity.finishedAt ?? at) - activity.startedAt);
  const running = activity.status === "running";
  const status = running
    ? took >= slowAfterMs
      ? "Still working: some actions reach GitHub or an AI Provider and take longer"
      : "Waiting for AI Office to answer"
    : activity.status === "done"
      ? "Done"
      : (activity.problem ?? "It failed.");
  return (
    <li className="space-y-1.5" data-status={activity.status}>
      <div className="flex items-start gap-2">
        {running ? (
          <Spinner className="mt-0.5" />
        ) : activity.status === "done" ? (
          <CircleCheck aria-hidden className="mt-0.5 size-4 text-success" />
        ) : (
          <CircleX aria-hidden className="mt-0.5 size-4 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {activity.label}
            {running ? "…" : ""}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {activity.detail}
          </p>
          <p
            className={cn(
              "text-xs",
              activity.status === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {status} · <span className="tabular-nums">{seconds(took)}</span>
          </p>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={activity.label}
        aria-valuetext={running ? `${status}, ${seconds(took)}` : status}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200 ease-out",
            activity.status === "failed"
              ? "bg-destructive"
              : activity.status === "done"
                ? "bg-success"
                : "bg-primary",
          )}
          style={{ width: `${String(running ? filled(took) : 100)}%` }}
        />
      </div>
    </li>
  );
}

/** What a screen reader is told: each start and end, once. */
const announcement = (shown: readonly Activity[]): string =>
  shown
    .map((activity) =>
      activity.status === "running"
        ? `${activity.label}…`
        : activity.status === "done"
          ? `${activity.label}: done.`
          : `${activity.label} failed: ${activity.problem ?? ""}`,
    )
    .join(" ");

/** The progress bar along the top and the panel in the corner. */
export function ActivityIndicator() {
  const activities = useActivities();
  const [at, setAt] = useState(() => performance.now());
  // The clock ticks only while something is on its way or on show.
  useEffect(() => {
    if (activities.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      setAt(performance.now());
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, [activities]);

  const shown = activities.filter((activity) => onShow(activity, at));
  const running = shown.filter(({ status }) => status === "running");
  const oldest = running[0];
  return (
    <>
      {/* Along the top: the longest wait so far. */}
      {oldest !== undefined && (
        <div
          aria-hidden
          data-slot="activity-bar"
          className="pointer-events-none fixed inset-x-0 top-0 z-50 h-1"
        >
          <div
            className="h-full bg-primary transition-[width] duration-200 ease-out"
            style={{
              width: `${String(filled(Math.max(0, at - oldest.startedAt)))}%`,
            }}
          />
        </div>
      )}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement(shown)}
      </div>
      {shown.length > 0 && (
        <section
          aria-label="Activity"
          aria-busy={running.length > 0}
          className="fixed right-4 bottom-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
        >
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {running.length > 0
              ? `Working on ${String(running.length)} ${running.length === 1 ? "thing" : "things"}`
              : "Finished"}
          </h2>
          <ul className="space-y-3">
            {shown.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} at={at} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
