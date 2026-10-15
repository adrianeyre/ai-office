import { expect, signIn, test } from "../support/office.ts";

// Agent Settings, the Owner's profile and the lobby's receptionist (the
// Communications Agent, at the reception desk), in a real browser against
// the built app, Postgres and a fake GitHub. The Owner sets their
// nickname, and the receptionist greets them by it as the Office opens;
// they rename the Communications Agent in Agent Settings, see a Floor's
// Agents there, and call the lift with its button.

test("the receptionist greets the Owner by nickname, and Agent Settings edits the lobby and a Floor", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);

  // The first Owner password's settings, in API Key Management: British
  // time by default.
  await page.getByRole("link", { name: "API Key Management" }).click();
  const profile = page.getByRole("form", {
    name: "Owner's password settings",
  });
  await expect(profile.getByLabel("Time zone")).toHaveValue("Europe/London");
  await profile.getByLabel("Name", { exact: true }).fill("Adrian");
  await profile.getByLabel("Nickname").fill("Ade");
  await profile.getByRole("button", { name: "Save Owner" }).click();
  // Saved, the password's card goes by its new name.
  await expect(
    page
      .getByRole("form", { name: "Adrian's password settings" })
      .getByRole("status"),
  ).toHaveText("Saved.");
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await expect(
    page.getByRole("link", { name: "web-shop", exact: true }),
  ).toBeVisible();

  // Opening the Office, the lobby's receptionist, the Communications
  // Agent (named at random at first start), greets the Owner.
  const agent = (await (
    await page.request.get("/api/communications-agent")
  ).json()) as { name: string };
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: `${agent.name} says:` }),
  ).toHaveText(
    new RegExp(
      `^${agent.name} says: Hi, Ade\\. Good (morning|afternoon|evening)\\.$`,
    ),
  );

  // Agent Settings shows the lobby, where the lift is.
  await page.getByRole("link", { name: "Agent Settings" }).click();
  await expect(page.getByLabel("Floor")).toHaveValue("lobby");
  const name = page.getByRole("form", {
    name: "The Communications Agent's name",
  });
  await name.getByLabel("Name").fill("Rosa");
  await name.getByRole("button", { name: "Save name" }).click();
  await expect(
    page.getByRole("heading", { name: "Rosa, the Communications Agent" }),
  ).toBeVisible();

  // A Floor's Agents, a tab each, with tabs for its settings and Avatar.
  await page.getByLabel("Floor").selectOption({ label: "web-shop" });
  const agents = page.getByRole("tablist", { name: /^Agents on / });
  await expect(agents.getByRole("tab")).not.toHaveCount(0);
  await agents.getByRole("tab").nth(1).click();
  await expect(page.getByLabel("Daily Token Cap")).toBeVisible();
  await page.getByRole("tab", { name: "Avatar", exact: true }).click();
  await expect(page.getByRole("group", { name: "Sex" })).toBeVisible();

  // Stored: the Communications Agent keeps the new name after a reload.
  await page.goto("/agent-settings?floor=lobby");
  await expect(
    page.getByRole("heading", { name: "Rosa, the Communications Agent" }),
  ).toBeVisible();
});
