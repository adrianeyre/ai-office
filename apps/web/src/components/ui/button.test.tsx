import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { selectClass } from "@/lib/utils.ts";

import { Button } from "./button.tsx";
import { Input } from "./input.tsx";

afterEach(cleanup);

const variants = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
] as const;
const sizes = ["default", "sm", "icon"] as const;

/** The height classes an element has: `h-*` and `size-*`, by pointer too. */
function heights(element: HTMLElement): string[] {
  return [...element.classList]
    .filter((name) => /^(pointer-coarse:)?(min-)?(h|size)-/.test(name))
    .sort();
}

describe("every Button", () => {
  it.each(
    variants.flatMap((variant) =>
      sizes.map((size): [(typeof variants)[number], (typeof sizes)[number]] => [
        variant,
        size,
      ]),
    ),
  )("is 36 px high, and 44 px by touch: %s, %s", (variant, size) => {
    render(
      <Button variant={variant} size={size}>
        Go
      </Button>,
    );
    const classes = heights(screen.getByRole("button", { name: "Go" }));
    expect(classes).toContain(size === "icon" ? "size-9" : "h-9");
    expect(classes).toContain("pointer-coarse:min-h-11");
    // Nothing else sets its height.
    expect(
      classes.filter((name) => !name.startsWith("pointer-coarse:")),
    ).toHaveLength(1);
  });

  it("is as high as an Input and a select, so a row of them lines up", () => {
    render(
      <>
        <Input aria-label="Name" />
        <select aria-label="Floor" className={selectClass} />
        <Button>Save</Button>
      </>,
    );
    const button = heights(screen.getByRole("button", { name: "Save" }));
    expect(heights(screen.getByRole("textbox", { name: "Name" }))).toEqual(
      button,
    );
    expect(heights(screen.getByRole("combobox", { name: "Floor" }))).toEqual(
      button,
    );
  });
});

describe("a pending Button", () => {
  it("shows the spinner in place of its icon, is busy and cannot be pressed", () => {
    render(
      <Button pending>
        <svg data-testid="icon" />
        Saving…
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Saving…",
    });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(button.className).toContain(
      "[&>svg:not([data-slot=spinner])]:hidden",
    );
  });

  it("is an ordinary Button once it is done", () => {
    render(<Button pending={false}>Save</Button>);
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Save",
    });
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });
});
