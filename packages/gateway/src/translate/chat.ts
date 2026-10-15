import type { Usage } from "../usage.ts";
import { noUsage } from "../usage.ts";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageParam,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicToolChoice,
} from "./anthropic.ts";
import {
  defaultMaxTokens,
  effortFor,
  finishReasonFor,
  imageBlock,
  mergeTurns,
  parseArguments,
  parseDataUrl,
  promptTokens,
  TranslationError,
  mergeAnthropicUsage,
  text,
  usageFromAnthropic,
  type TranslationContext,
} from "./common.ts";
import type { ChatMessage, ChatRequest } from "./openai.ts";
import { sseEvent, type SseEvent } from "./sse.ts";

// A Chat Completions client (`POST /v1/chat/completions`) served from an
// Anthropic-format AI Account: its request as a Messages request, and the
// Messages response, whole or streamed, as a Chat Completion.

const textOf = (content: string | readonly { text: string }[]): string =>
  typeof content === "string"
    ? content
    : content.map(({ text }) => text).join("\n");

const textBlocks = (
  content: string | readonly { text: string }[],
): AnthropicTextBlock[] => {
  const text = textOf(content);
  return text === "" ? [] : [{ type: "text", text }];
};

function userContent(
  message: Extract<ChatMessage, { role: "user" }>,
  index: number,
): AnthropicContentBlock[] {
  if (typeof message.content === "string") {
    return textBlocks(message.content);
  }
  return message.content.map((part, partIndex): AnthropicContentBlock => {
    const param = `messages[${String(index)}].content[${String(partIndex)}]`;
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image_url":
        return imageBlock(part.image_url.url, param);
      case "file": {
        const data =
          part.file.file_data === undefined
            ? undefined
            : parseDataUrl(part.file.file_data);
        if (data?.mediaType !== "application/pdf") {
          throw new TranslationError(
            "Only PDF files given as base64 data URLs can be sent to this AI Account.",
            param,
          );
        }
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: data.mediaType,
            data: data.data,
          },
          ...(part.file.filename === undefined
            ? {}
            : { title: part.file.filename }),
        };
      }
      case "input_audio":
        throw new TranslationError(
          "Audio input cannot be sent to this AI Account.",
          param,
        );
    }
  });
}

function toolChoiceFor(request: ChatRequest): AnthropicToolChoice | undefined {
  const parallel =
    request.parallel_tool_calls === false
      ? { disable_parallel_tool_use: true }
      : {};
  const choice = request.tool_choice;
  if (choice === undefined) {
    return request.parallel_tool_calls === false && request.tools?.length
      ? { type: "auto", ...parallel }
      : undefined;
  }
  if (choice === "none") {
    return { type: "none" };
  }
  if (choice === "auto") {
    return { type: "auto", ...parallel };
  }
  if (choice === "required") {
    return { type: "any", ...parallel };
  }
  return { type: "tool", name: choice.function.name, ...parallel };
}

/** A Chat Completions request as a Messages request. */
export function chatToMessages(request: ChatRequest): AnthropicRequest {
  if ((request.n ?? 1) !== 1) {
    throw new TranslationError("Only one choice (n: 1) can be made.", "n");
  }
  if (request.logprobs === true) {
    throw new TranslationError(
      "Log probabilities are not available from this AI Account.",
      "logprobs",
    );
  }
  if (request.modalities?.includes("audio") === true) {
    throw new TranslationError(
      "Audio output is not available from this AI Account.",
      "modalities",
    );
  }
  if (
    request.response_format !== undefined &&
    request.response_format.type !== "text"
  ) {
    throw new TranslationError(
      "Only text responses are available from this AI Account.",
      "response_format",
    );
  }

  const system: AnthropicTextBlock[] = [];
  const messages: AnthropicMessageParam[] = [];
  request.messages.forEach((message, index) => {
    switch (message.role) {
      case "system":
      case "developer":
        system.push(...textBlocks(message.content));
        break;
      case "user":
        messages.push({ role: "user", content: userContent(message, index) });
        break;
      case "assistant": {
        const content: AnthropicContentBlock[] = [];
        if (typeof message.content === "string") {
          content.push(...textBlocks(message.content));
        } else if (message.content != null) {
          for (const part of message.content) {
            const text = part.type === "text" ? part.text : part.refusal;
            if (text !== "") {
              content.push({ type: "text", text });
            }
          }
        }
        message.tool_calls?.forEach((call, callIndex) => {
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseArguments(
              call.function.arguments,
              `messages[${String(index)}].tool_calls[${String(callIndex)}].function.arguments`,
            ),
          });
        });
        messages.push({ role: "assistant", content });
        break;
      }
      case "tool":
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: textOf(message.content),
            },
          ],
        });
        break;
      case "function":
        throw new TranslationError(
          "Function messages are no longer supported; use tool messages.",
          `messages[${String(index)}].role`,
        );
    }
  });

  const effort = effortFor(request.reasoning_effort);
  const stop =
    request.stop == null
      ? undefined
      : typeof request.stop === "string"
        ? [request.stop]
        : request.stop;
  const toolChoice = toolChoiceFor(request);
  return {
    model: request.model,
    max_tokens:
      request.max_completion_tokens ?? request.max_tokens ?? defaultMaxTokens,
    messages: mergeTurns(messages),
    ...(system.length === 0 ? {} : { system }),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map(({ function: tool }) => ({
            name: tool.name,
            ...(tool.description === undefined
              ? {}
              : { description: tool.description }),
            input_schema: tool.parameters ?? {
              type: "object",
              properties: {},
            },
          })),
        }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(request.temperature == null
      ? {}
      : { temperature: request.temperature }),
    ...(request.top_p == null ? {} : { top_p: request.top_p }),
    ...(stop === undefined ? {} : { stop_sequences: stop }),
    ...(request.stream === true ? { stream: true } : {}),
    ...(effort === undefined
      ? {}
      : {
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort },
        }),
    ...(request.user === undefined
      ? {}
      : { metadata: { user_id: request.user } }),
  };
}

/** A Chat Completions `usage` object. */
export const chatUsage = (usage: Usage) => {
  const prompt = promptTokens(usage);
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: usage.cacheReadInputTokens ?? 0 },
  };
};

const created = (context: TranslationContext): number =>
  Math.floor(context.now.getTime() / 1000);

/** A whole Messages response as a Chat Completion. */
export function messageToChat(
  message: AnthropicMessage,
  context: TranslationContext,
): { body: unknown; usage: Usage } {
  const usage = usageFromAnthropic(message.usage);
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const reasoning = message.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("");
  const toolCalls = message.content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.input) },
    }));
  return {
    usage,
    body: {
      id: `chatcmpl-${message.id}`,
      object: "chat.completion",
      created: created(context),
      model: message.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text === "" && toolCalls.length > 0 ? null : text,
            ...(reasoning === "" ? {} : { reasoning_content: reasoning }),
            ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
            refusal: null,
          },
          logprobs: null,
          finish_reason: finishReasonFor(message.stop_reason),
        },
      ],
      usage: chatUsage(usage),
    },
  };
}

/** Turns one translated stream's events into the client's events. */
export interface StreamTranslator {
  /** The client's events for one event from the AI Provider. */
  push(event: SseEvent): string[];
  /** The client's events once the AI Provider's stream has ended. */
  end(): string[];
  readonly usage: Usage;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Parses a stream event's JSON data, or undefined. */
export function eventData(
  event: SseEvent,
): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(event.data);
    return isObject(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a Messages event stream and writes Chat Completion chunks, ending
 * with `data: [DONE]`. A usage chunk comes last when the client asked for
 * one (`stream_options.include_usage`).
 */
export function chatStreamFromMessages(
  context: TranslationContext,
  options: { readonly includeUsage: boolean },
): StreamTranslator {
  let id = "chatcmpl-unknown";
  let model = "";
  let usage: Usage = noUsage;
  let finishReason: string | null = null;
  let ended = false;
  // Each tool_use block's index among the tool calls, by block index.
  const toolIndex = new Map<number, number>();

  const chunk = (delta: unknown, finish: string | null = null) =>
    sseEvent(undefined, {
      id,
      object: "chat.completion.chunk",
      created: created(context),
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });

  const finish = (): string[] => {
    if (ended) {
      return [];
    }
    ended = true;
    return [
      chunk({}, finishReason ?? "stop"),
      ...(options.includeUsage
        ? [
            sseEvent(undefined, {
              id,
              object: "chat.completion.chunk",
              created: created(context),
              model,
              choices: [],
              usage: chatUsage(usage),
            }),
          ]
        : []),
      sseEvent(undefined, "[DONE]"),
    ];
  };

  const failed = (type: string, message: string): string[] => {
    if (ended) {
      return [];
    }
    ended = true;
    return [
      sseEvent(undefined, {
        error: { message, type, param: null, code: null },
      }),
    ];
  };

  return {
    get usage() {
      return usage;
    },
    push(event) {
      const data = eventData(event);
      if (data === undefined || ended) {
        return [];
      }
      switch (data["type"]) {
        case "message_start": {
          const message = isObject(data["message"]) ? data["message"] : {};
          id = `chatcmpl-${text(message["id"], "unknown")}`;
          model = text(message["model"], "");
          if (isObject(message["usage"])) {
            usage = usageFromAnthropic(message["usage"]);
          }
          return [chunk({ role: "assistant", content: "" })];
        }
        case "content_block_start": {
          const block = isObject(data["content_block"])
            ? data["content_block"]
            : {};
          if (block["type"] !== "tool_use") {
            return [];
          }
          const index = toolIndex.size;
          toolIndex.set(Number(data["index"]), index);
          return [
            chunk({
              tool_calls: [
                {
                  index,
                  id: block["id"],
                  type: "function",
                  function: { name: block["name"], arguments: "" },
                },
              ],
            }),
          ];
        }
        case "content_block_delta": {
          const delta = isObject(data["delta"]) ? data["delta"] : {};
          if (delta["type"] === "text_delta") {
            return [chunk({ content: delta["text"] })];
          }
          if (delta["type"] === "thinking_delta") {
            return [chunk({ reasoning_content: delta["thinking"] })];
          }
          if (delta["type"] === "input_json_delta") {
            const index = toolIndex.get(Number(data["index"]));
            return index === undefined
              ? []
              : [
                  chunk({
                    tool_calls: [
                      {
                        index,
                        function: { arguments: delta["partial_json"] },
                      },
                    ],
                  }),
                ];
          }
          return [];
        }
        case "message_delta": {
          const delta = isObject(data["delta"]) ? data["delta"] : {};
          finishReason = finishReasonFor(
            typeof delta["stop_reason"] === "string"
              ? delta["stop_reason"]
              : null,
          );
          usage = mergeAnthropicUsage(usage, data["usage"]);
          return [];
        }
        case "message_stop":
          return finish();
        case "error": {
          const error = isObject(data["error"]) ? data["error"] : {};
          return failed(
            text(error["type"], "server_error"),
            text(error["message"], "The stream failed."),
          );
        }
        default:
          return [];
      }
    },
    // A stream that ends without `message_stop` broke off.
    end: () => failed("server_error", "The AI Provider's stream ended early."),
  };
}
