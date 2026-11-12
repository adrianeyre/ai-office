import { expect, signIn, test } from "../support/office.ts";

// The currency costs are shown in (General Settings), in a real browser
// against the built app and Postgres: with no day's exchange rate (the
// tests reach nothing beyond the machine), costs show in US dollars as
// they are kept; once the Owner gives a rate, everywhere shows pounds.

test("costs show in the office's currency once it has a rate", async ({
  office,
  page,
}) => {
  await office.setUp();
  expect(
    await office.recordGatewayRequests([
      {
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        model: "claude-opus-5-5",
        account: "Work",
        status: 200,
        latencyMs: 900,
        inputTokens: 10_000,
        outputTokens: 2_000,
        estimatedCostUsd: 2,
        ownerTool: "laptop",
      },
    ]),
  ).toBe(1);
  await signIn(page);

  const tile = (label: string) =>
    page.locator("p", { hasText: new RegExp(`^${label}$`) }).locator("..");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(tile("Estimated cost")).toContainText("$2.00");

  // British pounds by default; with no day's rate, the Owner gives one.
  await page.getByRole("link", { name: "General Settings" }).click();
  const card = page
    .getByRole("heading", { name: "Currency", exact: true })
    .locator("xpath=ancestor::*[@data-slot='card']");
  await expect(card.getByRole("combobox", { name: "Currency" })).toHaveValue(
    "GBP",
  );
  await card.getByLabel(/Your own rate/).fill("0.8");
  await card.getByRole("button", { name: "Save currency" }).click();
  await expect(
    card.getByText("Saved. Every cost is now shown in British Pound (GBP)."),
  ).toBeVisible();
  await expect(
    card.getByText(/A cost of \$1\.00 shows as £0\.80\./),
  ).toBeVisible();

  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(tile("Estimated cost")).toContainText("£1.60");
});
