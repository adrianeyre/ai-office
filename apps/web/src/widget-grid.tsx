import { GripVertical, MoveDiagonal2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils.ts";

import {
  GRID,
  moveWidget,
  neighboursOf,
  parseLayout,
  readingOrder,
  resizeWidget,
  rowsFor,
  serialiseLayout,
  type WidgetLayout,
} from "./widget-layout.ts";

// A dashboard's widgets on a grid (widget-layout.ts). Each is moved by its
// grip and resized by its corner, with the pointer or the keyboard (arrow
// keys on the grip move it; with Shift they resize it), and snaps to whole
// cells. While it is dragged it leans a little to the right, lifted off
// the page; when it drops into place, the widgets around it shake. With
// reduced motion it neither leans nor shakes. A widget that fits its
// content grows taller whenever its content would not otherwise show in
// full, but never shrinks below the size it was given. On a narrow screen
// the widgets stack in one column, in reading order, and do not move.

/** One widget: its id, what its grip calls it, and what it shows. */
export interface Widget {
  readonly id: string;
  readonly title: string;
  readonly content: ReactNode;
  /** Grows taller, never shorter, so all of its content shows. */
  readonly fitContent?: boolean;
}

/** How many rows each widget that fits its content needs, by id. */
type Needs = Readonly<Record<string, number>>;

/**
 * `children` at their own height, measured in grid rows into `onNeeds`
 * whenever it changes, so their widget can grow to show them all.
 */
function FitToContent({
  id,
  onNeeds,
  children,
}: {
  id: string;
  onNeeds: (update: (needs: Needs) => Needs) => void;
  children: ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = inner.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const rows = rowsFor(element.getBoundingClientRect().height);
      onNeeds((needs) =>
        needs[id] === rows ? needs : { ...needs, [id]: rows },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [id, onNeeds]);
  return (
    <div>
      <div ref={inner}>{children}</div>
    </div>
  );
}

/** How far a dragged widget leans, as if lifted off the page. */
export const tilt = "3deg";

/** How long the widgets around a dropped one shake, in milliseconds. */
const shakeMs = 450;

/** How far the pointer must go before a press becomes a drag. */
const dragThreshold = 4;

const narrowQuery = "(max-width: 767px)";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

interface MediaQueries {
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
}
const matches = (query: string): boolean => {
  const { matchMedia } = globalThis as MediaQueries;
  return typeof matchMedia === "function" ? matchMedia(query).matches : false;
};

/** Whether the screen is too narrow for the grid: the widgets stack. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const { matchMedia } = globalThis as MediaQueries;
      const list =
        typeof matchMedia === "function" ? matchMedia(narrowQuery) : undefined;
      list?.addEventListener("change", onChange);
      return () => {
        list?.removeEventListener("change", onChange);
      };
    },
    () => matches(narrowQuery),
    () => false,
  );
}

/**
 * A layout kept in this browser under `key` (local storage), starting
 * from `defaults` and from them again after `reset`. Where storage is not
 * to be had, it lasts as long as the page.
 */
export function useStoredLayout(
  key: string,
  defaults: WidgetLayout,
): {
  layout: WidgetLayout;
  setLayout: (layout: WidgetLayout) => void;
  reset: () => void;
  changed: boolean;
} {
  const [layout, setState] = useState<WidgetLayout>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(key);
    } catch {
      // No storage: the defaults.
    }
    return parseLayout(stored, defaults);
  });
  const [changed, setChanged] = useState(() => {
    try {
      return localStorage.getItem(key) !== null;
    } catch {
      return false;
    }
  });
  return {
    layout,
    changed,
    setLayout(next) {
      setState(next);
      setChanged(true);
      try {
        localStorage.setItem(key, serialiseLayout(next));
      } catch {
        // Kept for this page only.
      }
    },
    reset() {
      setState(parseLayout(null, defaults));
      setChanged(false);
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing kept to remove.
      }
    },
  };
}

type Kind = "move" | "resize";

interface Gesture {
  readonly id: string;
  readonly kind: Kind;
  readonly pointerId: number;
  readonly from: { x: number; y: number };
  /** One cell and its gap, in pixels. */
  readonly pitch: { x: number; y: number };
  started: boolean;
}

interface Drag {
  readonly id: string;
  readonly kind: Kind;
  readonly offset: { x: number; y: number };
}

const keySteps: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function WidgetGrid({
  widgets,
  layout,
  onLayoutChange,
  label,
}: {
  widgets: readonly Widget[];
  layout: WidgetLayout;
  onLayoutChange: (layout: WidgetLayout) => void;
  /** What the grid is, for assistive technology. */
  label: string;
}) {
  const narrow = useNarrow();
  const grid = useRef<HTMLDivElement>(null);
  // A widget that fits its content grows when it needs more rows.
  const [needs, setNeeds] = useState<Needs>({});
  useEffect(() => {
    let next = layout;
    for (const [id, rows] of Object.entries(needs)) {
      const cell = next[id];
      if (cell !== undefined && rows > cell.h) {
        next = resizeWidget(next, id, cell.w, rows);
      }
    }
    if (next !== layout) {
      onLayoutChange(next);
    }
  }, [needs, layout, onLayoutChange]);
  const gesture = useRef<Gesture | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [shaking, setShaking] = useState<{
    ids: readonly string[];
    round: number;
  }>({ ids: [], round: 0 });
  const [said, setSaid] = useState("");
  const titleOf = (id: string) =>
    widgets.find((widget) => widget.id === id)?.title ?? id;

  const commit = (id: string, kind: Kind, next: WidgetLayout) => {
    if (next === layout) {
      return;
    }
    onLayoutChange(next);
    if (!matches(reducedMotionQuery)) {
      setShaking(({ round }) => ({
        ids: neighboursOf(layout, next, id),
        round: round + 1,
      }));
      window.setTimeout(() => {
        setShaking(({ round }) => ({ ids: [], round }));
      }, shakeMs);
    }
    const cell = next[id];
    if (cell !== undefined) {
      setSaid(
        kind === "move"
          ? `${titleOf(id)} moved to column ${String(cell.x + 1)}, row ${String(cell.y + 1)}.`
          : `${titleOf(id)} is ${String(cell.w)} columns wide and ${String(cell.h)} rows tall.`,
      );
    }
  };

  const apply = (id: string, kind: Kind, cols: number, rows: number) => {
    const cell = layout[id];
    if (cell === undefined) {
      return layout;
    }
    return kind === "move"
      ? moveWidget(layout, id, cell.x + cols, cell.y + rows)
      : resizeWidget(layout, id, cell.w + cols, cell.h + rows);
  };

  const press =
    (id: string, kind: Kind) => (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || grid.current === null) {
        return;
      }
      const width = grid.current.getBoundingClientRect().width;
      const cell = (width - GRID.gap * (GRID.columns - 1)) / GRID.columns;
      gesture.current = {
        id,
        kind,
        pointerId: event.pointerId,
        from: { x: event.clientX, y: event.clientY },
        pitch: { x: cell + GRID.gap, y: GRID.rowHeight + GRID.gap },
        started: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const move = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    const offset = {
      x: event.clientX - current.from.x,
      y: event.clientY - current.from.y,
    };
    if (!current.started && Math.hypot(offset.x, offset.y) < dragThreshold) {
      return;
    }
    current.started = true;
    setDrag({ id: current.id, kind: current.kind, offset });
  };

  const release = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    gesture.current = null;
    setDrag(null);
    if (!current.started) {
      return;
    }
    const cols = Math.round((event.clientX - current.from.x) / current.pitch.x);
    const rows = Math.round((event.clientY - current.from.y) / current.pitch.y);
    commit(
      current.id,
      current.kind,
      apply(current.id, current.kind, cols, rows),
    );
  };

  const cancel = () => {
    gesture.current = null;
    setDrag(null);
  };

  const onKey = (id: string) => (event: KeyboardEvent<HTMLElement>) => {
    const step = keySteps[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const kind: Kind = event.shiftKey ? "resize" : "move";
    commit(id, kind, apply(id, kind, step[0], step[1]));
  };

  const order = readingOrder(layout);
  const shown = [...widgets].sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
  );

  if (narrow) {
    return (
      <div aria-label={label} role="group" className="space-y-6">
        {shown.map((widget) => (
          <div key={widget.id} data-widget={widget.id}>
            {widget.content}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div
        ref={grid}
        role="group"
        aria-label={label}
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${String(GRID.columns)}, minmax(0, 1fr))`,
          gridAutoRows: `${String(GRID.rowHeight)}px`,
          gap: `${String(GRID.gap)}px`,
        }}
      >
        {shown.map((widget) => {
          const cell = layout[widget.id];
          if (cell === undefined) {
            return null;
          }
          const dragging = drag?.id === widget.id ? drag : null;
          const leaning =
            dragging?.kind === "move" && !matches(reducedMotionQuery);
          const style: CSSProperties = {
            gridColumn: `${String(cell.x + 1)} / span ${String(cell.w)}`,
            gridRow: `${String(cell.y + 1)} / span ${String(cell.h)}`,
            ...(dragging?.kind === "move"
              ? {
                  translate: `${String(dragging.offset.x)}px ${String(dragging.offset.y)}px`,
                  rotate: leaning ? tilt : "0deg",
                  zIndex: 20,
                }
              : {}),
            ...(dragging?.kind === "resize"
              ? {
                  width: `calc(100% + ${String(dragging.offset.x)}px)`,
                  height: `calc(100% + ${String(dragging.offset.y)}px)`,
                  zIndex: 20,
                }
              : {}),
          };
          const shake = shaking.ids.includes(widget.id);
          return (
            <div
              key={widget.id}
              data-widget={widget.id}
              data-dragging={dragging === null ? undefined : dragging.kind}
              data-shaking={
                shake ? (shaking.round % 2 === 0 ? "even" : "odd") : undefined
              }
              className={cn(
                "group/widget relative min-h-0 min-w-0 rounded-xl",
                dragging !== null &&
                  "shadow-2xl ring-2 ring-ring/40 transition-none",
                dragging === null &&
                  "transition-[translate,rotate] duration-200",
              )}
              style={style}
            >
              {/* Scrolls when it is smaller than its content, so the keyboard
                  reaches it too (WCAG 2.1.1). */}
              <div
                role="region"
                aria-label={widget.title}
                tabIndex={0}
                className="h-full overflow-auto rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&>*]:min-h-full"
              >
                {widget.fitContent === true ? (
                  <FitToContent id={widget.id} onNeeds={setNeeds}>
                    {widget.content}
                  </FitToContent>
                ) : (
                  widget.content
                )}
              </div>
              <button
                type="button"
                aria-label={`Move ${widget.title}`}
                aria-describedby="widget-grid-help"
                title="Drag to move; arrow keys move it, Shift and arrow keys resize it"
                className="absolute top-2 right-2 z-10 flex size-7 cursor-grab touch-none items-center justify-center rounded-md border bg-background/90 text-muted-foreground opacity-60 hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing group-hover/widget:opacity-100"
                onPointerDown={press(widget.id, "move")}
                onPointerMove={move}
                onPointerUp={release}
                onPointerCancel={cancel}
                onKeyDown={onKey(widget.id)}
              >
                <GripVertical aria-hidden className="size-4" />
              </button>
              <span
                aria-hidden
                title="Drag to resize"
                className="absolute right-1 bottom-1 z-10 flex size-5 cursor-se-resize touch-none items-center justify-center text-muted-foreground opacity-50 hover:opacity-100 group-hover/widget:opacity-100"
                onPointerDown={press(widget.id, "resize")}
                onPointerMove={move}
                onPointerUp={release}
                onPointerCancel={cancel}
              >
                <MoveDiagonal2 className="size-3.5" />
              </span>
            </div>
          );
        })}
      </div>
      <p id="widget-grid-help" className="sr-only">
        Arrow keys move the widget a cell at a time; Shift and the arrow keys
        resize it.
      </p>
      <p role="status" className="sr-only">
        {said}
      </p>
    </>
  );
}
