import { expect, signIn, test } from "../support/office.ts";

// A Floor's full settings (PRD FR-66, FR-7, FR-10, FR-12): every setting,
// adding and removing Agents with the Manager kept, and each Role's team
// size with the concurrency warning, in a real browser against the built
// app, Postgres and the test's fake GitHub.

test.beforeEach(async ({ office, page }) => {
  office.github.installRepository("adrianeyre/web-shop");
  // A second branch, to make the default.
  office.github.pushCommit("adrianeyre/web-shop", "develop");
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "web-shop" }),
  ).toBeVisible();
});

test("edits each of a Floor's settings, and they are kept", async ({
  page,
}) => {
  // The Agents are in Agent Settings.
  await page.goto("/agent-settings?floor=web-shop");
  const agents = page.getByRole("table", { name: "Agents on web-shop" });
  // A second reviewer, to require beside the first.
  const add = page.getByRole("form", { name: "Add an Agent" });
  await add.getByLabel("Role").selectOption("reviewer");
  await add.getByLabel("Name").fill("Rex");
  await add.getByRole("button", { name: "Add Agent" }).click();
  await expect(agents.getByRole("row", { name: /Rex/ })).toBeVisible();
  const [firstReviewer] = await agents
    .getByRole("row", { name: /Reviewerrequired reviewer/ })
    .getByRole("rowheader")
    .allTextContents();

  await page.goto("/floor-settings/web-shop");
  const settings = page.getByRole("form", { name: "Floor settings" });
  await expect(
    settings.getByLabel(`${firstReviewer ?? ""} (Claude claude-opus-5-5)`),
  ).toBeChecked();
  const rex = settings.getByLabel("Rex (Claude claude-opus-5-5)");
  await expect(rex).not.toBeChecked();

  await settings.getByLabel("Name", { exact: true }).fill("Web shop");
  await settings.getByLabel("Default branch").fill("develop");
  await settings.getByLabel("Setup command").fill("pnpm install");
  await settings.getByLabel("Test command").fill("pnpm test");
  await settings.getByLabel("Merge Policy").selectOption("auto_merge");
  await settings.getByLabel("Round Cap").fill("5");
  await settings.getByLabel("Daily Token Cap").fill("2000000");
  await settings.getByLabel("Monthly Token Cap").fill("40000000");
  await settings.getByLabel("Concurrency limit").fill("2");
  await settings.getByLabel("Priority").fill("7");
  await settings.getByLabel("Commit author name").fill("Web Shop Owner");
  await settings.getByLabel("Commit author email").fill("owner@example.com");
  await settings.getByLabel("Work waits for me to approve each Plan").uncheck();
  await rex.check();
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByRole("status")).toHaveText("Saved.");

  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Web shop" }),
  ).toBeVisible();
  await expect(settings.getByLabel("Name", { exact: true })).toHaveValue(
    "Web shop",
  );
  await expect(settings.getByLabel("Default branch")).toHaveValue("develop");
  await expect(settings.getByLabel("Setup command")).toHaveValue(
    "pnpm install",
  );
  await expect(settings.getByLabel("Test command")).toHaveValue("pnpm test");
  await expect(settings.getByLabel("Merge Policy")).toHaveValue("auto_merge");
  await expect(settings.getByLabel("Round Cap")).toHaveValue("5");
  await expect(settings.getByLabel("Daily Token Cap")).toHaveValue("2000000");
  await expect(settings.getByLabel("Monthly Token Cap")).toHaveValue(
    "40000000",
  );
  await expect(settings.getByLabel("Concurrency limit")).toHaveValue("2");
  await expect(settings.getByLabel("Priority")).toHaveValue("7");
  await expect(settings.getByLabel("Commit author name")).toHaveValue(
    "Web Shop Owner",
  );
  await expect(settings.getByLabel("Commit author email")).toHaveValue(
    "owner@example.com",
  );
  await expect(
    settings.getByLabel("Work waits for me to approve each Plan"),
  ).not.toBeChecked();
  await expect(
    settings.getByLabel(`${firstReviewer ?? ""} (Claude claude-opus-5-5)`),
  ).toBeChecked();
  await expect(rex).toBeChecked();
  await page.goto("/agent-settings?floor=web-shop");
  await expect(
    page
      .getByRole("table", { name: "Agents on Web shop" })
      .getByRole("row", { name: /Rex/ }),
  ).toContainText("Reviewerrequired reviewer");
  await page.goto("/floor-settings/web-shop");

  // A branch the repository does not have is refused, and nothing changes.
  await settings.getByLabel("Default branch").fill("nowhere");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByRole("alert")).toHaveText(
    'adrianeyre/web-shop has no branch "nowhere".',
  );
});

test("adds a second coder; removing the Manager is refused", async ({
  page,
}) => {
  await page.goto("/agent-settings?floor=web-shop");
  const agents = page.getByRole("table", { name: "Agents on web-shop" });
  const coders = agents.getByRole("row", { name: /Coder/ });
  await expect(coders).toHaveCount(1);
  const [first] = await coders.getByRole("rowheader").allTextContents();

  const add = page.getByRole("form", { name: "Add an Agent" });
  await expect(add.getByLabel("Role")).toHaveValue("coder");
  await add.getByLabel("Name").fill("Hopper");
  await add.getByRole("button", { name: "Add Agent" }).click();
  await expect(
    page.getByText(
      "Added Hopper, a coder Agent. Choose its AI Provider and Model below.",
    ),
  ).toBeVisible();
  // Its editor is open, to make it its own.
  const editor = page.getByRole("form", { name: "Edit Hopper" });
  await expect(editor).toBeVisible();
  await editor.getByLabel("Effort").selectOption("high");
  await editor.getByRole("button", { name: "Save Hopper" }).click();
  await expect(editor.getByRole("status")).toContainText("Saved.");

  // Two coders, kept: the first, and Hopper with its own Gateway Key.
  await page.reload();
  await expect(coders).toHaveCount(2);
  await expect(coders.getByRole("rowheader")).toHaveText([
    first ?? "",
    "Hopper",
  ]);
  await expect(agents.getByRole("row", { name: /Hopper/ })).toContainText(
    /aio_gk_/,
  );
  await expect(page.getByLabel("Coder", { exact: true })).toHaveValue("2");

  // The Manager cannot be removed: its Remove is disabled, saying why…
  const manager = agents.getByRole("row", { name: /Manager/ });
  const [managerName] = await manager.getByRole("rowheader").allTextContents();
  const remove = manager.getByRole("button", {
    name: `Remove ${managerName ?? ""}`,
  });
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAccessibleDescription(
    "The Manager cannot be removed: every Floor has exactly one.",
  );
  // …and the API refuses it too.
  const { csrfToken } = (await (
    await page.request.get("/api/session")
  ).json()) as { csrfToken: string };
  const managerId = (
    (await (await page.request.get("/api/floors/web-shop/agents")).json()) as {
      agents: { id: string; role: string }[];
    }
  ).agents.find(({ role }) => role === "manager")?.id;
  const refused = await page.request.delete(
    `/api/floors/web-shop/agents/${managerId ?? ""}`,
    { headers: { "x-csrf-token": csrfToken } },
  );
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({
    error: "manager_not_removable",
    message: "web-shop's Manager cannot be removed: a Floor has exactly one.",
  });
  await page.reload();
  await expect(agents.getByRole("row", { name: /Manager/ })).toHaveCount(1);

  // Hopper, idle, is removed at once.
  await agents.getByRole("button", { name: "Remove Hopper" }).click();
  await agents.getByRole("button", { name: "Remove Hopper" }).click();
  await expect(page.getByText("Hopper was removed.")).toBeVisible();
  await expect(coders).toHaveCount(1);
});

test("sets coders to 3 and warns when the concurrency limit is lower", async ({
  page,
}) => {
  await page.goto("/agent-settings?floor=web-shop");
  const team = page.getByRole("form", { name: "Team size" });
  const warning = team.getByRole("status");
  await expect(team.getByLabel("Manager")).toHaveValue("1");
  await expect(team.getByLabel("Coder", { exact: true })).toHaveValue("1");
  await expect(team.getByLabel("QA", { exact: true })).toHaveValue("1");
  await expect(team.getByLabel("Docs", { exact: true })).toHaveValue("0");
  // A coder and a QA Agent: within the office's 3 sandboxes.
  await expect(warning).toHaveCount(0);

  await team.getByLabel("Coder", { exact: true }).fill("3");
  await expect(warning).toContainText(
    "web-shop would have 4 sandbox Agents (in the work, QA and docs Stages), but at most 3 sandboxes run at once under the office's concurrency limit. The rest wait their turn.",
  );
  await team.getByRole("button", { name: "Save team" }).click();
  await expect(
    page.getByText(/^Added .+, copied from the first coder\.$/),
  ).toBeVisible();

  // Three coders, each its own, kept.
  await page.reload();
  const agents = page.getByRole("table", { name: "Agents on web-shop" });
  const coders = agents.getByRole("row", { name: /Coder/ });
  await expect(coders).toHaveCount(3);
  const names = await coders.getByRole("rowheader").allTextContents();
  expect(new Set(names).size).toBe(3);
  for (const index of [0, 1, 2]) {
    await expect(coders.nth(index)).toContainText(/aio_gk_/);
  }
  await expect(team.getByLabel("Coder", { exact: true })).toHaveValue("3");
  await expect(warning).toContainText("under the office's concurrency limit");

  // A lower limit of the Floor's own is the one the warning names.
  await page.goto("/floor-settings/web-shop");
  const settings = page.getByRole("form", { name: "Floor settings" });
  await settings.getByLabel("Concurrency limit").fill("2");
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(settings.getByRole("status")).toHaveText("Saved.");
  await page.goto("/agent-settings?floor=web-shop");
  await expect(warning).toContainText(
    "web-shop would have 4 sandbox Agents (in the work, QA and docs Stages), but at most 2 sandboxes run at once under this Floor's concurrency limit.",
  );

  // Back to one coder: the warning goes.
  await team.getByLabel("Coder", { exact: true }).fill("1");
  await expect(warning).toHaveCount(0);
  await team.getByRole("button", { name: "Save team" }).click();
  await expect(page.getByText(/^Removed .+ and .+\.$/)).toBeVisible();
  await expect(coders).toHaveCount(1);
});
