import type { Usage } from "../usage.ts";
import { noUsage } from "../usage.ts";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageParam,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
} from "./anthropic.ts";
import { eventData, type StreamTranslator } from "./chat.ts";
import {
  decodeThinking,
  defaultMaxTokens,
  effortFor,
  encodeThinking,
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
import type {
  CompactRequest,
  ResponsesContentPart,
  ResponsesToolOutputPart,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
} from "./openai.ts";
import { sseEvent } from "./sse.ts";

// A Responses client (`POST /v1/responses`, as Codex sends) served from an
// Anthropic-format AI Account: its request as a Messages request, and the
// Messages response, whole or streamed, as a Response. Claude's thinking
// comes back as reasoning items whose `encrypted_content` carries the
// thinking block, so a client that sends them back (as Codex does, with
// `store: false`) gives Claude its thinking back unchanged.
//
// Custom tools (free-form input, such as Codex's `apply_patch`) are sent
// as tools taking one string, `input`, and come back as custom tool calls.

/** What a translation of one Responses request needs to remember. */
export interface ResponsesTranslation {
  readonly request: AnthropicRequest;
  /** The names of the request's custom (free-form) tools. */
  readonly customTools: ReadonlySet<string>;
  /** The client's request, echoed in the Response. */
  readonly echo: Record<string, unknown>;
}

const customToolSchema = {
  type: "object",
  properties: {
    input: { type: "string", description: "The tool's input, as free text." },
  },
  required: ["input"],
};

function toolsFor(tools: readonly ResponsesTool[] | undefined): {
  tools: AnthropicTool[];
  custom: Set<string>;
} {
  const custom = new Set<string>();
  const translated = (tools ?? []).map((tool, index): AnthropicTool => {
    const param = `tools[${String(index)}]`;
    if (tool.type === "function" && "name" in tool) {
      const description = tool.description;
      return {
        name: String(tool.name),
        ...(typeof description === "string" ? { description } : {}),
        input_schema: tool.parameters ?? { type: "object", properties: {} },
      };
    }
    if (tool.type === "custom" && "name" in tool) {
      const name = String(tool.name);
      custom.add(name);
      const format = tool.format as
        { type?: string; syntax?: string; definition?: string } | undefined;
      const description = [
        typeof tool.description === "string" ? tool.description : "",
        format?.type === "grammar" && format.definition !== undefined
          ? `The input must follow this ${format.syntax ?? ""} grammar:\n${format.definition}`
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      return {
        name,
        ...(description === "" ? {} : { description }),
        input_schema: customToolSchema,
      };
    }
    throw new TranslationError(
      `The ${tool.type} tool cannot be used with this AI Account.`,
      param,
    );
  });
  return { tools: translated, custom };
}

function toolChoiceFor(
  request: CompactRequest,
): AnthropicToolChoice | undefined {
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
  if (
    (choice.type === "function" || choice.type === "custom") &&
    "name" in choice
  ) {
    return { type: "tool", name: String(choice.name), ...parallel };
  }
  throw new TranslationError(
    `A tool choice of type ${choice.type} cannot be used with this AI Account.`,
    "tool_choice",
  );
}

function contentFor(
  parts: string | readonly (ResponsesContentPart | ResponsesToolOutputPart)[],
  param: string,
): AnthropicContentBlock[] {
  if (typeof parts === "string") {
    return parts === "" ? [] : [{ type: "text", text: parts }];
  }
  return parts.flatMap((part, index): AnthropicContentBlock[] => {
    const at = `${param}[${String(index)}]`;
    switch (part.type) {
      case "input_text":
      case "output_text":
        return part.text === "" ? [] : [{ type: "text", text: part.text }];
      case "refusal":
        return [{ type: "text", text: part.refusal }];
      case "input_image":
        if (typeof part.image_url !== "string") {
          throw new TranslationError(
            "Images must be given by URL for this AI Account, not by file id.",
            at,
          );
        }
        return [imageBlock(part.image_url, at)];
      case "input_file": {
        const data =
          part.file_data === undefined
            ? undefined
            : parseDataUrl(part.file_data);
        if (data?.mediaType !== "application/pdf") {
          throw new TranslationError(
            "Only PDF files given as base64 data URLs can be sent to this AI Account.",
            at,
          );
        }
        return [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: data.mediaType,
              data: data.data,
            },
            ...(part.filename === undefined ? {} : { title: part.filename }),
          },
        ];
      }
      case "input_audio":
        throw new TranslationError(
          "Audio input cannot be sent to this AI Account.",
          at,
        );
      case "encrypted_content":
        throw new TranslationError(
          "Encrypted tool output cannot be sent to this AI Account.",
          at,
        );
    }
  });
}

/** A tool's output (text, or text and images) as a tool result's content. */
function toolOutput(
  output: Extract<
    ResponsesInputItem,
    { type: "function_call_output" }
  >["output"],
  param: string,
): AnthropicToolResultBlock["content"] {
  if (typeof output === "string") {
    return output;
  }
  return contentFor(output, param).filter(
    (block) => block.type === "text" || block.type === "image",
  );
}

/** The input items as Messages turns, and any system text among them. */
function messagesFor(input: CompactRequest["input"]): {
  system: AnthropicTextBlock[];
  messages: AnthropicMessageParam[];
} {
  const system: AnthropicTextBlock[] = [];
  const messages: AnthropicMessageParam[] = [];
  if (input === undefined) {
    return { system, messages };
  }
  if (typeof input === "string") {
    return {
      system,
      messages: [{ role: "user", content: [{ type: "text", text: input }] }],
    };
  }
  input.forEach((item, index) => {
    const param = `input[${String(index)}]`;
    if (
      !("type" in item) ||
      item.type === undefined ||
      item.type === "message"
    ) {
      const message = item;
      const content = contentFor(message.content, `${param}.content`);
      if (message.role === "system" || message.role === "developer") {
        system.push(
          ...content.filter(
            (block): block is AnthropicTextBlock => block.type === "text",
          ),
        );
      } else {
        messages.push({ role: message.role, content });
      }
      return;
    }
    switch (item.type) {
      case "function_call":
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: item.call_id,
              name: item.name,
              input: parseArguments(item.arguments, `${param}.arguments`),
            },
          ],
        });
        return;
      case "custom_tool_call":
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: item.call_id,
              name: item.name,
              input: { input: item.input },
            },
          ],
        });
        return;
      case "function_call_output":
      case "custom_tool_call_output":
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: item.call_id,
              content: toolOutput(item.output, `${param}.output`),
            },
          ],
        });
        return;
      case "reasoning": {
        // Only Claude's own thinking, carried by this Gateway, goes back.
        const thinking = decodeThinking(item.encrypted_content);
        if (thinking !== undefined) {
          messages.push({ role: "assistant", content: [thinking] });
        }
        return;
      }
      // Codex's settings and markers, with nothing of the conversation.
      case "configuration_update":
      case "compaction_trigger":
        return;
      default:
        throw new TranslationError(
          `Input items of type ${item.type} cannot be sent to this AI Account.`,
          `${param}.type`,
        );
    }
  });
  return { system, messages };
}

/** What the Responses formats share, as a Messages request. */
function translate(
  request: CompactRequest,
  stream: boolean,
): ResponsesTranslation {
  if (request.previous_response_id != null) {
    throw new TranslationError(
      "This AI Account keeps no responses: send the whole conversation, with store: false, instead of previous_response_id.",
      "previous_response_id",
    );
  }
  if (request.conversation !== undefined) {
    throw new TranslationError(
      "This AI Account keeps no conversations: send the whole conversation.",
      "conversation",
    );
  }
  if (request.background === true) {
    throw new TranslationError(
      "Background responses are not available from this AI Account.",
      "background",
    );
  }
  if (request.prompt !== undefined) {
    throw new TranslationError(
      "Stored prompts are not available from this AI Account.",
      "prompt",
    );
  }
  const format = request.text?.format?.type;
  if (format !== undefined && format !== "text") {
    throw new TranslationError(
      "Only text responses are available from this AI Account.",
      "text.format",
    );
  }
  const { tools, custom } = toolsFor(request.tools);
  const { system, messages } = messagesFor(request.input);
  if (typeof request.instructions === "string" && request.instructions !== "") {
    system.unshift({ type: "text", text: request.instructions });
  }
  const effort = effortFor(request.reasoning?.effort);
  const toolChoice = toolChoiceFor(request);
  return {
    customTools: custom,
    echo: {
      instructions: request.instructions ?? null,
      max_output_tokens: request.max_output_tokens ?? null,
      metadata: request.metadata ?? {},
      parallel_tool_calls: request.parallel_tool_calls ?? true,
      reasoning: {
        effort: request.reasoning?.effort ?? null,
        summary: request.reasoning?.summary ?? null,
      },
      store: false,
      temperature: request.temperature ?? null,
      text: { format: { type: "text" } },
      tool_choice: request.tool_choice ?? "auto",
      tools: request.tools ?? [],
      top_p: request.top_p ?? null,
      truncation: request.truncation ?? "disabled",
    },
    request: {
      model: request.model,
      max_tokens: request.max_output_tokens ?? defaultMaxTokens,
      messages: mergeTurns(messages),
      ...(system.length === 0 ? {} : { system }),
      ...(tools.length === 0 ? {} : { tools }),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(request.temperature == null
        ? {}
        : { temperature: request.temperature }),
      ...(request.top_p == null ? {} : { top_p: request.top_p }),
      ...(stream ? { stream: true } : {}),
      ...(effort === undefined
        ? {}
        : {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort },
          }),
      ...(request.user === undefined
        ? {}
        : { metadata: { user_id: request.user } }),
    },
  };
}

/** A Responses request as a Messages request. */
export const responsesToMessages = (
  request: ResponsesRequest,
): ResponsesTranslation => translate(request, request.stream === true);

/** What the model is asked when a conversation is compacted. */
export const compactInstruction =
  "Your context is about to be compacted. Write a summary of the conversation so far for yourself to carry on from, in place of everything before this message: the task, what has been done, what is in progress, the next steps, the decisions made and why, and the files touched. Write only the summary.";

/**
 * A compaction request (`POST /v1/responses/compact`) as a Messages
 * request that asks the model for a summary of the conversation.
 */
export function compactToMessages(
  request: CompactRequest,
): ResponsesTranslation {
  const translation = translate(
    { ...request, tools: undefined, tool_choice: undefined },
    false,
  );
  return {
    ...translation,
    request: {
      ...translation.request,
      messages: mergeTurns([
        ...translation.request.messages,
        { role: "user", content: [{ type: "text", text: compactInstruction }] },
      ]),
    },
  };
}

/** A Responses `usage` object. */
export const responsesUsage = (usage: Usage) => {
  const input = promptTokens(usage);
  const output = usage.outputTokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheReadInputTokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
};

const createdAt = (context: TranslationContext): number =>
  Math.floor(context.now.getTime() / 1000);

/** The id of the Response for a Messages response's id. */
const responseId = (messageId: string): string => `resp_${messageId}`;

/** An output item's id: its kind, the message and the block's index. */
const itemId = (prefix: string, messageId: string, index: number): string =>
  `${prefix}_${messageId.replace(/^msg_/, "")}_${String(index)}`;

/** One content block as a Response output item. */
function outputItem(
  block: AnthropicContentBlock,
  messageId: string,
  index: number,
  customTools: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  switch (block.type) {
    case "text":
      return {
        type: "message",
        id: itemId("msg", messageId, index),
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      };
    case "thinking":
    case "redacted_thinking":
      return {
        type: "reasoning",
        id: itemId("rs", messageId, index),
        summary:
          block.type === "thinking" && block.thinking !== ""
            ? [{ type: "summary_text", text: block.thinking }]
            : [],
        encrypted_content: encodeThinking(block),
      };
    case "tool_use":
      return customTools.has(block.name)
        ? {
            type: "custom_tool_call",
            id: itemId("ctc", messageId, index),
            status: "completed",
            call_id: block.id,
            name: block.name,
            input: customInput(block.input),
          }
        : {
            type: "function_call",
            id: itemId("fc", messageId, index),
            status: "completed",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          };
    default:
      return undefined;
  }
}

/** A custom tool's free-form input, from `{ input }`. */
const customInput = (input: unknown): string =>
  typeof input === "object" &&
  input !== null &&
  "input" in input &&
  typeof input.input === "string"
    ? input.input
    : JSON.stringify(input);

/** The Response's status, and why it is incomplete if it is. */
const statusFor = (stopReason: string | null) =>
  stopReason === "max_tokens"
    ? {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }
    : stopReason === "refusal"
      ? {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }
      : { status: "completed", incomplete_details: null };

function response(
  translation: ResponsesTranslation,
  context: TranslationContext,
  fields: {
    id: string;
    model: string;
    status: Record<string, unknown>;
    output: unknown[];
    usage: Usage | null;
  },
) {
  return {
    id: fields.id,
    object: "response",
    created_at: createdAt(context),
    ...fields.status,
    error: null,
    model: fields.model,
    output: fields.output,
    previous_response_id: null,
    ...translation.echo,
    usage: fields.usage === null ? null : responsesUsage(fields.usage),
  };
}

/** A whole Messages response as a Response. */
export function messageToResponse(
  message: AnthropicMessage,
  translation: ResponsesTranslation,
  context: TranslationContext,
): { body: unknown; usage: Usage } {
  const usage = usageFromAnthropic(message.usage);
  const output = message.content.flatMap((block, index) => {
    const item = outputItem(block, message.id, index, translation.customTools);
    return item === undefined ? [] : [item];
  });
  return {
    usage,
    body: response(translation, context, {
      id: responseId(message.id),
      model: message.model,
      status: statusFor(message.stop_reason),
      output,
      usage,
    }),
  };
}

/**
 * A summary from the model as the answer to a compaction: the user's own
 * messages, kept word for word, then the summary. The client replaces the
 * conversation with this output. (OpenAI's own answer carries an opaque
 * compaction item in place of the summary.)
 */
export function messageToCompaction(
  message: AnthropicMessage,
  request: CompactRequest,
  context: TranslationContext,
): { body: unknown; usage: Usage } {
  const usage = usageFromAnthropic(message.usage);
  const summary = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const kept = (
    typeof request.input === "string"
      ? [{ type: "message", role: "user", content: request.input }]
      : (request.input ?? [])
  ).filter(
    (item) =>
      (!("type" in item) ||
        item.type === undefined ||
        item.type === "message") &&
      "role" in item &&
      item.role === "user",
  );
  return {
    usage,
    body: {
      id: `cmp_${message.id}`,
      object: "response.compaction",
      created_at: createdAt(context),
      output: [
        ...kept,
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `Summary of the conversation so far:\n\n${summary}`,
            },
          ],
        },
      ],
      usage: responsesUsage(usage),
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One content block while it streams. */
interface OpenBlock {
  readonly kind: "text" | "thinking" | "redacted_thinking" | "tool_use";
  readonly outputIndex: number;
  readonly id: string;
  text: string;
  signature: string;
  readonly data: string;
  readonly callId: string;
  readonly name: string;
  readonly custom: boolean;
}

/**
 * Reads a Messages event stream and writes Responses events, from
 * `response.created` to `response.completed` (or `response.incomplete`,
 * or `response.failed`).
 */
export function responsesStreamFromMessages(
  translation: ResponsesTranslation,
  context: TranslationContext,
): StreamTranslator {
  let messageId = "msg_unknown";
  let model = "";
  let usage: Usage = noUsage;
  let stopReason: string | null = null;
  let sequence = 0;
  let ended = false;
  const output: Record<string, unknown>[] = [];
  const open = new Map<number, OpenBlock>();

  const emit = (type: string, fields: Record<string, unknown>): string =>
    sseEvent(type, { type, sequence_number: sequence++, ...fields });

  const current = (status: Record<string, unknown>, withUsage: boolean) =>
    response(translation, context, {
      id: responseId(messageId),
      model,
      status,
      output,
      usage: withUsage ? usage : null,
    });

  const failed = (code: string, message: string): string[] => {
    if (ended) {
      return [];
    }
    ended = true;
    return [
      emit("response.failed", {
        response: {
          ...current({ status: "failed", incomplete_details: null }, true),
          error: { code, message },
        },
      }),
    ];
  };

  const start = (index: number, block: Record<string, unknown>): string[] => {
    const type = block["type"];
    const outputIndex = output.length;
    if (type === "text") {
      const id = itemId("msg", messageId, index);
      open.set(index, {
        kind: "text",
        outputIndex,
        id,
        text: "",
        signature: "",
        data: "",
        callId: "",
        name: "",
        custom: false,
      });
      const item = {
        type: "message",
        id,
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      output.push(item);
      return [
        emit("response.output_item.added", { output_index: outputIndex, item }),
        emit("response.content_part.added", {
          item_id: id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      ];
    }
    if (type === "thinking" || type === "redacted_thinking") {
      const id = itemId("rs", messageId, index);
      open.set(index, {
        kind: type,
        outputIndex,
        id,
        text: "",
        signature: "",
        data: typeof block["data"] === "string" ? block["data"] : "",
        callId: "",
        name: "",
        custom: false,
      });
      const item = { type: "reasoning", id, summary: [] };
      output.push(item);
      return [
        emit("response.output_item.added", { output_index: outputIndex, item }),
        ...(type === "thinking"
          ? [
              emit("response.reasoning_summary_part.added", {
                item_id: id,
                output_index: outputIndex,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
              }),
            ]
          : []),
      ];
    }
    if (type === "tool_use") {
      const name = String(block["name"]);
      const custom = translation.customTools.has(name);
      const id = itemId(custom ? "ctc" : "fc", messageId, index);
      const callId = String(block["id"]);
      open.set(index, {
        kind: "tool_use",
        outputIndex,
        id,
        text: "",
        signature: "",
        data: "",
        callId,
        name,
        custom,
      });
      const item = custom
        ? {
            type: "custom_tool_call",
            id,
            status: "in_progress",
            call_id: callId,
            name,
            input: "",
          }
        : {
            type: "function_call",
            id,
            status: "in_progress",
            call_id: callId,
            name,
            arguments: "",
          };
      output.push(item);
      return [
        emit("response.output_item.added", { output_index: outputIndex, item }),
      ];
    }
    return [];
  };

  const delta = (index: number, data: Record<string, unknown>): string[] => {
    const block = open.get(index);
    if (block === undefined) {
      return [];
    }
    const type = data["type"];
    if (type === "text_delta" && typeof data["text"] === "string") {
      block.text += data["text"];
      return [
        emit("response.output_text.delta", {
          item_id: block.id,
          output_index: block.outputIndex,
          content_index: 0,
          delta: data["text"],
        }),
      ];
    }
    if (type === "thinking_delta" && typeof data["thinking"] === "string") {
      block.text += data["thinking"];
      return [
        emit("response.reasoning_summary_text.delta", {
          item_id: block.id,
          output_index: block.outputIndex,
          summary_index: 0,
          delta: data["thinking"],
        }),
      ];
    }
    if (type === "signature_delta" && typeof data["signature"] === "string") {
      block.signature += data["signature"];
      return [];
    }
    if (
      type === "input_json_delta" &&
      typeof data["partial_json"] === "string"
    ) {
      block.text += data["partial_json"];
      // A custom tool's input is known only once its JSON is whole.
      return block.custom
        ? []
        : [
            emit("response.function_call_arguments.delta", {
              item_id: block.id,
              output_index: block.outputIndex,
              delta: data["partial_json"],
            }),
          ];
    }
    return [];
  };

  const stop = (index: number): string[] => {
    const block = open.get(index);
    if (block === undefined) {
      return [];
    }
    open.delete(index);
    const at = { item_id: block.id, output_index: block.outputIndex };
    let item: Record<string, unknown>;
    const events: string[] = [];
    if (block.kind === "text") {
      const part = { type: "output_text", text: block.text, annotations: [] };
      item = {
        type: "message",
        id: block.id,
        status: "completed",
        role: "assistant",
        content: [part],
      };
      events.push(
        emit("response.output_text.done", {
          ...at,
          content_index: 0,
          text: block.text,
        }),
        emit("response.content_part.done", { ...at, content_index: 0, part }),
      );
    } else if (
      block.kind === "thinking" ||
      block.kind === "redacted_thinking"
    ) {
      const thinking =
        block.kind === "thinking"
          ? ({
              type: "thinking",
              thinking: block.text,
              signature: block.signature,
            } as const)
          : ({ type: "redacted_thinking", data: block.data } as const);
      item = {
        type: "reasoning",
        id: block.id,
        summary:
          block.text === "" ? [] : [{ type: "summary_text", text: block.text }],
        encrypted_content: encodeThinking(thinking),
      };
      if (block.kind === "thinking") {
        const part = { type: "summary_text", text: block.text };
        events.push(
          emit("response.reasoning_summary_text.done", {
            ...at,
            summary_index: 0,
            text: block.text,
          }),
          emit("response.reasoning_summary_part.done", {
            ...at,
            summary_index: 0,
            part,
          }),
        );
      }
    } else {
      const input =
        block.text === "" ? {} : (JSON.parse(block.text) as unknown);
      if (block.custom) {
        const text = customInput(input);
        item = {
          type: "custom_tool_call",
          id: block.id,
          status: "completed",
          call_id: block.callId,
          name: block.name,
          input: text,
        };
        events.push(
          emit("response.custom_tool_call_input.delta", { ...at, delta: text }),
          emit("response.custom_tool_call_input.done", { ...at, input: text }),
        );
      } else {
        const args = JSON.stringify(input);
        item = {
          type: "function_call",
          id: block.id,
          status: "completed",
          call_id: block.callId,
          name: block.name,
          arguments: args,
        };
        events.push(
          emit("response.function_call_arguments.done", {
            ...at,
            arguments: args,
          }),
        );
      }
    }
    output[block.outputIndex] = item;
    events.push(
      emit("response.output_item.done", {
        output_index: block.outputIndex,
        item,
      }),
    );
    return events;
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
          messageId = text(message["id"], messageId);
          model = text(message["model"], "");
          if (isObject(message["usage"])) {
            usage = usageFromAnthropic(message["usage"]);
          }
          const status = { status: "in_progress", incomplete_details: null };
          return [
            emit("response.created", { response: current(status, false) }),
            emit("response.in_progress", { response: current(status, false) }),
          ];
        }
        case "content_block_start":
          return isObject(data["content_block"])
            ? start(Number(data["index"]), data["content_block"])
            : [];
        case "content_block_delta":
          return isObject(data["delta"])
            ? delta(Number(data["index"]), data["delta"])
            : [];
        case "content_block_stop":
          try {
            return stop(Number(data["index"]));
          } catch {
            return failed(
              "server_error",
              "The AI Provider sent a tool call whose input is not JSON.",
            );
          }
        case "message_delta": {
          const change = isObject(data["delta"]) ? data["delta"] : {};
          if (typeof change["stop_reason"] === "string") {
            stopReason = change["stop_reason"];
          }
          usage = mergeAnthropicUsage(usage, data["usage"]);
          return [];
        }
        case "message_stop": {
          ended = true;
          const status = statusFor(stopReason);
          return [
            emit(
              status.status === "completed"
                ? "response.completed"
                : "response.incomplete",
              { response: current(status, true) },
            ),
          ];
        }
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
    end: () => failed("server_error", "The AI Provider's stream ended early."),
  };
}
