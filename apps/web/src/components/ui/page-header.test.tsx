import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "./button.tsx";
import { PageHeader } from "./page-header.tsx";

afterEach(cleanup);

describe("PageHeader", () => {
  it("has its title as the level-1 heading", () => {
    render(<PageHeader title="Analytics" description="Every request." />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Analytics" }),
    ).toBeTruthy();
    expect(screen.getByText("Every request.").tagName).toBe("P");
  });

  it("puts the way back above the title, and anything more under the description", () => {
    render(
      <PageHeader
        title="Connections"
        eyebrow={<a href="/general-settings">Admin</a>}
        description="How AI Office reaches you."
      >
        <p role="status">Live.</p>
      </PageHeader>,
    );
    const back = screen.getByRole("link", { name: "Admin" });
    const heading = screen.getByRole("heading", { level: 1 });
    const status = screen.getByRole("status");
    expect(
      back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      heading.compareDocumentPosition(status) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("holds the page's actions in the header", () => {
    const { container } = render(
      <PageHeader title="Roles" actions={<Button>Make a Role</Button>} />,
    );
    const header = container.querySelector("header");
    if (header === null) {
      throw new Error("No header");
    }
    expect(
      within(header).getByRole("button", { name: "Make a Role" }),
    ).toBeTruthy();
  });

  it("leaves out what it is not given", () => {
    const { container } = render(<PageHeader title="Activity" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });
});
