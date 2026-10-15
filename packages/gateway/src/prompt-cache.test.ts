import type { PromptCacheTtl } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { withPromptCacheTtl } from "./prompt-cache.ts";
import { gatewayKey, startFakeUpstream, startGateway } from "./test-support.ts";

// The prompt-cache TTL (PRD §6.8), given to every breakpoint of a request.

const json = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const parsed = (body: Buffer): unknown => JSON.parse(body.toString("utf8"));

const request = {
  model: "claude-opus-5-5",
  system: [
    {
      type: "text",
      text: "You are a coder.",
      cache_control: { type: "ephemeral" },
    },
  ],
  tools: [
    {
      name: "read",
      input_schema: { type: "object" },
      cache_control: { type: "ephemeral", ttl: "5m" },
    },
  ],
  messages: [
    { role: "user", content: "Hello" },
    {
      role: "user",
      content: [
        { type: "text", text: "Fix it.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Please." },
      ],
    },
  ],
};

describe("the prompt-cache TTL", () => {
  it("is given to every breakpoint: system, tools and messages", () => {
    const body = parsed(
      withPromptCacheTtl(json(request), "1h"),
    ) as typeof request;
    expect(body.system[0]?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(body.tools[0]?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(body.messages[1]?.content).toEqual([
      {
        type: "text",
        text: "Fix it.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      { type: "text", text: "Please." },
    ]);
    expect(body.messages[0]?.content).toBe("Hello");
  });

  it("leaves a request as sent when asked, or when there is nothing to change", () => {
    const sent = json(request);
    expect(withPromptCacheTtl(sent, "as_sent")).toBe(sent);
    const plain = json({
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(withPromptCacheTtl(plain, "1h")).toBe(plain);
    const already = json({
      model: "m",
      system: [
        {
          type: "text",
          text: "x",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      messages: [],
    });
    expect(withPromptCacheTtl(already, "5m")).toBe(already);
    const broken = Buffer.from("{not json", "utf8");
    expect(withPromptCacheTtl(broken, "1h")).toBe(broken);
  });
});

describe("the prompt-cache TTL through the Gateway", () => {
  it("is given to a request forwarded to Anthropic's API, as the setting says when it arrives", async () => {
    const upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    let ttl: PromptCacheTtl = "1h";
    const gateway = await startGateway({ upstream, promptCacheTtl: () => ttl });
    try {
      const send = () =>
        fetch(`${gateway.url}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${gatewayKey}`,
          },
          body: JSON.stringify(request),
        });
      expect((await send()).status).toBe(200);
      ttl = "as_sent";
      expect((await send()).status).toBe(200);
      const [first, second] = upstream.received.map(
        ({ body }) => JSON.parse(body) as typeof request,
      );
      expect(first?.system[0]?.cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
      expect(second).toEqual(request);
    } finally {
      await gateway.close();
      await upstream.close();
    }
  });
});
