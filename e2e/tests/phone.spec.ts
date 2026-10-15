import { devices, type Page } from "@playwright/test";

import { testAction } from "../support/control.ts";
import { expect, signIn, test, type Office } from "../support/office.ts";

// The Office on phones and tablets (PRD §7, Responsiveness) in a real
// browser, against the built app, Postgres and a fake GitHub. A phone
// gets the Office in 2D, with no canvas, and every section of it is in
// reach; a tablet gets the 3D Office.

// Each device's screen and touch, in this project's Chromium.
const deviceScreen = (name: string) => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } =
    devices[name] ?? fail(name);
  return { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent };
};

const phone = deviceScreen("Pixel 7");
const phoneScreen = phone.viewport;

/** Signs in, adds web-shop as a Floor in Floor Settings and raises an action Notice. */
async function officeWithAFloor(office: Office, page: Page) {
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Office" }),
  ).toBeVisible();
  await page.goto("/floor-settings");
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await expect(page.getByText("Already a Floor")).toBeVisible();
  await office.raiseNotice({
    kind: "action",
    title: "PR #14 awaiting your approval",
    floorId: "web-shop",
    actions: [testAction],
  });
}

/** Whether the page is wider than the screen, so it would scroll sideways. */
const overflows = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );

test.describe("on a phone", () => {
  test.use(phone);

  test("the Office is in 2D, with no canvas, and every section is in reach", async ({
    office,
    page,
  }) => {
    await officeWithAFloor(office, page);
    await page.goto("/");
    const view = page.getByTestId("office-2d");
    await expect(view).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(await overflows(page)).toBe(false);

    const sections = page.getByRole("navigation", { name: "Office sections" });
    for (const [name, id] of [
      ["Notice Board", "office-notices"],
      ["Activity", "office-activity"],
      ["Floors", "office-floors"],
      ["Settings", "office-admin"],
    ] as const) {
      await sections.getByRole("link", { name }).tap();
      await expect(
        page.getByRole("heading", { level: 2, name }),
      ).toBeInViewport();
      await expect(page.locator(`#${id}`)).toBeFocused();
    }

    // The Notice Board, with the Notice's action.
    const notices = page.locator("#office-notices");
    const notice = notices.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "PR #14 awaiting your approval" }),
    });
    await expect(notice).toBeVisible();
    await expect(
      notice.getByRole("button", { name: testAction.label }),
    ).toBeVisible();

    // The latest activity.
    await expect(
      page
        .locator("#office-activity")
        .getByText(
          'Floor "web-shop" added for adrianeyre/web-shop, from the Development Floor Template.',
        ),
    ).toBeVisible();

    // The Floor, with its four Agents, its health and nothing in progress.
    const floor = page.locator("#office-floor-web-shop");
    await expect(
      floor.getByRole("heading", { level: 3, name: "web-shop" }),
    ).toBeVisible();
    await expect(floor.getByText("Needs you")).toBeVisible();
    const agents = floor.getByRole("list", { name: "web-shop's Agents" });
    await expect(agents.getByTestId("agent-state")).toHaveCount(4);
    await expect(agents.getByTestId("agent-state").first()).toHaveText("Idle");
    await expect(floor.getByText("No issue is in progress.")).toBeVisible();

    // Every button a finger taps is a fingertip's size.
    for (const button of await view.locator("[data-slot=button]").all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // An Agent's live view, and back.
    const first = agents.getByRole("listitem").first();
    const name = await first.getByRole("heading", { level: 4 }).textContent();
    await first.getByRole("link", { name: `${name ?? ""}'s live view` }).tap();
    await expect(page).toHaveURL(/\/floors\/web-shop\/agents\/[^/]+$/);
    await page.goBack();
    await expect(view).toBeVisible();

    // General Settings, from the Settings section, fits the screen too.
    await page
      .locator("#office-admin")
      .getByRole("link", { name: "General Settings" })
      .tap();
    await expect(
      page.getByRole("heading", { level: 1, name: "General Settings" }),
    ).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("an Agent's name brings its entry into view, and the phone on its side stays 2D", async ({
    office,
    page,
  }) => {
    await officeWithAFloor(office, page);
    await page.goto("/");
    const agents = page.getByRole("list", { name: "web-shop's Agents" });
    const last = agents.getByRole("listitem").last();
    await expect(last).toBeVisible();
    const id = await last.getAttribute("id");
    const agentId = (id ?? "").replace("office-agent-web-shop-", "");

    await page.goto(`/?floor=web-shop&inspect=agent:${agentId}`);
    const entry = page.locator(`[id="${id ?? ""}"]`);
    await expect(entry).toBeFocused();
    await expect(entry).toBeInViewport();
    await expect(entry).toHaveAttribute("aria-current", "true");

    await page.setViewportSize({
      width: phoneScreen.height,
      height: phoneScreen.width,
    });
    await expect(page.getByTestId("office-2d")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("the Notice Board, the Activity Feed and the settings pages fit the screen", async ({
    office,
    page,
  }) => {
    await officeWithAFloor(office, page);
    for (const [path, heading] of [
      ["/notices", "Notice Board"],
      ["/activity", "Activity"],
      ["/ai-settings", "AI Settings"],
      ["/floor-settings", "Floor Settings"],
      ["/general-settings", "General Settings"],
      ["/floor-settings/web-shop", "web-shop"],
      ["/gateway", "Gateway requests"],
      ["/analytics", "Analytics"],
      ["/branches?floor=web-shop", "Branches"],
    ] as const) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      expect(await overflows(page), path).toBe(false);
    }
  });
});

test.describe("on a tablet", () => {
  // At one pixel to a CSS pixel: the layout is the same, and where there is
  // no GPU, the 3D Office renders in software four times as fast.
  const tablet = { ...deviceScreen("iPad Mini"), deviceScaleFactor: 1 };
  test.use(tablet);

  test("the Office is the 3D one, with every panel inside its view, upright or on its side", async ({
    office,
    page,
  }) => {
    // Where there is no GPU, the 3D Office renders in software, slowly.
    test.slow();
    await officeWithAFloor(office, page);
    await page.goto("/");
    await expect(
      page
        .getByRole("group", { name: "Camera view" })
        .or(page.getByText("This browser cannot show the 3D Office")),
    ).toBeVisible();
    await expect(page.getByTestId("office-2d")).toHaveCount(0);
    test.skip(
      (await page.locator("canvas").count()) === 0,
      "This browser has no WebGL 2, so the 3D Office and its panels are not shown.",
    );

    await page.getByRole("button", { name: "Inspect" }).tap();
    await page.getByRole("button", { name: "The Notice Board" }).tap();
    const panel = page.getByRole("dialog", { name: "The Notice Board" });
    for (const screen of [
      tablet.viewport,
      { width: tablet.viewport.height, height: tablet.viewport.width },
    ]) {
      await page.setViewportSize(screen);
      await expect(panel).toBeVisible();
      const view = await page.locator("canvas").boundingBox();
      // The canvas fills the whole view, not a canvas's default 150 px.
      const area = await page.locator("[data-panel-area]").boundingBox();
      expect(view?.height ?? 0).toBeGreaterThanOrEqual((area?.height ?? 0) - 1);
      const box = await panel.boundingBox();
      expect(box, `${String(screen.width)} wide`).not.toBeNull();
      expect(view).not.toBeNull();
      if (box !== null && view !== null) {
        expect(box.x).toBeGreaterThanOrEqual(view.x);
        expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width);
        expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height);
      }
      await expect(
        page.getByRole("button", { name: "Scene settings" }),
      ).toBeInViewport();
      await expect(
        panel.getByRole("button", { name: "Close panel" }),
      ).toBeInViewport();
    }
    await panel.getByRole("button", { name: "Close panel" }).tap();
    await expect(panel).toHaveCount(0);
  });
});

function fail(device: string): never {
  throw new Error(`Playwright has no device "${device}".`);
}
