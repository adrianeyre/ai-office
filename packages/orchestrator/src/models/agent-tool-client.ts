import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import {
  aiOfficeHeaders,
  aiProviderAgentTools,
  aiProviderOfModel,
  type AgentTool,
} from "@ai-office/shared";

import {
  removeContainer,
  sandboxHardening,
  sandboxNetwork,
} from "../sandbox/docker.ts";
import { sandboxImages } from "../sandbox/images.ts";
import {
  codexModelEnvironment,
  gatewayModelEnvironment,
  type GatewayAccess,
} from "../sandbox/environment.ts";
import { codexProviderId } from "../sandbox/agent-tools.ts";
import {
  ModelCallError,
  type OpenCallWork,
  type ModelClient,
  type ModelMessage,
  type ModelReply,
  type ModelRequest,
  type ModelStreamOptions,
} from "./client.ts";

// Model calls made through an Agent's own agent tool (PRD FR-16): Claude
// Code (`claude --print`) or Codex (`codex exec`), run once in its sandbox
// image, reaching models through the AI Gateway with the Agent's Gateway
// Key like any sandbox (ADR 0001). A subscription serves only its agent
// tool's requests, as its AI Provider's terms require (FR-35), so a call
// outside a sandbox, such as the Manager chat's (FR-24), is served by the
// Owner's Claude or ChatGPT subscription this way when no other AI Account
// can serve it (`withAgentToolFallback`).

/** The agent tools a call can be made through. */
export type CallingTool = Extract<AgentTool, "Claude Code" | "Codex">;

/** The agent tool a Model's calls can be made through, if any. */
export function callingToolOf(model: string): CallingTool | undefined {
  const aiProvider = aiProviderOfModel(model);
  const tool =
    aiProvider === undefined ? undefined : aiProviderAgentTools[aiProvider];
  return tool === "Claude Code" || tool === "Codex" ? tool : undefined;
}

/**
 * Codex's configuration for the AI Gateway as its model provider, at
 * `baseUrl` with the Gateway Key in `AI_OFFICE_GATEWAY_KEY`, sending AI
 * Office's headers from the environment.
 */
export function codexProviderConfig(baseUrl: string): string[] {
  const provider = `model_providers.${codexProviderId}`;
  const headers = Object.entries({
    [aiOfficeHeaders.issue]: "AI_OFFICE_ISSUE",
    [aiOfficeHeaders.pullRequest]: "AI_OFFICE_PULL_REQUEST",
    [aiOfficeHeaders.session]: "AI_OFFICE_SESSION",
    [aiOfficeHeaders.work]: "AI_OFFICE_WORK",
  })
    .map(([header, variable]) => `"${header}" = "${variable}"`)
    .join(", ");
  return [
    `model_provider="${codexProviderId}"`,
    `${provider}.name="AI Office"`,
    `${provider}.base_url="${baseUrl}"`,
    `${provider}.env_key="AI_OFFICE_GATEWAY_KEY"`,
    `${provider}.wire_api="responses"`,
    `${provider}.env_http_headers={ ${headers} }`,
  ];
}

/**
 * Codex's configuration that takes away its shell, so it runs no command
 * at all (P2-1): a command it ran could read anything in its container,
 * the Gateway Key in the process's environment included, read-only
 * sandbox or not.
 */
export const codexNoShellConfig = [
  "features.shell_tool=false",
  "features.unified_exec=false",
] as const;

/** A host directory a tool run is given, at `container`. */
export interface ToolMount {
  readonly host: string;
  readonly container: string;
  /** Mounted so the tool cannot change it, whatever it runs. */
  readonly readOnly: boolean;
}

/** One run of an agent tool in its sandbox image. */
export interface ToolRun {
  readonly tool: CallingTool;
  readonly image: string;
  /** The command, after the tool's own name. */
  readonly args: readonly string[];
  /** The model environment: the Gateway, and the Gateway Key. */
  readonly environment: Readonly<Record<string, string>>;
  /** Given to the tool on its standard input. */
  readonly input: string;
  /** Host directories it is given, such as a read-only clone; none if absent. */
  readonly mounts?: readonly ToolMount[];
  /** Its working directory; the image's own if absent. */
  readonly workdir?: string;
  readonly signal?: AbortSignal | undefined;
}

/** Runs a tool, giving each line it writes; throws if it fails. */
export type ToolRunner = (run: ToolRun) => AsyncIterable<string>;

export interface AgentToolModelClientOptions {
  /** The Gateway, as a sandbox reaches it, with the Agent's Gateway Key. */
  readonly gateway: (agentId: string) => Promise<GatewayAccess | undefined>;
  readonly run: ToolRunner;
  readonly images?: Partial<Record<CallingTool, string>>;
  /** Opens each call's work; without it, a call counts against no issue. */
  readonly work?: OpenCallWork;
}

/** The earlier turns, then the one to answer, as one prompt. */
export function conversationPrompt(messages: readonly ModelMessage[]): string {
  const last = messages.at(-1);
  if (messages.length <= 1) {
    return last?.content ?? "";
  }
  const earlier = messages
    .slice(0, -1)
    .map(
      ({ role, content }) =>
        `<${role === "user" ? "user" : "you"}>\n${content}\n</${role === "user" ? "user" : "you"}>`,
    )
    .join("\n");
  return `The conversation so far:\n${earlier}\n\nAnswer this, the latest message:\n${last?.content ?? ""}`;
}

/** Claude Code's text pieces and its result, from `stream-json` lines. */
function claudeEvent(line: string): {
  text?: string;
  result?: string;
  stopReason?: string | null;
} {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  const e = event as {
    type?: unknown;
    subtype?: unknown;
    is_error?: unknown;
    result?: unknown;
    stop_reason?: unknown;
    event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
  };
  if (
    e.type === "stream_event" &&
    e.event?.type === "content_block_delta" &&
    e.event.delta?.type === "text_delta" &&
    typeof e.event.delta.text === "string"
  ) {
    return { text: e.event.delta.text };
  }
  if (e.type === "result") {
    if (e.is_error === true || e.subtype !== "success") {
      throw new ModelCallError(
        502,
        `Claude Code could not answer${typeof e.result === "string" && e.result !== "" ? `: ${e.result}` : "."}`,
      );
    }
    return {
      result: typeof e.result === "string" ? e.result : "",
      stopReason: typeof e.stop_reason === "string" ? e.stop_reason : null,
    };
  }
  return {};
}

/** Codex's answer, from `exec --json` lines, old and new. */
function codexEvent(line: string): { text?: string; error?: string } {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  const e = event as {
    type?: unknown;
    message?: unknown;
    item?: { type?: unknown; text?: unknown };
    msg?: { type?: unknown; message?: unknown };
  };
  if (
    e.type === "item.completed" &&
    e.item?.type === "agent_message" &&
    typeof e.item.text === "string"
  ) {
    return { text: e.item.text };
  }
  if (e.msg?.type === "agent_message" && typeof e.msg.message === "string") {
    return { text: e.msg.message };
  }
  if (
    (e.type === "error" || e.type === "turn.failed") &&
    typeof e.message === "string"
  ) {
    return { error: e.message };
  }
  return {};
}

export function agentToolModelClient(
  options: AgentToolModelClientOptions,
): ModelClient {
  const callWith = async (
    request: ModelRequest,
    work: string | undefined,
    onText: ((text: string) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ModelReply> => {
    const tool = callingToolOf(request.model);
    if (tool === undefined) {
      throw new ModelCallError(
        503,
        `No agent tool can call "${request.model}".`,
      );
    }
    const access = await options.gateway(request.agentId);
    if (access === undefined) {
      throw new ModelCallError(401, "The Agent has no Gateway Key.");
    }
    const attribution = {
      issue: request.issue,
      pullRequest: request.pullRequest,
      session: request.session,
      work,
    };
    const prompt = conversationPrompt(request.messages);
    const image = options.images?.[tool] ?? sandboxImages[tool];
    if (tool === "Claude Code") {
      const lines = options.run({
        tool,
        image,
        // One answer, with no tools: the call is a conversation's turn.
        args: [
          "--print",
          "--verbose",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--model",
          request.model,
          "--system-prompt",
          request.system,
          "--tools",
          "",
          "--max-turns",
          "1",
        ],
        environment: gatewayModelEnvironment(access, attribution),
        input: prompt,
        signal,
      });
      let streamed = "";
      for await (const line of lines) {
        const event = claudeEvent(line);
        if (event.text !== undefined) {
          streamed += event.text;
          onText?.(event.text);
        }
        if (event.result !== undefined) {
          const text = event.result === "" ? streamed : event.result;
          if (streamed === "" && text !== "") {
            onText?.(text);
          }
          return { text, stopReason: event.stopReason ?? "end_turn" };
        }
      }
      throw new ModelCallError(502, "Claude Code ended without an answer.");
    }
    const lines = options.run({
      tool,
      image,
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        request.model,
        // One answer, with no shell: the call is a conversation's turn.
        ...codexNoShellConfig.flatMap((value) => ["-c", value]),
        // The Gateway as Codex's model provider, as in a sandbox
        // (`codexOverrides`), given as separate arguments, not for a shell.
        ...codexProviderConfig(
          codexModelEnvironment(access, attribution)["OPENAI_BASE_URL"] ?? "",
        ).flatMap((value) => ["-c", value]),
        "-",
      ],
      environment: codexModelEnvironment(access, attribution),
      input: `${request.system}\n\n${prompt}`,
      signal,
    });
    let answer = "";
    for await (const line of lines) {
      const event = codexEvent(line);
      if (event.error !== undefined) {
        throw new ModelCallError(502, `Codex could not answer: ${event.error}`);
      }
      if (event.text !== undefined) {
        answer = event.text;
      }
    }
    if (answer === "") {
      throw new ModelCallError(502, "Codex ended without an answer.");
    }
    onText?.(answer);
    return { text: answer, stopReason: "end_turn" };
  };
  const call = async (
    request: ModelRequest,
    onText: ((text: string) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ModelReply> => {
    // Its work's token is good only while the tool runs.
    const work = options.work?.(request.agentId, {
      ...(request.issue === undefined ? {} : { issue: request.issue }),
      ...(request.pullRequest === undefined
        ? {}
        : { pullRequest: request.pullRequest }),
    });
    try {
      return await callWith(request, work?.token, onText, signal);
    } finally {
      work?.close();
    }
  };
  return {
    complete: (request, signal) => call(request, undefined, signal),
    stream: (request: ModelRequest, streamOptions: ModelStreamOptions) =>
      call(request, streamOptions.onText, streamOptions.signal),
  };
}

/**
 * Calls through `primary` (the Gateway), and through the agent tool when
 * the Gateway has no AI Account that can serve the call directly (a 503
 * before any of the answer), as when the Owner's only accounts for the
 * Model's AI Provider are subscriptions.
 */
export function withAgentToolFallback(
  primary: ModelClient,
  fallback: ModelClient,
): ModelClient {
  const fallsBack = (error: unknown, request: ModelRequest, started: boolean) =>
    !started &&
    error instanceof ModelCallError &&
    error.status === 503 &&
    callingToolOf(request.model) !== undefined;
  return {
    async complete(request, signal) {
      try {
        return await primary.complete(request, signal);
      } catch (error) {
        if (fallsBack(error, request, false)) {
          return fallback.complete(request, signal);
        }
        throw error;
      }
    },
    async stream(request, streamOptions) {
      let started = false;
      try {
        return await primary.stream(request, {
          ...streamOptions,
          onText: (text) => {
            started = true;
            streamOptions.onText(text);
          },
        });
      } catch (error) {
        if (fallsBack(error, request, started)) {
          return fallback.stream(request, streamOptions);
        }
        throw error;
      }
    },
  };
}

/** `ms` in whole minutes, or seconds under a minute: "10 minutes", "1 second". */
const duration = (ms: number): string => {
  const [count, unit] =
    ms >= 60_000
      ? [Math.round(ms / 60_000), "minute"]
      : [Math.max(1, Math.round(ms / 1000)), "second"];
  return `${String(count)} ${unit}${count === 1 ? "" : "s"}`;
};

/**
 * Runs each tool with `docker run`, hardened as a sandbox is
 * (`sandboxHardening`, pen-testing S2-4): its environment is handed over
 * by name, never on the command line, and the container is removed when it
 * ends, with its volumes. Given `network`, the network the sandbox relay is
 * on, each run has a network of its own that the relay joins, as a sandbox
 * does (`sandboxNetwork`, S2-5), removed after it.
 */
export function dockerToolRunner(options: {
  readonly network?: string | undefined;
  /**
   * How long one run may take before it is stopped and its call fails,
   * so a run that hangs (a model that never answers, a network that never
   * connects) ends as an error the Owner sees rather than "answering…"
   * for ever. Ten minutes by default.
   */
  readonly timeoutMs?: number;
}): ToolRunner {
  const commands: Record<CallingTool, string> = {
    "Claude Code": "claude",
    Codex: "codex",
  };
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  return async function* run(toolRun) {
    const own =
      options.network === undefined
        ? undefined
        : await sandboxNetwork(options.network);
    const name = `ai-office-tool-${randomUUID()}`;
    try {
      yield* runTool(own?.name, name, toolRun);
    } finally {
      if (own !== undefined) {
        // Gone already unless the run was stopped before it ended.
        await removeContainer(name);
        await own.remove();
      }
    }
  };

  async function* runTool(
    network: string | undefined,
    name: string,
    toolRun: ToolRun,
  ): AsyncGenerator<string> {
    const limit = AbortSignal.timeout(timeoutMs);
    const signal =
      toolRun.signal === undefined
        ? limit
        : AbortSignal.any([toolRun.signal, limit]);
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        ...(network === undefined ? [] : ["--network", network]),
        ...Object.keys(toolRun.environment).flatMap((key) => ["-e", key]),
        ...(toolRun.mounts ?? []).flatMap(({ host, container, readOnly }) => [
          "--mount",
          `type=bind,source=${host},target=${container}${readOnly ? ",readonly" : ""}`,
        ]),
        ...(toolRun.workdir === undefined
          ? []
          : ["--workdir", toolRun.workdir]),
        ...sandboxHardening,
        "--entrypoint",
        commands[toolRun.tool],
        toolRun.image,
        ...toolRun.args,
      ],
      {
        env: { ...process.env, ...toolRun.environment },
        signal,
        // Docker passes the stop on to the container it started.
        killSignal: "SIGTERM",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2000);
    });
    const timedOut = () =>
      limit.aborted && !(toolRun.signal?.aborted ?? false)
        ? new ModelCallError(
            504,
            `${toolRun.tool} did not answer within ${duration(timeoutMs)}, so it was stopped.`,
          )
        : undefined;
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", (error) => {
        reject(timedOut() ?? error);
      });
      child.on("close", resolve);
    });
    // Awaited once its output has been read; until then a failure must not
    // go unhandled, which would bring the whole server down.
    exited.catch(() => undefined);
    child.stdin.end(toolRun.input);
    for await (const line of createInterface({ input: child.stdout })) {
      yield line;
    }
    const code = await exited;
    const late = timedOut();
    if (late !== undefined) {
      throw late;
    }
    if (code !== 0) {
      throw new ModelCallError(
        502,
        toolFailure(toolRun.tool, toolRun.image, code, errors),
      );
    }
  }
}

/**
 * Why a tool's run failed, from its exit code and what it wrote to its
 * standard error: Docker's own reason when `docker run` itself failed
 * (exit 125), saying how to build a sandbox image that is not there, and
 * otherwise the tool's last line.
 */
export function toolFailure(
  tool: CallingTool,
  image: string,
  code: number | null,
  stderr: string,
): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes("docker run --help"));
  if (
    lines.some((line) =>
      /Unable to find image|pull access denied|No such image/i.test(line),
    )
  ) {
    const build = tool === "Claude Code" ? "claude" : "codex";
    return `${tool} could not start: its sandbox image ${image} is not built. Build it with \`pnpm sandbox:build ${build}\`.`;
  }
  const reason =
    code === 125
      ? (lines.find((line) => line.startsWith("docker:")) ?? lines.at(-1))
      : lines.at(-1);
  return `${tool} failed (exit ${String(code)})${reason === undefined ? "." : `: ${reason}`}`;
}
