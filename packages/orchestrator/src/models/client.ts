import { aiOfficeHeaders } from "@ai-office/shared";

// Model calls AI Office makes for an Agent outside a sandbox, such as a
// reviewer's (PRD FR-20). Like every Agent's model call, each goes through
// the AI Gateway with the Agent's own Gateway Key (ADR 0001, FR-46), so it
// is attributed to the Agent, its Floor and its issue (FR-42) and counted
// against its Token Caps (FR-33). It is a Messages request: the Gateway
// serves it from an AI Account of the Model's AI Provider, translating
// where that account speaks another format (FR-34).

/** One turn of the conversation. */
export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ModelRequest {
  /** The Agent making the call: its Gateway Key is used. */
  readonly agentId: string;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens: number;
  /** What the call is for, as the Gateway records it (FR-42). */
  readonly issue?: number;
  readonly pullRequest?: number;
  /** The Agent session it belongs to (FR-37, FR-84), if any. */
  readonly session?: string;
}

export interface ModelReply {
  /** The text of the model's answer. */
  readonly text: string;
  /** Why it stopped, such as `end_turn` or `max_tokens`. */
  readonly stopReason: string | null;
}

export interface ModelStreamOptions {
  /** Called with each piece of the answer's text as it arrives. */
  readonly onText: (text: string) => void;
  readonly signal?: AbortSignal;
}

/** Makes Agents' model calls. */
export interface ModelClient {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelReply>;
  /**
   * The same call, streamed (FR-34): `onText` is given the answer's text a
   * piece at a time as the model writes it, and the whole reply resolves
   * at the end.
   */
  stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): Promise<ModelReply>;
}

/** A model call that failed; the Gateway's own message, never a key. */
export class ModelCallError extends Error {
  /** The Gateway's HTTP status; 0 when it could not be reached. */
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelCallError";
    this.status = status;
  }
}

/**
 * Opens the work one of AI Office's own calls for an Agent is for
 * (pen-testing G1-1): the token the call sends as `x-ai-office-work`, so
 * the Gateway counts it against that issue and pull request, and closes it
 * once the Gateway has answered. The Gateway never takes an Agent's issue
 * from the call's own word.
 */
export type OpenCallWork = (
  agentId: string,
  work: { readonly issue?: number; readonly pullRequest?: number },
) => { readonly token: string; close(): void };

export interface GatewayModelClientOptions {
  /** The AI Gateway's address, such as `http://127.0.0.1:3047`. */
  readonly url: string;
  /** The Agent's own Gateway Key (a credential: never logged). */
  readonly key: (agentId: string) => Promise<string | undefined>;
  /** Opens each call's work; without it, a call counts against no issue. */
  readonly work?: OpenCallWork;
  readonly fetch?: typeof fetch;
}

const anthropicVersion = "2023-06-01";

/** The Gateway's error message, from an Anthropic- or OpenAI-format error. */
const errorMessage = (body: unknown): string | undefined => {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : undefined;
};

/** The text blocks of a Messages answer, joined. */
const textOf = (content: readonly unknown[]): string =>
  content
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map(({ text }) => text)
    .join("");

/** Each server-sent event's data in `body`, parsed, as it arrives. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dataOf = (frame: string): unknown => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") {
      return undefined;
    }
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += chunk.done
        ? decoder.decode()
        : decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = chunk.done ? "" : (frames.pop() ?? "");
      for (const frame of frames) {
        const data = dataOf(frame);
        if (data !== undefined) {
          yield data;
        }
      }
      if (chunk.done) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function gatewayModelClient(
  options: GatewayModelClientOptions,
): ModelClient {
  const call = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/v1/messages`;

  /** Sends the request; a response that is not a success is thrown. */
  const send = async (
    request: ModelRequest,
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const key = await options.key(request.agentId);
    if (key === undefined) {
      throw new ModelCallError(
        0,
        `The Agent ${request.agentId} has no Gateway Key.`,
      );
    }
    const work = options.work?.(request.agentId, {
      ...(request.issue === undefined ? {} : { issue: request.issue }),
      ...(request.pullRequest === undefined
        ? {}
        : { pullRequest: request.pullRequest }),
    });
    let response: Response;
    try {
      response = await call(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": anthropicVersion,
          "x-api-key": key,
          ...(stream ? { accept: "text/event-stream" } : {}),
          ...(work === undefined ? {} : { [aiOfficeHeaders.work]: work.token }),
          ...(request.issue === undefined
            ? {}
            : { [aiOfficeHeaders.issue]: String(request.issue) }),
          ...(request.pullRequest === undefined
            ? {}
            : {
                [aiOfficeHeaders.pullRequest]: String(request.pullRequest),
              }),
          ...(request.session === undefined
            ? {}
            : { [aiOfficeHeaders.session]: request.session }),
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages,
          ...(stream ? { stream: true } : {}),
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      throw new ModelCallError(
        0,
        `The AI Gateway could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      // The Gateway has read it once it answers.
      work?.close();
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new ModelCallError(
        response.status,
        `The AI Gateway answered ${String(response.status)}: ${errorMessage(body) ?? response.statusText}`,
      );
    }
    return response;
  };

  /** A whole (unstreamed) answer's reply. */
  const replyOf = async (response: Response): Promise<ModelReply> => {
    const body: unknown = await response.json().catch(() => null);
    const { content, stop_reason: stopReason } = (body ?? {}) as {
      content?: unknown;
      stop_reason?: unknown;
    };
    if (!Array.isArray(content)) {
      throw new ModelCallError(
        response.status,
        "The AI Gateway's answer had no content.",
      );
    }
    return {
      text: textOf(content),
      stopReason: typeof stopReason === "string" ? stopReason : null,
    };
  };

  return {
    async complete(request, signal) {
      return replyOf(await send(request, false, signal));
    },

    async stream(request, { onText, signal }) {
      const response = await send(request, true, signal);
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("text/event-stream") || response.body === null) {
        // Answered whole after all: all of its text at once.
        const reply = await replyOf(response);
        if (reply.text !== "") {
          onText(reply.text);
        }
        return reply;
      }
      let text = "";
      let stopReason: string | null = null;
      let stopped = false;
      for await (const data of sseData(response.body)) {
        const event = data as {
          type?: unknown;
          delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
          error?: { message?: unknown };
        };
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          text += event.delta.text;
          onText(event.delta.text);
        } else if (
          event.type === "message_delta" &&
          typeof event.delta?.stop_reason === "string"
        ) {
          stopReason = event.delta.stop_reason;
        } else if (event.type === "message_stop") {
          stopped = true;
        } else if (event.type === "error") {
          throw new ModelCallError(
            response.status,
            `The AI Gateway's stream failed: ${errorMessage(data) ?? "no reason given"}`,
          );
        }
      }
      if (!stopped) {
        throw new ModelCallError(
          response.status,
          "The AI Gateway's stream ended before the answer did.",
        );
      }
      return { text, stopReason };
    },
  };
}
