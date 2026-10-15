import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, signIn, test } from "../support/office.ts";

// An Agent's direct chat, in a real browser against the built app,
// Postgres and the server's own AI Gateway, which forwards to a fake AI
// Provider here. The Agent's reply streams into the chat while the AI
// Provider is still writing it, however many of the Office's live streams
// are open in the Owner's other tabs.

const key = "sk-ant-api03-e2eagentchat-Qw3Er4Ty5Ui6Op7As8Df9Gh0Jk";

const sse = (type: string, data: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const textDelta = (text: string): string =>
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } });

let provider: Server;
let providerURL = "";
let release: () => void = () => undefined;

test.beforeEach(async () => {
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Writes the first half of its answer at once, and the rest once the
  // test releases it.
  provider = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/messages") {
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: {} }));
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sse("message_start", {
          message: {
            id: "msg_e2e",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            usage: { input_tokens: 120, output_tokens: 1 },
          },
        }) +
          sse("content_block_start", {
            index: 0,
            content_block: { type: "text", text: "" },
          }) +
          textDelta("I am on "),
      );
      void released.then(() => {
        response.end(
          textDelta("issue #4.") +
            sse("content_block_stop", { index: 0 }) +
            sse("message_delta", {
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 6 },
            }) +
            sse("message_stop", {}),
        );
      });
    });
  });
  await new Promise<void>((resolve) => {
    provider.listen(0, "127.0.0.1", resolve);
  });
  providerURL = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;
});

test.afterEach(async () => {
  release();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
});

test("chats with an Agent while the Office and the Activity Feed are open in other tabs", async ({
  office,
  page,
}) => {
  // The 3D Office renders slowly without a GPU.
  test.slow();
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);

  // An AI Account for the Gateway to serve the Agents' Model from.
  await page.getByRole("link", { name: "AI Settings" }).click();
  const form = page.getByRole("form", { name: "Add an AI Account" });
  await form.getByLabel("Name").fill("Work");
  await form.getByLabel("API key").fill(key);
  await form.getByLabel("Custom endpoint URL").fill(providerURL);
  await form.getByRole("button", { name: "Add AI Account" }).click();
  await expect(form.getByRole("status")).toContainText("Added Work.");

  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await expect(page.getByText("Already a Floor")).toBeVisible();
  const team = (await (
    await page.request.get("/api/floors/web-shop/agents")
  ).json()) as { agents: { id: string; name: string; role: string }[] };
  const coder = team.agents.find(({ role }) => role === "coder");
  if (coder === undefined) {
    throw new Error("The new Floor has no coder.");
  }

  // The Office, at the coder's card, and the Activity Feed, in other tabs:
  // each follows the live event stream, as the Owner's own tabs would.
  // A browser opens at most six connections to the server, and each open
  // stream holds one for as long as it is open.
  const officeTab = await page.context().newPage();
  await officeTab.goto(`/?floor=web-shop&inspect=agent:${coder.id}`);
  await expect(
    officeTab.getByRole("button", { name: `Chat with ${coder.name}` }),
  ).toBeVisible({ timeout: 15_000 });
  const activityTab = await page.context().newPage();
  await activityTab.goto("/activity");

  await page.goto(`/floors/web-shop/agents/${coder.id}/chat`);
  const chat = page.getByRole("log", { name: `Chat with ${coder.name}` });
  const status = page.getByRole("status", { name: "Connection" });
  await expect(status).toHaveText("Live");

  // The message is sent, and the reply streams in while the AI Provider
  // still holds the rest of it.
  await page.getByLabel(`Message ${coder.name}`).fill("What are you on?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(chat.locator('[data-kind="owner"]')).toContainText(
    "What are you on?",
  );
  const writing = chat.locator('[data-kind="pending"]');
  await expect(writing).toContainText("I am on");
  await expect(status).toHaveText(`${coder.name} is answering…`);

  release();
  await expect(chat.locator('[data-kind="reply"]')).toContainText(
    "I am on issue #4.",
  );
  await expect(writing).toHaveCount(0);
  await expect(status).toHaveText("Live");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByLabel(`Message ${coder.name}`).fill("Thanks");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});
