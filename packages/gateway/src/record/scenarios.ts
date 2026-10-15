import { crc32, deflateSync } from "node:zlib";

// The scripted exchanges `pnpm --filter @ai-office/gateway record` sends
// through the AI Gateway (#45), so its recorder mode writes one fixture
// per exchange (PRD §9): each as Anthropic's Messages API or OpenAI's Chat
// Completions asks it, whichever the AI Provider speaks, so it reaches the
// AI Provider unchanged rather than translated.

/** The API a scenario is asked in: the AI Provider's own. */
export type RecordFormat = "messages" | "chat_completions";

/** One scripted exchange. */
export interface Scenario {
  readonly id: string;
  /** As the summary names it. */
  readonly label: string;
  /**
   * The request's body. `marker` goes in its prompt, so the fixture it
   * produces can be told from any other the server writes meanwhile.
   */
  body(format: RecordFormat, model: string, marker: string): unknown;
  /**
   * What is wrong with the answer for this scenario, if anything: a tool
   * call scenario answered without one, say.
   */
  check?(format: RecordFormat, answer: string): string | undefined;
}

/** A scenario the script does not send, and why. */
export interface SkippedScenario {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

const maxTokens = 64;

const prompt = (marker: string, text: string) =>
  `${text} (AI Office fixture recording ${marker}.)`;

const plainBody = (
  format: RecordFormat,
  model: string,
  marker: string,
  stream: boolean,
) => {
  const messages = [
    {
      role: "user",
      content: prompt(marker, "Reply with the single word: recorded."),
    },
  ];
  return format === "messages"
    ? { model, max_tokens: maxTokens, messages, ...(stream && { stream }) }
    : {
        model,
        max_tokens: maxTokens,
        messages,
        ...(stream && { stream, stream_options: { include_usage: true } }),
      };
};

const weatherTool = {
  name: "get_weather",
  description: "The current weather in a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "The city." } },
    required: ["city"],
  },
};

/** A 16 × 16 PNG of one colour: the smallest image every API takes. */
export function solidPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const size = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  // 8 bits per channel, RGB, no interlacing.
  header.set([8, 2, 0, 0, 0], 8);
  // Each row: no filter, then its pixels, all AI Office's orange.
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [0xf2, 0x8c, 0x28]).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Whether an answer (not streamed) holds a tool call. */
function hasToolCall(format: RecordFormat, answer: string): boolean {
  try {
    const parsed = JSON.parse(answer) as {
      content?: { type?: string }[];
      choices?: { message?: { tool_calls?: unknown[] } }[];
    };
    return format === "messages"
      ? (parsed.content ?? []).some((block) => block.type === "tool_use")
      : (parsed.choices?.[0]?.message?.tool_calls ?? []).length > 0;
  } catch {
    return false;
  }
}

export const scenarios: readonly Scenario[] = [
  {
    id: "plain",
    label: "plain message",
    body: (format, model, marker) => plainBody(format, model, marker, false),
  },
  {
    id: "streaming",
    label: "streaming",
    body: (format, model, marker) => plainBody(format, model, marker, true),
  },
  {
    id: "tool-call",
    label: "tool call",
    body: (format, model, marker) => {
      const messages = [
        {
          role: "user",
          content: prompt(
            marker,
            "What is the weather in Paris? Use the get_weather tool.",
          ),
        },
      ];
      return format === "messages"
        ? {
            model,
            max_tokens: maxTokens,
            messages,
            tools: [
              {
                name: weatherTool.name,
                description: weatherTool.description,
                input_schema: weatherTool.parameters,
              },
            ],
            tool_choice: { type: "tool", name: weatherTool.name },
          }
        : {
            model,
            max_tokens: maxTokens,
            messages,
            tools: [{ type: "function", function: weatherTool }],
            // `auto`: every OpenAI-compatible API takes it, as some do
            // not take a named function.
            tool_choice: "auto",
          };
    },
    check: (format, answer) =>
      hasToolCall(format, answer)
        ? undefined
        : "the answer holds no tool call; record it again or with another Model",
  },
  {
    id: "image",
    label: "image",
    body: (format, model, marker) => {
      const data = solidPng().toString("base64");
      const text = prompt(marker, "What colour is this image? One word.");
      return format === "messages"
        ? {
            model,
            max_tokens: maxTokens,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data },
                  },
                  { type: "text", text },
                ],
              },
            ],
          }
        : {
            model,
            max_tokens: maxTokens,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text },
                  {
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${data}` },
                  },
                ],
              },
            ],
          };
    },
  },
];

/** The scenarios no AI Provider is sent, each with why. */
export const skippedScenarios: readonly SkippedScenario[] = [
  {
    id: "rate-limit",
    label: "rate limit",
    reason:
      "no AI Provider gives a 429 on request: provoking one means spending a limit's worth of tokens or flooding the API. A 429 met in normal use is recorded when its AI Account was forced (--account), as the Gateway otherwise answers from another account",
  },
  {
    id: "token-refresh",
    label: "token refresh",
    reason:
      "the AI Gateway refreshes a subscription's OAuth token itself, at the AI Provider's sign-in server and not through its endpoints, so recorder mode writes no fixture of it. It happens once the token is due within 15 minutes (AI Settings shows it as expiring); the requests after it are recorded as any others",
  },
];

/** Every scenario's id, sent or not. */
export const scenarioIds: readonly string[] = [
  ...scenarios.map(({ id }) => id),
  ...skippedScenarios.map(({ id }) => id),
];
