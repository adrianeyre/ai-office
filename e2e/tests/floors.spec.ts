import { expect, signIn, test } from "../support/office.ts";

// Floors from Floor Settings (PRD FR-6, FR-7, FR-9, FR-97), in a real
// browser against the built app, Postgres and the test's fake GitHub.

test.beforeEach(async ({ office, page }) => {
  office.github.installRepository("adrianeyre/web-shop");
  office.github.installRepository("adrianeyre/blog", {
    defaultBranch: "trunk",
  });
  await office.setUp();
  await signIn(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Office" }),
  ).toBeVisible();
});

test("adds a Floor from Floor Settings", async ({ page }) => {
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await expect(page.getByText("No Floors yet.")).toBeVisible();
  const repositories = page.getByRole("list", {
    name: "Repositories the App is installed on",
  });
  await expect(repositories.getByRole("listitem")).toHaveText([
    /adrianeyre\/blog\s*Add Floor/,
    /adrianeyre\/web-shop\s*Add Floor/,
  ]);

  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await expect(repositories.getByRole("listitem").nth(1)).toHaveText(
    /adrianeyre\/web-shop\s*Already a Floor/,
  );

  // The new Floor, with the default settings, survives a reload.
  await page.reload();
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  await expect(page).toHaveURL(/\/floor-settings\/web-shop$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "web-shop" }),
  ).toBeVisible();
  await expect(page.getByLabel("Default branch")).toHaveValue("main");
  await expect(page.getByLabel("Merge Policy")).toHaveValue("send_to_me");
  await expect(page.getByLabel("Round Cap")).toHaveValue("3");
  await expect(page.getByLabel("Setup command")).toHaveValue("");
  await expect(page.getByLabel("Test command")).toHaveValue("");
  await expect(
    page.getByLabel("Work waits for me to approve each Plan"),
  ).toBeChecked();
});

test("adds a Floor from the Floor Template picked", async ({ page }) => {
  await page.goto("/floor-settings");
  const picker = page.getByRole("group", { name: "Floor Template" });
  const development = picker.getByRole("radio", { name: "Development" });
  const blank = picker.getByRole("radio", { name: "Blank" });
  // Development first, and chosen; each with its starting team.
  await expect(picker.getByRole("radio")).toHaveCount(10);
  await expect(development).toBeChecked();
  await expect(development).toHaveAccessibleDescription(
    "A software team that changes the code, reviews each pull request and tests it. Starting team: Manager, coder, reviewer, QA",
  );
  await expect(blank).toHaveAccessibleDescription(
    "Only a Manager, for a Floor whose team you put together yourself. Starting team: Manager",
  );
  await expect(
    picker.getByRole("radio", { name: "Online store" }),
  ).toHaveAccessibleDescription(
    "A store team that changes the product data, copy and theme in the store's repository, reviews each change for the brand and checks it. Starting team: Manager, merchandiser, copywriter, storefront developer, brand reviewer, store QA",
  );
  await expect(
    picker.getByRole("radio", { name: "Infrastructure" }),
  ).toHaveAccessibleDescription(
    "A platform team that changes the Terraform in the repository, reviews each change for security and checks its plan and policies, without ever applying it. Starting team: Manager, platform engineer, security reviewer, plan QA",
  );

  await picker.getByText("Blank", { exact: true }).click();
  await expect(blank).toBeChecked();
  await page
    .getByRole("button", { name: "Add adrianeyre/blog as a Floor" })
    .click();
  const inUse = page.getByRole("region", { name: "Floors in use" });
  await expect(inUse.getByRole("listitem")).toHaveText([
    /blog\s*adrianeyre\/blog\s*· started from Blank/,
  ]);
  // Back to Development for the other.
  await development.check();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await expect(inUse.getByRole("listitem")).toHaveText([
    /blog\s*adrianeyre\/blog\s*· started from Blank/,
    /web-shop\s*adrianeyre\/web-shop\s*· started from Development/,
  ]);

  // The Blank Floor has a Manager only, and says where it started from.
  await inUse.getByRole("link", { name: "blog", exact: true }).click();
  await expect(
    page.getByText("It started from the Blank Floor Template."),
  ).toBeVisible();
  const blogAgents = page.getByRole("table", { name: "Agents on blog" });
  await expect(blogAgents.getByRole("row", { name: /Manager/ })).toHaveCount(1);
  await expect(blogAgents.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByLabel("Coder", { exact: true })).toHaveValue("0");

  // The Development Floor has the Manager, a coder, a reviewer and QA.
  await page.goto("/floor-settings/web-shop");
  await expect(
    page.getByText("It started from the Development Floor Template."),
  ).toBeVisible();
  const webShopAgents = page.getByRole("table", { name: "Agents on web-shop" });
  await expect(webShopAgents.locator("tbody tr")).toHaveCount(4);
  for (const role of ["Manager", "Coder", "Reviewer", "QA"]) {
    await expect(
      webShopAgents.getByRole("row", { name: new RegExp(role) }),
    ).toHaveCount(1);
  }

  // The Activity Feed says which template each Floor came from.
  await page.goto("/activity?type=floor.created");
  await expect(page.getByText("from the Blank Floor Template")).toBeVisible();
  await expect(
    page.getByText(
      'Floor "web-shop" added for adrianeyre/web-shop, from the Development Floor Template.',
    ),
  ).toBeVisible();
});

test("changes a Floor's settings, then archives it", async ({ page }) => {
  await page.goto("/floor-settings");
  await page
    .getByRole("button", { name: "Add adrianeyre/blog as a Floor" })
    .click();
  await page.getByRole("link", { name: "blog", exact: true }).click();

  await page.getByLabel("Merge Policy").selectOption("auto_merge");
  await page.getByLabel("Round Cap").fill("5");
  await page.getByLabel("Test command").fill("pnpm test");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Default branch")).toHaveValue("trunk");
  await expect(page.getByLabel("Merge Policy")).toHaveValue("auto_merge");
  await expect(page.getByLabel("Round Cap")).toHaveValue("5");
  await expect(page.getByLabel("Test command")).toHaveValue("pnpm test");

  await page.getByRole("button", { name: "Archive Floor" }).click();
  await page.getByRole("button", { name: "Archive blog" }).click();
  await expect(page).toHaveURL(/\/floor-settings$/);
  await expect(page.getByText("No Floors yet.")).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Repositories the App is installed on" })
      .getByRole("listitem")
      .first(),
  ).toHaveText(/adrianeyre\/blog\s*Already a Floor/);
});
