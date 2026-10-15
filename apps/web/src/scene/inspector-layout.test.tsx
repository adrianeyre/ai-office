import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { navigationWidths, useNavigationPrefs } from "../navigation-prefs.ts";
import type { InspectableKind, InspectableObject } from "./inspectable.ts";
import { InspectorPanel } from "./inspector.tsx";
import { panelLayoutKey } from "./panel-layout.ts";

// An inspector panel moved, resized and filling the screen, by the pointer
// and the keyboard, within the Office's view (a stand-in here, measured
// as the browser would), and each kind's layout kept in this browser.

const area = { width: 1000, height: 700 };
/** Where a panel sits before it is moved: top right, beside the controls. */
const docked = { x: 668, y: 60, width: 320, height: 240 };

const pixels = (value: string, fallback: number) =>
  value === "" ? fallback : Number.parseFloat(value);

/** The panel's box as the browser would lay it out from its style. */
function boxOf(element: HTMLElement) {
  const { style } = element;
  return {
    x: pixels(style.left, docked.x),
    y: pixels(style.top, docked.y),
    width: pixels(style.width, docked.width),
    height: pixels(style.height, docked.height),
  };
}

const rect = (x: number, y: number, width: number, height: number) =>
  ({
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  }) as DOMRect;

beforeEach(() => {
  localStorage.clear();
  useNavigationPrefs.setState({
    collapsed: false,
    width: navigationWidths.initial,
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-panel-area") ? area.width : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-panel-area") ? area.height : 0;
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.hasAttribute("data-panel-area")) {
        return rect(0, 0, area.width, area.height);
      }
      if (
        this instanceof HTMLElement &&
        this.getAttribute("role") === "dialog"
      ) {
        const box = boxOf(this);
        return rect(box.x, box.y, box.width, box.height);
      }
      return rect(0, 0, 0, 0);
    },
  );
  Element.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  area.width = 1000;
  area.height = 700;
});

const object = (kind: InspectableKind = "notice-board"): InspectableObject => ({
  kind,
  id: "office",
  label: "The Notice Board",
  location: { kind: "lobby" },
  box: { centre: [0, 0, 0], size: [1, 1, 1] },
  view: { position: [0, 0, 0], target: [0, 0, 0] },
});

function open(kind?: InspectableKind) {
  return render(
    <div data-panel-area="">
      <InspectorPanel object={object(kind)} />
    </div>,
  );
}

const dialog = () => screen.getByRole("dialog");
const box = () => boxOf(dialog());
const stored = () =>
  JSON.parse(localStorage.getItem(panelLayoutKey) ?? "null") as unknown;

function drag(element: Element, dx: number, dy: number) {
  fireEvent.pointerDown(element, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(element, {
    clientX: 100 + dx,
    clientY: 100 + dy,
    pointerId: 1,
  });
  fireEvent.pointerUp(element, {
    clientX: 100 + dx,
    clientY: 100 + dy,
    pointerId: 1,
  });
}

const handle = (edge: "right" | "bottom" | "corner") => {
  const element = dialog().querySelector(`[data-resize="${edge}"]`);
  if (element === null) {
    throw new Error(`No ${edge} handle`);
  }
  return element;
};

describe("an inspector panel's layout", () => {
  it("is moved by dragging its header, kept within the view", () => {
    open();
    expect(dialog().dataset["layout"]).toBe("docked");
    drag(screen.getByRole("heading", { name: "The Notice Board" }), -200, 40);
    expect(dialog().dataset["layout"]).toBe("placed");
    expect(box()).toMatchObject({ x: 468, y: 100 });
    expect(stored()).toEqual({ "notice-board": { x: 468, y: 100 } });

    // Never off the view, however far it is dragged.
    drag(screen.getByRole("heading", { name: "The Notice Board" }), 5000, 5000);
    expect(box()).toMatchObject({ x: 680, y: 460 });
  });

  it("does not drag from the header's buttons", () => {
    open();
    drag(screen.getByRole("button", { name: "Close panel" }), -200, 40);
    expect(dialog().dataset["layout"]).toBe("docked");
  });

  it("moves with the arrow keys on its grip, and resizes with Shift", async () => {
    open();
    screen.getByRole("button", { name: "Move panel" }).focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowDown}");
    expect(box()).toMatchObject({ x: 636, y: 76 });
    expect(within(dialog()).getByRole("status").textContent).toBe(
      "Panel moved to 636, 76 pixels.",
    );
    await userEvent.keyboard("{Shift>}{ArrowLeft}{ArrowDown}{/Shift}");
    expect(box()).toMatchObject({ x: 636, y: 76, width: 304, height: 256 });
    expect(within(dialog()).getByRole("status").textContent).toBe(
      "Panel resized to 304 by 256 pixels.",
    );
    expect(dialog().hasAttribute("data-sized")).toBe(true);
  });

  it("resizes from its right and bottom edges and its corner, within its least and most", () => {
    open();
    drag(handle("right"), 100, 100);
    expect(box()).toEqual({ x: 668, y: 60, width: 332, height: 240 });
    expect(dialog().hasAttribute("data-sized")).toBe(false);
    drag(handle("bottom"), 100, 100);
    expect(box()).toEqual({ x: 668, y: 60, width: 332, height: 340 });
    expect(dialog().hasAttribute("data-sized")).toBe(true);
    drag(handle("corner"), -500, -500);
    expect(box()).toEqual({ x: 668, y: 60, width: 280, height: 200 });
    drag(handle("corner"), 5000, 5000);
    expect(box()).toEqual({ x: 668, y: 60, width: 332, height: 640 });
  });

  it("fills the page beside the navigation menu, until the button or Escape restores it", async () => {
    open();
    drag(screen.getByRole("heading", { name: "The Notice Board" }), -200, 0);
    await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(dialog().dataset["layout"]).toBe("full");
    expect(dialog().style).toMatchObject({
      position: "fixed",
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: `${String(navigationWidths.initial)}px`,
    });
    expect(dialog().hasAttribute("data-sized")).toBe(true);
    expect(screen.queryByRole("button", { name: "Move panel" })).toBeNull();
    expect(dialog().querySelector("[data-resize]")).toBeNull();

    // The menu collapsed to its icons, or made wider, it still leaves it be.
    act(() => {
      useNavigationPrefs.setState({ collapsed: true });
    });
    expect(dialog().style.left).toBe("64px");
    act(() => {
      useNavigationPrefs.setState({ collapsed: false, width: 300 });
    });
    expect(dialog().style.left).toBe("300px");

    await userEvent.click(
      screen.getByRole("button", { name: "Restore panel" }),
    );
    expect(dialog().dataset["layout"]).toBe("placed");
    expect(box()).toMatchObject({ x: 468, y: 60 });

    await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
    dialog().focus();
    await userEvent.keyboard("{Escape}");
    expect(dialog().dataset["layout"]).toBe("placed");
    expect(stored()).toEqual({ "notice-board": { x: 468, y: 60 } });
  });

  it("opens as it was left, each kind of panel its own way", async () => {
    const first = open();
    drag(screen.getByRole("heading", { name: "The Notice Board" }), -100, 20);
    drag(handle("corner"), 80, 60);
    await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
    first.unmount();

    open();
    expect(dialog().dataset["layout"]).toBe("full");
    await userEvent.click(
      screen.getByRole("button", { name: "Restore panel" }),
    );
    expect(box()).toEqual({ x: 568, y: 80, width: 400, height: 300 });
    cleanup();

    open("whiteboard");
    expect(dialog().dataset["layout"]).toBe("docked");
  });

  it("keeps a stored layout bigger than the view within it", () => {
    localStorage.setItem(
      panelLayoutKey,
      JSON.stringify({
        "notice-board": { x: 4000, y: -90, width: 3000, height: 2000 },
      }),
    );
    area.width = 800;
    area.height = 500;
    open();
    expect(box()).toEqual({ x: 0, y: 0, width: 800, height: 500 });
  });

  it("ignores a stored layout that is not one", () => {
    localStorage.setItem(panelLayoutKey, "not json");
    open();
    expect(dialog().dataset["layout"]).toBe("docked");
  });

  it("works without storage, for as long as it is open", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    open();
    expect(dialog().dataset["layout"]).toBe("docked");
    drag(screen.getByRole("heading", { name: "The Notice Board" }), -100, 0);
    expect(box()).toMatchObject({ x: 568, y: 60 });
    await userEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(dialog().dataset["layout"]).toBe("full");
  });

  it("lies across a narrow view as before, neither moving nor resizing", () => {
    localStorage.setItem(
      panelLayoutKey,
      JSON.stringify({ "notice-board": { x: 10, y: 10, full: true } }),
    );
    area.width = 500;
    open();
    expect(dialog().dataset["layout"]).toBe("docked");
    expect(dialog().getAttribute("style")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move panel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
    expect(dialog().querySelector("[data-resize]")).toBeNull();
    expect(dialog().className).toContain("@max-[39rem]:w-full");
    expect(screen.getByRole("button", { name: "Close panel" })).toBeInstanceOf(
      HTMLButtonElement,
    );
  });
});
