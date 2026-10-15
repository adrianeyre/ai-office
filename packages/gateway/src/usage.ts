// Token usage read from Anthropic Messages responses, as they pass through.
// Nothing here changes a byte of the response; it only watches.

export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

export const noUsage: Usage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
};

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * `usage` merged over `previous`. A count missing from `usage` keeps its
 * previous value: a stream's `message_delta` usage may carry only
 * `output_tokens`, with the input counts given earlier in `message_start`.
 */
function mergeUsage(previous: Usage, usage: unknown): Usage {
  if (!isObject(usage)) {
    return previous;
  }
  return {
    inputTokens: count(usage["input_tokens"]) ?? previous.inputTokens,
    outputTokens: count(usage["output_tokens"]) ?? previous.outputTokens,
    cacheReadInputTokens:
      count(usage["cache_read_input_tokens"]) ?? previous.cacheReadInputTokens,
    cacheCreationInputTokens:
      count(usage["cache_creation_input_tokens"]) ??
      previous.cacheCreationInputTokens,
  };
}

/** The usage in a non-streamed Messages response body (a `message`). */
export function usageFromMessage(body: string): Usage {
  try {
    const message: unknown = JSON.parse(body);
    return isObject(message) && message["type"] === "message"
      ? mergeUsage(noUsage, message["usage"])
      : noUsage;
  } catch {
    return noUsage;
  }
}

/**
 * Follows a Messages event stream chunk by chunk and keeps the latest
 * usage. `message_start` carries the input and cache counts, and each
 * `message_delta` the cumulative output count. Chunks may split an event,
 * a line or a multi-byte character anywhere.
 */
export class StreamUsageReader {
  #usage: Usage = noUsage;
  #pending = "";
  readonly #decoder = new TextDecoder();

  get usage(): Usage {
    return this.#usage;
  }

  push(chunk: Uint8Array): void {
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    // Events end with a blank line; servers may use \n or \r\n.
    let end: RegExpExecArray | null;
    while ((end = /\r?\n\r?\n/.exec(this.#pending)) !== null) {
      this.#readEvent(this.#pending.slice(0, end.index));
      this.#pending = this.#pending.slice(end.index + end[0].length);
    }
  }

  #readEvent(event: string): void {
    // Only these two events carry usage; skip the rest without parsing.
    if (!event.includes("message_start") && !event.includes("message_delta")) {
      return;
    }
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n");
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObject(payload)) {
      return;
    }
    if (payload["type"] === "message_start" && isObject(payload["message"])) {
      this.#usage = mergeUsage(this.#usage, payload["message"]["usage"]);
    } else if (payload["type"] === "message_delta") {
      this.#usage = mergeUsage(this.#usage, payload["usage"]);
    }
  }
}
