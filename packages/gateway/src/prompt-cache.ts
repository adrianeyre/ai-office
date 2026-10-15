import type { PromptCacheTtl } from "@ai-office/shared";

// The prompt-cache TTL the Owner chose (PRD §6.8), given to every
// prompt-cache breakpoint (`cache_control: {type: "ephemeral"}`) of a
// request to Anthropic's Messages API: in its system prompt, its tools and
// its messages' content. Every breakpoint gets the same TTL, so Anthropic's
// rule that longer TTLs come before shorter ones always holds. A request
// with no breakpoint, or that is not JSON, is sent exactly as it came.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sets the TTL of each block's breakpoint; whether any changed. */
function setTtls(blocks: unknown, ttl: string): boolean {
  if (!Array.isArray(blocks)) {
    return false;
  }
  let changed = false;
  for (const block of blocks) {
    if (!isObject(block)) {
      continue;
    }
    const cache = block["cache_control"];
    if (
      isObject(cache) &&
      cache["type"] === "ephemeral" &&
      cache["ttl"] !== ttl
    ) {
      block["cache_control"] = { ...cache, ttl };
      changed = true;
    }
  }
  return changed;
}

/** A Messages request's body with every breakpoint given `ttl`. */
export function withPromptCacheTtl(body: Buffer, ttl: PromptCacheTtl): Buffer {
  if (ttl === "as_sent") {
    return body;
  }
  let request: unknown;
  try {
    request = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!isObject(request)) {
    return body;
  }
  let changed = setTtls(request["system"], ttl);
  changed = setTtls(request["tools"], ttl) || changed;
  if (Array.isArray(request["messages"])) {
    for (const message of request["messages"]) {
      if (isObject(message)) {
        changed = setTtls(message["content"], ttl) || changed;
      }
    }
  }
  return changed ? Buffer.from(JSON.stringify(request), "utf8") : body;
}
