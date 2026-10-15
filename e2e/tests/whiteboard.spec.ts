import { agentListSchema, batchListSchema } from "@ai-office/shared";

import { expect, signIn, test } from "../support/office.ts";

// Plan approval, editing and replanning on the whiteboard (PRD FR-25.3,
// FR-49, FR-58; §5 scenario 1), in a real browser against the built app,
// Postgres and a fake GitHub. With plan approval on (a new Floor's
// default), "complete issues 1 to 3" makes a Batch whose Plan awaits
// approval: nothing starts, and an action Notice asks for it. Its "Open
// Plan" opens the Floor's whiteboard, where the Owner moves #3 to the top,
// drops #2 and writes a note on #1, then saves: the Manager replans (here
// by AI Office's rules, as there is no AI Account for its Model) as
// version 2. Approving it starts the work in the new order: #3, then #1.

test("edit then approve a Plan on the whiteboard: the Manager replans, and work starts in the new order", async ({
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
  // Plan approval is on, as for every new Floor.
  await expect(
    page.getByLabel("Work waits for me to approve each Plan"),
  ).toBeChecked();

  for (const title of ["Add a basket", "Add a wish list", "Tidy the footer"]) {
    office.github.createIssue("adrianeyre/web-shop", {
      title,
      body: "## Acceptance criteria\n\n- [ ] It works",
    });
  }
  const team = agentListSchema.parse(
    await (await page.request.get("/api/floors/web-shop/agents")).json(),
  ).agents;
  const manager = team.find(({ role }) => role === "manager");
  const coder = team.find(({ role }) => role === "coder");

  // The Batch: its Plan awaits approval, and nothing starts.
  await page.getByRole("link", { name: "Chat with the Manager" }).click();
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText(
    "Live",
  );
  const box = page.getByLabel(/^Message /);
  await box.fill("complete issues 1 to 3");
  await box.press("Enter");
  const answer = page
    .getByRole("log", { name: "Manager chat" })
    .locator('[data-kind="command"]');
  await expect(answer).toContainText(
    "Plan approval is on for this Floor, so work starts once you approve the Plan on the Floor's whiteboard, where you can first reorder, drop and annotate its issues, and I replan.",
  );
  expect(await office.sandboxTasks()).toEqual([]);

  // The action Notice opens the whiteboard on the Batch.
  await page.getByRole("link", { name: "Notices" }).click();
  const notice = page.getByRole("listitem").filter({
    hasText: "Plan awaiting approval on web-shop: Batch 1, 3 issues",
  });
  await expect(notice).toBeVisible();
  await notice.getByRole("link", { name: "Open Plan" }).click();
  await expect(page).toHaveURL(/\/floors\/web-shop\/whiteboard\?batch=1$/);
  await expect(
    page.getByRole("heading", { name: "Batch 1: Awaiting approval" }),
  ).toBeVisible();
  const issues = page
    .getByRole("list", { name: "The Plan's issues, in order" })
    .getByRole("listitem");
  await expect(issues).toHaveCount(3);
  await expect(issues.nth(0)).toContainText("#1 Add a basket");
  await expect(issues.nth(0)).toContainText(coder?.name ?? "");

  // The Owner moves #3 to the top, drops #2 and writes a note on #1.
  await page.getByRole("button", { name: "Move #3 up" }).click();
  await page.getByRole("button", { name: "Move #3 up" }).click();
  await page.getByRole("button", { name: "Drop #2" }).click();
  await page.getByLabel("Your note on #1").fill("Keep the basket small.");
  await expect(
    page.getByRole("button", { name: "Approve Plan" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save edits and replan" }).click();

  // The Manager replans, as version 2, in the Owner's order.
  await expect(
    page.getByText(
      /^Version 2, replanned by AI Office's rules after your edits to version 1,/,
    ),
  ).toBeVisible();
  await expect(issues).toHaveCount(2);
  await expect(issues.nth(0)).toContainText("#3 Tidy the footer");
  await expect(issues.nth(1)).toContainText("#1 Add a basket");
  await expect(page.getByLabel("Your note on #1")).toHaveValue(
    "Keep the basket small.",
  );
  await expect(
    page.getByText("#2 is left out: you dropped it from the Plan."),
  ).toBeVisible();
  await expect(
    page.getByText("AI Office's rules replanned your edits"),
  ).toBeVisible();
  // Still nothing has started.
  expect(await office.sandboxTasks()).toEqual([]);

  // Approving it starts the work in the new order: #3, then #1.
  await page.getByRole("button", { name: "Approve Plan" }).click();
  await expect(
    page.getByRole("heading", { name: "Batch 1: In progress" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve Plan" })).toHaveCount(
    0,
  );
  await expect
    .poll(async () => (await office.sandboxTasks()).map(({ issue }) => issue))
    .toEqual([3, 1]);
  expect(
    (await office.sandboxTasks()).every(({ agentId }) => agentId === coder?.id),
  ).toBe(true);

  // Kept as approved, with both versions.
  const { batches } = batchListSchema.parse(
    await (await page.request.get("/api/floors/web-shop/batches")).json(),
  );
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({
    id: 1,
    issues: [1, 2, 3],
    status: "in_progress",
    agentId: manager?.id,
    started: [3, 1],
    plan: {
      version: 2,
      draftedBy: "rules",
      editedFrom: 1,
      items: [
        { issue: 3, title: "Tidy the footer" },
        {
          issue: 1,
          title: "Add a basket",
          annotation: "Keep the basket small.",
        },
      ],
      leftOut: [{ issue: 2, reason: "you dropped it from the Plan" }],
    },
  });

  // Earlier versions stay on the whiteboard.
  await page.getByLabel("Version").selectOption("1");
  await expect(issues).toHaveCount(3);
  await expect(issues.nth(0)).toContainText("#1 Add a basket");

  // The meeting-room whiteboard in the 3D office shows the same Plans.
  await page.goto("/?floor=web-shop&inspect=whiteboard:web-shop");
  const panel = page.getByRole("dialog", { name: "The whiteboard" });
  // The 3D scene loads first, so the panel's Plan can be slow under load.
  await expect(
    panel.getByRole("heading", { name: "Batch 1: In progress" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    panel.getByRole("list", { name: "The Plan's issues, in order" }),
  ).toContainText("#3 Tidy the footer (started)");

  // The approval Notice is closed; the Batch started one is up.
  await page.getByRole("link", { name: "Notices" }).click();
  await expect(
    page.getByText(
      "Batch started on web-shop: 3 issues, work started on #3 and #1",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Plan awaiting approval on web-shop: Batch 1, 3 issues"),
  ).toHaveCount(0);

  // The Activity Feed records the replan and the approval.
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    page.getByText(
      `${manager?.name ?? ""} replanned the Owner's edits to version 1 as version 2 of Batch 1's Plan, by AI Office's rules: #3 and #1.`,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      `The Owner approved version 2 of Batch 1's Plan, by ${manager?.name ?? ""}.`,
    ),
  ).toBeVisible();
});
