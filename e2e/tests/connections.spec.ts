import { serveFakeWebhook } from "@ai-office/communications/testing";

import { expect, signIn, test } from "../support/office.ts";

// Connections (PRD FR-93), in a real browser against the built app,
// Postgres and a fake webhook receiver: a generic webhook Connection is
// added from General Settings, sent a test that arrives, paused and deleted. Its
// address and secret are never shown again, nor written to the log.

test("adds a webhook Connection, sends a test, pauses and deletes it", async ({
  office,
  page,
}) => {
  const webhook = await serveFakeWebhook();
  try {
    await office.setUp();
    await signIn(page);
    await page.getByRole("link", { name: "General Settings" }).click();
    await page.getByRole("link", { name: "Manage Connections" }).click();
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();

    const form = page.getByRole("form", { name: "Add a Connection" });
    await form.getByLabel("Name").fill("Team chat");
    await form.getByLabel("Webhook address").fill(webhook.url);
    await form
      .getByLabel("Signing secret (optional)")
      .fill("whsec-e2e-0123456789abcdef");
    await form.getByRole("button", { name: "Add Connection" }).click();
    const connection = page
      .getByRole("list", { name: "Connections" })
      .getByRole("listitem", { name: "Team chat" });
    await expect(connection).toContainText("Signed with HMAC-SHA256");
    await expect(connection).toContainText("Status: Working");

    await connection
      .getByRole("button", { name: "Send test to Team chat" })
      .click();
    await expect(connection.getByRole("status")).toHaveText(
      "The test message was delivered.",
    );
    expect(webhook.received).toHaveLength(1);
    expect(webhook.received[0]?.body).toMatchObject({
      test: true,
      kind: "test",
    });
    await expect(connection).toContainText("Last delivery: Test delivered");

    await connection.getByRole("button", { name: "Pause Team chat" }).click();
    await expect(connection).toContainText("Status: Paused");
    await expect(
      connection.getByRole("button", { name: "Resume Team chat" }),
    ).toBeVisible();

    // Shown once: never after a reload.
    await page.reload();
    await expect(connection).toBeVisible();
    const content = await page.content();
    expect(content).not.toContain(new URL(webhook.url).pathname);
    expect(content).not.toContain("whsec-e2e-0123456789abcdef");

    await connection.getByRole("button", { name: "Delete Team chat" }).click();
    await connection
      .getByRole("button", { name: "Yes, delete Team chat" })
      .click();
    await expect(page.getByText("No Connections yet.")).toBeVisible();

    await page.goto("/activity");
    await expect(page.getByText('Connection "Team chat" added')).toBeVisible();
    await expect(
      page.getByText('Connection "Team chat" paused.'),
    ).toBeVisible();
    await expect(
      page.getByText('Connection "Team chat" deleted.'),
    ).toBeVisible();
    expect(office.log()).toContain("A Connection was added.");
    expect(office.log()).not.toContain(new URL(webhook.url).pathname);
    expect(office.log()).not.toContain("whsec-e2e-0123456789abcdef");
  } finally {
    await webhook.close();
  }
});
