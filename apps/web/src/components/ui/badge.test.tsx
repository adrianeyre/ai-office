import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Badge } from "./badge.tsx";

afterEach(cleanup);

describe("Badge", () => {
  it("says its label, in the neutral tone by default", () => {
    render(<Badge>Info</Badge>);
    const badge = screen.getByText("Info");
    expect(badge.tagName).toBe("SPAN");
    expect(badge.className).toContain("bg-tone-neutral");
  });

  it.each([
    ["success", "bg-tone-success"],
    ["warning", "bg-tone-warning"],
    ["danger", "bg-tone-danger"],
    ["primary", "bg-primary"],
  ] as const)("takes the %s tone's tokens", (tone, fill) => {
    render(<Badge tone={tone}>Label</Badge>);
    expect(screen.getByText("Label").className).toContain(fill);
  });

  it("passes on its attributes", () => {
    render(<Badge title="One-off Role">Contractor</Badge>);
    expect(screen.getByTitle("One-off Role").textContent).toBe("Contractor");
  });
});
