// Where the Owner has put each kind of inspector panel over the 3D Office,
// kept in this browser only: where it was moved to, how big it was made,
// and whether it fills the screen. Each kind (an Agent's card and chat, a
// monitor, a Grilling Session…) has its own, as their contents differ: a
// chat wants to be tall, the Notice Board's link small. They are kept
// together under one key. Storage can be missing or refuse (a private
// window, blocked site data), so every read and write is guarded, and the
// panels work without it, where they always open.

export const panelLayoutKey = "ai-office:inspector-panels";

/**
 * One kind of panel's layout. With no `x` and `y` it sits where it always
 * did, beside the controls; with no `width` or `height` it takes its own.
 * Positions are in pixels from the Office view's top left corner.
 */
export interface PanelLayout {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** Whether it fills the page beside the navigation menu. */
  readonly full?: boolean | undefined;
}

/** The space a panel is kept within: the Office view, in pixels. */
export interface PanelArea {
  readonly width: number;
  readonly height: number;
}

/** A panel's least and most size, in pixels; the view's size bounds it too. */
export const panelSizes = {
  minWidth: 280,
  minHeight: 200,
  maxWidth: 1400,
  maxHeight: 1200,
} as const;

const between = (value: number, least: number, most: number): number =>
  Math.round(Math.min(Math.max(value, least), Math.max(least, most)));

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * `layout` kept within `area`: no bigger than it (nor its least and most
 * size), and wholly inside it. `own` is the panel's size where it takes
 * its own width or height, to keep its far edges in the view too.
 */
export function clampLayout(
  layout: PanelLayout,
  area: PanelArea,
  own: PanelArea = { width: panelSizes.minWidth, height: panelSizes.minHeight },
): PanelLayout {
  const width =
    layout.width === undefined
      ? undefined
      : between(
          layout.width,
          Math.min(panelSizes.minWidth, area.width),
          Math.min(panelSizes.maxWidth, area.width),
        );
  const tall =
    layout.height === undefined
      ? undefined
      : between(
          layout.height,
          Math.min(panelSizes.minHeight, area.height),
          Math.min(panelSizes.maxHeight, area.height),
        );
  const full = layout.full === true ? { full: true } : {};
  if (layout.x === undefined || layout.y === undefined) {
    return { width, height: tall, ...full };
  }
  return {
    x: between(layout.x, 0, area.width - (width ?? own.width)),
    y: between(layout.y, 0, area.height - (tall ?? own.height)),
    width,
    height: tall,
    ...full,
  };
}

/** A stored layout, its unknown and broken parts dropped. */
export function parseLayout(value: unknown): PanelLayout {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const { x, y, width, height, full } = value as Record<string, unknown>;
  const at =
    finite(x) !== undefined && finite(y) !== undefined
      ? { x: finite(x), y: finite(y) }
      : {};
  return {
    ...at,
    width: finite(width),
    height: finite(height),
    ...(full === true ? { full: true } : {}),
  };
}

const readAll = (): Record<string, unknown> => {
  try {
    const text = globalThis.localStorage.getItem(panelLayoutKey);
    const parsed: unknown = text === null ? null : JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** The saved layout of `kind`'s panel; an empty one when none is saved. */
export function readLayout(kind: string): PanelLayout {
  return parseLayout(readAll()[kind]);
}

/** Keeps `layout` as `kind`'s panel's, beside the other kinds'. */
export function saveLayout(kind: string, layout: PanelLayout): void {
  try {
    globalThis.localStorage.setItem(
      panelLayoutKey,
      JSON.stringify({ ...readAll(), [kind]: layout }),
    );
  } catch {
    // Not kept: it holds while the panel is open.
  }
}
