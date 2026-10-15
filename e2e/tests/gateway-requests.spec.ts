import { expect, makeGatewayKey, signIn, test } from "../support/office.ts";

// Request history (PRD FR-44) in a real browser against the built app,
// Postgres and the server's own AI Gateway: a request made through the
// Gateway appears on the open Gateway page without a reload, its detail
// shows redacted headers and its bodies, the live log shows it, and with
// body storage off its bodies are not kept.

const sendThroughGateway = (gatewayURL: string, key: string, prompt: string) =>
  fetch(`${gatewayURL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": key,
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 16,
      messages: [{ role: "user", content: prompt }],
    }),
  });

test("the live stream shows a new request, whose detail opens", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "AI Settings" }).click();
  const key = await makeGatewayKey(page, "e2e tool");

  await page.getByRole("link", { name: "Gateway", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Gateway requests" }),
  ).toBeVisible();
  await expect(page.getByText("No requests yet.")).toBeVisible();
  await expect(page.getByText("Live.", { exact: true })).toBeVisible();

  // No AI Account, so the Gateway answers 503; it is still a request.
  const response = await sendThroughGateway(
    office.gatewayURL,
    key,
    "Hello from the end-to-end test.",
  );
  expect(response.status).toBe(503);

  // It appears without a reload.
  const row = page.getByRole("row", { name: "Request 1" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("claude-haiku-5-5");
  await expect(row).toContainText("e2e tool");
  await expect(row).toContainText("503");
  // So does the Gateway's log line for it.
  await expect(
    page
      .getByRole("list", { name: "Gateway log" })
      .getByText("A Gateway request finished."),
  ).toBeVisible();

  // Its detail: headers without the key, and both bodies (stored by default).
  await row.getByRole("link").click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Request 1" }),
  ).toBeVisible();
  const headers = page.getByRole("table", { name: "Request headers" });
  await expect(headers).toContainText("x-api-key");
  await expect(headers).toContainText("[REDACTED]");
  await expect(
    page.getByRole("region", { name: "Request body" }),
  ).toContainText("Hello from the end-to-end test.");
  await expect(
    page.getByRole("region", { name: "Response body" }),
  ).toContainText("No AI Account is available.");
  expect(await page.content()).not.toContain(key);

  // With body storage off, the next request's bodies are not kept.
  await page.getByRole("link", { name: "AI Settings" }).click();
  const storage = page.getByRole("checkbox", {
    name: "Keep request and response bodies (encrypted)",
  });
  await expect(storage).toBeChecked();
  // The checkbox changes at once; the setting is saved by the PUT after it.
  const saved = page.waitForResponse(
    (answer) =>
      answer.url().endsWith("/api/office/request-bodies") &&
      answer.request().method() === "PUT",
  );
  await storage.uncheck();
  expect((await saved).ok()).toBe(true);
  await expect(storage).not.toBeChecked();
  await sendThroughGateway(office.gatewayURL, key, "Not to be kept.");
  await page.goto("/gateway/requests/2");
  await expect(
    page.getByText(/Bodies were not kept for this request/),
  ).toBeVisible();
  expect(await page.content()).not.toContain("Not to be kept.");
  expect(office.log()).not.toContain(key);
});
