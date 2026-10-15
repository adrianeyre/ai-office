import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiFormat } from "./gateway.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  type FakeUpstream,
  type RunningGateway,
} from "./test-support.ts";
import { readSse } from "./translate/sse.ts";

// The OpenAI endpoints (PRD FR-34) and their refusals: what is checked
// before anything is forwarded, what cannot be translated, and streams
// that fail part-way.

let upstream: FakeUpstream | undefined;
let gateway: RunningGateway | undefined;
let requestLog = memoryRequestLog();

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = undefined;
  upstream = undefined;
});

/** A Gateway in front of a fake AI Provider that answers `body`. */
async function serve(
  apiFormat: ApiFormat,
  body = "{}",
  contentType = "application/json",
  status = 200,
): Promise<string> {
  upstream = await startFakeUpstream((_request, response) => {
    response.writeHead(status, { "content-type": contentType });
    response.end(body);
  });
  requestLog = memoryRequestLog();
  gateway = await startGateway({ upstream, requestLog, apiFormat });
  return gateway.url;
}

const post = (url: string, path: string, body: unknown, key = gatewayKey) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const chat = {
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content: "Hi" }],
};

describe("checking OpenAI-format requests", () => {
  it.each<[ApiFormat]>([["anthropic"], ["openai"]])(
    "refuses an unknown top-level field with a 400, whatever the account (%s)",
    async (format) => {
      const url = await serve(format);
      for (const [path, body] of [
        ["/v1/chat/completions", { ...chat, temprature: 1 }],
        ["/v1/responses", { model: "m", input: "Hi", frobnicate: true }],
        ["/v1/responses/compact", { model: "m", input: "Hi", stream: true }],
      ] as const) {
        const response = await post(url, path, body);
        expect(response.status, path).toBe(400);
        const answer = (await response.json()) as {
          error: { type: string; message: string; param: string };
        };
        expect(answer.error.type).toBe("invalid_request_error");
        expect(answer.error.message).toMatch(
          /^Unrecognized request argument supplied: /,
        );
        expect(answer.error.param).toMatch(/^(temprature|frobnicate|stream)$/);
      }
      expect(upstream?.received).toEqual([]);
      await vi.waitFor(() => {
        expect(requestLog.records).toHaveLength(3);
      });
      expect(requestLog.records.map(({ status }) => status)).toEqual([
        400, 400, 400,
      ]);
    },
  );

  it("refuses a body that is not JSON, or fields of the wrong shape", async () => {
    const url = await serve("anthropic");
    const notJson = await post(url, "/v1/chat/completions", "{nope");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({
      error: { message: "The request body is not valid JSON." },
    });
    const wrong = await post(url, "/v1/chat/completions", {
      ...chat,
      messages: "Hi",
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: { param: "messages" } });
    expect(upstream?.received).toEqual([]);
  });

  it("answers a missing Gateway Key in the caller's format", async () => {
    const url = await serve("anthropic");
    const response = await post(url, "/v1/responses", { model: "m" }, "");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { type: "authentication_error", param: null },
    });
  });
});

describe("what cannot be translated", () => {
  it.each([
    ["/v1/chat/completions", { ...chat, n: 2 }, "n"],
    ["/v1/chat/completions", { ...chat, logprobs: true }, "logprobs"],
    [
      "/v1/chat/completions",
      { ...chat, response_format: { type: "json_object" } },
      "response_format",
    ],
    [
      "/v1/chat/completions",
      {
        ...chat,
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: "x" } }],
          },
        ],
      },
      "messages[0].content[0]",
    ],
    [
      "/v1/responses",
      { model: "m", input: "Hi", previous_response_id: "resp_1" },
      "previous_response_id",
    ],
    [
      "/v1/responses",
      { model: "m", input: "Hi", tools: [{ type: "web_search" }] },
      "tools[0]",
    ],
    [
      "/v1/responses",
      { model: "m", input: [{ type: "item_reference", id: "msg_1" }] },
      "input[0].type",
    ],
    [
      "/v1/responses",
      {
        model: "m",
        input: [{ type: "tool_search_call", execution: "client" }],
      },
      "input[0].type",
    ],
    [
      "/v1/responses",
      {
        model: "m",
        input: [
          {
            role: "user",
            content: [{ type: "input_audio", audio_url: "data:," }],
          },
        ],
      },
      "input[0].content[0]",
    ],
    [
      "/v1/responses",
      {
        model: "m",
        input: [
          {
            type: "function_call_output",
            call_id: "c1",
            output: [{ type: "encrypted_content", encrypted_content: "x" }],
          },
        ],
      },
      "input[0].output[0]",
    ],
  ])(
    "refuses %s with %j when the account speaks Messages",
    async (path, body, param) => {
      const url = await serve("anthropic");
      const response = await post(url, path, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: "invalid_request_error", param },
      });
      expect(upstream?.received).toEqual([]);
    },
  );

  it("passes the same request through to an account that speaks it", async () => {
    const url = await serve("openai", JSON.stringify({ id: "resp_2" }));
    const body = { model: "m", input: "Hi", previous_response_id: "resp_1" };
    const response = await post(url, "/v1/responses", body);
    expect(response.status).toBe(200);
    expect(upstream?.received[0]?.body).toBe(JSON.stringify(body));
  });

  it("passes Codex's own items and metadata through to an account that speaks them", async () => {
    const url = await serve("openai", JSON.stringify({ id: "resp_2" }));
    const body = {
      model: "m",
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Hi" },
            { type: "input_audio", audio_url: "data:audio/wav;base64,AA==" },
          ],
        },
        {
          type: "tool_search_call",
          call_id: "ts_1",
          execution: "client",
          arguments: { query: "goal" },
        },
        {
          type: "tool_search_output",
          call_id: "ts_1",
          status: "completed",
          execution: "client",
          tools: [],
        },
        {
          type: "function_call_output",
          call_id: "fc_1",
          output: [{ type: "encrypted_content", encrypted_content: "x" }],
        },
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/a",
          content: [],
        },
        { type: "configuration_update", reasoning: { effort: "high" } },
        { type: "compaction_trigger" },
        { type: "context_compaction", encrypted_content: "x" },
      ],
      client_metadata: { "x-codex-installation-id": "i" },
    };
    const response = await post(url, "/v1/responses", body);
    expect(response.status).toBe(200);
    expect(upstream?.received[0]?.body).toBe(JSON.stringify(body));
  });

  it("refuses token counting from an OpenAI-format account, in the Anthropic format", async () => {
    const url = await serve("openai");
    const response = await post(url, "/v1/messages/count_tokens", {
      model: "m",
      messages: [],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Token counting is not available from this AI Account.",
      },
    });
  });

  it("refuses a Messages request it cannot read for an OpenAI-format account", async () => {
    const url = await serve("openai");
    const response = await post(url, "/v1/messages", {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "Hi" }],
      container: "x",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  it("gives an OpenAI-format account's error to a Messages caller in the Anthropic format", async () => {
    const url = await serve(
      "openai",
      JSON.stringify({
        error: { message: "Bad key.", type: "invalid_api_key" },
      }),
      "application/json",
      401,
    );
    const response = await post(url, "/v1/messages", {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Bad key." },
    });
  });
});

describe("translated streams that fail", () => {
  const anthropicStream = (...events: object[]) =>
    events
      .map(
        (event) =>
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
  const start = {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  };
  const overloaded = {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  };

  it("ends a Chat Completions stream with the AI Provider's error", async () => {
    const url = await serve(
      "anthropic",
      anthropicStream(start, overloaded),
      "text/event-stream",
    );
    const response = await post(url, "/v1/chat/completions", {
      ...chat,
      stream: true,
    });
    const events = readSse(await response.text());
    expect(events.at(-1)?.data).toBe(
      JSON.stringify({
        error: {
          message: "Overloaded",
          type: "overloaded_error",
          param: null,
          code: null,
        },
      }),
    );
    expect(events.some(({ data }) => data === "[DONE]")).toBe(false);
  });

  it("fails a Responses stream with the AI Provider's error, or when it ends early", async () => {
    for (const body of [
      anthropicStream(start, overloaded),
      anthropicStream(start),
    ]) {
      const url = await serve("anthropic", body, "text/event-stream");
      const response = await post(url, "/v1/responses", {
        model: "m",
        input: "Hi",
        stream: true,
      });
      const events = readSse(await response.text());
      expect(events.map(({ event }) => event)).toEqual([
        "response.created",
        "response.in_progress",
        "response.failed",
      ]);
      const failed = JSON.parse(events[2]?.data ?? "{}") as {
        response: { status: string; error: { code: string } };
      };
      expect(failed.response.status).toBe("failed");
      expect(failed.response.error.code).toMatch(
        /^(overloaded_error|server_error)$/,
      );
      await gateway?.close();
      await upstream?.close();
    }
    gateway = undefined;
    upstream = undefined;
  });

  it("passes each translated event on as it arrives", async () => {
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    upstream = await startFakeUpstream(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(anthropicStream(start));
      await finished;
      response.end(anthropicStream({ type: "message_stop" }));
    });
    gateway = await startGateway({ upstream });
    const response = await post(gateway.url, "/v1/chat/completions", {
      ...chat,
      stream: true,
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(
      new TextDecoder().decode(first?.value as Uint8Array | undefined),
    ).toContain('"role":"assistant"');
    finish();
    let rest = "";
    for (
      let chunk = await reader?.read();
      chunk !== undefined && !chunk.done;
      chunk = await reader?.read()
    ) {
      rest += new TextDecoder().decode(chunk.value as Uint8Array);
    }
    expect(rest).toContain("data: [DONE]");
  });
});
