import { noUsage, type Usage } from "../usage.ts";
import { usageFromOpenAi } from "./common.ts";
import { SseReader, type SseEvent } from "./sse.ts";

// Token usage read from OpenAI-format responses as they pass through an
// OpenAI-format AI Account untranslated, counted as Anthropic counts it:
// cached prompt tokens, and those written to the cache where the AI
// Provider counts them, apart from the rest.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The record's usage from a Chat Completions `usage` object. */
export function usageFromChat(usage: unknown): Usage {
  if (!isObject(usage)) {
    return noUsage;
  }
  const details = isObject(usage["prompt_tokens_details"])
    ? usage["prompt_tokens_details"]
    : {};
  return usageFromOpenAi(
    usage["prompt_tokens"],
    usage["completion_tokens"],
    details["cached_tokens"],
    details["cache_write_tokens"],
  );
}

/** The record's usage from a Responses `usage` object. */
export function usageFromResponses(usage: unknown): Usage {
  if (!isObject(usage)) {
    return noUsage;
  }
  const details = isObject(usage["input_tokens_details"])
    ? usage["input_tokens_details"]
    : {};
  return usageFromOpenAi(
    usage["input_tokens"],
    usage["output_tokens"],
    details["cached_tokens"],
  );
}

/** The usage in a whole Chat Completion or Response body. */
export function usageFromOpenAiBody(
  format: "chat" | "responses",
  body: string,
): Usage {
  const parsed = parse(body);
  if (!isObject(parsed)) {
    return noUsage;
  }
  return format === "chat"
    ? usageFromChat(parsed["usage"])
    : usageFromResponses(parsed["usage"]);
}

/** The usage an event of an OpenAI-format stream carries, if any. */
function usageInEvent(
  format: "chat" | "responses",
  event: SseEvent,
): Usage | undefined {
  if (format === "chat") {
    if (!event.data.includes('"usage"')) {
      return undefined;
    }
    const data = parse(event.data);
    return isObject(data) && isObject(data["usage"])
      ? usageFromChat(data["usage"])
      : undefined;
  }
  if (!event.data.includes('"usage"')) {
    return undefined;
  }
  const data = parse(event.data);
  return isObject(data) &&
    isObject(data["response"]) &&
    isObject(data["response"]["usage"])
    ? usageFromResponses(data["response"]["usage"])
    : undefined;
}

/**
 * Follows an OpenAI-format stream chunk by chunk and keeps the latest
 * usage: Chat Completions' last chunk (with `include_usage`), or the
 * Response in `response.completed`.
 */
export class OpenAiStreamUsageReader {
  #usage: Usage = noUsage;
  readonly #reader = new SseReader();
  readonly #format: "chat" | "responses";

  constructor(format: "chat" | "responses") {
    this.#format = format;
  }

  get usage(): Usage {
    return this.#usage;
  }

  push(chunk: Uint8Array): void {
    for (const event of this.#reader.push(chunk)) {
      this.#usage = usageInEvent(this.#format, event) ?? this.#usage;
    }
  }
}
