import { describe, expect, it } from "vitest";

import {
  compact,
  GRID,
  MIN_SIZE,
  moveWidget,
  neighboursOf,
  parseLayout,
  readingOrder,
  resizeWidget,
  rowsFor,
  serialiseLayout,
  type WidgetLayout,
} from "./widget-layout.ts";

// Two side by side across the top, one under the first.
const layout: WidgetLayout = {
  a: { x: 0, y: 0, w: 6, h: 4 },
  b: { x: 6, y: 0, w: 6, h: 4 },
  c: { x: 0, y: 4, w: 6, h: 4 },
};

describe("a widget layout", () => {
  it("reads top to bottom, then left to right", () => {
    expect(readingOrder(layout)).toEqual(["a", "b", "c"]);
  });

  it("rises into any blank band", () => {
    expect(compact({ a: { x: 0, y: 5, w: 6, h: 4 } })).toEqual({
      a: { x: 0, y: 0, w: 6, h: 4 },
    });
  });

  it("snaps a move to whole cells, inside the grid", () => {
    const moved = moveWidget(layout, "b", 10.4, 0);
    expect(moved["b"]).toEqual({ x: 6, y: 0, w: 6, h: 4 });
    expect(moveWidget(layout, "b", -3, 0)["b"]?.x).toBe(0);
  });

  it("pushes down what a moved widget lands on", () => {
    const moved = moveWidget(layout, "c", 6, 0);
    expect(moved["c"]).toEqual({ x: 6, y: 0, w: 6, h: 4 });
    expect(moved["b"]).toEqual({ x: 6, y: 4, w: 6, h: 4 });
  });

  it("goes under what it is moved down past", () => {
    const moved = moveWidget(layout, "a", 0, 5);
    expect(moved["c"]).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(moved["a"]).toEqual({ x: 0, y: 4, w: 6, h: 4 });
  });

  it("resizes no smaller than the least, and no wider than the grid", () => {
    expect(resizeWidget(layout, "a", 1, 1)["a"]).toEqual({
      x: 0,
      y: 0,
      w: MIN_SIZE.w,
      h: MIN_SIZE.h,
    });
    const wide = resizeWidget(layout, "a", GRID.columns + 4, 4);
    expect(wide["a"]?.w).toBe(GRID.columns);
    // What it grew over is pushed down.
    expect(wide["b"]?.y).toBe(4);
  });

  it("shakes the widgets a drop touches or moves, not the far ones", () => {
    const wide: WidgetLayout = {
      ...layout,
      d: { x: 0, y: 8, w: 12, h: 3 },
    };
    const after = moveWidget(wide, "c", 6, 0);
    expect(neighboursOf(wide, after, "c").sort()).toEqual(["a", "b"]);
  });

  it("counts the rows some pixels take, gaps included", () => {
    expect(rowsFor(GRID.rowHeight)).toBe(1);
    expect(rowsFor(GRID.rowHeight * 2 + GRID.gap)).toBe(2);
  });

  it("reads back what it stored, and the defaults for what it lacks or holds badly", () => {
    const stored = moveWidget(layout, "c", 6, 0);
    expect(parseLayout(serialiseLayout(stored), layout)).toEqual(stored);
    expect(parseLayout("not json", layout)).toEqual(layout);
    expect(parseLayout(null, layout)).toEqual(layout);
    expect(
      parseLayout(
        JSON.stringify({ a: { x: 99, y: 0, w: 1, h: 4 }, b: { x: "1" } }),
        layout,
      ),
    ).toEqual({
      // Kept inside the grid, then pushed under the default it overlaps.
      a: { x: GRID.columns - MIN_SIZE.w, y: 4, w: MIN_SIZE.w, h: 4 },
      b: { x: 6, y: 0, w: 6, h: 4 },
      // Nothing is left above it, so it rises.
      c: { x: 0, y: 0, w: 6, h: 4 },
    });
  });
});
