import { expect, signIn, test } from "../support/office.ts";

// The Owner's own Floor Templates (PRD FR-101), in a real browser against
// the built app, Postgres and the test's fake GitHub: a Floor's set-up
// (its team, settings and Manager) is saved as a new template from its
// settings page, and a new Floor is added from that template.

test("saves a Floor as a template, then adds a new Floor from it", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/web-shop");
  office.github.installRepository("adrianeyre/blog");
  await office.setUp();
  await signIn(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Office" }),
  ).toBeVisible();

  // web-shop, from Development, then made its own: two coders and a docs
  // Agent, its own Merge Policy, Round Cap and check command.
  await page.goto("/floor-settings");
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  const inUse = page.getByRole("region", { name: "Floors in use" });
  await expect(inUse.getByRole("listitem")).toHaveText([
    /web-shop\s*adrianeyre\/web-shop\s*· started from Development/,
  ]);
  await page.goto("/agent-settings?floor=web-shop");
  const team = page.getByRole("form", { name: "Team size" });
  await team.getByLabel("Coder", { exact: true }).fill("2");
  await team.getByLabel("Docs", { exact: true }).fill("1");
  await team.getByRole("button", { name: "Save team" }).click();
  const webShopAgents = page.getByRole("table", { name: "Agents on web-shop" });
  await expect(webShopAgents.locator("tbody tr")).toHaveCount(6);

  await page.goto("/floor-settings/web-shop");
  await page.getByLabel("Merge Policy").selectOption("auto_merge");
  await page.getByLabel("Round Cap").fill("4");
  await page.getByLabel("Test command").fill("pnpm test");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").getByText("Saved.")).toBeVisible();

  // Saved as a template, from the Floor's settings page.
  const save = page.getByRole("form", { name: "Save as a Floor Template" });
  await save.getByLabel("Template name").fill("Web team");
  await save
    .getByLabel("Template description")
    .fill("Two coders, a reviewer, QA and docs, merging on their own.");
  await save.getByRole("button", { name: "Save as a template" }).click();
  await expect(save.getByRole("status")).toHaveText(
    "Saved Web team: Manager, 2 × coder, reviewer, QA, docs. Open Web team",
  );

  // It is the Owner's own on the Floor Templates page, and editable.
  await save.getByRole("link", { name: "Open Web team" }).click();
  await expect(page).toHaveURL(/\/admin\/templates\?template=web-team$/);
  const templates = page.getByRole("table", { name: "Floor Templates" });
  const row = templates.getByRole("row", { name: /Web team/ });
  await expect(row.getByRole("cell")).toHaveText([
    "Yours",
    "Manager, 2 × coder, reviewer, QA, docs",
    /Open\s*Duplicate\s*Export\s*Delete/,
  ]);
  const form = page.getByRole("form", { name: "Edit Web team" });
  await expect(form.getByLabel("Merge Policy")).toHaveValue("auto_merge");
  await expect(form.getByLabel("Round Cap")).toHaveValue("4");
  await expect(form.getByLabel("Check command")).toHaveValue("pnpm test");
  await expect(form.getByLabel("coder count")).toHaveValue("2");

  // A new Floor from it, picked in the picker.
  await page.goto("/floor-settings");
  const picker = page.getByRole("group", { name: "Floor Template" });
  const webTeam = picker.getByRole("radio", { name: "Web team" });
  await expect(webTeam).toHaveAccessibleDescription(
    "Two coders, a reviewer, QA and docs, merging on their own. Starting team: Manager, 2 × coder, reviewer, QA, docs",
  );
  await webTeam.check();
  await page
    .getByRole("button", { name: "Add adrianeyre/blog as a Floor" })
    .click();
  await expect(inUse.getByRole("listitem")).toHaveText([
    /web-shop\s*adrianeyre\/web-shop\s*· started from Development/,
    /blog\s*adrianeyre\/blog\s*· started from Web team/,
  ]);

  // blog has web-shop's settings and team.
  await inUse.getByRole("link", { name: "blog", exact: true }).click();
  await expect(
    page.getByText("It started from the Web team Floor Template."),
  ).toBeVisible();
  await expect(page.getByLabel("Merge Policy")).toHaveValue("auto_merge");
  await expect(page.getByLabel("Round Cap")).toHaveValue("4");
  await expect(page.getByLabel("Test command")).toHaveValue("pnpm test");
  await page.goto("/agent-settings?floor=blog");
  const blogAgents = page.getByRole("table", { name: "Agents on blog" });
  await expect(blogAgents.locator("tbody tr")).toHaveCount(6);
  for (const [role, count] of [
    ["Manager", 1],
    ["Coder", 2],
    ["Reviewer", 1],
    ["QA", 1],
    ["Docs", 1],
  ] as const) {
    await expect(
      blogAgents.getByRole("row", { name: new RegExp(role) }),
    ).toHaveCount(count);
  }

  // The Activity Feed has the template, and the Floor added from it.
  await page.goto("/activity");
  await expect(
    page.getByText(
      'Floor Template "Web team" saved from the web-shop Floor\'s set-up.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Floor "blog" added for adrianeyre/blog, from the Web team Floor Template.',
    ),
  ).toBeVisible();
});
