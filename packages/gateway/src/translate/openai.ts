import { z } from "zod";

// The OpenAI formats the AI Gateway speaks (PRD FR-34): Chat Completions
// (`POST /v1/chat/completions`) and Responses (`POST /v1/responses` and
// `/v1/responses/compact`). Every request is checked against these before
// it goes anywhere: an unknown top-level field is refused with a 400, as
// OpenAI's own API does, rather than silently dropped. Inside, objects
// keep fields the Gateway does not know, for passthrough.

const reasoningEffort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffort>;

// Chat Completions

const chatTextPart = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});
const chatImagePart = z.looseObject({
  type: z.literal("image_url"),
  image_url: z.looseObject({ url: z.string(), detail: z.string().optional() }),
});
const chatFilePart = z.looseObject({
  type: z.literal("file"),
  file: z.looseObject({
    file_data: z.string().optional(),
    file_id: z.string().optional(),
    filename: z.string().optional(),
  }),
});
const chatAudioPart = z.looseObject({ type: z.literal("input_audio") });
const chatRefusalPart = z.looseObject({
  type: z.literal("refusal"),
  refusal: z.string(),
});

const chatUserContent = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [
      chatTextPart,
      chatImagePart,
      chatFilePart,
      chatAudioPart,
    ]),
  ),
]);
const chatTextContent = z.union([z.string(), z.array(chatTextPart)]);

export const chatToolCallSchema = z.looseObject({
  id: z.string(),
  type: z.literal("function"),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});

const chatMessage = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("system"), content: chatTextContent }),
  z.looseObject({ role: z.literal("developer"), content: chatTextContent }),
  z.looseObject({ role: z.literal("user"), content: chatUserContent }),
  z.looseObject({
    role: z.literal("assistant"),
    content: z
      .union([
        z.string(),
        z.array(z.discriminatedUnion("type", [chatTextPart, chatRefusalPart])),
      ])
      .nullable()
      .optional(),
    tool_calls: z.array(chatToolCallSchema).optional(),
    reasoning_content: z.string().optional(),
  }),
  z.looseObject({
    role: z.literal("tool"),
    tool_call_id: z.string(),
    content: chatTextContent,
  }),
  z.looseObject({ role: z.literal("function") }),
]);
export type ChatMessage = z.infer<typeof chatMessage>;

const chatTool = z.looseObject({
  type: z.literal("function"),
  function: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
    strict: z.boolean().nullable().optional(),
  }),
});

/** The body of `POST /v1/chat/completions`. */
export const chatRequestSchema = z.strictObject({
  model: z.string().min(1),
  messages: z.array(chatMessage).min(1),
  stream: z.boolean().nullable().optional(),
  stream_options: z
    .looseObject({ include_usage: z.boolean().optional() })
    .nullable()
    .optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  n: z.number().int().nullable().optional(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  tools: z.array(chatTool).optional(),
  tool_choice: z
    .union([
      z.enum(["none", "auto", "required"]),
      z.looseObject({
        type: z.literal("function"),
        function: z.looseObject({ name: z.string() }),
      }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning_effort: reasoningEffort.nullable().optional(),
  response_format: z.looseObject({ type: z.string() }).optional(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  frequency_penalty: z.number().nullable().optional(),
  presence_penalty: z.number().nullable().optional(),
  logit_bias: z.record(z.string(), z.number()).nullable().optional(),
  logprobs: z.boolean().nullable().optional(),
  top_logprobs: z.number().int().nullable().optional(),
  store: z.boolean().nullable().optional(),
  service_tier: z.string().nullable().optional(),
  modalities: z.array(z.string()).nullable().optional(),
  audio: z.unknown().optional(),
  prediction: z.unknown().optional(),
  web_search_options: z.unknown().optional(),
  verbosity: z.string().nullable().optional(),
  prompt_cache_key: z.string().optional(),
  safety_identifier: z.string().optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

// Responses

const inputText = z.looseObject({
  type: z.literal("input_text"),
  text: z.string(),
});
const outputText = z.looseObject({
  type: z.literal("output_text"),
  text: z.string(),
});
const inputImage = z.looseObject({
  type: z.literal("input_image"),
  image_url: z.string().nullable().optional(),
  file_id: z.string().nullable().optional(),
  detail: z.string().optional(),
});
const inputFile = z.looseObject({
  type: z.literal("input_file"),
  file_data: z.string().optional(),
  file_id: z.string().nullable().optional(),
  file_url: z.string().optional(),
  filename: z.string().optional(),
});
const refusal = z.looseObject({
  type: z.literal("refusal"),
  refusal: z.string(),
});
const inputAudio = z.looseObject({ type: z.literal("input_audio") });
/** A tool's output Codex keeps encrypted, for its own AI Provider. */
const encryptedContent = z.looseObject({
  type: z.literal("encrypted_content"),
  encrypted_content: z.string(),
});
const toolOutputPart = z.discriminatedUnion("type", [
  inputText,
  inputImage,
  inputFile,
  inputAudio,
  encryptedContent,
]);
export type ResponsesToolOutputPart = z.infer<typeof toolOutputPart>;

const messageContentPart = z.discriminatedUnion("type", [
  inputText,
  outputText,
  inputImage,
  inputFile,
  inputAudio,
  refusal,
]);
export type ResponsesContentPart = z.infer<typeof messageContentPart>;

const messageItem = z.looseObject({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(messageContentPart)]),
});

const functionCallItem = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
const functionCallOutputItem = z.looseObject({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.union([z.string(), z.array(toolOutputPart)]),
});
const customToolCallItem = z.looseObject({
  type: z.literal("custom_tool_call"),
  call_id: z.string(),
  name: z.string(),
  input: z.string(),
});
const customToolCallOutputItem = z.looseObject({
  type: z.literal("custom_tool_call_output"),
  call_id: z.string(),
  output: z.union([z.string(), z.array(toolOutputPart)]),
});
const reasoningItem = z.looseObject({
  type: z.literal("reasoning"),
  summary: z
    .array(z.looseObject({ type: z.string(), text: z.string() }))
    .optional(),
  content: z.unknown().optional(),
  encrypted_content: z.string().nullable().optional(),
});
/** Item types the Gateway knows of but cannot translate. */
const otherItem = z.looseObject({
  type: z.enum([
    "item_reference",
    "file_search_call",
    "web_search_call",
    "computer_call",
    "computer_call_output",
    "local_shell_call",
    "local_shell_call_output",
    "image_generation_call",
    "code_interpreter_call",
    "mcp_call",
    "mcp_list_tools",
    "mcp_approval_request",
    "mcp_approval_response",
    "compaction",
    // Codex's own, for its AI Provider.
    "additional_tools",
    "agent_message",
    "tool_search_call",
    "tool_search_output",
    "configuration_update",
    "compaction_trigger",
    "context_compaction",
  ]),
});

export const responsesInputItemSchema = z.union([
  z.discriminatedUnion("type", [
    functionCallItem,
    functionCallOutputItem,
    customToolCallItem,
    customToolCallOutputItem,
    reasoningItem,
    otherItem,
  ]),
  messageItem,
]);
export type ResponsesInputItem = z.infer<typeof responsesInputItemSchema>;

const responsesTool = z.union([
  z.looseObject({
    type: z.literal("function"),
    name: z.string(),
    description: z.string().nullable().optional(),
    parameters: z.unknown().optional(),
    strict: z.boolean().nullable().optional(),
  }),
  z.looseObject({
    type: z.literal("custom"),
    name: z.string(),
    description: z.string().optional(),
    format: z.unknown().optional(),
  }),
  z.looseObject({ type: z.string() }),
]);
export type ResponsesTool = z.infer<typeof responsesTool>;

const responsesToolChoice = z.union([
  z.enum(["none", "auto", "required"]),
  z.looseObject({ type: z.enum(["function", "custom"]), name: z.string() }),
  z.looseObject({ type: z.string() }),
]);

const responsesShape = {
  model: z.string().min(1),
  input: z.union([z.string(), z.array(responsesInputItemSchema)]).optional(),
  instructions: z.string().nullable().optional(),
  tools: z.array(responsesTool).optional(),
  tool_choice: responsesToolChoice.optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  max_tool_calls: z.number().int().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  top_logprobs: z.number().int().nullable().optional(),
  reasoning: z
    .looseObject({
      effort: reasoningEffort.nullable().optional(),
      summary: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  text: z
    .looseObject({
      format: z.looseObject({ type: z.string() }).optional(),
      verbosity: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  store: z.boolean().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  previous_response_id: z.string().nullable().optional(),
  conversation: z.unknown().optional(),
  include: z.array(z.string()).nullable().optional(),
  truncation: z.string().nullable().optional(),
  user: z.string().optional(),
  service_tier: z.string().nullable().optional(),
  prompt: z.unknown().optional(),
  prompt_cache_key: z.string().optional(),
  safety_identifier: z.string().optional(),
  background: z.boolean().nullable().optional(),
  /** What Codex says of its turn, for its AI Provider. */
  client_metadata: z.record(z.string(), z.string()).nullable().optional(),
};

/** The body of `POST /v1/responses`. */
export const responsesRequestSchema = z.strictObject({
  ...responsesShape,
  stream: z.boolean().nullable().optional(),
  stream_options: z.unknown().optional(),
});
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

/** The body of `POST /v1/responses/compact`, which is never streamed. */
export const compactRequestSchema = z.strictObject(responsesShape);
export type CompactRequest = z.infer<typeof compactRequestSchema>;

/** An error body in the OpenAI format. */
export const openAiError = (
  type: string,
  message: string,
  param: string | null = null,
  code: string | null = null,
) => ({ error: { message, type, param, code } });

/** The OpenAI error `type` for an HTTP status. */
export const openAiErrorType = (status: number): string =>
  status === 401
    ? "authentication_error"
    : status === 403
      ? "permission_error"
      : status === 404
        ? "not_found_error"
        : status === 429
          ? "rate_limit_error"
          : status >= 500
            ? "server_error"
            : "invalid_request_error";
