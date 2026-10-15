import { agentListSchema, batchListSchema } from "@ai-office/shared";

import { expect, signIn, test } from "../support/office.ts";

// A Batch command drafts a Plan (PRD FR-25 (1), §5 scenario 1), in a real
// browser against the built app, Postgres and a fake GitHub. With plan
// approval off, "complete issues 1 and 2" in the Manager chat makes a
// Batch, whose Plan is kept, and its work starts at once: both issues go
// into the pipeline, and their tasks reach the (stand-in) sandboxes. There
// is no AI Account here, so the Manager's Model cannot be asked: AI
// Office's own rules draft the Plan, and triage the issues.

test('"complete issues 1 and 2" with plan approval off: the Plan is kept, shown in the chat, and work starts', async ({
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

  // Plan approval off, in the Floor's settings.
  await page
    .getByLabel("Work waits for me to approve each Plan")
    .setChecked(false);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  for (const title of ["Add a basket", "Add a wish list"]) {
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

  await page.getByRole("link", { name: "Chat with the Manager" }).click();
  const chat = page.getByRole("log", { name: "Manager chat" });
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText(
    "Live",
  );
  const box = page.getByLabel(/^Message /);
  await box.fill("complete issues 1 and 2");
  await box.press("Enter");

  const answer = chat.locator('[data-kind="command"]');
  await expect(answer).toContainText(
    `Understood: complete 2 issues: #1 and #2. Batch 1: ${manager?.name ?? ""} drafted its Plan (version 1) by AI Office's rules.`,
  );
  await expect(answer).toContainText(
    `1. #1 Add a basket: ${coder?.name ?? ""}.`,
  );
  await expect(answer).toContainText("In parallel: #1 and #2.");
  await expect(answer).toContainText(
    "Plan approval is off for this Floor, so work has started on #1 and #2.",
  );

  // Both tasks reached the sandboxes, as the Plan gave them out.
  await expect
    .poll(async () =>
      (await office.sandboxTasks()).map(({ issue }) => issue).sort(),
    )
    .toEqual([1, 2]);

  // The Batch and its Plan are kept, with every field.
  const { batches } = batchListSchema.parse(
    await (await page.request.get("/api/floors/web-shop/batches")).json(),
  );
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({
    id: 1,
    issues: [1, 2],
    status: "in_progress",
    agentId: manager?.id,
    started: [1, 2],
    plan: {
      version: 1,
      draftedBy: "rules",
      items: [
        { issue: 1, title: "Add a basket", dependsOn: [], files: [] },
        { issue: 2, title: "Add a wish list", dependsOn: [], files: [] },
      ],
      overlaps: [],
      parallel: [[1, 2]],
      leftOut: [],
    },
  });
  expect(batches[0]?.plan.summary).toContain(
    "AI Office's rules drafted this Plan",
  );

  // The Owner is told on the Notice Board, and the Activity Feed has it.
  await page.getByRole("link", { name: "Notices" }).click();
  await expect(
    page.getByText(
      "Batch started on web-shop: 2 issues, work started on #1 and #2",
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    page.getByText("Batch 1 started: work started on #1 and #2."),
  ).toBeVisible();
});
