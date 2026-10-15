import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { Tabs } from "./tabs.tsx";

afterEach(cleanup);

const tabs = [
  { id: "ada", label: "Ada", content: <p>Ada&apos;s panel</p> },
  { id: "rex", label: "Rex", content: <p>Rex&apos;s panel</p> },
  { id: "eve", label: "Eve", content: <p>Eve&apos;s panel</p> },
];

describe("Tabs", () => {
  it("shows only the chosen tab's panel, starting on `initial`", async () => {
    render(<Tabs label="Agents" tabs={tabs} initial="rex" />);
    expect(screen.getByRole("tabpanel").textContent).toBe("Rex's panel");
    await userEvent.click(screen.getByRole("tab", { name: "Eve" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("Eve's panel");
    expect(
      screen.getByRole("tab", { name: "Eve" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      screen.getByRole("tab", { name: "Eve" }).id,
    );
  });

  it("moves between tabs with the arrow keys, Home and End", async () => {
    render(<Tabs label="Agents" tabs={tabs} />);
    await userEvent.click(screen.getByRole("tab", { name: "Ada" }));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("Eve");
    await userEvent.keyboard("{Home}{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("Rex");
    expect(screen.getByRole("tabpanel").textContent).toBe("Rex's panel");
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tabpanel").textContent).toBe("Eve's panel");
    // Only the chosen tab is in the Tab order.
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([
      -1, -1, 0,
    ]);
  });

  it("falls back to the first tab when the chosen one goes", () => {
    const { rerender } = render(
      <Tabs label="Agents" tabs={tabs} initial="eve" />,
    );
    rerender(<Tabs label="Agents" tabs={tabs.slice(0, 2)} initial="eve" />);
    expect(screen.getByRole("tabpanel").textContent).toBe("Ada's panel");
  });
});
