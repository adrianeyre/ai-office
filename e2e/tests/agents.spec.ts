import { expect, signIn, test } from "../support/office.ts";

// A new Floor's default team (PRD FR-10, FR-11), on its Floor settings page,
// in a real browser against the built app, Postgres and a fake GitHub.

test("the Floor's settings list the four Agents of a new Floor", async ({
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
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  // The Floor's Agents are in Agent Settings.
  await page
    .getByRole("link", { name: "Open web-shop's Agent Settings" })
    .click();

  const table = page.getByRole("table", { name: "Agents on web-shop" });
  const rows = table.getByRole("row");
  // A heading row, then the four Agents.
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(1)).toContainText("Manager");
  await expect(rows.nth(2)).toContainText("Coder");
  await expect(rows.nth(3)).toContainText("Reviewerrequired reviewer");
  await expect(rows.nth(4)).toContainText("QA");
  for (const index of [1, 2, 3, 4]) {
    await expect(rows.nth(index)).toContainText(
      /Claude\s*claude-opus-5-5\s*\(default\)\s*Idle/,
    );
  }
  const names = await table.getByRole("rowheader").allTextContents();
  expect(new Set(names).size).toBe(4);

  // They are stored: the same four after a reload.
  await page.reload();
  await expect(table.getByRole("rowheader")).toHaveText(names);
});
