// Where each widget sits on a dashboard's grid, as pure data and functions
// so they are tested without a browser. The grid is `GRID.columns` wide
// and as many rows tall as it needs; each widget covers whole cells. A
// widget moved or resized snaps to whole cells and stays inside the grid;
// whatever it lands on is pushed down, and every widget then rises as far
// as it can, so no blank band is left.

/** The grid: its columns, the height of a row and the gap between cells, in pixels. */
export const GRID = { columns: 12, rowHeight: 32, gap: 16 } as const;

/** The smallest a widget may be, in cells. */
export const MIN_SIZE = { w: 3, h: 3 } as const;

/** Where one widget is: its column and row, its width and height, in cells. */
export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Every widget's cell, by its id. */
export type WidgetLayout = Readonly<Record<string, Cell>>;

const overlaps = (a: Cell, b: Cell): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const sameCell = (a: Cell | undefined, b: Cell | undefined): boolean =>
  a?.x === b?.x &&
  a?.y === b?.y &&
  a?.w === b?.w &&
  a?.h === b?.h &&
  a !== undefined;

/** The widgets top to bottom, then left to right: how they read, and stack on a phone. */
export const readingOrder = (layout: WidgetLayout): string[] =>
  Object.keys(layout).sort((a, b) => {
    const one = layout[a];
    const other = layout[b];
    if (one === undefined || other === undefined) {
      return 0;
    }
    return one.y - other.y || one.x - other.x || a.localeCompare(b);
  });

/** Pushes down, in reading order, whatever `id` overlaps, and whatever that then overlaps. */
function settle(layout: WidgetLayout, id: string): Record<string, Cell> {
  const next: Record<string, Cell> = { ...layout };
  const queue = [id];
  while (queue.length > 0) {
    const moverId = queue.shift() ?? id;
    const mover = next[moverId];
    if (mover === undefined) {
      continue;
    }
    for (const other of readingOrder(next)) {
      const cell = next[other];
      if (other === moverId || other === id || cell === undefined) {
        continue;
      }
      if (overlaps(mover, cell)) {
        next[other] = { ...cell, y: mover.y + mover.h };
        queue.push(other);
      }
    }
  }
  return next;
}

/**
 * Each widget, top to bottom, risen as far as it can go without
 * overlapping one placed before it: no blank band is left.
 */
export function compact(layout: WidgetLayout): WidgetLayout {
  const next: Record<string, Cell> = {};
  const placed: Cell[] = [];
  const clashes = (cell: Cell) => placed.some((each) => overlaps(cell, each));
  for (const id of readingOrder(layout)) {
    let cell = layout[id];
    if (cell === undefined) {
      continue;
    }
    while (cell.y > 0 && !clashes({ ...cell, y: cell.y - 1 })) {
      cell = { ...cell, y: cell.y - 1 };
    }
    while (clashes(cell)) {
      cell = { ...cell, y: cell.y + 1 };
    }
    next[id] = cell;
    placed.push(cell);
  }
  return next;
}

/**
 * The widget `id` moved to column `x` and row `y`, snapped to whole cells
 * and kept inside the grid; what it lands on is pushed down.
 */
export function moveWidget(
  layout: WidgetLayout,
  id: string,
  x: number,
  y: number,
): WidgetLayout {
  const from = layout[id];
  if (from === undefined) {
    return layout;
  }
  const to: Cell = {
    ...from,
    x: Math.min(GRID.columns - from.w, Math.max(0, Math.round(x))),
    y: Math.max(0, Math.round(y)),
  };
  if (sameCell(from, to)) {
    return layout;
  }
  // Moved down past what is below it, it goes under that rather than
  // pushing it further down: what it passes rises into its place.
  const others = Object.fromEntries(
    Object.entries(layout).filter(([other]) => other !== id),
  );
  const below = compact(others);
  const landing =
    to.y > from.y
      ? Math.max(
          to.y,
          ...Object.values(below)
            .filter(
              (cell) =>
                cell.x < to.x + to.w &&
                to.x < cell.x + cell.w &&
                cell.y < to.y &&
                cell.y + cell.h > to.y,
            )
            .map((cell) => cell.y + cell.h),
        )
      : to.y;
  return compact(settle({ ...below, [id]: { ...to, y: landing } }, id));
}

/**
 * The widget `id` made `w` columns wide and `h` rows tall from its top-left
 * corner, snapped to whole cells, no smaller than `MIN_SIZE` and inside the
 * grid; what it grows over is pushed down.
 */
export function resizeWidget(
  layout: WidgetLayout,
  id: string,
  w: number,
  h: number,
): WidgetLayout {
  const from = layout[id];
  if (from === undefined) {
    return layout;
  }
  const to: Cell = {
    ...from,
    w: Math.min(GRID.columns - from.x, Math.max(MIN_SIZE.w, Math.round(w))),
    h: Math.max(MIN_SIZE.h, Math.round(h)),
  };
  if (sameCell(from, to)) {
    return layout;
  }
  return compact(settle({ ...layout, [id]: to }, id));
}

/**
 * The widgets a drop shakes: those it moved, and those that now touch the
 * widget dropped (beside it, or just above or below it).
 */
export function neighboursOf(
  before: WidgetLayout,
  after: WidgetLayout,
  dropped: string,
): string[] {
  const at = after[dropped];
  if (at === undefined) {
    return [];
  }
  return readingOrder(after).filter((id) => {
    const cell = after[id];
    if (id === dropped || cell === undefined) {
      return false;
    }
    const sharesColumns = cell.x < at.x + at.w && at.x < cell.x + cell.w;
    const sharesRows = cell.y < at.y + at.h && at.y < cell.y + cell.h;
    const beside =
      sharesRows && (cell.x === at.x + at.w || cell.x + cell.w === at.x);
    const aboveOrBelow =
      sharesColumns && (cell.y === at.y + at.h || cell.y + cell.h === at.y);
    return beside || aboveOrBelow || !sameCell(before[id], cell);
  });
}

/** How many rows `px` pixels take, gaps included. */
export const rowsFor = (px: number): number =>
  Math.max(1, Math.ceil((px + GRID.gap) / (GRID.rowHeight + GRID.gap)));

/**
 * A layout read back from storage, for the widgets `defaults` names: each
 * stored cell that is valid, kept inside the grid; any widget it lacks, or
 * holds badly, gets its default. Then compacted, so nothing overlaps.
 */
export function parseLayout(
  text: string | null,
  defaults: WidgetLayout,
): WidgetLayout {
  let stored: unknown;
  try {
    stored = text === null ? undefined : JSON.parse(text);
  } catch {
    stored = undefined;
  }
  const record =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  const whole = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value);
  const next: Record<string, Cell> = {};
  for (const [id, fallback] of Object.entries(defaults)) {
    const cell = record[id] as Partial<Record<keyof Cell, unknown>> | undefined;
    if (
      cell !== undefined &&
      whole(cell.x) &&
      whole(cell.y) &&
      whole(cell.w) &&
      whole(cell.h)
    ) {
      const w = Math.min(GRID.columns, Math.max(MIN_SIZE.w, cell.w));
      next[id] = {
        w,
        h: Math.max(MIN_SIZE.h, cell.h),
        x: Math.min(GRID.columns - w, Math.max(0, cell.x)),
        y: Math.max(0, cell.y),
      };
    } else {
      next[id] = fallback;
    }
  }
  return compact(next);
}

/** A layout as storage keeps it. */
export const serialiseLayout = (layout: WidgetLayout): string =>
  JSON.stringify(layout);
