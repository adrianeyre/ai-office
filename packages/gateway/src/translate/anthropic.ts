import { z } from "zod";

// The Anthropic Messages format (`POST /v1/messages`), as far as the AI
// Gateway translates it: what it sends to an Anthropic-format AI Account,
// and what it reads from one client (Claude Code) to call an
// OpenAI-format account.

export interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

export type AnthropicImageSource =
  | {
      readonly type: "base64";
      readonly media_type: string;
      readonly data: string;
    }
  | { readonly type: "url"; readonly url: string };

export interface AnthropicImageBlock {
  readonly type: "image";
  readonly source: AnthropicImageSource;
}

export interface AnthropicDocumentBlock {
  readonly type: "document";
  readonly source: {
    readonly type: "base64";
    readonly media_type: string;
    readonly data: string;
  };
  readonly title?: string;
}

export interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content:
    string | readonly (AnthropicTextBlock | AnthropicImageBlock)[];
  readonly is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature: string;
}

export interface AnthropicRedactedThinkingBlock {
  readonly type: "redacted_thinking";
  readonly data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export interface AnthropicMessageParam {
  readonly role: "user" | "assistant";
  readonly content: AnthropicContentBlock[];
}

export interface AnthropicTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: unknown;
}

export type AnthropicToolChoice =
  | { readonly type: "auto"; readonly disable_parallel_tool_use?: boolean }
  | { readonly type: "any"; readonly disable_parallel_tool_use?: boolean }
  | {
      readonly type: "tool";
      readonly name: string;
      readonly disable_parallel_tool_use?: boolean;
    }
  | { readonly type: "none" };

/** The effort levels Claude's adaptive thinking takes. */
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof efforts)[number];

/** A Messages request, as the Gateway writes one. */
export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: AnthropicTextBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config?: { effort: Effort };
  metadata?: { user_id: string };
}

/** A whole Messages response (`type: "message"`). */
export interface AnthropicMessage {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: string | null;
  readonly stop_sequence: string | null;
  readonly usage: AnthropicUsage;
}

export interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}

/** An error body in the Anthropic format. */
export const anthropicError = (type: string, message: string) => ({
  type: "error",
  error: { type, message },
});

// What the Gateway reads from a Messages client to translate its request
// for an OpenAI-format AI Account. Fields it cannot translate are refused
// rather than dropped; unknown ones too.

const cacheControl = z.unknown().optional();

const textBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: cacheControl,
  citations: z.unknown().optional(),
});

const imageBlock = z.object({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("base64"),
      media_type: z.string(),
      data: z.string(),
    }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
  cache_control: cacheControl,
});

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  cache_control: cacheControl,
});

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z
    .union([z.string(), z.array(z.union([textBlock, imageBlock]))])
    .optional(),
  is_error: z.boolean().optional(),
  cache_control: cacheControl,
});

const thinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

const redactedThinkingBlock = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

const messageContent = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [
      textBlock,
      imageBlock,
      toolUseBlock,
      toolResultBlock,
      thinkingBlock,
      redactedThinkingBlock,
    ]),
  ),
]);

/** A Messages request a client sends, to be translated. */
export const messagesRequestSchema = z.strictObject({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z.array(
    z.object({ role: z.enum(["user", "assistant"]), content: messageContent }),
  ),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        input_schema: z.unknown(),
        type: z.literal("custom").optional(),
        cache_control: cacheControl,
        strict: z.boolean().optional(),
        eager_input_streaming: z.boolean().optional(),
      }),
    )
    .optional(),
  tool_choice: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("auto"),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("any"),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("tool"),
        name: z.string(),
        disable_parallel_tool_use: z.boolean().optional(),
      }),
      z.object({ type: z.literal("none") }),
    ])
    .optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  thinking: z
    .object({
      type: z.enum(["adaptive", "enabled", "disabled", "between_tools"]),
      budget_tokens: z.number().optional(),
      display: z.string().optional(),
    })
    .optional(),
  output_config: z.object({ effort: z.enum(efforts).optional() }).optional(),
  metadata: z.object({ user_id: z.string().optional() }).optional(),
  cache_control: cacheControl,
  service_tier: z.string().optional(),
});
export type MessagesRequest = z.infer<typeof messagesRequestSchema>;
