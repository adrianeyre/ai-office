import { expect, ownerPassword, signIn, test } from "../support/office.ts";

// API Key Management, in a real browser against the built app and
// Postgres: a key with AI proxy and UI access is made and given a
// nickname; it signs in to AI Office, where the receptionist greets it by
// that nickname; disabled, it can no longer sign in. Making such a key, or
// adding an Owner password, asks for the current password (A1-3).

test("a key with UI access signs in and is greeted by its nickname; disabled, it cannot", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "API Key Management" }).click();
  const make = page.getByRole("form", { name: "Make a Gateway Key" });
  await make.getByLabel("Tool").fill("My laptop");
  await make.getByLabel("Access").selectOption("proxy_and_ui");
  await make.getByLabel("Your current password").fill(ownerPassword);
  await make.getByRole("button", { name: "Make Gateway Key" }).click();
  const key = await make.getByLabel("The key for My laptop").inputValue();
  expect(key).toMatch(/^aio_gk_/);

  const settings = page.getByRole("form", { name: "My laptop's settings" });
  await expect(settings.getByLabel("Time zone")).toHaveValue("Europe/London");
  await settings.getByLabel("Nickname").fill("Laps");
  await settings.getByRole("button", { name: "Save My laptop" }).click();
  await expect(settings.getByRole("status")).toHaveText("Saved.");

  // Signed in with the key, the receptionist greets it by its nickname.
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/login");
  await page.getByRole("button", { name: "Use an API key instead" }).click();
  await page.getByLabel("API key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(
    page.getByRole("status").filter({ hasText: "says:" }),
  ).toHaveText(/Hi, Laps\. Good (morning|afternoon|evening)\.$/);

  // Disabled, it cannot sign in again.
  await page.getByRole("link", { name: "API Key Management" }).click();
  await page.getByRole("button", { name: "Disable My laptop" }).click();
  await page.waitForURL("**/login");
  await page.getByRole("button", { name: "Use an API key instead" }).click();
  await page.getByLabel("API key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "That API key cannot sign in",
  );
});

test("a second Owner password signs someone else in, greeted by their nickname", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "API Key Management" }).click();
  const add = page.getByRole("form", { name: "Add an Owner password" });
  await add.getByLabel("Name", { exact: true }).fill("Samantha");
  await add
    .getByLabel("Password", { exact: true })
    .fill("Correct-Horse-Battery-9");
  await add.getByLabel("Your current password").fill(ownerPassword);
  await add.getByRole("button", { name: "Add password" }).click();
  await expect(add.getByRole("status")).toContainText(
    "Added Samantha's password.",
  );
  const sam = page.getByRole("form", {
    name: "Samantha's password settings",
  });
  await sam.getByLabel("Nickname").fill("Sam");
  await sam.getByRole("button", { name: "Save Samantha" }).click();
  await expect(sam.getByRole("status")).toHaveText("Saved.");

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/login");
  await page.getByLabel("Password").fill("Correct-Horse-Battery-9");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(
    page.getByRole("status").filter({ hasText: "says:" }),
  ).toHaveText(/Hi, Sam\. Good (morning|afternoon|evening)\.$/);
});
