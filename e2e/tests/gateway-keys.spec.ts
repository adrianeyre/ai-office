import { expect, makeGatewayKey, signIn, test } from "../support/office.ts";

// Gateway Keys (PRD FR-46, ADR 0001), in a real browser against the built
// app, Postgres and the server's own AI Gateway: the Gateway refuses a
// request without a key in use, a key made in AI Settings is shown once and
// works, its use shows, and once revoked it is refused.

const countTokens = (gatewayURL: string, headers: Record<string, string>) =>
  fetch(`${gatewayURL}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
  });

test("makes a Gateway Key for a tool, uses it, then revokes it", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  expect((await countTokens(office.gatewayURL, {})).status).toBe(401);

  await page.getByRole("link", { name: "AI Settings" }).click();
  const key = await makeGatewayKey(page, "Codex");
  expect(key).toMatch(/^aio_gk_/);
  const tools = page.getByRole("list", { name: "Owner tools' Gateway Keys" });
  const codex = tools.getByRole("listitem", { name: "Codex" });
  await expect(codex).toContainText("Never used");
  // Shown once: not after a reload.
  await page.reload();
  await expect(codex).toBeVisible();
  expect(await page.content()).not.toContain(key);

  // It gets past the Gateway's check (no AI Account yet, so a 503).
  expect(
    (await countTokens(office.gatewayURL, { authorization: `Bearer ${key}` }))
      .status,
  ).toBe(503);
  await page.reload();
  await expect(codex).toContainText("Last used");

  await page.getByRole("button", { name: "Revoke Codex" }).click();
  await page.getByRole("button", { name: "Yes, revoke Codex" }).click();
  await expect(page.getByText("No keys for your own tools yet.")).toBeVisible();
  expect(
    (await countTokens(office.gatewayURL, { "x-api-key": key })).status,
  ).toBe(401);
  expect(office.log()).toContain("A Gateway Key was revoked.");
  expect(office.log()).not.toContain(key);
});
