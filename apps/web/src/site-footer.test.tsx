import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { repositoryUrl } from "./legal/links.ts";
import { SiteFooter } from "./site-footer.tsx";

afterEach(cleanup);

describe("the footer", () => {
  it("credits the design, shows the version and lists the policies", () => {
    render(<SiteFooter />);
    const nav = within(screen.getByRole("contentinfo")).getByRole(
      "navigation",
      { name: "About AI Office" },
    );
    const credit = within(nav).getByRole("link", {
      name: "Website design, source on GitHub, opens in a new tab",
    });
    expect(credit.getAttribute("href")).toBe(repositoryUrl);
    expect(credit.getAttribute("target")).toBe("_blank");
    expect(credit.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(nav).getByText(`Version: ${__APP_VERSION__}`)).toBeTruthy();
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      `Version: ${__APP_VERSION__}, changelog`,
      "Privacy Policy",
      "Terms and Conditions",
      "Cookie Policy",
      "Accessibility",
    ]);
  });

  it.each([
    ["Privacy Policy", "Close privacy policy"],
    ["Terms and Conditions", "Close terms and conditions"],
    ["Cookie Policy", "Close cookie policy"],
    ["Accessibility", "Close accessibility statement"],
  ])(
    "opens the %s in a dialog, which the cross closes",
    async (label, closeLabel) => {
      const user = userEvent.setup();
      render(<SiteFooter />);
      const opener = screen.getByRole("button", { name: label });
      await user.click(opener);

      const dialog = screen.getByRole("dialog", { name: label });
      expect(
        within(dialog).getByRole("heading", { level: 2, name: label }),
      ).toBeTruthy();
      const close = within(dialog).getByRole("button", { name: closeLabel });
      expect(document.activeElement).toBe(close);

      await user.click(close);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(opener);
    },
  );

  it("opens the changelog from the version, rendered from its Markdown", async () => {
    const user = userEvent.setup();
    render(<SiteFooter />);
    const opener = screen.getByRole("button", {
      name: `Version: ${__APP_VERSION__}, changelog`,
    });
    expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Changelog" });
    expect(
      within(dialog).getByRole("heading", { level: 2, name: "Changelog" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Close changelog" }),
    );
    // The current release's heading, from the root CHANGELOG.md, under the
    // dialog's title.
    const releases = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    // Dated or not, as semantic-release or the Owner writes it; how its
    // sections and links render is legal.test.tsx's, with a sample.
    expect(releases[0]).toMatch(
      new RegExp(`^${__APP_VERSION__}( \\(\\d{4}-\\d{2}-\\d{2}\\))?$`),
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes a dialog with Escape and with its footer's Close", async () => {
    const user = userEvent.setup();
    render(<SiteFooter />);
    await user.click(screen.getByRole("button", { name: "Cookie Policy" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cookie Policy" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Close",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives the dialog a body that scrolls both ways and takes focus", async () => {
    const user = userEvent.setup();
    render(<SiteFooter />);
    await user.click(screen.getByRole("button", { name: "Cookie Policy" }));
    const body = screen.getByRole("region", { name: "Cookie Policy" });
    expect(body.getAttribute("tabindex")).toBe("0");
    expect(body.className).toContain("overflow-auto");
    expect(
      within(body).getByRole("table", {
        name: "Cookies and browser storage AI Office uses",
      }),
    ).toBeTruthy();
  });
});
