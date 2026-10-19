import { describe, expect, it } from "vitest";

import {
  chatStreamFromCodeAssist,
  chatToCodeAssist,
  codeAssistPath,
  codeAssistToChat,
} from "./gemini.ts";
import { chatRequestSchema } from "./openai.ts";
import { readSse } from "./sse.ts";

const context = { now: new Date("2026-10-19T12:00:00Z") };

describe("a Chat Completions request for a Gemini subscription", () => {
  it("goes to Code Assist's generateContent, or its stream as SSE", () => {
    expect(codeAssistPath(false)).toBe("/v1internal:generateContent");
    expect(codeAssistPath(true)).toBe(
      "/v1internal:streamGenerateContent?alt=sse",
    );
  });

  it("names the project, and gives back each call's thought signature with its result", () => {
    // Gemini calls a tool, signing its thoughts…
    const answer = codeAssistToChat(
      {
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { name: "read", args: { path: "a.ts" } },
                    thoughtSignature: "c2lnbmVk",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
      "gemini-3.1-pro-preview",
      context,
    ).body as {
      choices: { message: { tool_calls: { id: string }[] } }[];
    };
    const callId = answer.choices[0]?.message.tool_calls[0]?.id ?? "";
    // …and the next request carries the call and its result.
    const request = chatToCodeAssist(
      chatRequestSchema.parse({
        model: "gemini-3.1-pro-preview",
        reasoning_effort: "low",
        max_tokens: 100,
        messages: [
          { role: "user", content: "Read a.ts" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: callId,
                type: "function",
                function: { name: "read", arguments: '{"path":"a.ts"}' },
              },
              {
                id: "call_unknown",
                type: "function",
                function: { name: "read", arguments: '{"path":"b.ts"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: callId, content: "export {}" },
          { role: "tool", tool_call_id: "call_unknown", content: "" },
        ],
      }),
      "project-1",
    );
    expect(request).toMatchObject({
      model: "gemini-3.1-pro-preview",
      project: "project-1",
      request: {
        contents: [
          { role: "user", parts: [{ text: "Read a.ts" }] },
          {
            role: "model",
            parts: [
              {
                functionCall: { name: "read", args: { path: "a.ts" } },
                thoughtSignature: "c2lnbmVk",
              },
              {
                functionCall: { name: "read", args: { path: "b.ts" } },
                // A call Gemini did not sign here goes back unsigned.
                thoughtSignature: "skip_thought_signature_validator",
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "read",
                  response: { content: "export {}" },
                },
              },
              { functionResponse: { name: "read", response: { content: "" } } },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 100,
          thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
        },
      },
    });
  });

  it("refuses what Gemini cannot take", () => {
    const translate = (body: unknown) => () =>
      chatToCodeAssist(chatRequestSchema.parse(body), undefined);
    expect(
      translate({
        model: "gemini-3.5-flash",
        n: 2,
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).toThrow("one choice");
    expect(
      translate({
        model: "gemini-3.5-flash",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/a.png" },
              },
            ],
          },
        ],
      }),
    ).toThrow("data URL");
    expect(
      translate({
        model: "gemini-3.5-flash",
        messages: [{ role: "tool", tool_call_id: "call_x", content: "" }],
      }),
    ).toThrow("answers no tool call");
  });
});

describe("a Code Assist stream", () => {
  it("that ends without saying why it stopped broke off", () => {
    const stream = chatStreamFromCodeAssist("gemini-3.5-flash", context, {
      includeUsage: false,
    });
    const events = readSse(
      `data: ${JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
      })}\n\n`,
    ).flatMap((event) => stream.push(event));
    expect(events).toHaveLength(2);
    expect(stream.end().join("")).toContain("ended early");
  });
});
