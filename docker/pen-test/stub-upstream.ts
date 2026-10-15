// The pen-test stack's stub upstream (docs/pen-testing/stack.md): a small
// server that answers like the AI Providers the stack's AI Accounts are
// for, and logs every request it receives, headers and body included. The
// stack has no real AI Account credentials; its AI Accounts point here
// (`stub-accounts.ts`), with canary credentials, so a leaked credential is
// detectable in this log and worthless anywhere else.
//
// Each AI Account's endpoint URL starts with its AI Provider's prefix, so
// the log says which account a request came through and each list of
// Models is in its AI Provider's shape:
// - `/anthropic`: Anthropic Messages (`/v1/messages`, streamed or not, and
//   `/v1/messages/count_tokens`) and its model list (`/v1/models`);
// - `/xai`, `/gemini` (`/v1beta/openai`) and `/openai` (an OpenAI-compatible
//   endpoint): Chat Completions and Responses, streamed or not, and an
//   OpenAI-shaped model list.
// Whatever is asked, the answer is the same short text. `GET /health`, for
// the compose health check, is the one request that is not logged.
//
// It uses nothing but Node, so the stack runs it from the Node image as it
// is: `node stub-upstream.ts`, listening on STUB_UPSTREAM_PORT (3050).
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/** What every answer says. */
export const stubReply =
  "This is the pen-test stub upstream. No AI Provider read this request.";

/** The AI Providers' prefixes, and the Models each lists. */
export const stubModels = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  xai: ["grok-stub"],
  gemini: ["gemini-stub"],
  openai: ["gpt-stub"],
} as const;

export type StubProvider = keyof typeof stubModels;

const isStubProvider = (value: string): value is StubProvider =>
  Object.hasOwn(stubModels, value);

/** One request, as the stub received it. */
export interface StubLogEntry {
  readonly at: string;
  readonly method: string;
  /** The path and query, as sent. */
  readonly url: string;
  /** Every header, exactly as received: credentials included. */
  readonly headers: IncomingHttpHeaders;
  /** The body as text, cut at `maxLoggedBody` bytes. */
  readonly body: string;
  readonly bodyBytes: number;
  /** The status it was answered with. */
  readonly status: number;
}

/** The most of a body the log keeps. */
export const maxLoggedBody = 1024 * 1024;

export interface StubUpstreamOptions {
  /** Called once for each request, after it is answered. */
  readonly log: (entry: StubLogEntry) => void;
  readonly now?: () => Date;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A rough count: four characters to a token, at least one. */
const tokensIn = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

const id = (prefix: string): string =>
  `${prefix}${randomBytes(8).toString("hex")}`;

interface Answer {
  readonly status: number;
  /** A JSON body, or server-sent events. */
  readonly json?: unknown;
  readonly events?: readonly { event?: string; data: unknown }[];
}

const error = (provider: StubProvider, status: number, message: string) => ({
  status,
  json:
    provider === "anthropic"
      ? { type: "error", error: { type: "invalid_request_error", message } }
      : { error: { message, type: "invalid_request_error" } },
});

function modelList(provider: StubProvider, created: number): Answer {
  const models = stubModels[provider];
  if (provider === "anthropic") {
    return {
      status: 200,
      json: {
        data: models.map((model) => ({
          type: "model",
          id: model,
          display_name: `${model} (stub)`,
          created_at: new Date(created * 1000).toISOString(),
        })),
        has_more: false,
        first_id: models[0],
        last_id: models.at(-1),
      },
    };
  }
  return {
    status: 200,
    json: {
      object: "list",
      data: models.map((model) => ({
        // Google lists its Models as `models/<name>`.
        id: provider === "gemini" ? `models/${model}` : model,
        object: "model",
        created,
        owned_by: "pen-test-stub",
      })),
    },
  };
}

function messages(model: string, input: number, stream: boolean): Answer {
  const output = tokensIn(stubReply);
  const message = {
    id: id("msg_stub_"),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: stubReply }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output },
  };
  if (!stream) {
    return { status: 200, json: message };
  }
  const events = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: input, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: stubReply },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: output },
    },
    { type: "message_stop" },
  ];
  return {
    status: 200,
    events: events.map((data) => ({ event: data.type, data })),
  };
}

function chatCompletion(
  model: string,
  input: number,
  created: number,
  request: Record<string, unknown>,
): Answer {
  const output = tokensIn(stubReply);
  const usage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
  const completionId = id("chatcmpl-stub-");
  if (request["stream"] !== true) {
    return {
      status: 200,
      json: {
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: stubReply },
            finish_reason: "stop",
          },
        ],
        usage,
      },
    };
  }
  const chunk = (choices: unknown[], extra: object = {}) => ({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices,
    ...extra,
  });
  const streamOptions = request["stream_options"];
  return {
    status: 200,
    events: [
      chunk([
        {
          index: 0,
          delta: { role: "assistant", content: stubReply },
          finish_reason: null,
        },
      ]),
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
      ...(isObject(streamOptions) && streamOptions["include_usage"] === true
        ? [chunk([], { usage })]
        : []),
      "[DONE]",
    ].map((data) => ({ data })),
  };
}

function response(
  model: string,
  input: number,
  created: number,
  stream: boolean,
): Answer {
  const output = tokensIn(stubReply);
  const itemId = id("msg_stub_");
  const part = { type: "output_text", text: stubReply, annotations: [] };
  const item = {
    type: "message",
    id: itemId,
    status: "completed",
    role: "assistant",
    content: [part],
  };
  const whole = {
    id: id("resp_stub_"),
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output: [item],
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
    },
  };
  if (!stream) {
    return { status: 200, json: whole };
  }
  const at = { item_id: itemId, output_index: 0, content_index: 0 };
  const events = [
    {
      type: "response.created",
      response: { ...whole, status: "in_progress", output: [], usage: null },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...at,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...at, delta: stubReply },
    { type: "response.output_text.done", ...at, text: stubReply },
    { type: "response.content_part.done", ...at, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: whole },
  ];
  return {
    status: 200,
    events: events.map((data, index) => ({
      event: data.type,
      data: { ...data, sequence_number: index },
    })),
  };
}

/** The answer to one request, as its AI Provider would give it. */
function answer(
  method: string,
  path: string,
  body: Buffer,
  created: number,
): Answer {
  const [, prefix = "", ...rest] = path.split("/");
  if (!isStubProvider(prefix)) {
    return {
      status: 404,
      json: {
        error: {
          message: `No AI Provider here: the path starts with one of /${Object.keys(stubModels).join(", /")}.`,
        },
      },
    };
  }
  const provider = prefix;
  const route = `/${rest.join("/")}`;
  if (method === "GET" && route.endsWith("/models")) {
    return modelList(provider, created);
  }
  if (method !== "POST") {
    return error(provider, 404, `Nothing answers ${method} ${route} here.`);
  }
  let request: unknown;
  try {
    request = JSON.parse(body.toString("utf8"));
  } catch {
    return error(provider, 400, "The body is not JSON.");
  }
  if (!isObject(request)) {
    return error(provider, 400, "The body is not a JSON object.");
  }
  const model =
    typeof request["model"] === "string"
      ? request["model"]
      : stubModels[provider][0];
  const input = tokensIn(body.toString("utf8"));
  const stream = request["stream"] === true;
  if (provider === "anthropic") {
    if (route.endsWith("/messages/count_tokens")) {
      return { status: 200, json: { input_tokens: input } };
    }
    if (route.endsWith("/messages")) {
      return messages(model, input, stream);
    }
  } else {
    if (route.endsWith("/chat/completions")) {
      return chatCompletion(model, input, created, request);
    }
    if (route.endsWith("/responses")) {
      return response(model, input, created, stream);
    }
  }
  return error(provider, 404, `Nothing answers POST ${route} here.`);
}

function send(reply: ServerResponse, answered: Answer): void {
  if (answered.events === undefined) {
    reply.writeHead(answered.status, { "content-type": "application/json" });
    reply.end(JSON.stringify(answered.json));
    return;
  }
  reply.writeHead(answered.status, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const { event, data } of answered.events) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    reply.write(
      `${event === undefined ? "" : `event: ${event}\n`}data: ${payload}\n\n`,
    );
  }
  reply.end();
}

/** The stub upstream, not yet listening. */
export function createStubUpstream(options: StubUpstreamOptions): Server {
  const now = options.now ?? (() => new Date());
  return createServer((request, reply) => {
    void (async () => {
      const method = request.method ?? "GET";
      const url = request.url ?? "/";
      const path = new URL(url, "http://stub").pathname;
      if (path === "/health") {
        send(reply, { status: 200, json: { status: "ok" } });
        return;
      }
      const at = now();
      let body: Buffer = Buffer.alloc(0);
      let answered: Answer;
      try {
        body = await readBody(request);
        answered = answer(method, path, body, Math.floor(at.getTime() / 1000));
      } catch {
        answered = { status: 400, json: { error: { message: "Unreadable." } } };
      }
      send(reply, answered);
      options.log({
        at: at.toISOString(),
        method,
        url,
        headers: request.headers,
        body: body.subarray(0, maxLoggedBody).toString("utf8"),
        bodyBytes: body.length,
        status: answered.status,
      });
    })();
  });
}

if (import.meta.main) {
  const port = Number(process.env["STUB_UPSTREAM_PORT"] ?? "3050");
  const server = createStubUpstream({
    log: (entry) => {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    },
  });
  server.listen(port, "0.0.0.0", () => {
    console.error(
      `The pen-test stub upstream is listening on ${String(port)}.`,
    );
  });
  const stop = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
