import { randomUUID } from "node:crypto";

import type { Usage } from "../usage.ts";
import { chatUsage, eventData, type StreamTranslator } from "./chat.ts";
import {
  parseArguments,
  parseDataUrl,
  text,
  TranslationError,
  usageFromOpenAi,
  type TranslationContext,
} from "./common.ts";
import type { ChatMessage, ChatRequest } from "./openai.ts";
import { sseEvent } from "./sse.ts";

// A Chat Completions client (opencode) served from a Gemini subscription:
// its request as a Gemini `generateContent` request, wrapped as Google's
// Code Assist API takes it (`model`, `project` and the `request`), and
// the answer, whole or streamed, unwrapped as a Chat Completion. Gemini
// streams each part as it comes: text and thoughts in pieces, each
// function call whole.

/** Where a translated request goes on Code Assist's API. */
export const codeAssistPath = (streamed: boolean): string =>
  streamed
    ? "/v1internal:streamGenerateContent?alt=sse"
    : "/v1internal:generateContent";

type GeminiPart = Record<string, unknown>;
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Gemini signs the thoughts behind each function call it makes, and wants
 * the signature back with the call in the history, which Chat Completions
 * has no place for. They are kept here by call id, the newest few
 * thousand; a call whose signature is gone (after a restart) goes back
 * with the placeholder Google documents for history it did not make.
 */
const signatures = new Map<string, string>();
const maxSignatures = 4096;
const unsignedCall = "skip_thought_signature_validator";

const keepSignature = (id: string, signature: unknown): void => {
  if (typeof signature !== "string" || signature === "") {
    return;
  }
  signatures.delete(id);
  signatures.set(id, signature);
  for (const oldest of signatures.keys()) {
    if (signatures.size <= maxSignatures) {
      break;
    }
    signatures.delete(oldest);
  }
};

const textOf = (content: string | readonly { text: string }[]): string =>
  typeof content === "string"
    ? content
    : content.map(({ text }) => text).join("\n");

/** A data URL as inline data; anything else is refused. */
function inlineData(url: string, param: string, what: string): GeminiPart {
  const data = parseDataUrl(url);
  if (data === undefined) {
    throw new TranslationError(
      `${what} must be a base64 data URL for this AI Account.`,
      param,
    );
  }
  return { inlineData: { mimeType: data.mediaType, data: data.data } };
}

function userParts(
  message: Extract<ChatMessage, { role: "user" }>,
  index: number,
): GeminiPart[] {
  if (typeof message.content === "string") {
    return message.content === "" ? [] : [{ text: message.content }];
  }
  return message.content.map((part, partIndex): GeminiPart => {
    const param = `messages[${String(index)}].content[${String(partIndex)}]`;
    switch (part.type) {
      case "text":
        return { text: part.text };
      case "image_url":
        return inlineData(part.image_url.url, param, "An image");
      case "file":
        return inlineData(part.file.file_data ?? "", param, "A file");
      case "input_audio":
        throw new TranslationError(
          "Audio input cannot be sent to this AI Account.",
          param,
        );
    }
  });
}

/** `contents` with consecutive turns of one role merged, as Gemini wants. */
function mergeContents(contents: readonly GeminiContent[]): GeminiContent[] {
  const merged: GeminiContent[] = [];
  for (const content of contents) {
    if (content.parts.length === 0) {
      continue;
    }
    const last = merged.at(-1);
    if (last?.role === content.role) {
      last.parts.push(...content.parts);
    } else {
      merged.push({ role: content.role, parts: [...content.parts] });
    }
  }
  return merged;
}

/** How hard a Model thinks, as Gemini 3 (a level) or 2.5 (a budget) asks. */
function thinkingFor(request: ChatRequest): Record<string, unknown> {
  const effort = request.reasoning_effort;
  const config: Record<string, unknown> = { includeThoughts: true };
  if (effort == null || effort === "none") {
    return config;
  }
  if (/^gemini-[3-9]/.test(request.model)) {
    return {
      ...config,
      thinkingLevel: effort === "minimal" || effort === "low" ? "low" : "high",
    };
  }
  const budgets = { minimal: 512, low: 2048, medium: 8192, high: 24_576 };
  return {
    ...config,
    thinkingBudget: budgets[effort === "xhigh" ? "high" : effort],
  };
}

/** The response format a Chat Completions request asks for, as Gemini's. */
function responseFormatFor(request: ChatRequest): Record<string, unknown> {
  const format = request.response_format;
  if (format?.type === "json_object") {
    return { responseMimeType: "application/json" };
  }
  if (format?.type === "json_schema") {
    const schema = (format as { json_schema?: { schema?: unknown } })
      .json_schema?.schema;
    return {
      responseMimeType: "application/json",
      ...(schema === undefined ? {} : { responseJsonSchema: schema }),
    };
  }
  return {};
}

/**
 * A Chat Completions request as a Code Assist `generateContent` request,
 * for the Code Assist project the account is set up with (`project`).
 */
export function chatToCodeAssist(
  request: ChatRequest,
  project: string | undefined,
): Record<string, unknown> {
  if (request.n != null && request.n > 1) {
    throw new TranslationError(
      "This AI Account answers with one choice only.",
      "n",
    );
  }
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  // Each call's function, by its id: a tool result names the function.
  const called = new Map<string, string>();
  request.messages.forEach((message, index) => {
    switch (message.role) {
      case "system":
      case "developer":
        system.push(textOf(message.content));
        return;
      case "user":
        contents.push({ role: "user", parts: userParts(message, index) });
        return;
      case "assistant": {
        const parts: GeminiPart[] = [];
        if (message.reasoning_content) {
          parts.push({ text: message.reasoning_content, thought: true });
        }
        const said =
          message.content == null
            ? ""
            : typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) =>
                    part.type === "text" ? part.text : part.refusal,
                  )
                  .join("");
        if (said !== "") {
          parts.push({ text: said });
        }
        message.tool_calls?.forEach((call, callIndex) => {
          called.set(call.id, call.function.name);
          parts.push({
            functionCall: {
              name: call.function.name,
              args: parseArguments(
                call.function.arguments,
                `messages[${String(index)}].tool_calls[${String(callIndex)}].function.arguments`,
              ),
            },
            thoughtSignature: signatures.get(call.id) ?? unsignedCall,
          });
        });
        contents.push({ role: "model", parts });
        return;
      }
      case "tool": {
        const name = called.get(message.tool_call_id);
        if (name === undefined) {
          throw new TranslationError(
            "A tool result answers no tool call before it.",
            `messages[${String(index)}].tool_call_id`,
          );
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name,
                response: { content: textOf(message.content) },
              },
            },
          ],
        });
        return;
      }
      case "function":
        throw new TranslationError(
          "Function messages are not supported; use tool messages.",
          `messages[${String(index)}]`,
        );
    }
  });
  const stop =
    request.stop == null
      ? undefined
      : typeof request.stop === "string"
        ? [request.stop]
        : request.stop;
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  const choice = request.tool_choice;
  const toolConfig =
    choice === undefined
      ? undefined
      : {
          functionCallingConfig:
            choice === "none"
              ? { mode: "NONE" }
              : choice === "auto"
                ? { mode: "AUTO" }
                : choice === "required"
                  ? { mode: "ANY" }
                  : {
                      mode: "ANY",
                      allowedFunctionNames: [choice.function.name],
                    },
        };
  const generationConfig = {
    ...(maxTokens == null ? {} : { maxOutputTokens: maxTokens }),
    ...(request.temperature == null
      ? {}
      : { temperature: request.temperature }),
    ...(request.top_p == null ? {} : { topP: request.top_p }),
    ...(stop === undefined ? {} : { stopSequences: stop }),
    ...(request.seed == null ? {} : { seed: request.seed }),
    ...(request.presence_penalty == null
      ? {}
      : { presencePenalty: request.presence_penalty }),
    ...(request.frequency_penalty == null
      ? {}
      : { frequencyPenalty: request.frequency_penalty }),
    ...responseFormatFor(request),
    thinkingConfig: thinkingFor(request),
  };
  return {
    model: request.model,
    ...(project === undefined ? {} : { project }),
    user_prompt_id: randomUUID(),
    request: {
      contents: mergeContents(contents),
      ...(system.length === 0
        ? {}
        : { systemInstruction: { parts: [{ text: system.join("\n\n") }] } }),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.function.name,
                  ...(tool.function.description === undefined
                    ? {}
                    : { description: tool.function.description }),
                  ...(tool.function.parameters === undefined
                    ? {}
                    : { parametersJsonSchema: tool.function.parameters }),
                })),
              },
            ],
          }),
      ...(toolConfig === undefined ? {} : { toolConfig }),
      generationConfig,
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The `response` Code Assist wraps Gemini's answer in. */
const unwrap = (body: Record<string, unknown>): Record<string, unknown> =>
  isObject(body["response"]) ? body["response"] : body;

/** The record's usage from Gemini's `usageMetadata`. */
function usageFromGemini(metadata: unknown): Usage | undefined {
  if (!isObject(metadata)) {
    return undefined;
  }
  const output =
    (typeof metadata["candidatesTokenCount"] === "number"
      ? metadata["candidatesTokenCount"]
      : 0) +
    (typeof metadata["thoughtsTokenCount"] === "number"
      ? metadata["thoughtsTokenCount"]
      : 0);
  return usageFromOpenAi(
    metadata["promptTokenCount"],
    output,
    metadata["cachedContentTokenCount"],
  );
}

/** Why Gemini stopped, as Chat Completions says it. */
const finishReasonOf = (reason: unknown, called: boolean): string | null => {
  if (typeof reason !== "string" || reason === "") {
    return null;
  }
  if (called) {
    return "tool_calls";
  }
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    default:
      return "stop";
  }
};

/** A Gemini answer's first candidate's parts, read. */
function partsOf(answer: Record<string, unknown>): {
  text: string;
  thoughts: string;
  calls: { id: string; name: string; arguments: string }[];
  finishReason: unknown;
} {
  const candidates = Array.isArray(answer["candidates"])
    ? answer["candidates"]
    : [];
  const candidate: unknown = candidates[0];
  const content =
    isObject(candidate) && isObject(candidate["content"])
      ? candidate["content"]
      : {};
  const parts = Array.isArray(content["parts"])
    ? content["parts"].filter(isObject)
    : [];
  let said = "";
  let thoughts = "";
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (const part of parts) {
    if (isObject(part["functionCall"])) {
      const call = part["functionCall"];
      const id = `call_${text(call["id"]) || randomUUID().replaceAll("-", "")}`;
      keepSignature(id, part["thoughtSignature"]);
      calls.push({
        id,
        name: text(call["name"]),
        arguments: JSON.stringify(call["args"] ?? {}),
      });
    } else if (typeof part["text"] === "string") {
      if (part["thought"] === true) {
        thoughts += part["text"];
      } else {
        said += part["text"];
      }
    }
  }
  return {
    text: said,
    thoughts,
    calls,
    finishReason: isObject(candidate) ? candidate["finishReason"] : undefined,
  };
}

const created = (context: TranslationContext): number =>
  Math.floor(context.now.getTime() / 1000);

const idOf = (answer: Record<string, unknown>): string =>
  `chatcmpl-${text(answer["responseId"]) || randomUUID()}`;

/** A whole Code Assist answer as a Chat Completion. */
export function codeAssistToChat(
  body: Record<string, unknown>,
  model: string,
  context: TranslationContext,
): { body: unknown; usage: Usage } {
  const answer = unwrap(body);
  const usage =
    usageFromGemini(answer["usageMetadata"]) ?? usageFromOpenAi(0, 0, 0);
  const read = partsOf(answer);
  return {
    usage,
    body: {
      id: idOf(answer),
      object: "chat.completion",
      created: created(context),
      model: text(answer["modelVersion"], model),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              read.text === "" && read.calls.length > 0 ? null : read.text,
            ...(read.thoughts === ""
              ? {}
              : { reasoning_content: read.thoughts }),
            ...(read.calls.length === 0
              ? {}
              : {
                  tool_calls: read.calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }),
            refusal: null,
          },
          logprobs: null,
          finish_reason:
            finishReasonOf(read.finishReason, read.calls.length > 0) ?? "stop",
        },
      ],
      usage: chatUsage(usage),
    },
  };
}

/**
 * Reads a Code Assist event stream and writes Chat Completion chunks,
 * ending with `data: [DONE]`. A usage chunk comes last when the client
 * asked for one (`stream_options.include_usage`). Gemini's stream simply
 * ends: one that ends before saying why it stopped broke off.
 */
export function chatStreamFromCodeAssist(
  model: string,
  context: TranslationContext,
  options: { readonly includeUsage: boolean },
): StreamTranslator {
  let id: string | undefined;
  let usage: Usage = usageFromOpenAi(0, 0, 0);
  let finishReason: string | null = null;
  let toolCalls = 0;
  let ended = false;

  const chunk = (delta: unknown, finish: string | null = null) =>
    sseEvent(undefined, {
      id,
      object: "chat.completion.chunk",
      created: created(context),
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });

  return {
    get usage() {
      return usage;
    },
    push(event) {
      const data = eventData(event);
      if (data === undefined || ended) {
        return [];
      }
      if (isObject(data["error"])) {
        ended = true;
        return [
          sseEvent(undefined, {
            error: {
              message: text(data["error"]["message"], "The stream failed."),
              type: "server_error",
              param: null,
              code: null,
            },
          }),
        ];
      }
      const answer = unwrap(data);
      const events: string[] = [];
      if (id === undefined) {
        id = idOf(answer);
        model = text(answer["modelVersion"], model);
        events.push(chunk({ role: "assistant", content: "" }));
      }
      usage = usageFromGemini(answer["usageMetadata"]) ?? usage;
      const read = partsOf(answer);
      if (read.thoughts !== "") {
        events.push(chunk({ reasoning_content: read.thoughts }));
      }
      if (read.text !== "") {
        events.push(chunk({ content: read.text }));
      }
      for (const call of read.calls) {
        events.push(
          chunk({
            tool_calls: [
              {
                index: toolCalls,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          }),
        );
        toolCalls += 1;
      }
      finishReason =
        finishReasonOf(read.finishReason, toolCalls > 0) ?? finishReason;
      return events;
    },
    end() {
      if (ended) {
        return [];
      }
      ended = true;
      if (finishReason === null) {
        return [
          sseEvent(undefined, {
            error: {
              message: "The AI Provider's stream ended early.",
              type: "server_error",
              param: null,
              code: null,
            },
          }),
        ];
      }
      return [
        chunk({}, finishReason),
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
    },
  };
}
