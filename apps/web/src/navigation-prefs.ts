import { create } from "zustand";

// How the Owner likes the main navigation, kept in this browser only: the
// order of its items, dragged into place, whether it is collapsed to its
// icons, how wide it is, dragged by its right edge, and how tall its menu
// of pages is, dragged by the line above Sign out. Storage can be missing or refuse (a private window, blocked
// site data), so every read and write is guarded and the navigation works
// without it: in its default order, expanded.

const orderKey = "ai-office:navigation-order";
const collapsedKey = "ai-office:navigation-collapsed";
const widthKey = "ai-office:navigation-width";
const menuHeightKey = "ai-office:navigation-menu-height";

/** The navigation's width in pixels: its first, and the least and most. */
export const navigationWidths = { initial: 220, min: 160, max: 400 } as const;

/** The menu of pages' height in pixels, when set: its least and most. */
export const menuHeights = { min: 96, max: 1600 } as const;

/** `height` within the menu's least and most, whole. */
export const clampMenuHeight = (height: number): number =>
  Math.round(Math.min(menuHeights.max, Math.max(menuHeights.min, height)));

/** The saved menu height; none, for its own height, when none is saved. */
const savedMenuHeight = (): number | undefined => {
  const text = read(menuHeightKey);
  const height = Number(text);
  return text === null || !Number.isFinite(height)
    ? undefined
    : clampMenuHeight(height);
};

/** The navigation's width collapsed to its icons, in pixels (`md:w-16`). */
export const collapsedNavigationWidth = 64;

/** Where the navigation sits beside the page rather than over it (`md`). */
export const wideNavigationQuery = "(min-width: 48rem)";

/**
 * How much of a wide screen's left the navigation takes, in pixels: its
 * width, or its icons' when collapsed. Nothing on a narrow screen, where
 * it is above the page.
 */
export const navigationInset = (
  prefs: Pick<NavigationPrefs, "collapsed" | "width">,
  wide: boolean,
): number =>
  !wide ? 0 : prefs.collapsed ? collapsedNavigationWidth : prefs.width;

/** `width` within the navigation's least and most, whole. */
export const clampWidth = (width: number): number =>
  Math.round(
    Math.min(navigationWidths.max, Math.max(navigationWidths.min, width)),
  );

/** The saved width; the first width when none is saved. */
const savedWidth = (): number => {
  const width = Number(read(widthKey));
  return read(widthKey) === null || !Number.isFinite(width)
    ? navigationWidths.initial
    : clampWidth(width);
};

const read = (key: string): string | null => {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // Not kept: it holds for this visit only.
  }
};

const remove = (key: string): void => {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // Nothing kept to remove.
  }
};

/** The saved order, as item addresses; empty when none is saved. */
const savedOrder = (): string[] => {
  const text = read(orderKey);
  if (text === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

/**
 * `items` in the saved `order`: those it names first, in its order, then
 * any it does not (new ones), in their own order.
 */
export function inOrder<T extends { readonly to: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((to, index) => [to, index]));
  const known = items
    .filter(({ to }) => rank.has(to))
    .sort((a, b) => (rank.get(a.to) ?? 0) - (rank.get(b.to) ?? 0));
  return [...known, ...items.filter(({ to }) => !rank.has(to))];
}

/** `order` with `item` moved to where `target` is. */
export function moved(
  order: readonly string[],
  item: string,
  target: string,
): string[] {
  const from = order.indexOf(item);
  const to = order.indexOf(target);
  if (from === -1 || to === -1 || from === to) {
    return [...order];
  }
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export interface NavigationPrefs {
  /** The items' addresses in the Owner's order; empty for the default. */
  readonly order: readonly string[];
  /** Whether wide screens show only the items' icons. */
  readonly collapsed: boolean;
  /** How wide it is on wide screens, expanded, in pixels. */
  readonly width: number;
  /** Sets the width while dragging; `save` keeps it once the drag ends. */
  readonly setWidth: (width: number, save?: boolean) => void;
  readonly resetWidth: () => void;
  /**
   * How tall the menu of pages is on wide screens, in pixels, scrolling
   * within it; none for its own height.
   */
  readonly menuHeight: number | undefined;
  /** Sets the menu's height while dragging; `save` keeps it once it ends. */
  readonly setMenuHeight: (height: number, save?: boolean) => void;
  readonly resetMenuHeight: () => void;
  readonly setOrder: (order: readonly string[]) => void;
  readonly resetOrder: () => void;
  readonly toggleCollapsed: () => void;
}

export const useNavigationPrefs = create<NavigationPrefs>()((set, get) => ({
  order: savedOrder(),
  collapsed: read(collapsedKey) === "true",
  width: savedWidth(),
  setWidth: (width, save = true) => {
    const clamped = clampWidth(width);
    if (save) {
      write(widthKey, String(clamped));
    }
    set({ width: clamped });
  },
  resetWidth: () => {
    remove(widthKey);
    set({ width: navigationWidths.initial });
  },
  menuHeight: savedMenuHeight(),
  setMenuHeight: (height, save = true) => {
    const clamped = clampMenuHeight(height);
    if (save) {
      write(menuHeightKey, String(clamped));
    }
    set({ menuHeight: clamped });
  },
  resetMenuHeight: () => {
    remove(menuHeightKey);
    set({ menuHeight: undefined });
  },
  setOrder: (order) => {
    write(orderKey, JSON.stringify(order));
    set({ order: [...order] });
  },
  resetOrder: () => {
    remove(orderKey);
    set({ order: [] });
  },
  toggleCollapsed: () => {
    const collapsed = !get().collapsed;
    write(collapsedKey, String(collapsed));
    set({ collapsed });
  },
}));

/** Reads the saved preferences again; for tests. */
export function reloadNavigationPrefs(): void {
  useNavigationPrefs.setState({
    order: savedOrder(),
    collapsed: read(collapsedKey) === "true",
    width: savedWidth(),
    menuHeight: savedMenuHeight(),
  });
}
