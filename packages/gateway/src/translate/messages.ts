import type { Usage } from "../usage.ts";
import { noUsage } from "../usage.ts";
import type { MessagesRequest } from "./anthropic.ts";
import { eventData, type StreamTranslator } from "./chat.ts";
import {
  imageUrl,
  reasoningEffortFor,
  stopReasonFor,
  text,
  TranslationError,
} from "./common.ts";
import { usageFromChat } from "./openai-usage.ts";
import { sseEvent } from "./sse.ts";

// A Messages client (`POST /v1/messages`, as Claude Code sends) served from
// an OpenAI-format AI Account: its request as a Chat Completions request,
// and the Chat Completion, whole or streamed, as a Messages response.
// Thinking blocks are Claude's own and are not sent on; nor is reasoning
// that comes back, as a Messages client would need its signature.

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessageOut =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type MessageBlock = Exclude<
  MessagesRequest["messages"][number]["content"],
  string
>[number];

const systemText = (system: MessagesRequest["system"]): string =>
  system === undefined
    ? ""
    : typeof system === "string"
      ? system
      : system.map(({ text }) => text).join("\n\n");

/** A Messages request as a Chat Completions request. */
export function messagesToChat(
  request: MessagesRequest,
): Record<string, unknown> {
  const messages: ChatMessageOut[] = [];
  const system = systemText(request.system);
  if (system !== "") {
    messages.push({ role: "system", content: system });
  }
  request.messages.forEach((message, index) => {
    const blocks: MessageBlock[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    if (message.role === "assistant") {
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const calls = blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        }));
      messages.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length === 0 ? {} : { tool_calls: calls }),
      });
      return;
    }
    // A user turn: its tool results first, each as a tool message.
    const parts: ChatContentPart[] = [];
    blocks.forEach((block, blockIndex) => {
      const param = `messages[${String(index)}].content[${String(blockIndex)}]`;
      switch (block.type) {
        case "tool_result": {
          const content = block.content ?? "";
          const text =
            typeof content === "string"
              ? content
              : content
                  .map((part) =>
                    part.type === "text" ? part.text : "[image omitted]",
                  )
                  .join("\n");
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.is_error === true ? `Error: ${text}` : text,
          });
          break;
        }
        case "text":
          parts.push({ type: "text", text: block.text });
          break;
        case "image":
          parts.push({
            type: "image_url",
            image_url: { url: imageUrl(block) },
          });
          break;
        default:
          throw new TranslationError(
            `A ${block.type} block cannot be sent to this AI Account.`,
            param,
          );
      }
    });
    if (parts.length > 0) {
      messages.push({
        role: "user",
        content: parts.every((part) => part.type === "text")
          ? parts.map((part) => (part as { text: string }).text).join("\n")
          : parts,
      });
    }
  });

  const choice = request.tool_choice;
  const effort = request.output_config?.effort;
  return {
    model: request.model,
    messages,
    max_completion_tokens: request.max_tokens,
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
              parameters: tool.input_schema,
            },
          })),
        }),
    ...(choice === undefined
      ? {}
      : {
          tool_choice:
            choice.type === "auto"
              ? "auto"
              : choice.type === "any"
                ? "required"
                : choice.type === "none"
                  ? "none"
                  : { type: "function", function: { name: choice.name } },
          ...("disable_parallel_tool_use" in choice &&
          choice.disable_parallel_tool_use === true
            ? { parallel_tool_calls: false }
            : {}),
        }),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
    ...(request.stop_sequences === undefined
      ? {}
      : { stop: request.stop_sequences }),
    ...(request.stream === true
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
    ...(effort === undefined
      ? {}
      : { reasoning_effort: reasoningEffortFor(effort) }),
    ...(request.metadata?.user_id === undefined
      ? {}
      : { user: request.metadata.user_id }),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A Messages `usage` object. */
const anthropicUsage = (usage: Usage) => ({
  input_tokens: usage.inputTokens ?? 0,
  output_tokens: usage.outputTokens ?? 0,
  cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
  cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
});

/** A whole Chat Completion as a Messages response. */
export function chatToMessage(completion: Record<string, unknown>): {
  body: unknown;
  usage: Usage;
} {
  const usage = usageFromChat(completion["usage"]);
  const choices = Array.isArray(completion["choices"])
    ? (completion["choices"] as unknown[])
    : [];
  const choice = isObject(choices[0]) ? choices[0] : {};
  const message = isObject(choice["message"]) ? choice["message"] : {};
  const content: unknown[] = [];
  if (typeof message["content"] === "string" && message["content"] !== "") {
    content.push({ type: "text", text: message["content"] });
  }
  if (typeof message["refusal"] === "string" && message["refusal"] !== "") {
    content.push({ type: "text", text: message["refusal"] });
  }
  const calls = Array.isArray(message["tool_calls"])
    ? (message["tool_calls"] as unknown[])
    : [];
  for (const call of calls) {
    if (isObject(call) && isObject(call["function"])) {
      let input: unknown;
      try {
        const args = text(call["function"]["arguments"], "");
        input = args === "" ? {} : JSON.parse(args);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: String(call["id"]),
        name: String(call["function"]["name"]),
        input,
      });
    }
  }
  return {
    usage,
    body: {
      id: `msg_${text(completion["id"], "unknown")}`,
      type: "message",
      role: "assistant",
      model: text(completion["model"], ""),
      content,
      stop_reason: stopReasonFor(
        typeof choice["finish_reason"] === "string"
          ? choice["finish_reason"]
          : null,
      ),
      stop_sequence: null,
      usage: anthropicUsage(usage),
    },
  };
}

/**
 * Reads Chat Completion chunks and writes a Messages event stream. Usage
 * comes in the last chunk, so `message_delta` is written at the end.
 */
export function messagesStreamFromChat(): StreamTranslator {
  let usage: Usage = noUsage;
  let started = false;
  let ended = false;
  let finishReason: string | null = null;
  /** The open content block: its index and kind. */
  let block:
    { index: number; kind: "text" | "tool"; call?: number } | undefined;
  let nextIndex = 0;

  const event = (type: string, data: Record<string, unknown>) =>
    sseEvent(type, { type, ...data });

  const close = (): string[] => {
    if (block === undefined) {
      return [];
    }
    const index = block.index;
    block = undefined;
    return [event("content_block_stop", { index })];
  };

  const finish = (): string[] => {
    if (ended || !started) {
      return [];
    }
    ended = true;
    return [
      ...close(),
      event("message_delta", {
        delta: {
          stop_reason: stopReasonFor(finishReason),
          stop_sequence: null,
        },
        usage: anthropicUsage(usage),
      }),
      event("message_stop", {}),
    ];
  };

  return {
    get usage() {
      return usage;
    },
    push(raw) {
      if (ended) {
        return [];
      }
      if (raw.data.trim() === "[DONE]") {
        return finish();
      }
      const data = eventData(raw);
      if (data === undefined) {
        return [];
      }
      if (isObject(data["error"])) {
        ended = true;
        return [
          event("error", {
            error: {
              type: "api_error",
              message: text(data["error"]["message"], "The stream failed."),
            },
          }),
        ];
      }
      const events: string[] = [];
      if (!started) {
        started = true;
        events.push(
          event("message_start", {
            message: {
              id: `msg_${text(data["id"], "unknown")}`,
              type: "message",
              role: "assistant",
              model: text(data["model"], ""),
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: anthropicUsage(noUsage),
            },
          }),
        );
      }
      if (data["usage"] !== undefined && data["usage"] !== null) {
        usage = usageFromChat(data["usage"]);
      }
      const choices = Array.isArray(data["choices"])
        ? (data["choices"] as unknown[])
        : [];
      const choice = isObject(choices[0]) ? choices[0] : undefined;
      if (choice === undefined) {
        return events;
      }
      const delta = isObject(choice["delta"]) ? choice["delta"] : {};
      if (typeof delta["content"] === "string" && delta["content"] !== "") {
        if (block?.kind !== "text") {
          events.push(...close());
          block = { index: nextIndex++, kind: "text" };
          events.push(
            event("content_block_start", {
              index: block.index,
              content_block: { type: "text", text: "" },
            }),
          );
        }
        events.push(
          event("content_block_delta", {
            index: block.index,
            delta: { type: "text_delta", text: delta["content"] },
          }),
        );
      }
      const calls = Array.isArray(delta["tool_calls"])
        ? (delta["tool_calls"] as unknown[])
        : [];
      for (const call of calls) {
        if (!isObject(call)) {
          continue;
        }
        const callIndex = Number(call["index"] ?? 0);
        const fn = isObject(call["function"]) ? call["function"] : {};
        if (block?.kind !== "tool" || block.call !== callIndex) {
          events.push(...close());
          block = { index: nextIndex++, kind: "tool", call: callIndex };
          events.push(
            event("content_block_start", {
              index: block.index,
              content_block: {
                type: "tool_use",
                id: text(call["id"], ""),
                name: text(fn["name"], ""),
                input: {},
              },
            }),
          );
        }
        if (typeof fn["arguments"] === "string" && fn["arguments"] !== "") {
          events.push(
            event("content_block_delta", {
              index: block.index,
              delta: {
                type: "input_json_delta",
                partial_json: fn["arguments"],
              },
            }),
          );
        }
      }
      if (typeof choice["finish_reason"] === "string") {
        finishReason = choice["finish_reason"];
      }
      return events;
    },
    end() {
      if (ended) {
        return [];
      }
      ended = true;
      return [
        event("error", {
          error: {
            type: "api_error",
            message: "The AI Provider's stream ended early.",
          },
        }),
      ];
    },
  };
}
