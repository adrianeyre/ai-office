import type { OfficeEvent } from "@ai-office/events/schema";
import type { Locator } from "@playwright/test";

import { expect, signIn, test } from "../support/office.ts";

// One Agent's live view (PRD FR-58, §5 scenario 2) in a real browser,
// against the built app and Postgres. The Agent's events are published in
// the server, as its sandbox and the AI Gateway will publish them, and
// must stream into the panel without a reload.

test("an Agent's events stream into its live view", async ({
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

  // The coder's name in the Floor's settings flies to it in the Office (FR-63);
  // its live view is at its own address.
  const coder = page
    .getByRole("table", { name: "Agents on web-shop" })
    .getByRole("row")
    .filter({ hasText: "Coder" });
  const name = (await coder.getByRole("rowheader").textContent()) ?? "";
  const agentId = await agentOf(coder.getByRole("link", { name }));
  await page.goto(`/floors/web-shop/agents/${agentId}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText(/^Coder on web-shop/)).toBeVisible();
  const log = page.getByRole("log", { name: "Live activity" });
  await expect(log).toContainText("Nothing yet.");
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText(
    "Live",
  );

  await page.evaluate(() => {
    (window as unknown as { marker: string }).marker = "same page";
  });
  const subject = {
    version: 1,
    floorId: "web-shop",
    agentId,
    issue: 4,
    sandboxId: "sbx-e2e",
  } as const;
  const events: OfficeEvent[] = [
    { type: "sandbox.started", ...subject, branch: "ai-office/4-add-a-basket" },
    { type: "sandbox.text", ...subject, text: "Adding the basket page." },
    { type: "sandbox.tool_call", ...subject, name: "Bash", args: "pnpm test" },
    {
      type: "sandbox.diff",
      ...subject,
      path: "src/basket.ts",
      diff: "-export const total = 0;\n+export const total = sum(items);",
      added: 1,
      removed: 1,
    },
    {
      type: "model_call.completed",
      version: 1,
      floorId: "web-shop",
      agentId,
      issue: 4,
      aiAccount: "claude-1",
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      status: 200,
      latencyMs: 812,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
    // Another Agent's work is not this Agent's.
    {
      type: "sandbox.text",
      ...subject,
      agentId: "someone-else",
      text: "Not mine.",
    },
  ];
  for (const event of events) {
    await office.publish(event);
  }

  const lines = log.getByRole("listitem");
  await expect(lines).toHaveText([
    "Sandbox started for #4 on ai-office/4-add-a-basket",
    "Adding the basket page.",
    "Tool call: ▸ Bash pnpm test",
    /src\/basket\.ts\+1 −1-export const total = 0;\+export const total = sum\(items\);/,
    "Model call · Claude claude-opus-5-5 · 1,200 in · 300 out · 812 ms",
  ]);
  expect(
    await page.evaluate(() => (window as unknown as { marker: string }).marker),
  ).toBe("same page");

  // They are kept: a reload starts with them.
  await page.reload();
  await expect(lines).toHaveCount(5);
});

test("the live view follows new output, and pauses while the Owner reads back", async ({
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
  const coder = page
    .getByRole("table", { name: "Agents on web-shop" })
    .getByRole("row")
    .filter({ hasText: "Coder" });
  const agentId = await agentOf(coder.getByRole("link"));
  await page.goto(`/floors/web-shop/agents/${agentId}`);
  const log = page.getByRole("log", { name: "Live activity" });
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText(
    "Live",
  );
  const say = (line: number) =>
    office.publish({
      type: "sandbox.text",
      version: 1,
      floorId: "web-shop",
      agentId,
      issue: 4,
      sandboxId: "sbx-e2e",
      text: `Line ${String(line)}`,
    });
  const distanceFromBottom = () =>
    log.evaluate(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight,
    );

  for (let line = 1; line <= 80; line += 1) {
    await say(line);
  }
  await expect(log.getByRole("listitem")).toHaveCount(80);
  // Following: at the bottom.
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);

  // Scrolled up, new output does not move the view.
  await log.hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(0);
  await say(81);
  await say(82);
  await expect(log.getByRole("listitem")).toHaveCount(82);
  expect(await log.evaluate((element) => element.scrollTop)).toBe(0);

  // Jumping to the latest follows again.
  await page.getByRole("button", { name: "Jump to latest (2 new)" }).click();
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
  await say(83);
  await expect(log.getByRole("listitem")).toHaveCount(83);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
});

/** The Agent an Agent's name links to: the Office, flying to it. */
async function agentOf(link: Locator): Promise<string> {
  await expect(link).toHaveAttribute(
    "href",
    /^\/\?floor=web-shop&inspect=agent%3A[\w-]+$/,
  );
  return (
    decodeURIComponent((await link.getAttribute("href")) ?? "").split(
      "agent:",
    )[1] ?? ""
  );
}
