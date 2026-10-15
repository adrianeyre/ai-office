import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { agentListSchema } from "@ai-office/shared";

import { standInFailure } from "../support/control.ts";
import { expect, signIn, test } from "../support/office.ts";

// The Agent editor in the Floor's settings (PRD FR-11, FR-12), in a real
// browser against the built app, Postgres and a fake GitHub. The Owner
// moves the coder to Grok with a Model of its own, chosen from the model
// catalogue (fetched from a fake xAI here), and the coder's next task is
// given that AI Provider and Model. Back on Claude's default, the task
// after that is given those. The server's stand-in sandbox runner records
// each task and fails it, as no Docker runs here. Each issue lists
// acceptance criteria, so the Manager's triage (PRD FR-23) lets it
// through: with no Claude AI Account, the Manager's Model cannot be asked,
// and AI Office's own rules judge it.

const xaiKey = "xai-e2etestkey-Qw3Er4Ty5Ui6Op7As8Df9Gh0";

/** An issue body clear enough to work. */
const withCriteria = (criterion: string): string =>
  `## Acceptance criteria\n\n- [ ] ${criterion}`;

let provider: Server;
let providerURL = "";

test.beforeEach(async () => {
  // xAI's models endpoint, listing two Grok Models.
  provider = createServer((request, response) => {
    request.resume();
    if (request.url?.startsWith("/v1/models") === true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "grok-4", object: "model" },
            { id: "grok-4-fast", object: "model" },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
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

test("an Agent's new AI Provider and Model are what its next task uses", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "AI Settings" }).click();

  // An xAI key, the catalogue fetched with it, and Grok's default Model.
  const account = page.getByRole("form", { name: "Add an AI Account" });
  await account.getByLabel("Account type").selectOption("xAI API key");
  await account.getByLabel("Name").fill("Grok key");
  await account.getByLabel("API key").fill(xaiKey);
  await account.getByLabel("Custom endpoint URL").fill(providerURL);
  await account.getByRole("button", { name: "Add AI Account" }).click();
  await expect(account.getByRole("status")).toContainText("Added Grok key.");
  await page
    .getByRole("button", { name: "Refresh the model catalogue" })
    .click();
  await expect(
    page.getByRole("status", { name: "Catalogue refreshed" }),
  ).toContainText("Grok (API key): 2 Models.");
  const grok = page.getByRole("form", { name: "Grok", exact: true });
  await grok.getByLabel("Default Model").selectOption("grok-4");
  await grok.getByRole("button", { name: "Save Grok's default" }).click();
  await expect(grok.getByText(/No default Model/)).toHaveCount(0);
  await expect(grok.getByLabel("Default Model")).toHaveValue("grok-4");

  // The Floor, and its coder.
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
  const agents = agentListSchema.parse(
    await (await page.request.get("/api/floors/web-shop/agents")).json(),
  ).agents;
  const coder = agents.find(({ name }) => name === coderName);
  expect(coder?.role).toBe("coder");

  // Grok, with a Model of its own.
  await page
    .getByRole("button", { name: `Edit ${coderName}`, exact: true })
    .click();
  const editor = page.getByRole("form", { name: `Edit ${coderName}` });
  await editor.getByLabel("AI Provider").selectOption("Grok");
  await editor.getByLabel("Model").selectOption("grok-4-fast");
  await editor.getByRole("button", { name: `Save ${coderName}` }).click();
  await expect(editor.getByRole("status")).toContainText(
    `Saved. ${coderName} uses the changes from`,
  );
  await expect(coderRow).toContainText(/Grok\s*grok-4-fast/);
  // Stored: the same after a reload.
  await page.reload();
  await expect(coderRow).toContainText(/Grok\s*grok-4-fast/);

  // Its next task: an issue labelled `ai-office`, picked up now.
  office.github.createIssue("adrianeyre/web-shop", {
    title: "Add a basket",
    body: withCriteria("A basket page lists the products added"),
    labels: ["ai-office"],
  });
  expect(await office.pollIntake()).toBe(1);
  await expect
    .poll(() => office.sandboxTasks())
    .toEqual([
      {
        agentId: coder?.id,
        issue: 1,
        aiProvider: "Grok",
        model: "grok-4-fast",
        effort: null,
      },
    ]);
  // The stand-in runner failed it, so the coder is blocked, as it would be.
  await page.getByRole("link", { name: "Notices" }).click();
  await expect(
    page.getByText(`Agent blocked: ${coderName} on #1: ${standInFailure}`),
  ).toBeVisible();

  // Back to Claude, on its default Model, with an effort.
  await page.goBack();
  await page
    .getByRole("button", { name: `Edit ${coderName}`, exact: true })
    .click();
  await editor.getByLabel("AI Provider").selectOption("Claude");
  await expect(editor.getByLabel("Model")).toHaveValue("");
  await editor.getByLabel("Effort").selectOption("high");
  await editor.getByRole("button", { name: `Save ${coderName}` }).click();
  await expect(coderRow).toContainText(
    /Claude\s*claude-opus-5-5\s*\(default\)/,
  );

  office.github.createIssue("adrianeyre/web-shop", {
    title: "Add a checkout",
    body: withCriteria("A checkout page takes the basket's total"),
    labels: ["ai-office"],
  });
  expect(await office.pollIntake()).toBe(1);
  await expect
    .poll(async () => (await office.sandboxTasks()).at(-1))
    .toEqual({
      agentId: coder?.id,
      issue: 2,
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      effort: "high",
    });

  // The key never reached the page or the server's log.
  expect(office.log()).not.toContain(xaiKey);
});
