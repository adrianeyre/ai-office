import { expect, signIn, test } from "../support/office.ts";
import { testAction } from "../support/control.ts";

// The 2D Notice Board (PRD FR-48, FR-50) in a real browser, against the
// built app, Postgres and a fake GitHub. Notices are raised in the server
// as their sources will raise them, and must appear without a reload.

test("a raised Notice appears live, then is acted on and dismissed", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await expect(page.getByText("Already a Floor")).toBeVisible();

  await page.getByRole("link", { name: "Notices" }).click();
  await expect(
    page.getByText("No Notices. Nothing needs you right now."),
  ).toBeVisible();

  // Raised while the board is open: it appears without a reload.
  await page.evaluate(() => {
    (window as unknown as { marker: string }).marker = "same page";
  });
  await office.raiseNotice({
    kind: "action",
    title: "PR #14 awaiting your approval",
    floorId: "web-shop",
    pullRequest: {
      number: 14,
      url: "https://github.com/adrianeyre/web-shop/pull/14",
    },
    actions: [testAction],
  });
  const notices = page.getByRole("list", { name: "Notices" });
  const awaiting = notices.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "PR #14 awaiting your approval" }),
  });
  await expect(awaiting).toBeVisible();
  await expect(awaiting).toContainText("Action");
  await expect(awaiting).toContainText("web-shop");
  await expect(awaiting.getByRole("link", { name: "PR #14" })).toHaveAttribute(
    "href",
    "https://github.com/adrianeyre/web-shop/pull/14",
  );
  expect(
    await page.evaluate(() => (window as unknown as { marker: string }).marker),
  ).toBe("same page");

  await office.raiseNotice({
    kind: "info",
    title: "PR #12 merged by the App",
    floorId: "web-shop",
  });
  const merged = notices.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "PR #12 merged by the App" }),
  });
  await expect(merged).toBeVisible();

  // Taking the action, and dismissing, each take a Notice off the board.
  await awaiting.getByRole("button", { name: testAction.label }).click();
  await expect(awaiting).toHaveCount(0);
  await merged.getByRole("button", { name: "Dismiss" }).click();
  await expect(
    page.getByText("No Notices. Nothing needs you right now."),
  ).toBeVisible();

  // They stay off it.
  await page.reload();
  await expect(
    page.getByText("No Notices. Nothing needs you right now."),
  ).toBeVisible();
});

test("the Notice Board shows one Floor's Notices when asked", async ({
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
  await office.raiseNotice({
    kind: "info",
    title: "Batch started",
    floorId: "web-shop",
  });
  await office.raiseNotice({
    kind: "info",
    title: "PR #3 opened",
    floorId: "blog",
  });

  await page.getByRole("link", { name: "Notices" }).click();
  const headings = page
    .getByRole("list", { name: "Notices" })
    .getByRole("heading");
  await expect(headings).toHaveText(["PR #3 opened", "Batch started"]);
  await page.getByLabel("Floor").selectOption({ label: "blog" });
  await expect(headings).toHaveText(["PR #3 opened"]);
  await expect(page).toHaveURL(/\/notices\?floorId=blog$/);
});
