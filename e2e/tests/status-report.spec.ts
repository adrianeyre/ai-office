import { agentListSchema } from "@ai-office/shared";

import { standInFailure } from "../support/control.ts";
import { expect, signIn, test } from "../support/office.ts";

// The Manager's status report (PRD FR-23, "Reporting"), in a real browser
// against the built app, Postgres and a fake GitHub. An issue is picked up
// and its work fails (the stand-in sandbox fails every task), and another
// waits for the Owner at `needs-human`. Asked "status" in the Manager chat,
// the Manager lists them, in plain code (no model is asked), and the
// report is on the Notice Board as an info Notice too.

test('"status" in the Manager chat: the report lists the blocked issue and those needing the Owner, and is an info Notice', async ({
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
  const coder = agentListSchema
    .parse(await (await page.request.get("/api/floors/web-shop/agents")).json())
    .agents.find(({ role }) => role === "coder");

  // #1 is picked up, and its work fails; #2 waits for the Owner.
  office.github.createIssue("adrianeyre/web-shop", {
    title: "Add a basket",
    body: "## Acceptance criteria\n\n- [ ] A basket page lists the products added",
    labels: ["ai-office"],
  });
  expect(await office.pollIntake()).toBe(1);
  await expect.poll(async () => (await office.sandboxTasks()).length).toBe(1);
  office.github.createIssue("adrianeyre/web-shop", {
    title: "Rework checkout",
    body: "- [ ] It works",
    labels: ["ai-office", "needs-human"],
  });
  await page.getByRole("link", { name: "Notices" }).click();
  const blockedNotice = `Agent blocked: ${coder?.name ?? ""} on #1: ${standInFailure}`;
  await expect(page.getByText(blockedNotice)).toBeVisible();

  // Asked in the chat.
  await page.goto("/floors/web-shop/manager");
  const chat = page.getByRole("log", { name: "Manager chat" });
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText(
    "Live",
  );
  const box = page.getByLabel(/^Message /);
  await box.fill("status");
  await box.press("Enter");
  const report = chat.locator('[data-kind="report"]');
  await expect(report).toContainText("Status report");
  await expect(report).toContainText(
    /Status report on web-shop, \d{4}-\d\d-\d\d \d\d:\d\d UTC\./,
  );
  await expect(report).toContainText("Blocked (1):");
  await expect(report).toContainText(
    `- #1 Add a basket (needs-work): its work at needs-work failed (${coder?.name ?? ""}), and nothing is queued again.`,
  );
  await expect(report).toContainText("Needing you (2):");
  await expect(report).toContainText(`- #1 Add a basket: ${blockedNotice}`);
  await expect(report).toContainText(
    "- #2 Rework checkout: handed to you, at needs-human.",
  );
  await expect(report).toContainText(
    /Tokens used: [\d,]+ today, [\d,]+ this month \(UTC\)\./,
  );
  // Kept in the chat.
  await page.reload();
  await expect(report).toContainText("Needing you (2):");

  // And on the Notice Board, as an info Notice: no actions, its links.
  await page.getByRole("link", { name: "Notices" }).click();
  const notice = page
    .getByRole("list", { name: "Notices" })
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", {
        name: /^Status report on web-shop: \d+ in flight, 1 blocked, 2 needing you, [\d,]+ tokens today$/,
      }),
    });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(notice.getByRole("button")).toHaveCount(1);
  await expect(
    notice.getByRole("link", { name: "The report in the Manager chat" }),
  ).toHaveAttribute("href", /\/floors\/web-shop\/manager$/);
  await expect(
    notice.getByRole("link", { name: "#2 needs you" }),
  ).toHaveAttribute("href", /\/issues\/2$/);
});
