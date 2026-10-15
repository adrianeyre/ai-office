import type { Usage } from "../usage.ts";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessageParam,
  AnthropicRedactedThinkingBlock,
  AnthropicThinkingBlock,
  AnthropicUsage,
  Effort,
} from "./anthropic.ts";
import type { ReasoningEffort } from "./openai.ts";

// What the translators between the OpenAI formats and Anthropic Messages
// share.

/** A request the Gateway cannot translate: answered with a 400. */
export class TranslationError extends Error {
  readonly param: string | null;

  constructor(message: string, param: string | null = null) {
    super(message);
    this.name = "TranslationError";
    this.param = param;
  }
}

/** What a translation needs besides the bodies. */
export interface TranslationContext {
  /** When the response was made, for `created` and `created_at`. */
  readonly now: Date;
}

/**
 * `max_tokens` for a request that gives none: Messages requires it, the
 * OpenAI formats do not. Generous, as agent tools write whole files.
 */
export const defaultMaxTokens = 32_000;

/** An OpenAI reasoning effort as Claude's effort, or none to leave it be. */
export function effortFor(
  effort: ReasoningEffort | null | undefined,
): Effort | undefined {
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

/** Claude's effort as an OpenAI reasoning effort. */
export const reasoningEffortFor = (effort: Effort): ReasoningEffort =>
  effort === "max" ? "xhigh" : effort;

/** `value` if it is a string, else `fallback`: for fields read from JSON. */
export const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/**
 * `previous` with the counts in an Anthropic `usage` object over it. A
 * count the object leaves out keeps its value: a stream's `message_delta`
 * may carry only `output_tokens`.
 */
export function mergeAnthropicUsage(previous: Usage, usage: unknown): Usage {
  if (typeof usage !== "object" || usage === null) {
    return previous;
  }
  const given = usage as Record<string, unknown>;
  const pick = (name: string, old: number | null): number | null =>
    typeof given[name] === "number" ? count(given[name]) : old;
  return {
    inputTokens: pick("input_tokens", previous.inputTokens),
    outputTokens: pick("output_tokens", previous.outputTokens),
    cacheReadInputTokens: pick(
      "cache_read_input_tokens",
      previous.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: pick(
      "cache_creation_input_tokens",
      previous.cacheCreationInputTokens,
    ),
  };
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

/** The record's usage from an Anthropic `usage` object. */
export const usageFromAnthropic = (usage: AnthropicUsage): Usage => ({
  inputTokens: count(usage.input_tokens),
  outputTokens: count(usage.output_tokens),
  cacheReadInputTokens: count(usage.cache_read_input_tokens),
  cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
});

/**
 * OpenAI counts every prompt token, cached or not, in its prompt total;
 * Anthropic counts cache reads and writes apart from `input_tokens`.
 */
export const promptTokens = (usage: Usage): number =>
  (usage.inputTokens ?? 0) +
  (usage.cacheReadInputTokens ?? 0) +
  (usage.cacheCreationInputTokens ?? 0);

/**
 * The record's usage from OpenAI's prompt and completion counts, and the
 * prompt's cached tokens and, where an AI Provider counts them (OpenRouter,
 * Kimi), those written to its cache.
 */
export const usageFromOpenAi = (
  prompt: unknown,
  completion: unknown,
  cached: unknown,
  written?: unknown,
): Usage => ({
  inputTokens: Math.max(0, count(prompt) - count(cached) - count(written)),
  outputTokens: count(completion),
  cacheReadInputTokens: count(cached),
  cacheCreationInputTokens: count(written),
});

/** `data:<media type>;base64,<data>` as its parts, or undefined. */
export function parseDataUrl(
  url: string,
): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match === null
    ? undefined
    : { mediaType: match[1] ?? "", data: match[2] ?? "" };
}

/** An image from a URL or a data URL, as a Messages image block. */
export function imageBlock(url: string, param: string): AnthropicImageBlock {
  const data = parseDataUrl(url);
  if (data !== undefined) {
    return {
      type: "image",
      source: { type: "base64", media_type: data.mediaType, data: data.data },
    };
  }
  if (/^https?:\/\//.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  throw new TranslationError(
    "An image must be an http(s) URL or a base64 data URL.",
    param,
  );
}

/** A Messages image block as a URL (a data URL for base64 images). */
export const imageUrl = (block: AnthropicImageBlock): string =>
  block.source.type === "url"
    ? block.source.url
    : `data:${block.source.media_type};base64,${block.source.data}`;

/** Parses a tool call's JSON arguments, or refuses the request. */
export function parseArguments(text: string, param: string): unknown {
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TranslationError("A tool call's arguments are not JSON.", param);
  }
}

// Claude's thinking blocks must go back to it unchanged with their
// signature. The OpenAI Responses format carries opaque reasoning in a
// reasoning item's `encrypted_content`, so a thinking block travels there,
// marked so it is recognised on the way back.
const thinkingMarker = "aio-claude-thinking:";

/** A thinking block as a reasoning item's `encrypted_content`. */
export const encodeThinking = (
  block: AnthropicThinkingBlock | AnthropicRedactedThinkingBlock,
): string =>
  `${thinkingMarker}${Buffer.from(JSON.stringify(block), "utf8").toString("base64url")}`;

/** The thinking block in `encrypted_content`, if the Gateway put one there. */
export function decodeThinking(
  encrypted: string | null | undefined,
): AnthropicThinkingBlock | AnthropicRedactedThinkingBlock | undefined {
  if (!encrypted?.startsWith(thinkingMarker)) {
    return undefined;
  }
  try {
    const block = JSON.parse(
      Buffer.from(encrypted.slice(thinkingMarker.length), "base64url").toString(
        "utf8",
      ),
    ) as { type?: unknown };
    return block.type === "thinking" || block.type === "redacted_thinking"
      ? (block as AnthropicThinkingBlock | AnthropicRedactedThinkingBlock)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `messages` with consecutive messages of one role merged, as Messages
 * expects turns to alternate. Tool results come first in a user turn.
 */
export function mergeTurns(
  messages: readonly AnthropicMessageParam[],
): AnthropicMessageParam[] {
  const merged: {
    role: "user" | "assistant";
    content: AnthropicContentBlock[];
  }[] = [];
  for (const message of messages) {
    if (message.content.length === 0) {
      continue;
    }
    const last = merged.at(-1);
    if (last?.role === message.role) {
      last.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  for (const message of merged) {
    if (message.role === "user") {
      message.content.sort(
        (a, b) =>
          Number(b.type === "tool_result") - Number(a.type === "tool_result"),
      );
    }
  }
  return merged;
}

/** Why a Messages response stopped, as Chat Completions says it. */
export const finishReasonFor = (stopReason: string | null): string =>
  stopReason === "max_tokens"
    ? "length"
    : stopReason === "tool_use"
      ? "tool_calls"
      : stopReason === "refusal"
        ? "content_filter"
        : "stop";

/** Why a Chat Completion stopped, as Messages says it. */
export const stopReasonFor = (finishReason: string | null): string =>
  finishReason === "length"
    ? "max_tokens"
    : finishReason === "tool_calls" || finishReason === "function_call"
      ? "tool_use"
      : finishReason === "content_filter"
        ? "refusal"
        : "end_turn";
