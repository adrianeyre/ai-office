import { afterEach, describe, expect, it } from "vitest";

import { collapsedV1, type AccountRequest } from "./gateway.ts";
import { staticKeys } from "./keys/keys.ts";
import {
  gatewayKey,
  startFakeUpstream,
  testCaller,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";

// What the Owner's own tools need of the Gateway beyond the model calls
// themselves: a base URL given with `/v1` where AI Office's own address
// is wanted still works, and the Models can be listed.

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = undefined;
  upstream = undefined;
});

describe("collapsedV1", () => {
  it("serves a doubled /v1 as one", () => {
    expect(collapsedV1("/v1/v1/messages")).toBe("/v1/messages");
    expect(collapsedV1("/v1/v1/messages/count_tokens?beta=true")).toBe(
      "/v1/messages/count_tokens?beta=true",
    );
    expect(collapsedV1("/v1/v1")).toBe("/v1");
  });

  it("leaves every other path as it is", () => {
    expect(collapsedV1("/v1/messages")).toBe("/v1/messages");
    expect(collapsedV1("/v1/v1x")).toBe("/v1/v1x");
    expect(collapsedV1("/api/v1/v1/messages")).toBe("/api/v1/v1/messages");
  });
});

describe("a base URL that already ends in /v1", () => {
  it("serves Claude Code's /v1/v1/messages as /v1/messages", async () => {
    upstream = await startFakeUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    gateway = await startGateway({ upstream });

    const response = await fetch(`${gateway.url}/v1/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": gatewayKey,
      },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1 }),
    });

    expect(response.status).toBe(200);
    expect(upstream.received.map(({ url }) => url)).toEqual(["/v1/messages"]);
  });
});

describe("GET /v1/models", () => {
  const models = () =>
    Promise.resolve([
      {
        id: "claude-haiku-5-5",
        displayName: "Claude Haiku 5.5",
        aiProvider: "Claude",
      },
      { id: "gpt-5", displayName: null, aiProvider: "ChatGPT" },
    ]);

  it("lists the Models in OpenAI's shape", async () => {
    gateway = await startGateway({ account: undefined, models });
    const response = await fetch(`${gateway.url}/v1/models`, {
      headers: { authorization: `Bearer ${gatewayKey}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "claude-haiku-5-5",
          object: "model",
          created: 0,
          owned_by: "Claude",
        },
        { id: "gpt-5", object: "model", created: 0, owned_by: "ChatGPT" },
      ],
    });
  });

  it("lists them in Anthropic's shape for a client that sends anthropic-version", async () => {
    gateway = await startGateway({ account: undefined, models });
    const response = await fetch(`${gateway.url}/v1/models`, {
      headers: { "x-api-key": gatewayKey, "anthropic-version": "2023-06-01" },
    });

    expect(await response.json()).toEqual({
      data: [
        {
          type: "model",
          id: "claude-haiku-5-5",
          display_name: "Claude Haiku 5.5",
          created_at: "1970-01-01T00:00:00.000Z",
        },
        {
          type: "model",
          id: "gpt-5",
          display_name: "gpt-5",
          created_at: "1970-01-01T00:00:00.000Z",
        },
      ],
      has_more: false,
      first_id: "claude-haiku-5-5",
      last_id: "gpt-5",
    });
  });

  it("is empty when no Models are known", async () => {
    gateway = await startGateway({ account: undefined });
    const response = await fetch(`${gateway.url}/v1/models`, {
      headers: { authorization: `Bearer ${gatewayKey}` },
    });

    expect(await response.json()).toEqual({ object: "list", data: [] });
  });

  it("needs a Gateway Key", async () => {
    gateway = await startGateway({ account: undefined, models });
    const response = await fetch(`${gateway.url}/v1/models`);

    expect(response.status).toBe(401);
  });
});

describe("a Gateway Key limited to some AI Providers", () => {
  const limitedKey = "aio_gk_akeylimitedtosomeaiproviders00000000000";
  const keys = staticKeys({
    [gatewayKey]: testCaller,
    [limitedKey]: {
      kind: "owner_tool",
      keyId: "limited-key",
      name: "Script",
      aiProviders: ["OpenRouter"],
    },
  });

  it("asks for its calls' accounts, and its Models, of those AI Providers only", async () => {
    const asked: (readonly string[] | undefined)[] = [];
    const listed: (readonly string[] | undefined)[] = [];
    gateway = await startGateway({
      keys,
      accounts: {
        select: (request: AccountRequest) => {
          asked.push(request.aiProviders);
          return Promise.resolve(undefined);
        },
      },
      models: (aiProviders) => {
        listed.push(aiProviders);
        return Promise.resolve([]);
      },
    });
    for (const key of [gatewayKey, limitedKey]) {
      await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": key,
        },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1 }),
      });
      await fetch(`${gateway.url}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
      });
    }
    expect(asked).toEqual([undefined, ["OpenRouter"]]);
    expect(listed).toEqual([undefined, ["OpenRouter"]]);
  });
});
