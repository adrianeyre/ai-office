import type { SeededGatewayRequest } from "../support/control.ts";
import { expect, signIn, test } from "../support/office.ts";

// The AI Gateway's analytics dashboards (PRD FR-43) in a real browser
// against the built app and Postgres, with seeded request records: the
// headline totals, the charts over time, the breakdowns and the top
// consumers render from them.

/** Today's requests, a few hours ago, so every range holds them. */
function seeded(): SeededGatewayRequest[] {
  const at = (hoursAgo: number) =>
    new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return [
    {
      startedAt: at(1),
      model: "claude-opus-5-5",
      account: "Work",
      status: 200,
      latencyMs: 1_200,
      inputTokens: 40_000,
      outputTokens: 10_000,
      cacheReadInputTokens: 120_000,
      estimatedCostUsd: 0.9,
      ownerTool: "laptop",
    },
    {
      startedAt: at(2),
      model: "claude-opus-5-5",
      account: "Work",
      status: 529,
      latencyMs: 300,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      ownerTool: "laptop",
    },
    {
      startedAt: at(2),
      model: "grok-5",
      account: "xAI",
      status: 200,
      latencyMs: 600,
      inputTokens: 8_000,
      outputTokens: 2_000,
      estimatedCostUsd: 0.1,
      ownerTool: "ci",
    },
  ];
}

test("the dashboards render the seeded requests", async ({ office, page }) => {
  await office.setUp();
  expect(await office.recordGatewayRequests(seeded())).toBe(3);
  await signIn(page);

  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Analytics" }),
  ).toBeVisible();

  // The headline totals.
  // A stat tile: its label is the one paragraph with these words.
  const tile = (label: string) =>
    page.locator("p", { hasText: new RegExp(`^${label}$`) }).locator("..");
  await expect(tile("Requests")).toContainText("3");
  await expect(tile("Tokens")).toContainText("60K");
  await expect(tile("Estimated cost")).toContainText("$1.00");
  await expect(tile("Error rate")).toContainText("33%");

  // The charts over time, each with its marks.
  for (const title of [
    "Requests",
    "Tokens by type",
    "Estimated cost",
    "Latency",
    "Error rate",
  ]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await expect(
    page.getByRole("group", { name: /^Tokens by type\./ }).locator("path"),
  ).not.toHaveCount(0);

  // The breakdown by Model, and the top consumers.
  const byModel = page.getByRole("list", { name: "Tokens by Model" });
  await expect(byModel.getByRole("listitem")).toHaveCount(2);
  await expect(byModel.getByRole("listitem").first()).toContainText(
    "claude-opus-5-5",
  );
  await page
    .getByRole("combobox", { name: "Break down by" })
    .selectOption("owner_tool");
  await expect(
    page
      .getByRole("list", { name: "Tokens by Owner tool" })
      .getByRole("listitem"),
  ).toHaveCount(2);
  await expect(page).toHaveURL(/by=owner_tool/);
  await expect(
    page
      .getByRole("heading", { name: "Top consumers" })
      .locator("xpath=ancestor::*[@data-slot='card']"),
  ).toContainText("laptop");

  // The last 24 hours, by the hour, hold them too.
  await page.getByRole("button", { name: "Last 24 hours" }).click();
  await expect(page).toHaveURL(/range=24h/);
  await expect(tile("Requests")).toContainText("3");
});
