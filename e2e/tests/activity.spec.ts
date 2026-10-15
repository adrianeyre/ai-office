import { expect, signIn, test } from "../support/office.ts";

// The Activity Feed (PRD FR-52) in a real browser, against the built app,
// Postgres and a fake GitHub: filtering by Floor and by type narrows the
// list, and new events stream in without a reload.

test("the Activity Feed filters by Floor and type, and new events stream in", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/web-shop");
  office.github.installRepository("adrianeyre/blog");
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "Floor Settings" }).click();
  for (const repository of ["web-shop", "blog"]) {
    await page
      .getByRole("button", { name: `Add adrianeyre/${repository} as a Floor` })
      .click();
  }
  await expect(page.getByText("Already a Floor")).toHaveCount(2);

  await page.getByRole("link", { name: "Activity" }).click();
  const feed = page.getByRole("list", { name: "Activity" });
  const entries = feed.locator(":scope > li");
  // The sign-in, then each Floor and its four Agents.
  await expect(entries).toHaveCount(11);
  await expect(entries.last()).toContainText(
    "The Owner signed in from 127.0.0.1.",
  );
  await expect(entries.first()).toContainText("joined as QA");
  await expect(feed).toContainText(
    'Floor "blog" added for adrianeyre/blog, from the Development Floor Template.',
  );

  // One Floor: its creation and its four Agents.
  await page.getByLabel("Floor").selectOption({ label: "web-shop" });
  await expect(page).toHaveURL(/floorId=web-shop/);
  await expect(entries).toHaveCount(5);
  await expect(feed).not.toContainText("adrianeyre/blog");
  await expect(entries.last()).toContainText(
    'Floor "web-shop" added for adrianeyre/web-shop, from the Development Floor Template.',
  );

  // One type, too: only the Floor's creation.
  await page.getByLabel("Type").selectOption({ label: "Floor added" });
  await expect(page).toHaveURL(/type=floor\.created/);
  await expect(entries).toHaveCount(1);

  // Every Floor's, of that type.
  await page.getByLabel("Floor").selectOption({ label: "All Floors" });
  await expect(entries).toHaveCount(2);

  // A Floor's settings change in another tab: it streams in, at the top.
  await page.getByLabel("Type").selectOption({ label: "All types" });
  await page.getByLabel("Floor").selectOption({ label: "blog" });
  await expect(entries).toHaveCount(5);
  await page.evaluate(() => {
    (window as unknown as { marker: string }).marker = "same page";
  });
  const admin = await page.context().newPage();
  await admin.goto("/floor-settings/blog");
  await admin.getByLabel("Round Cap").fill("5");
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByRole("status").getByText("Saved.")).toBeVisible();

  await expect(entries).toHaveCount(6);
  await expect(entries.first()).toContainText(
    "Floor settings changed: roundCap.",
  );
  // Another Floor's events do not stream into this one's feed.
  await admin.goto("/floor-settings/web-shop");
  await admin.getByLabel("Round Cap").fill("4");
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByRole("status").getByText("Saved.")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(entries).toHaveCount(6);
  expect(
    await page.evaluate(() => (window as unknown as { marker: string }).marker),
  ).toBe("same page");
});

test("the Activity Feed loads older events as it scrolls", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Office" }),
  ).toBeVisible();
  // 120 events, more than two pages of 50.
  for (let issue = 1; issue <= 120; issue += 1) {
    await office.publish({
      type: "config.changed",
      version: 1,
      scope: "office",
      keys: [`setting${String(issue)}`],
    });
  }
  await page.getByRole("link", { name: "Activity" }).click();
  const entries = page
    .getByRole("list", { name: "Activity" })
    .locator(":scope > li");
  await expect(entries).toHaveCount(50);
  await expect(entries.first()).toContainText("setting120");
  // Scrolling to the bottom loads older events, a page at a time, until
  // there are none left: the sign-in, and every one published.
  await entries.last().scrollIntoViewIfNeeded();
  await expect.poll(() => entries.count()).toBeGreaterThanOrEqual(100);
  await expect(async () => {
    await entries.last().scrollIntoViewIfNeeded();
    await expect(entries).toHaveCount(121, { timeout: 1000 });
  }).toPass();
  await expect(page.getByText("That is everything.")).toBeVisible();
  await expect(entries.last()).toContainText("The Owner signed in");
});
