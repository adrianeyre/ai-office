import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CreditsCard } from "./credits-card.tsx";

describe("CreditsCard", () => {
  it("credits the creator, Matt Pocock's Skills and the other work AI Office uses", () => {
    render(<CreditsCard />);
    const list = within(screen.getByRole("list", { name: "Credits" }));
    expect(list.getByRole("link", { name: "Adrian Eyre" })).toBeDefined();
    expect(
      list.getByRole("link", { name: "Matt Pocock" }).getAttribute("href"),
    ).toBe("https://github.com/mattpocock/skills");
    expect(list.getByText(/built-in Skills/)).toBeDefined();
    expect(list.getByRole("link", { name: "Kenney" })).toBeDefined();
  });
});
