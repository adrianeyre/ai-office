import { defaultRetentionSettings } from "@ai-office/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { appearanceStorageKey } from "../appearance.ts";
import { useNoticeAlertSettings } from "../notice-alerts.ts";
import { panelLayoutKey } from "../scene/panel-layout.ts";
import { useSceneSettings } from "../scene/scene-settings.ts";
import { useSoundSettings } from "../scene/sound-settings.ts";
import { AccessibilityStatement } from "./accessibility-statement.tsx";
import { Changelog } from "./changelog.tsx";
import { CookiePolicy } from "./cookie-policy.tsx";
import { PrivacyPolicy } from "./privacy-policy.tsx";
import { TermsAndConditions } from "./terms-and-conditions.tsx";

afterEach(cleanup);

describe("the cookie policy", () => {
  it("says the session cookie stops working after 24 hours unused (A1-8)", () => {
    render(<CookiePolicy />);
    const row = screen.getByRole("rowheader", {
      name: "ai_office_session",
    }).parentElement;
    expect(row?.textContent).toContain(
      "7 days from signing in, or 24 hours unused, or until you sign out",
    );
  });

  it("lists every cookie and every setting kept in the browser", () => {
    render(<CookiePolicy />);
    const table = screen.getByRole("table", {
      name: "Cookies and browser storage AI Office uses",
    });
    const names = within(table)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent);
    expect(names.sort()).toEqual(
      [
        // The server's session and two-step sign-in cookies.
        "ai_office_session",
        "ai_office_sign_in",
        appearanceStorageKey,
        useSceneSettings.persist.getOptions().name,
        useSoundSettings.persist.getOptions().name,
        useNoticeAlertSettings.persist.getOptions().name,
        // navigation-prefs.ts and the Analytics page's widget grid.
        "ai-office:navigation-order",
        "ai-office:navigation-collapsed",
        "ai-office:navigation-width",
        "ai-office:analytics-layout",
        // The 3D Office's inspector panels (scene/panel-layout.ts).
        panelLayoutKey,
      ].sort(),
    );
  });
});

describe("the privacy policy", () => {
  it("gives retention's default periods", () => {
    const { container } = render(<PrivacyPolicy />);
    const text = container.textContent;
    const {
      requestBodiesDays,
      requestMetadataDays,
      activityDays,
      connectionDeliveriesDays,
    } = defaultRetentionSettings;
    expect(text).toContain(
      `request and response bodies are deleted after ${String(requestBodiesDays)} days`,
    );
    expect(requestMetadataDays).toBe(connectionDeliveriesDays);
    expect(text).toContain(
      `delivery logs after ${String(requestMetadataDays)} days`,
    );
    expect(text).toContain(
      `sign-in attempts after ${String(activityDays)} days`,
    );
  });
});

describe("the policies", () => {
  it.each([
    ["privacy policy", PrivacyPolicy],
    ["terms and conditions", TermsAndConditions],
    ["cookie policy", CookiePolicy],
    ["accessibility statement", AccessibilityStatement],
  ])("the %s reads as written, not as amended", (_, Policy) => {
    const { container } = render(<Policy />);
    expect(container.textContent).not.toMatch(
      /amended|changes since|previous version|changelog/i,
    );
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(
      0,
    );
  });
});

describe("the changelog", () => {
  it("renders its Markdown as headings, lists and links, never as HTML", () => {
    render(
      <Changelog
        text={[
          "## 1.2.0 (2026-10-11)",
          "",
          "### Features",
          "",
          "* **web:** a thing <script>alert(1)</script> ([abc1234](https://github.com/adrianeyre/ai-office/commit/abc1234))",
        ].join("\n")}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "1.2.0 (2026-10-11)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 4, name: "Features" }),
    ).toBeTruthy();
    const item = screen.getByRole("listitem");
    expect(item.querySelector("strong")?.textContent).toBe("web:");
    expect(item.querySelector("script")).toBeNull();
    const link = within(item).getByRole("link", { name: "abc1234" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/adrianeyre/ai-office/commit/abc1234",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("is the root CHANGELOG.md, starting at the current version", () => {
    render(<Changelog />);
    expect(
      screen.getAllByRole("heading", { level: 3 })[0]?.textContent,
    ).toMatch(new RegExp(`^${__APP_VERSION__}( \\(|$)`));
  });
});
