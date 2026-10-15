import { agentListSchema } from "@ai-office/shared";

import { expect, signIn, test } from "../support/office.ts";

// The Avatar Editor (PRD FR-13; §5 scenario 7), in a real browser against
// the built app, Postgres and a fake GitHub. From the Floor's settings, the
// Owner changes the coder's hair colour and outfit, saves, and reloads:
// the change is stored, in the editor and in the API alike.

test("an Agent's new hair colour and outfit outlast a reload", async ({
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
  const coderRow = table.getByRole("row").nth(2);
  await expect(coderRow).toContainText("Coder");
  const coderName = (await coderRow.getByRole("rowheader").textContent()) ?? "";
  const team = async () =>
    agentListSchema.parse(
      await (await page.request.get("/api/floors/web-shop/agents")).json(),
    ).agents;
  const before = (await team()).find(({ name }) => name === coderName);
  if (before === undefined) {
    throw new Error("The Floor has no coder.");
  }
  // A colour and an outfit it does not have yet.
  const [hair, hairHex] =
    before.avatar.hairColour === "#2e6fd8"
      ? ["Pink", "#d64f8f"]
      : ["Blue", "#2e6fd8"];
  const [outfit, outfitStyle] =
    before.avatar.outfit.style === "overalls"
      ? ["Dress", "dress"]
      : ["Overalls", "overalls"];
  const [colour, colourHex] =
    before.avatar.outfit.primaryColour === "#d98e04"
      ? ["Sage", "#81b29a"]
      : ["Mustard", "#d98e04"];

  const openEditor = async () => {
    await page
      .getByRole("button", { name: `Open ${coderName}'s Avatar Editor` })
      .click();
    return page.getByRole("form", { name: `${coderName}'s Avatar` });
  };
  let editor = await openEditor();
  await expect(
    editor.getByText(`How ${coderName} looks in the Office.`, {
      exact: false,
    }),
  ).toBeVisible();
  await editor
    .getByRole("group", { name: "Hair colour" })
    .getByRole("radio", { name: hair })
    .check();
  await editor.getByLabel("Outfit", { exact: true }).selectOption(outfit);
  await editor
    .getByRole("group", { name: "Outfit colour" })
    .getByRole("radio", { name: colour })
    .check();
  await editor
    .getByRole("button", { name: `Save ${coderName}'s Avatar` })
    .click();
  await expect(editor.getByRole("status")).toContainText(
    `Saved. The Office shows ${coderName}'s new look`,
  );

  // Stored: the same after a reload.
  await page.reload();
  editor = await openEditor();
  await expect(
    editor
      .getByRole("group", { name: "Hair colour" })
      .getByRole("radio", { name: hair }),
  ).toBeChecked();
  await expect(editor.getByLabel("Outfit", { exact: true })).toHaveValue(
    outfitStyle,
  );
  await expect(
    editor
      .getByRole("group", { name: "Outfit colour" })
      .getByRole("radio", { name: colour }),
  ).toBeChecked();
  // Nothing to save: it is what was saved.
  await expect(
    editor.getByRole("button", { name: `Save ${coderName}'s Avatar` }),
  ).toBeDisabled();

  const after = (await team()).find(({ id }) => id === before.id);
  expect(after?.avatar).toEqual({
    ...before.avatar,
    hairColour: hairHex,
    outfit: {
      ...before.avatar.outfit,
      style: outfitStyle,
      primaryColour: colourHex,
    },
  });
  // Nothing else about the coder changed.
  expect({ ...after, avatar: undefined }).toEqual({
    ...before,
    avatar: undefined,
  });
});
