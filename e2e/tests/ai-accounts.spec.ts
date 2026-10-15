import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, makeGatewayKey, signIn, test } from "../support/office.ts";

// AI Accounts in AI Settings (PRD FR-35, FR-36), in a real browser
// against the built app, Postgres and the server's own AI Gateway, which
// forwards to a fake AI Provider here. The key is typed once and never
// comes back: not to the page, not to the server's log.

const key = "sk-ant-api03-e2etestkey-Qw3Er4Ty5Ui6Op7As8Df9Gh0";

let provider: Server;
let providerURL = "";
const keysReceived: (string | undefined)[] = [];

test.beforeEach(async () => {
  keysReceived.length = 0;
  provider = createServer((request, response) => {
    keysReceived.push(request.headers["x-api-key"] as string | undefined);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 7 }));
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, "127.0.0.1", resolve);
  });
  providerURL = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;
});

test.afterEach(async () => {
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
});

/** A request through the Gateway, as an agent tool would send it. */
const countTokens = (gatewayURL: string, gatewayKey: string) =>
  fetch(`${gatewayURL}/v1/messages/count_tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": gatewayKey,
    },
    body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
  });

test("adds an AI Account, pauses it, then deletes it", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "AI Settings" }).click();
  await expect(page.getByText(/No AI Accounts yet/)).toBeVisible();
  const gatewayKey = await makeGatewayKey(page, "e2e tool");
  const count = () => countTokens(office.gatewayURL, gatewayKey);
  expect((await count()).status).toBe(503);

  // Add it.
  const form = page.getByRole("form", { name: "Add an AI Account" });
  await expect(form.getByLabel("Account type")).toHaveValue("0");
  await form.getByLabel("Name").fill("Work");
  await form.getByLabel("API key").fill(key);
  await form.getByLabel("Custom endpoint URL").fill(providerURL);
  await form.getByRole("button", { name: "Add AI Account" }).click();
  await expect(form.getByRole("status")).toHaveText(
    "Added Work. Its key is stored encrypted and will not be shown again.",
  );
  await expect(form.getByLabel("API key")).toHaveValue("");
  const accounts = page.getByRole("list", { name: "AI Accounts" });
  const work = accounts.getByRole("listitem", { name: "Work" });
  await expect(work).toContainText("Active");
  await expect(work).toContainText("Anthropic Console API key");
  await expect(work).toContainText(providerURL);

  // The Gateway serves from it at once, with its key.
  expect(await (await count()).json()).toEqual({
    input_tokens: 7,
  });
  expect(keysReceived).toEqual([key]);

  // It survives a reload, and the key is not on the page.
  await page.reload();
  await expect(work).toContainText("Active");
  expect(await page.content()).not.toContain(key);

  // Pause it: the Gateway has no account to serve from.
  await page.getByRole("button", { name: "Pause Work" }).click();
  await expect(work).toContainText("Paused");
  await expect(page.getByRole("button", { name: "Resume Work" })).toBeVisible();
  expect((await count()).status).toBe(503);
  await page.reload();
  await expect(work).toContainText("Paused");

  // Delete it.
  await page.getByRole("button", { name: "Delete Work" }).click();
  await page.getByRole("button", { name: "Yes, delete Work" }).click();
  await expect(page.getByText(/No AI Accounts yet/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/No AI Accounts yet/)).toBeVisible();
  expect((await count()).status).toBe(503);
  expect(keysReceived).toEqual([key]);

  // The changes are in the Activity Feed, without the key.
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    page.getByText("AI Gateway settings changed: aiAccounts.deleted."),
  ).toBeVisible();
  expect(await page.content()).not.toContain(key);
  expect(office.log()).toContain("An AI Account was added.");
  expect(office.log()).not.toContain(key);
});
