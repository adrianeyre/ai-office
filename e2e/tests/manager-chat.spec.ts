import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, signIn, test } from "../support/office.ts";

// The Manager chat (PRD FR-24), in a real browser against the built app,
// Postgres and the server's own AI Gateway, which forwards to a fake AI
// Provider here. Commands are answered in plain code and reach no model;
// anything else goes to the Manager's Model through the Gateway, and its
// reply streams into the page while the AI Provider is still writing it.

const key = "sk-ant-api03-e2emanagerchat-Qw3Er4Ty5Ui6Op7As8Df9Gh0";

/** What "complete issues 1 to 3" does on a repository without them. */
const noBatch = [
  "No Batch was made: none of these issues can be worked.",
  "",
  "#1: it was not found on GitHub.",
  "#2: it was not found on GitHub.",
  "#3: it was not found on GitHub.",
].join("\n");

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: {
    model?: string;
    stream?: boolean;
    system?: string;
    messages?: { role: string; content: string }[];
  };
}

const sse = (type: string, data: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const textDelta = (text: string): string =>
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } });

let provider: Server;
let providerURL = "";
let received: Received[] = [];
let release: () => void = () => undefined;

test.beforeEach(async () => {
  received = [];
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
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        headers: request.headers,
        body: JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Received["body"],
      });
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
          textDelta("Start with "),
      );
      void released.then(() => {
        response.end(
          textDelta("issue #4: the basket blocks the rest.") +
            sse("content_block_stop", { index: 0 }) +
            sse("message_delta", {
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 14 },
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

test("chats with a Floor's Manager: commands in plain code, a reply streamed in", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);

  // An AI Account for the Gateway to serve the Manager's Model from.
  await page.getByRole("link", { name: "AI Settings" }).click();
  const form = page.getByRole("form", { name: "Add an AI Account" });
  await form.getByLabel("Name").fill("Work");
  await form.getByLabel("API key").fill(key);
  await form.getByLabel("Custom endpoint URL").fill(providerURL);
  await form.getByRole("button", { name: "Add AI Account" }).click();
  await expect(form.getByRole("status")).toContainText("Added Work.");

  // A Floor, and its Manager chat from the Floor's settings.
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  await page.getByRole("link", { name: "Chat with the Manager" }).click();
  await expect(page).toHaveURL(/\/floors\/web-shop\/manager$/);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(/^Chat with \S+$/);
  const manager =
    (await heading.textContent())?.replace("Chat with ", "") ?? "";
  const chat = page.getByRole("log", { name: "Manager chat" });
  const box = page.getByLabel(`Message ${manager}`);
  const status = page.getByRole("status", { name: "Connection" });
  await expect(status).toHaveText("Live");

  // A command: answered at once with what was understood and done; no
  // model call. The Floor's repository has no issues #1 to #3, so no Batch
  // is made.
  await box.fill("complete issues 1 to 3");
  await box.press("Enter");
  await expect(chat.locator('[data-kind="command"]')).toContainText(
    `Understood: complete 3 issues: #1, #2 and #3. ${noBatch}`,
  );
  // A typo: refused with a hint; no model call either.
  await box.fill("compleet issues 1 to 3");
  await box.press("Enter");
  await expect(chat.locator('[data-kind="hint"]')).toContainText(
    'I did not understand that. Did you mean "complete issues 1 to 3"?',
  );
  expect(received).toHaveLength(0);

  // Anything else: the Manager's Model, through the Gateway. Its reply
  // streams in while the AI Provider still holds the rest of it.
  await box.fill("What should we work on first?");
  await page.getByRole("button", { name: "Send" }).click();
  const writing = chat.locator('[data-kind="pending"]');
  await expect(writing).toContainText("Start with");
  await expect(writing).not.toContainText("issue #4");
  await expect(status).toHaveText(`${manager} is answering…`);
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  expect(received).toHaveLength(1);
  const [call] = received;
  // The AI Account's key reached the AI Provider; the Manager's Gateway
  // Key did not.
  expect(call?.headers["x-api-key"]).toBe(key);
  expect(call?.body).toMatchObject({ model: "claude-opus-5-5", stream: true });
  expect(call?.body.system).toContain(
    `You are ${manager}, the Manager of the Floor "web-shop" in AI Office.`,
  );
  expect(call?.body.messages).toEqual([
    { role: "user", content: "complete issues 1 to 3" },
    {
      role: "assistant",
      content: `Understood: complete 3 issues: #1, #2 and #3. ${noBatch}`,
    },
    { role: "user", content: "compleet issues 1 to 3" },
    {
      role: "assistant",
      content:
        'I did not understand that. Did you mean "complete issues 1 to 3"?',
    },
    { role: "user", content: "What should we work on first?" },
  ]);

  release();
  const replies = chat.locator('[data-kind="reply"]');
  await expect(replies).toContainText(
    "Start with issue #4: the basket blocks the rest.",
  );
  await expect(writing).toHaveCount(0);
  await expect(status).toHaveText("Live");

  // The chat is kept for the Floor.
  await page.reload();
  await expect(chat.getByRole("listitem")).toHaveCount(6);
  await expect(replies).toContainText(
    "Start with issue #4: the basket blocks the rest.",
  );

  // The Gateway attributed the call to the Manager and its Floor (FR-42).
  const agents = (await (
    await page.request.get("/api/floors/web-shop/agents")
  ).json()) as { agents: { id: string; role: string }[] };
  const managerId = agents.agents.find(({ role }) => role === "manager")?.id;
  const requests = (await (
    await page.request.get("/api/gateway/requests?endpoint=messages")
  ).json()) as {
    requests: {
      agentId: string;
      floorId: string;
      streamed: boolean;
      status: number;
    }[];
  };
  expect(requests.requests).toEqual([
    expect.objectContaining({
      agentId: managerId,
      floorId: "web-shop",
      streamed: true,
      status: 200,
    }),
  ]);
  // The Owner's words are not logged; the key never is.
  expect(office.log()).toContain("The Owner wrote to a Floor's Manager.");
  expect(office.log()).not.toContain("What should we work on first?");
  expect(office.log()).not.toContain(key);
});
