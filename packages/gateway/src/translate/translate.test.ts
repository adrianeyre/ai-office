import { describe, expect, it } from "vitest";

import { chatToMessages } from "./chat.ts";
import {
  decodeThinking,
  encodeThinking,
  mergeTurns,
  TranslationError,
} from "./common.ts";
import { messagesToChat } from "./messages.ts";
import {
  chatRequestSchema,
  responsesRequestSchema,
  type ChatRequest,
} from "./openai.ts";
import { messagesRequestSchema } from "./anthropic.ts";
import { responsesToMessages } from "./responses.ts";
import { readSse, SseReader } from "./sse.ts";

// The translators' finer points, one at a time; the fixtures in
// `fixtures/translation/` cover whole requests and responses.

const chat = (body: Partial<ChatRequest>): ChatRequest =>
  chatRequestSchema.parse({
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: "Hi" }],
    ...body,
  });

describe("Chat Completions to Messages", () => {
  it("puts parallel tool results in one user turn, before any text", () => {
    const { messages } = chatToMessages(
      chat({
        messages: [
          { role: "user", content: "Go." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "a",
                type: "function",
                function: { name: "t", arguments: "" },
              },
              {
                id: "b",
                type: "function",
                function: { name: "t", arguments: '{"x":1}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "a", content: "A" },
          {
            role: "tool",
            tool_call_id: "b",
            content: [{ type: "text", text: "B" }],
          },
          { role: "user", content: "And?" },
        ],
      }),
    );
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Go." }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "t", input: {} },
          { type: "tool_use", id: "b", name: "t", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "A" },
          { type: "tool_result", tool_use_id: "b", content: "B" },
          { type: "text", text: "And?" },
        ],
      },
    ]);
  });

  it("maps tool choices, sampling and reasoning", () => {
    expect(chatToMessages(chat({ tool_choice: "none" })).tool_choice).toEqual({
      type: "none",
    });
    expect(
      chatToMessages(chat({ tool_choice: "required" })).tool_choice,
    ).toEqual({ type: "any" });
    const sampled = chatToMessages(
      chat({ temperature: 0.3, top_p: 0.9, max_tokens: 99, stop: ["x", "y"] }),
    );
    expect(sampled).toMatchObject({
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 99,
      stop_sequences: ["x", "y"],
    });
    expect(
      chatToMessages(chat({ reasoning_effort: "none" })),
    ).not.toHaveProperty("thinking");
    expect(
      chatToMessages(chat({ reasoning_effort: "minimal" })).output_config,
    ).toEqual({ effort: "low" });
  });

  it("sends image URLs and PDFs, and refuses what it cannot send", () => {
    const { messages } = chatToMessages(
      chat({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/a.png" },
              },
              {
                type: "file",
                file: {
                  file_data: "data:application/pdf;base64,JVBERi0=",
                  filename: "spec.pdf",
                },
              },
            ],
          },
        ],
      }),
    );
    expect(messages[0]?.content).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/a.png" },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "JVBERi0=",
        },
        title: "spec.pdf",
      },
    ]);
    expect(() =>
      chatToMessages(
        chat({
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "file:///x" } }],
            },
          ],
        }),
      ),
    ).toThrow(TranslationError);
    expect(() =>
      chatToMessages(
        chat({
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "a",
                  type: "function",
                  function: { name: "t", arguments: "{not json" },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow("A tool call's arguments are not JSON.");
  });
});

describe("Responses to Messages", () => {
  const responses = (body: object) =>
    responsesToMessages(
      responsesRequestSchema.parse({ model: "claude-opus-5-5", ...body }),
    );

  it("takes a string input as one user message", () => {
    expect(responses({ input: "Hi" }).request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);
  });

  it("drops reasoning it did not make, and gives back its own", () => {
    const own = encodeThinking({
      type: "redacted_thinking",
      data: "opaque",
    });
    const { request } = responses({
      input: [
        { role: "user", content: "Hi" },
        {
          type: "reasoning",
          summary: [],
          encrypted_content: "gAAAAAopenai-own-encrypted",
        },
        { type: "reasoning", summary: [], encrypted_content: own },
        { role: "assistant", content: "Hello." },
      ],
    });
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "Hello." },
        ],
      },
    ]);
  });

  it("skips Codex's settings and markers, which hold nothing of the conversation", () => {
    const { request } = responses({
      input: [
        { role: "user", content: "Hi" },
        { type: "configuration_update", reasoning: { effort: "high" } },
        { type: "compaction_trigger" },
      ],
    });
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);
  });

  it("gives tool outputs with images back as tool results", () => {
    const { request } = responses({
      input: [
        {
          type: "function_call_output",
          call_id: "c1",
          output: [
            { type: "input_text", text: "Screenshot:" },
            { type: "input_image", image_url: "data:image/png;base64,AAA=" },
          ],
        },
      ],
    });
    expect(request.messages[0]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "c1",
        content: [
          { type: "text", text: "Screenshot:" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA=" },
          },
        ],
      },
    ]);
  });

  it("maps a named tool choice, and refuses other kinds", () => {
    expect(
      responses({
        input: "Hi",
        tools: [{ type: "function", name: "t" }],
        tool_choice: { type: "function", name: "t" },
      }).request.tool_choice,
    ).toEqual({ type: "tool", name: "t" });
    expect(() =>
      responses({ input: "Hi", tool_choice: { type: "allowed_tools" } }),
    ).toThrow(TranslationError);
  });
});

describe("Messages to Chat Completions", () => {
  const messages = (body: object) =>
    messagesToChat(
      messagesRequestSchema.parse({
        model: "gpt-5.5",
        max_tokens: 100,
        ...body,
      }),
    );

  it("sends tool errors as tool messages, and forced tool use as required", () => {
    const chat = messages({
      system: "Be brief.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: "boom",
              is_error: true,
            },
          ],
        },
      ],
      tool_choice: { type: "any" },
      stop_sequences: ["END"],
    });
    expect(chat).toMatchObject({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "tool", tool_call_id: "c1", content: "Error: boom" },
      ],
      tool_choice: "required",
      stop: ["END"],
    });
  });

  it("refuses blocks an OpenAI-format account cannot take", () => {
    expect(() =>
      messages({
        messages: [
          {
            role: "user",
            content: [{ type: "thinking", thinking: "x", signature: "s" }],
          },
        ],
      }),
    ).toThrow(TranslationError);
  });
});

describe("the helpers", () => {
  it("round-trips Claude's thinking through encrypted_content, and nothing else", () => {
    const block = {
      type: "thinking",
      thinking: "Hm.",
      signature: "sig",
    } as const;
    expect(decodeThinking(encodeThinking(block))).toEqual(block);
    expect(decodeThinking("gAAAAA")).toBeUndefined();
    expect(decodeThinking("aio-claude-thinking:bm90IGpzb24")).toBeUndefined();
    expect(decodeThinking(null)).toBeUndefined();
  });

  it("merges turns of one role and drops empty ones", () => {
    expect(
      mergeTurns([
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "user", content: [] },
        { role: "user", content: [{ type: "text", text: "b" }] },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
  });

  it("reads server-sent events split anywhere, with \\n or \\r\\n", () => {
    const text =
      'event: a\r\ndata: {"x":"é"}\r\n\r\ndata: 1\ndata: 2\n\n: comment\n\n';
    const bytes = new TextEncoder().encode(text);
    const reader = new SseReader();
    const events = [];
    for (const byte of bytes) {
      events.push(...reader.push(new Uint8Array([byte])));
    }
    events.push(...reader.end());
    expect(events).toEqual([
      { event: "a", data: '{"x":"é"}' },
      { event: undefined, data: "1\n2" },
    ]);
    expect(readSse("data: tail")).toEqual([{ event: undefined, data: "tail" }]);
  });
});
