import { expect, signIn, test } from "../support/office.ts";

// The Branches page in a real browser against the built app, Postgres and
// the test's fake GitHub, which the server's GitHub App reads over HTTP: a
// Floor's AI Office branches as lanes off its default branch.

const webShop = "adrianeyre/web-shop";

test("opens Branches from the menu, picks a Floor and sees a lane with its ahead/behind badge", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/blog");
  office.github.installRepository(webShop);
  const issue = office.github.createIssue(webShop, {
    title: "Add a basket",
    labels: ["ai-office"],
  });
  const branch = `ai-office/${String(issue.number)}-add-a-basket`;
  office.github.pushCommit(webShop, branch, {
    message: "Add a basket\n\nAgent: Ada (coder, Claude claude-opus-5-5)",
  });
  office.github.pushCommit(webShop, branch, { message: "Total the basket" });
  office.github.pushCommit(webShop, branch, { message: "Show the total" });
  office.github.pushCommit(webShop, "main", { message: "Meanwhile on main" });
  office.github.pushCommit(webShop, "main", { message: "And again" });

  await office.setUp();
  await signIn(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Office" }),
  ).toBeVisible();
  // The blog first, so the page opens on it.
  await page.goto("/floor-settings");
  const repositories = page.getByRole("list", {
    name: "Repositories the App is installed on",
  });
  for (const repository of ["adrianeyre/blog", webShop]) {
    await repositories
      .getByRole("button", { name: `Add ${repository} as a Floor` })
      .click();
    await expect(
      repositories.getByRole("listitem").filter({ hasText: repository }),
    ).toContainText("Already a Floor");
  }

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Branches" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Branches" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/branches\?floor=blog$/);
  await expect(page.getByText("blog has no AI Office branches.")).toBeVisible();

  await page.getByLabel("Floor").selectOption("web-shop");
  await expect(page).toHaveURL(/\/branches\?floor=web-shop$/);
  const row = page.getByRole("row", { name: new RegExp(branch) });
  await expect(row.getByText("↑3 ↓2")).toBeVisible();
  await expect(row).toContainText("3 commits ahead of main, 2 behind");
  await expect(
    row.getByRole("link", { name: `#${String(issue.number)} Add a basket` }),
  ).toHaveAttribute("href", `https://github.com/${webShop}/issues/1`);
  await expect(row).toContainText("No CI");

  // The lane view: a dot for each of the branch's commits, newest last.
  const lanes = page.getByRole("group", { name: "Lanes off main" });
  await expect(lanes.getByRole("link")).toHaveCount(3);
  await lanes.getByRole("link").last().focus();
  await expect(page.getByRole("tooltip")).toContainText("Show the total");

  // A link opens the same Floor.
  await page.goto("/branches?floor=blog");
  await expect(page.getByLabel("Floor")).toHaveValue("blog");
});
