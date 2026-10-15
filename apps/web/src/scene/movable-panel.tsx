import {
  GripVertical,
  Maximize2,
  Minimize2,
  MoveDiagonal2,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

import {
  navigationInset,
  useNavigationPrefs,
  wideNavigationQuery,
} from "../navigation-prefs.ts";
import { panelClass } from "./lobby-panels.tsx";
import {
  clampLayout,
  readLayout,
  saveLayout,
  type PanelArea,
  type PanelLayout,
} from "./panel-layout.ts";

// The frame every panel over the 3D Office has (PRD FR-58): moved by its
// header, resized by its edges, filling the screen from its button, each
// kind's layout kept in this browser (panel-layout.ts), within the view
// office-view.tsx marks with `data-panel-area`.

/** Under this width, in rem, the Office's view is too narrow to move a panel in. */
const narrowRem = 39;

/** How far an arrow key moves or resizes a panel, in pixels. */
const keyStep = 16;

/** How far the pointer must go before a press becomes a drag. */
const dragThreshold = 4;

const keySteps: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Which of the panel's edges a gesture moves: all of it, or one or two. */
type Grip = "move" | "right" | "bottom" | "corner";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Gesture {
  readonly grip: Grip;
  readonly pointerId: number;
  readonly from: { readonly x: number; readonly y: number };
  readonly start: Box;
  started: boolean;
}

const rootFontSize = (): number =>
  Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/** The view a panel moves in, marked by office-view.tsx. */
const areaOf = (panel: HTMLElement | null): HTMLElement | null =>
  panel?.closest<HTMLElement>("[data-panel-area]") ?? null;

/**
 * The size of the view the panel is in, kept up to date; none where it
 * is not in one, or the view is too narrow for the panel to move in it.
 */
function useArea(panel: RefObject<HTMLElement | null>) {
  const [area, setArea] = useState<PanelArea | undefined>(undefined);
  useLayoutEffect(() => {
    const element = areaOf(panel.current);
    if (element === null) {
      return;
    }
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setArea((before) =>
        width < narrowRem * rootFontSize()
          ? undefined
          : before?.width === width && before.height === height
            ? before
            : { width, height },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [panel]);
  return area;
}

interface MediaQueries {
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
}

/** Whether the navigation is beside the page, so full screen leaves it be. */
function useWideNavigation(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const { matchMedia } = globalThis as MediaQueries;
      const list =
        typeof matchMedia === "function"
          ? matchMedia(wideNavigationQuery)
          : undefined;
      list?.addEventListener("change", onChange);
      return () => {
        list?.removeEventListener("change", onChange);
      };
    },
    () => {
      const { matchMedia } = globalThis as MediaQueries;
      return typeof matchMedia === "function"
        ? matchMedia(wideNavigationQuery).matches
        : true;
    },
    () => true,
  );
}

export interface MovablePanelProps {
  /** Which kind of panel it is: its layout is kept under this name. */
  readonly layoutKey: string;
  /** Its heading. */
  readonly title: ReactNode;
  /** A line under the heading, in muted ink. */
  readonly description?: ReactNode;
  readonly onClose: () => void;
  /** What the close button says to a screen reader. */
  readonly closeLabel?: string;
  /** `dialog` takes focus as it opens and hands it back; `region` does not. */
  readonly role?: "dialog" | "region";
  /** Its width while it takes its own, as a class. */
  readonly widthClass?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A panel over the 3D Office (the inspector's, the Status update's), with
 * a close button. As a `dialog`, focus moves into it as it opens, and back
 * to where it was as it closes.
 *
 * Where the view has room, the panel moves and resizes within it: dragged
 * by its header, or its grip's arrow keys (with Shift, they resize it), and
 * resized by its right and bottom edges and its corner. Its button fills
 * the page with it, all but the navigation menu, until the button or
 * Escape puts it back. Each kind of panel keeps its layout in this browser
 * (panel-layout.ts). Where the view is narrow, or the panel is in none
 * (the 2D Office), it stays where it is laid out instead.
 */
export function MovablePanel({
  layoutKey,
  title,
  description,
  onClose,
  closeLabel = "Close panel",
  role = "dialog",
  widthClass = "w-80",
  className,
  children,
}: MovablePanelProps) {
  const headingId = useId();
  const helpId = useId();
  const panel = useRef<HTMLElement>(null);
  const area = useArea(panel);
  const wide = useWideNavigation();
  const inset = useNavigationPrefs((prefs) => navigationInset(prefs, wide));
  const [layout, setLayout] = useState<PanelLayout>(() =>
    readLayout(layoutKey),
  );
  const [dragging, setDragging] = useState<PanelLayout | undefined>(undefined);
  const gesture = useRef<Gesture | null>(null);
  // Its size as last laid out, to keep it within the view.
  const [own, setOwn] = useState<PanelArea | undefined>(undefined);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (role !== "dialog") {
      return;
    }
    const before = document.activeElement;
    panel.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) {
        before.focus();
      }
    };
  }, [role]);
  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (rect !== undefined && rect.width > 0) {
      setOwn((before) =>
        before?.width === rect.width && before.height === rect.height
          ? before
          : { width: rect.width, height: rect.height },
      );
    }
  }, [area, layout, dragging]);

  const movable = area !== undefined;
  const shown =
    area === undefined ? {} : clampLayout(dragging ?? layout, area, own);
  const full = movable && shown.full === true;
  const placed = movable && !full && shown.x !== undefined;
  const sized = full || (placed && shown.height !== undefined);

  /** The panel as it is now, in the view's pixels. */
  const measure = (): Box => {
    const rect = panel.current?.getBoundingClientRect();
    const view = areaOf(panel.current)?.getBoundingClientRect();
    return {
      x: (rect?.left ?? 0) - (view?.left ?? 0),
      y: (rect?.top ?? 0) - (view?.top ?? 0),
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    };
  };

  /** The layout after moving or resizing `start` by `dx` and `dy`. */
  const next = (grip: Grip, start: Box, dx: number, dy: number) => {
    if (area === undefined) {
      return layout;
    }
    const at = { ...layout, x: start.x, y: start.y };
    const changed: PanelLayout =
      grip === "move"
        ? { ...at, x: start.x + dx, y: start.y + dy }
        : {
            ...at,
            // Its top left corner stays put: it grows only as far as the view.
            ...(grip === "bottom"
              ? {}
              : { width: Math.min(start.width + dx, area.width - start.x) }),
            ...(grip === "right"
              ? {}
              : {
                  height: Math.min(start.height + dy, area.height - start.y),
                }),
          };
    return clampLayout(changed, area, start);
  };

  const keep = (grip: Grip, value: PanelLayout) => {
    setLayout(value);
    saveLayout(layoutKey, value);
    setSaid(
      value.full === true
        ? "The panel fills the screen."
        : grip === "move"
          ? `Panel moved to ${String(value.x)}, ${String(value.y)} pixels.`
          : `Panel resized to ${String(value.width ?? own?.width ?? 0)} by ${String(value.height ?? own?.height ?? 0)} pixels.`,
    );
  };

  const toggleFull = () => {
    const value: PanelLayout = { ...layout, full: full ? undefined : true };
    setLayout(value);
    saveLayout(layoutKey, value);
    setSaid(
      value.full === true
        ? "The panel fills the screen."
        : "The panel is back to its size.",
    );
  };

  /** A press on the header, or on an edge or corner (its `data-resize`). */
  const press = (event: PointerEvent<HTMLElement>) => {
    const grip = (event.currentTarget.dataset["resize"] ?? "move") as Grip;
    if (event.button !== 0 || !movable || full) {
      return;
    }
    if (
      grip === "move" &&
      event.target instanceof Element &&
      event.target.closest("button:not([data-move-handle]), a, input") !== null
    ) {
      return;
    }
    gesture.current = {
      grip,
      pointerId: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      start: measure(),
      started: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - current.from.x;
    const dy = event.clientY - current.from.y;
    if (!current.started && Math.hypot(dx, dy) < dragThreshold) {
      return;
    }
    current.started = true;
    setDragging(next(current.grip, current.start, dx, dy));
  };

  const release = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    gesture.current = null;
    setDragging(undefined);
    if (current.started) {
      keep(
        current.grip,
        next(
          current.grip,
          current.start,
          event.clientX - current.from.x,
          event.clientY - current.from.y,
        ),
      );
    }
  };

  const cancel = () => {
    gesture.current = null;
    setDragging(undefined);
  };

  const onGripKey = (event: KeyboardEvent<HTMLElement>) => {
    const step = keySteps[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const grip: Grip = event.shiftKey ? "corner" : "move";
    keep(grip, next(grip, measure(), step[0] * keyStep, step[1] * keyStep));
  };

  const style: CSSProperties | undefined =
    area === undefined
      ? undefined
      : full
        ? {
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            left: inset,
            zIndex: 40,
          }
        : placed
          ? {
              position: "absolute",
              left: shown.x,
              top: shown.y,
              width: shown.width,
              height: shown.height,
              maxHeight: area.height - (shown.y ?? 0),
              zIndex: 20,
            }
          : undefined;

  return (
    <section
      ref={panel}
      role={role}
      aria-labelledby={headingId}
      data-kind={layoutKey}
      data-layout={full ? "full" : placed ? "placed" : "docked"}
      data-sized={sized ? "" : undefined}
      tabIndex={-1}
      style={style}
      className={cn(
        panelClass,
        "group/inspector relative flex max-w-full flex-col gap-3 p-4 text-sm outline-none",
        shown.width === undefined && !full && widthClass,
        full && "rounded-none bg-background shadow-2xl",
        dragging !== undefined && "shadow-2xl ring-2 ring-ring/40",
        // Across the Office's view, scrolling, where it is too narrow to
        // sit beside the controls (office-view.tsx).
        "@max-[39rem]:max-h-full @max-[39rem]:w-full @max-[39rem]:overflow-y-auto",
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape" && full && !event.defaultPrevented) {
          // Out of full screen first; the next Escape closes it.
          event.preventDefault();
          toggleFull();
        }
      }}
    >
      <header
        className={cn(
          "flex shrink-0 items-start justify-between gap-2",
          movable && !full && "cursor-move touch-none select-none",
        )}
        onPointerDown={press}
        onPointerMove={drag}
        onPointerUp={release}
        onPointerCancel={cancel}
      >
        <div className="min-w-0 space-y-0.5">
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
          {description !== undefined && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="-mt-1 -mr-2 flex shrink-0 items-center">
          {movable && !full && (
            <Button
              size="icon"
              variant="ghost"
              className="cursor-grab active:cursor-grabbing"
              data-move-handle=""
              aria-label="Move panel"
              aria-describedby={helpId}
              title="Drag to move; arrow keys move it, Shift and arrow keys resize it"
              onKeyDown={onGripKey}
            >
              <GripVertical aria-hidden />
            </Button>
          )}
          {movable && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={full ? "Restore panel" : "Full screen"}
              title={full ? "Restore panel (Escape)" : "Full screen"}
              onClick={toggleFull}
            >
              {full ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label={closeLabel}
            title={`${closeLabel} (Escape)`}
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        </div>
      </header>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 [&>a]:self-start [&>button]:self-start">
        {children}
      </div>
      {movable && !full && (
        <>
          <span
            aria-hidden
            data-resize="right"
            className="absolute top-3 right-0 bottom-4 w-1.5 cursor-e-resize touch-none"
            onPointerDown={press}
            onPointerMove={drag}
            onPointerUp={release}
            onPointerCancel={cancel}
          />
          <span
            aria-hidden
            data-resize="bottom"
            className="absolute right-4 bottom-0 left-3 h-1.5 cursor-s-resize touch-none"
            onPointerDown={press}
            onPointerMove={drag}
            onPointerUp={release}
            onPointerCancel={cancel}
          />
          <span
            aria-hidden
            data-resize="corner"
            title="Drag to resize"
            className="absolute right-0 bottom-0 flex size-4 cursor-se-resize touch-none items-center justify-center text-muted-foreground opacity-60 hover:opacity-100"
            onPointerDown={press}
            onPointerMove={drag}
            onPointerUp={release}
            onPointerCancel={cancel}
          >
            <MoveDiagonal2 className="size-3" />
          </span>
          <p id={helpId} className="sr-only">
            Arrow keys move the panel; Shift and the arrow keys resize it.
          </p>
        </>
      )}
      <p role="status" className="sr-only">
        {said}
      </p>
    </section>
  );
}
