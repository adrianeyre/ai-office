import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStoredLayout, WidgetGrid } from "./widget-grid.tsx";
import type { WidgetLayout } from "./widget-layout.ts";

// The widget grid, with the keyboard: a widget moves and resizes a cell at
// a time, says where it went, shakes its neighbours, and the layout is
// kept in this browser until it is reset.

const key = "test:widgets";

const defaults: WidgetLayout = {
  one: { x: 0, y: 0, w: 6, h: 4 },
  two: { x: 6, y: 0, w: 6, h: 4 },
};

function Board() {
  const { layout, setLayout, reset, changed } = useStoredLayout(key, defaults);
  return (
    <>
      <button type="button" disabled={!changed} onClick={reset}>
        Reset layout
      </button>
      <WidgetGrid
        label="Widgets"
        layout={layout}
        onLayoutChange={setLayout}
        widgets={[
          { id: "one", title: "One", content: <p>First</p> },
          { id: "two", title: "Two", content: <p>Second</p> },
        ]}
      />
    </>
  );
}

const widget = (id: string) => {
  const element = document.querySelector<HTMLElement>(`[data-widget="${id}"]`);
  if (element === null) {
    throw new Error(`No widget ${id}.`);
  }
  return element;
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the widget grid", () => {
  it("moves a widget with the arrow keys, says where, and shakes its neighbour", async () => {
    render(<Board />);
    const grip = screen.getByRole("button", { name: "Move Two" });
    expect(widget("two").style.gridColumn).toBe("7 / span 6");
    grip.focus();
    await userEvent.keyboard("{ArrowDown}");
    // Nothing is under it, so it rises back: no change, nothing said.
    expect(widget("two").style.gridRow).toBe("1 / span 4");
    await userEvent.keyboard("{ArrowLeft}");
    expect(widget("two").style.gridColumn).toBe("6 / span 6");
    // It lands on One, which is pushed under it, and shakes.
    expect(widget("one").style.gridRow).toBe("5 / span 4");
    expect(widget("one").dataset["shaking"]).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe(
      "Two moved to column 6, row 1.",
    );
  });

  it("resizes with Shift and the arrow keys, and keeps the layout until it is reset", async () => {
    const { unmount } = render(<Board />);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Reset layout" })
        .disabled,
    ).toBe(true);
    screen.getByRole("button", { name: "Move One" }).focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(widget("one").style.gridRow).toBe("1 / span 5");
    expect(screen.getByRole("status").textContent).toBe(
      "One is 6 columns wide and 5 rows tall.",
    );
    unmount();

    // Kept: the same after the page opens again.
    render(<Board />);
    expect(widget("one").style.gridRow).toBe("1 / span 5");
    await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(widget("one").style.gridRow).toBe("1 / span 4");
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("stacks the widgets in reading order on a narrow screen, with no grips", () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    try {
      render(<Board />);
      const group = screen.getByRole("group", { name: "Widgets" });
      expect(within(group).queryByRole("button", { name: /^Move/ })).toBeNull();
      expect(group.textContent).toBe("FirstSecond");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops shaking soon after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Board />);
    screen.getByRole("button", { name: "Move Two" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(widget("one").dataset["shaking"]).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(widget("one").dataset["shaking"]).toBeUndefined();
  });

  it("grows a widget that fits its content until all of it shows, pushing those below down, and never shrinks it", () => {
    const fitting: WidgetLayout = {
      tall: { x: 0, y: 0, w: 6, h: 3 },
      below: { x: 0, y: 3, w: 6, h: 4 },
    };
    function Fitting({ height }: { height: number }) {
      const { layout, setLayout } = useStoredLayout(key, fitting);
      return (
        <WidgetGrid
          label="Widgets"
          layout={layout}
          onLayoutChange={setLayout}
          widgets={[
            {
              id: "tall",
              title: "Tall",
              fitContent: true,
              content: <p data-height={height}>Every total</p>,
            },
            { id: "below", title: "Below", content: <p>Below</p> },
          ]}
        />
      );
    }
    let observed: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed = callback;
        }
        observe() {
          return undefined;
        }
        disconnect() {
          return undefined;
        }
      },
    );
    // The content's own height, as the browser would lay it out.
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const height = Number(
          this.querySelector("[data-height]")?.getAttribute("data-height") ?? 0,
        );
        return { height } as DOMRect;
      });
    try {
      const { rerender } = render(<Fitting height={400} />);
      // 400px is nine rows of 32px with their 16px gaps.
      expect(widget("tall").style.gridRow).toBe("1 / span 9");
      expect(widget("below").style.gridRow).toBe("10 / span 4");

      rerender(<Fitting height={40} />);
      act(() => {
        observed?.();
      });
      expect(widget("tall").style.gridRow).toBe("1 / span 9");
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
