import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { aiProviders } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  agentToolOf,
  agentToolSetup,
  claudeHookAnswer,
  claudeHookCall,
  codexOverrides,
} from "./agent-tools.ts";
import {
  sandboxEnvironment,
  sandboxEnvironmentKeys,
  SandboxEnvironmentError,
  proxyEnvironment,
  proxyEnvironmentKeys,
} from "./environment.ts";
import { sandboxImages } from "./images.ts";

// Each AI Provider's agent tool in the sandbox (PRD FR-16), and how each
// is pointed at the AI Gateway with the Agent's Gateway Key, never an AI
// Account's credential (ADR 0001).

const run = promisify(execFile);
const gatewayKey = "aio_gk_agentkeyforthesandbox0000000000000000000";
const gateway = { url: "http://app:4000", key: gatewayKey };
const attribution = { issue: 4, pullRequest: 7, session: "sbx-1" };
const identity = { name: "adrianeyre", email: "adrian@example.com" };

const agents = {
  Claude: { aiProvider: "Claude", model: "claude-opus-5-5", effort: "high" },
  ChatGPT: { aiProvider: "ChatGPT", model: "gpt-5.5-codex", effort: "minimal" },
  Grok: { aiProvider: "Grok", model: "grok-5", effort: null },
  Gemini: { aiProvider: "Gemini", model: "gemini-3-pro", effort: null },
  OpenRouter: {
    aiProvider: "OpenRouter",
    model: "anthropic/claude-sonnet-4.5",
    effort: null,
  },
  DeepSeek: { aiProvider: "DeepSeek", model: "deepseek-chat", effort: null },
  "Z.ai": { aiProvider: "Z.ai", model: "glm-4.6", effort: null },
  Minimax: { aiProvider: "Minimax", model: "MiniMax-M2", effort: null },
  Kimi: { aiProvider: "Kimi", model: "kimi-k2-turbo-preview", effort: null },
  Qwen: { aiProvider: "Qwen", model: "qwen3-coder-plus", effort: null },
  Ollama: { aiProvider: "Ollama", model: "qwen3-coder:30b", effort: null },
  "Anthropic-compatible": {
    aiProvider: "Anthropic-compatible",
    model: "glm-4.6",
    effort: null,
  },
  "OpenAI-compatible": {
    aiProvider: "OpenAI-compatible",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    effort: null,
  },
} as const;

// AI Account credentials of every shape AI Office knows (PRD FR-35).
const aiAccountCredentials: Record<string, string> = {
  "an Anthropic API key": "sk-ant-api03-AbCdEf0123456789-xyz",
  "an Anthropic subscription token": "sk-ant-oat01-AbCdEf0123456789-xyz",
  "an OpenAI key": "sk-proj-AbCdEf0123456789AbCdEf01",
  "an xAI key": "xai-AbCdEf0123456789AbCdEf0123",
  "a Google API key": "AIzaSyA-0123456789abcdefghijklmnopqrstu",
  "a Google OAuth token": "ya29.a0AbCdEf0123456789AbCdEf",
  "a ChatGPT OAuth token (a JWT)":
    "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlMDEyMzQ1",
  "an OpenRouter key": "sk-or-v1-0123456789abcdef0123456789abcdef",
  "a DeepSeek or Kimi key": "sk-AbCdEf0123456789AbCdEf0123456789",
  "a Z.ai key": "0123456789abcdef0123456789abcdef.AbCdEf0123456789",
};

/** The command the agent tool runs with, as Sandcastle builds it. */
const commandOf = (setup: ReturnType<typeof agentToolSetup>) =>
  setup.provider.buildPrintCommand({
    prompt: "Work issue #4.",
    dangerouslySkipPermissions: true,
  });

/** `command`'s words after `sh` has parsed and expanded it, in `env`. */
const shellWords = async (
  command: string,
  env: Readonly<Record<string, string>>,
): Promise<string[]> =>
  (
    await run("sh", ["-c", `printf '%s\\n' ${command}`], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
    })
  ).stdout
    .split("\n")
    .slice(0, -1);

describe("the agent tool for each AI Provider", () => {
  it("is Claude Code for Claude and Anthropic-compatible endpoints, Codex for ChatGPT, opencode for every other", () => {
    expect(
      Object.fromEntries(
        aiProviders.map((aiProvider) => [aiProvider, agentToolOf(aiProvider)]),
      ),
    ).toEqual({
      Claude: "Claude Code",
      ChatGPT: "Codex",
      Grok: "opencode",
      Gemini: "opencode",
      OpenRouter: "opencode",
      DeepSeek: "opencode",
      "Z.ai": "opencode",
      Minimax: "opencode",
      Kimi: "opencode",
      Qwen: "opencode",
      Ollama: "opencode",
      "Anthropic-compatible": "Claude Code",
      "OpenAI-compatible": "opencode",
    });
    for (const aiProvider of aiProviders) {
      expect(
        agentToolSetup(agents[aiProvider], gateway, attribution).tool,
      ).toBe(agentToolOf(aiProvider));
    }
    expect(() => agentToolOf("Mistral")).toThrow(
      "No agent tool runs the AI Provider Mistral",
    );
  });

  it("each run from its own image", () => {
    expect(sandboxImages).toEqual({
      "Claude Code": "ai-office/sandbox-claude:6",
      Codex: "ai-office/sandbox-codex:6",
      opencode: "ai-office/sandbox-opencode:6",
    });
  });

  it("points Claude Code at the Gateway with ANTHROPIC_BASE_URL and the Gateway Key", () => {
    const setup = agentToolSetup(agents.Claude, gateway, attribution);
    expect(setup.environment).toEqual({
      ...proxyEnvironment("http://app:4000"),
      ANTHROPIC_BASE_URL: "http://app:4000",
      ANTHROPIC_AUTH_TOKEN: gatewayKey,
      ANTHROPIC_CUSTOM_HEADERS:
        "x-ai-office-issue: 4\nx-ai-office-pull-request: 7\nx-ai-office-session: sbx-1",
    });
    expect(setup.provider.name).toBe("claude-code");
    const { command, stdin } = commandOf(setup);
    expect(command).toMatch(/^claude /);
    expect(command).toContain("--model 'claude-opus-5-5'");
    expect(command).toContain("--effort high");
    expect(stdin).toBe("Work issue #4.");
  });

  it("gives Claude Code AI Office's screen as a PreToolUse hook on every tool when its calls are screened before they run (P1-8)", async () => {
    const screened = agentToolSetup(agents.Claude, gateway, attribution, {
      beforeCalls: true,
    });
    expect(screened.screensBeforeCalls).toBe(true);
    const words = await shellWords(commandOf(screened).command, {});
    const settings = JSON.parse(
      words[words.indexOf("--settings") + 1] ?? "{}",
    ) as {
      hooks: {
        PreToolUse: {
          matcher: string;
          hooks: { type: string; command: string; timeout: number }[];
        }[];
      };
    };
    const [entry] = settings.hooks.PreToolUse;
    expect(entry?.matcher).toBe("*");
    const hook = entry?.hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 120 });
    // To the Gateway's screen route, for this session, with the key taken
    // from the environment: never written in the command.
    expect(hook?.command).toContain(
      '"${ANTHROPIC_BASE_URL%/}/v1/ai-office/tool-calls"',
    );
    expect(hook?.command).toContain("'x-ai-office-session: sbx-1'");
    expect(hook?.command).toContain("$ANTHROPIC_AUTH_TOKEN");
    expect(hook?.command).not.toContain(gatewayKey);
    // Anything that stops the screen being asked blocks the call.
    expect(hook?.command).toMatch(/\|\| \{ echo '[^']+' >&2; exit 2; \}$/);

    // Without screening before calls, no settings are given for it.
    const unscreened = agentToolSetup(agents.Claude, gateway, attribution);
    expect(unscreened.screensBeforeCalls).toBe(false);
    expect(commandOf(unscreened).command).not.toContain("PreToolUse");
    // Codex and opencode take no such hook: their calls are screened as
    // they stream.
    for (const agent of [agents.ChatGPT, agents.Grok]) {
      const setup = agentToolSetup(agent, gateway, attribution, {
        beforeCalls: true,
      });
      expect(setup.screensBeforeCalls).toBe(false);
      expect(commandOf(setup).command).not.toContain("PreToolUse");
    }
  });

  it("starts Claude Code reading none of the repository's settings, CLAUDE.md or MCP servers, screened or not (P1-9)", async () => {
    for (const screening of [undefined, { beforeCalls: true }]) {
      const words = await shellWords(
        commandOf(
          agentToolSetup(agents.Claude, gateway, attribution, screening),
        ).command,
        {},
      );
      expect(words[words.indexOf("--setting-sources") + 1]).toBe("user");
      expect(words).toContain("--strict-mcp-config");
    }
    // Fact-finding's sandboxes start their agent tool the same way.
    expect(
      commandOf(
        agentToolSetup(
          { aiProvider: "Claude", model: "claude-opus-5-5", effort: null },
          gateway,
          { session: "sbx-2" },
        ),
      ).command,
    ).toContain("'--setting-sources' 'user' '--strict-mcp-config'");
  });

  it("reads a hook's call as the stream shows it, and answers a denial so the call does not run (P1-8)", () => {
    expect(
      claudeHookCall({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test", description: "Tests" },
      }),
    ).toEqual({ name: "Bash", args: "pnpm test" });
    expect(
      claudeHookCall({
        tool_name: "Read",
        tool_input: { file_path: "/proc/self/environ" },
      }),
    ).toEqual({ name: "Read", args: '{"file_path":"/proc/self/environ"}' });
    expect(claudeHookCall({ tool_input: {} })).toBeUndefined();
    expect(claudeHookCall("Bash")).toBeUndefined();
    expect(claudeHookAnswer(undefined)).toEqual({});
    expect(claudeHookAnswer("it reads the sandbox's credentials")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "AI Office stopped this call: it reads the sandbox's credentials",
      },
    });
  });

  it("runs Claude Code for an Anthropic-compatible endpoint too, with its Model and no effort", () => {
    const setup = agentToolSetup(
      { ...agents["Anthropic-compatible"], effort: "high" },
      gateway,
      attribution,
    );
    expect(setup.tool).toBe("Claude Code");
    // The Gateway, as for Claude: the endpoint's key never reaches it.
    expect(setup.environment).toEqual(
      agentToolSetup(agents.Claude, gateway, attribution).environment,
    );
    const { command } = commandOf(setup);
    expect(command).toContain("--model 'glm-4.6'");
    // Effort levels are Claude's own.
    expect(command).not.toContain("--effort");
  });

  it("points Codex at the Gateway's OpenAI API with OPENAI_BASE_URL and the Gateway Key", async () => {
    const setup = agentToolSetup(agents.ChatGPT, gateway, attribution);
    expect(setup.environment).toEqual({
      ...proxyEnvironment("http://app:4000"),
      OPENAI_BASE_URL: "http://app:4000/v1",
      AI_OFFICE_GATEWAY_KEY: gatewayKey,
      AI_OFFICE_ISSUE: "4",
      AI_OFFICE_PULL_REQUEST: "7",
      AI_OFFICE_SESSION: "sbx-1",
    });
    expect(setup.provider.name).toBe("codex");
    const { command, stdin } = commandOf(setup);
    expect(command).toMatch(/^codex exec --json /);
    // The prompt goes on standard input, never on the command line.
    expect(stdin).toBe("Work issue #4.");
    expect(command).not.toContain("Work issue");
    // The key is read from the environment, never written into the command.
    expect(command).not.toContain(gatewayKey);

    // What Codex is given, once the sandbox's shell has parsed the command.
    const words = await shellWords(
      command.replace(/^codex exec /, ""),
      setup.environment,
    );
    const overrides = words.flatMap((word, index) =>
      words[index - 1] === "-c" ? [word] : [],
    );
    expect(words).toContain("gpt-5.5-codex");
    expect(overrides).toEqual([
      'model_provider="ai_office"',
      'model_providers.ai_office.name="AI Office"',
      'model_providers.ai_office.env_key="AI_OFFICE_GATEWAY_KEY"',
      'model_providers.ai_office.wire_api="responses"',
      'model_providers.ai_office.env_http_headers={ "x-ai-office-issue" = "AI_OFFICE_ISSUE", "x-ai-office-pull-request" = "AI_OFFICE_PULL_REQUEST", "x-ai-office-session" = "AI_OFFICE_SESSION" }',
      // Codex's own effort levels, `minimal` among them.
      'model_reasoning_effort="minimal"',
      // The repository's AGENTS.md is not its instructions (P1-9).
      "project_doc_max_bytes=0",
      'model_providers.ai_office.base_url="http://app:4000/v1"',
    ]);
  });

  it("gives Codex no effort when the Agent has none", () => {
    expect(codexOverrides(undefined)).not.toContain("model_reasoning_effort");
    const setup = agentToolSetup(
      { ...agents.ChatGPT, effort: null },
      gateway,
      attribution,
    );
    expect(commandOf(setup).command).not.toContain("model_reasoning_effort");
  });

  it("names only the issue to Codex until it has a pull request", () => {
    expect(
      agentToolSetup(agents.ChatGPT, gateway, { issue: 12 }).environment,
    ).toEqual({
      ...proxyEnvironment("http://app:4000"),
      OPENAI_BASE_URL: "http://app:4000/v1",
      AI_OFFICE_GATEWAY_KEY: gatewayKey,
      AI_OFFICE_ISSUE: "12",
    });
  });

  it.each(["Grok", "Gemini"] as const)(
    "points opencode at the Gateway's OpenAI API with its provider config, for %s",
    (aiProvider) => {
      const agent = agents[aiProvider];
      const setup = agentToolSetup(
        agent,
        { ...gateway, url: "http://app:4000/" },
        attribution,
      );
      expect(Object.keys(setup.environment)).toEqual([
        ...proxyEnvironmentKeys,
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_CONFIG_CONTENT",
      ]);
      // Nothing of the repository configures it (P1-9).
      expect(setup.environment["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("true");
      expect(setup.environment["OPENCODE_DISABLE_CLAUDE_CODE"]).toBe("true");
      const config = JSON.parse(
        setup.environment["OPENCODE_CONFIG_CONTENT"] ?? "",
      ) as unknown;
      expect(config).toEqual({
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        share: "disabled",
        // The Gateway is its only model provider.
        enabled_providers: ["ai-office"],
        model: `ai-office/${agent.model}`,
        small_model: `ai-office/${agent.model}`,
        provider: {
          "ai-office": {
            npm: "@ai-sdk/openai-compatible",
            name: "AI Office",
            options: {
              baseURL: "http://app:4000/v1",
              apiKey: gatewayKey,
              headers: {
                "x-ai-office-issue": "4",
                "x-ai-office-pull-request": "7",
                "x-ai-office-session": "sbx-1",
              },
            },
            models: { [agent.model]: { name: agent.model } },
          },
        },
      });
      expect(setup.provider.name).toBe("opencode");
      const { command } = commandOf(setup);
      expect(command).toMatch(/^opencode run --format json /);
      expect(command).toContain(`--model 'ai-office/${agent.model}'`);
      // opencode takes no effort for these AI Providers.
      expect(command).not.toContain("--variant");
      expect(command).not.toContain(gatewayKey);
    },
  );

  it("gives opencode the prompt as one word, never running shell in it", async () => {
    const setup = agentToolSetup(agents.Grok, gateway, attribution);
    const prompt = "Add a basket. $(touch pwned) `id` '; rm -rf / #";
    const { command } = setup.provider.buildPrintCommand({
      prompt,
      dangerouslySkipPermissions: true,
    });
    const words = await shellWords(command.replace(/^opencode /, ""), {});
    expect(words.at(-1)).toBe(prompt);
  });

  it.each(aiProviders)(
    "gives %s's tool an environment with no key for an AI Account's credential",
    (aiProvider) => {
      const environment = sandboxEnvironment({
        identity,
        githubToken: "ghs_readonly",
        model: agentToolSetup(agents[aiProvider], gateway, attribution)
          .environment,
      });
      for (const key of Object.keys(environment)) {
        expect(sandboxEnvironmentKeys).toContain(key);
      }
      for (const key of [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "XAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "ZHIPU_API_KEY",
        "MINIMAX_API_KEY",
        "MOONSHOT_API_KEY",
        "DASHSCOPE_API_KEY",
        "OLLAMA_API_KEY",
      ]) {
        expect(environment).not.toHaveProperty(key);
        expect(sandboxEnvironmentKeys).not.toContain(key);
      }
      // The only secret it holds for models is the Agent's Gateway Key.
      const holding = Object.entries(environment)
        .filter(([, value]) => value.includes("aio_gk_"))
        .map(([key]) => key);
      expect(holding).toHaveLength(1);
    },
  );

  // Where each tool's key goes: refused there, never let through.
  const keyPlaces = {
    Claude: "ANTHROPIC_AUTH_TOKEN",
    ChatGPT: "AI_OFFICE_GATEWAY_KEY",
    Grok: "OPENCODE_CONFIG_CONTENT",
    Gemini: "OPENCODE_CONFIG_CONTENT",
    OpenRouter: "OPENCODE_CONFIG_CONTENT",
    DeepSeek: "OPENCODE_CONFIG_CONTENT",
    "Z.ai": "OPENCODE_CONFIG_CONTENT",
    Minimax: "OPENCODE_CONFIG_CONTENT",
    Kimi: "OPENCODE_CONFIG_CONTENT",
    Qwen: "OPENCODE_CONFIG_CONTENT",
    Ollama: "OPENCODE_CONFIG_CONTENT",
    "Anthropic-compatible": "ANTHROPIC_AUTH_TOKEN",
    "OpenAI-compatible": "OPENCODE_CONFIG_CONTENT",
  } as const;

  it.each(
    aiProviders.flatMap((aiProvider) =>
      Object.entries(aiAccountCredentials).map(
        ([kind, credential]) => [aiProvider, kind, credential] as const,
      ),
    ),
  )(
    "takes only a Gateway Key for %s's tool, never %s",
    (aiProvider, _kind, credential) => {
      const refusal = (() => {
        try {
          agentToolSetup(
            agents[aiProvider],
            { url: "http://app:4000", key: credential },
            attribution,
          );
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(refusal).toBeInstanceOf(SandboxEnvironmentError);
      expect((refusal as SandboxEnvironmentError).key).toBe(
        keyPlaces[aiProvider],
      );
      // The refusal never carries the credential.
      expect((refusal as Error).message).not.toContain(credential);
    },
  );

  it.each(aiProviders)(
    "refuses %s's environment when a credential is slipped into it",
    (aiProvider) => {
      const { environment } = agentToolSetup(
        agents[aiProvider],
        gateway,
        attribution,
      );
      for (const [key, value] of Object.entries(environment)) {
        const slipped = () =>
          sandboxEnvironment({
            identity,
            githubToken: "ghs_readonly",
            model: {
              ...environment,
              [key]: `${value} ${aiAccountCredentials["an OpenAI key"] ?? ""}`,
            },
          });
        if ((proxyEnvironmentKeys as readonly string[]).includes(key)) {
          // A proxy variable keeps only AI Office's own value: anything
          // else, a credential with it, is dropped before the sandbox.
          expect(slipped()).not.toHaveProperty(key);
        } else {
          expect(slipped).toThrow(expect.objectContaining({ key }));
        }
      }
    },
  );
});
