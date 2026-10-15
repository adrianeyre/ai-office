import { describe, expect, it } from "vitest";

import { StreamUsageReader, noUsage, usageFromMessage } from "./usage.ts";

const event = (name: string, data: unknown, newline = "\n") =>
  `event: ${name}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;

const stream = [
  event("message_start", {
    type: "message_start",
    message: {
      type: "message",
      usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 2000,
        output_tokens: 1,
      },
    },
  }),
  event("ping", { type: "ping" }),
  event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Grüße — ☕ message_delta" },
  }),
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 15 },
  }),
  event("message_stop", { type: "message_stop" }),
].join("");

const expected = {
  inputTokens: 25,
  outputTokens: 15,
  cacheReadInputTokens: 2000,
  cacheCreationInputTokens: 100,
};

const readAll = (text: string, chunkSize: number) => {
  const reader = new StreamUsageReader();
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    reader.push(bytes.subarray(offset, offset + chunkSize));
  }
  return reader.usage;
};

describe("StreamUsageReader", () => {
  it("reads input and cache counts from message_start and output from message_delta", () => {
    expect(readAll(stream, stream.length)).toEqual(expected);
  });

  it.each([1, 2, 3, 5, 64])(
    "reads the same however the stream is split (%i-byte chunks)",
    (chunkSize) => {
      expect(readAll(stream, chunkSize)).toEqual(expected);
    },
  );

  it("reads CRLF-separated events and data lines without a space", () => {
    const text = stream.replaceAll("\n", "\r\n").replaceAll("data: ", "data:");
    expect(readAll(text, 3)).toEqual(expected);
  });

  it("takes every count from a message_delta that carries them all", () => {
    const text =
      stream +
      event("message_delta", {
        type: "message_delta",
        usage: {
          input_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 2100,
          output_tokens: 40,
        },
      });
    expect(readAll(text, 9)).toEqual({
      inputTokens: 30,
      outputTokens: 40,
      cacheReadInputTokens: 2100,
      cacheCreationInputTokens: 0,
    });
  });

  it("keeps what it has when the stream breaks off or holds nonsense", () => {
    const text =
      stream.slice(0, stream.indexOf("event: ping")) +
      "event: message_delta\ndata: {not json\n\n" +
      event("message_delta", { type: "message_delta", usage: "lots" }) +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":';
    expect(readAll(text, 4)).toEqual({ ...expected, outputTokens: 1 });
  });

  it("has no usage for a stream without it", () => {
    expect(readAll(event("ping", { type: "ping" }), 2)).toEqual(noUsage);
  });
});

describe("usageFromMessage", () => {
  it("reads a message's usage", () => {
    expect(
      usageFromMessage(
        JSON.stringify({
          type: "message",
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 0,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: null,
    });
  });

  it.each([
    ["an error", JSON.stringify({ type: "error", error: { type: "x" } })],
    ["not JSON", "<html>Bad gateway</html>"],
    [
      "negative counts",
      JSON.stringify({ type: "message", usage: { input_tokens: -1 } }),
    ],
  ])("has no usage for %s", (_name, body) => {
    expect(usageFromMessage(body)).toEqual(noUsage);
  });
});
