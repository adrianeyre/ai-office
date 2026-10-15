import type { Page } from "@playwright/test";

import { expect, ownerPassword, signIn, test } from "../support/office.ts";

// Setup, login, logout and sign out everywhere (PRD FR-1, FR-2), in a real
// browser against the built app and Postgres.

const officeHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Office" });

test.describe("the first run", () => {
  test("sends every page to the setup screen, which sets the password once, then signs in with it", async ({
    page,
  }) => {
    await page.goto("/general-settings");
    await expect(page).toHaveURL(/\/setup$/);
    await expect(
      page.getByRole("heading", { name: "Welcome to AI Office" }),
    ).toBeVisible();

    // A weak password is refused before anything is sent.
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();

    await page.getByLabel("Password", { exact: true }).fill(ownerPassword);
    await page.getByLabel("Confirm password").fill(ownerPassword);
    await page.getByRole("button", { name: "Set password" }).click();

    // Setting the password does not sign in: the new password does.
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(officeHeading(page)).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    // The setup screen is gone for good.
    const again = await page.goto("/setup");
    expect(again?.status()).toBe(404);
  });
});

test.describe("signing in and out", () => {
  test.beforeEach(async ({ office }) => {
    await office.setUp();
  });

  test("sends a signed-out visitor to the login page", async ({ page }) => {
    await page.goto("/notices");
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeVisible();
    const api = await page.request.get("/api/session");
    expect(api.status()).toBe(401);
  });

  test("refuses a wrong password, then signs in", async ({ page }) => {
    await signIn(page, `${ownerPassword}-wrong`);
    await expect(page.getByText("That password is not right.")).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveValue("");
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(officeHeading(page)).toBeVisible();

    // The session holds across pages and reloads.
    await page.getByRole("link", { name: "Notices" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Notice Board" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: "Notice Board" }),
    ).toBeVisible();
  });

  test("signs out", async ({ page }) => {
    await signIn(page);
    await expect(officeHeading(page)).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("signs out everywhere, ending every other session", async ({
    page,
    browser,
    office,
  }) => {
    // Two browsers each open the 3D Office, which renders in software where
    // there is no GPU, slowly.
    test.slow();
    const elsewhere = await browser.newContext({ baseURL: office.baseURL });
    try {
      const other = await elsewhere.newPage();
      await signIn(other);
      await expect(officeHeading(other)).toBeVisible();

      await signIn(page);
      await expect(officeHeading(page)).toBeVisible();
      await page.getByRole("button", { name: "Sign out everywhere" }).click();
      await expect(page).toHaveURL(/\/login$/);

      // The login page says, once, what still signs in: the one Owner
      // password, by name, and no API key with UI access.
      const notice = page
        .getByRole("status")
        .filter({ hasText: "You are signed out everywhere." });
      await expect(notice).toBeVisible();
      await expect(
        notice
          .getByRole("list", { name: "Owner passwords" })
          .getByRole("listitem"),
      ).toHaveCount(1);
      await expect(
        notice.getByRole("list", { name: "API keys with UI access" }),
      ).toHaveCount(0);
      await expect(notice).toContainText(
        "Sign in and remove any you do not recognise in API Key Management.",
      );
      await page.reload();
      await expect(page.getByLabel("Password")).toBeVisible();
      await expect(notice).toHaveCount(0);

      // The other browser's session is over too.
      await other.reload();
      await expect(other).toHaveURL(/\/login$/);
      const api = await other.request.get("/api/session");
      expect(api.status()).toBe(401);
    } finally {
      await elsewhere.close();
    }
  });
});
