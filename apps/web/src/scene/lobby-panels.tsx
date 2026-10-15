import { ArrowUpDown, BellRing, ClipboardList } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

import { isRiding, liftDestination, liftLocation } from "./lift.ts";
import { useLiftStore } from "./lift-store.ts";
import { sameLocation, stopAt, type LiftStop } from "./lift-stops.ts";
import type { BoardPreview } from "./notice-board-preview.ts";

// The lobby's HTML over the scene (PRD §7: panels are HTML): the lift's
// floor picker, and what the 3D Notice Board shows in words, with a link to
// the 2D Notice Board. Both work from the keyboard.

/** A panel over the scene: it takes the pointer, unlike the space around it. */
export const panelClass =
  "pointer-events-auto rounded-lg border bg-background/90 p-2 shadow-sm backdrop-blur-sm";

const actionNoticesText = (count: number) =>
  `${String(count)} action Notice${count === 1 ? "" : "s"}`;

/** A stop's action Notices: a count with a bell, never colour alone. */
function ActionIndicator({ count }: { count: number }) {
  return (
    <span
      className="ml-auto inline-flex items-center gap-1 rounded-full bg-office-state-critical px-1.5 py-0.5 text-xs font-medium text-office-paper"
      title={actionNoticesText(count)}
    >
      <BellRing aria-hidden className="size-3" />
      <span aria-hidden>{count}</span>
      <span className="sr-only">, {actionNoticesText(count)}</span>
    </span>
  );
}

/**
 * The lift's floor picker: the lobby and every Floor, each with its action
 * Notices. Picking one rides the lift there; the stop it is at is marked
 * as the current one.
 */
export function FloorPicker({ stops }: { stops: readonly LiftStop[] }) {
  const id = useId();
  const open = useLiftStore((state) => state.pickerOpen);
  const setOpen = useLiftStore((state) => state.setPickerOpen);
  const call = useLiftStore((state) => state.call);
  const location = useLiftStore((state) => liftLocation(state.lift));
  const going = useLiftStore((state) =>
    isRiding(state.lift) ? liftDestination(state.lift).location : undefined,
  );
  const here = stopAt(stops, location);
  const there = going === undefined ? undefined : stopAt(stops, going);

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        size="sm"
        variant="outline"
        className="pointer-events-auto"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <ArrowUpDown aria-hidden />
        Lift
      </Button>
      <nav
        id={id}
        aria-label="Floors"
        hidden={!open}
        className={cn(panelClass, "w-64 space-y-2")}
      >
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {stops.map((stop) => {
            const current = sameLocation(stop.location, location);
            return (
              <li key={stop.order}>
                <Button
                  size="sm"
                  variant={current ? "secondary" : "ghost"}
                  className="w-full justify-start"
                  aria-current={current ? "location" : undefined}
                  title={stop.repository}
                  onClick={() => {
                    call({ order: stop.order, location: stop.location });
                  }}
                >
                  <span className="truncate">{stop.name}</span>
                  {stop.actionNotices > 0 && (
                    <ActionIndicator count={stop.actionNotices} />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
        <p
          role="status"
          className="border-t px-2 pt-2 text-xs text-muted-foreground"
        >
          {there === undefined
            ? `You are in ${here?.name ?? "the lobby"}.`
            : `Going to ${there.name}…`}
        </p>
      </nav>
    </div>
  );
}

/**
 * The 3D Notice Board in words, and the way to read it: the 2D Notice
 * Board, where each Notice can be acted on.
 */
export function BoardSummary({
  board,
  navigate,
}: {
  board: BoardPreview;
  navigate?: ((href: string) => void) | undefined;
}) {
  return (
    <section
      aria-label="Notice Board"
      className={cn(panelClass, "max-w-xs space-y-1 text-sm")}
    >
      <p>{board.summary}</p>
      <a
        href="/notices"
        className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
        onClick={(event) => {
          if (navigate !== undefined) {
            event.preventDefault();
            navigate("/notices");
          }
        }}
      >
        <ClipboardList aria-hidden className="size-4" />
        Open the Notice Board
      </a>
    </section>
  );
}
