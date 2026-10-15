// The Communications Agent's model calls (PRD FR-90): only for Digests
// and published Wrap-up reports, through this process's own AI Gateway
// with the Communications Agent's own Gateway Key (ADR 0001), so each is
// attributed to it and counted against the office's Token Caps. What it is
// given is structured data, never an issue's text (FR-95).

export interface GatewayTextOptions {
  /** The AI Gateway's address, such as `http://127.0.0.1:3047`. */
  readonly url: string;
  /** The Communications Agent's own Gateway Key (a credential: never logged). */
  readonly key: () => Promise<string | undefined>;
  /** How long the call may take; a minute by default. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** The Gateway's own error message, if it gave one. */
const errorMessage = (body: unknown): string | undefined => {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : undefined;
};

/**
 * The text a Model writes for one Messages request through the AI
 * Gateway: `system` its instructions, `content` the one user turn.
 */
export async function gatewayText(
  options: GatewayTextOptions,
  request: {
    readonly model: string;
    readonly maxTokens: number;
    readonly system: string;
    readonly content: string;
  },
): Promise<string> {
  const call = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/v1/messages`;
  const key = await options.key();
  if (key === undefined) {
    throw new Error("The Communications Agent has no Gateway Key.");
  }
  const response = await call(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": key,
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.content }],
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `The AI Gateway answered ${String(response.status)}: ${errorMessage(body) ?? response.statusText}`,
    );
  }
  const content = (body as { content?: unknown } | null)?.content;
  const text = (Array.isArray(content) ? content : [])
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map(({ text: part }) => part)
    .join("")
    .trim();
  if (text === "") {
    throw new Error("The AI Gateway's answer had no text.");
  }
  return text;
}
