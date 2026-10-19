import { z } from "zod";

import { aiProviders } from "./agents.ts";
import type { GatewayEndpointName } from "./gateway-requests.ts";
import { ownerUrl, ownerUrlProblem } from "./internal-hosts.ts";
import { modelNameSchema } from "./pricing.ts";

// AI Accounts (PRD §6.8, FR-35, FR-36): the Owner's credentials with AI
// Providers, which the AI Gateway serves Agents' model calls from. The
// server and the web app share these. A credential goes in when an account
// is added and never comes back out: no response carries it, or any part
// of it.

/**
 * How an AI Account signs in: a key, a subscription's OAuth login, a
 * cloud platform's own credentials (AWS Bedrock's IAM credentials or
 * profile, Google Vertex AI's service account), or an endpoint the Owner
 * names, with a key only if it asks for one (`endpoint`: the Owner's own
 * Ollama server, or any Anthropic- or OpenAI-compatible API).
 */
export const aiAccountTypes = [
  "api_key",
  "oauth",
  "bedrock",
  "vertex",
  "endpoint",
] as const;
export type AiAccountType = (typeof aiAccountTypes)[number];

/** The agent tools that run in sandboxes (PRD FR-16). */
export const agentTools = ["Claude Code", "Codex", "opencode"] as const;
export type AgentTool = (typeof agentTools)[number];

/** Where the Owner's own Ollama server is when they give no URL. */
export const ollamaEndpointUrl = "http://localhost:11434";

/**
 * The kinds of AI Account that can be added so far: an AI Provider and an
 * account type, with the API the Gateway calls (its format, and where its
 * paths start, in place of `/v1`). A subscription's OAuth login serves
 * only the agent tool AI Office runs for its AI Provider (`servesOnly`;
 * FR-16), as the provider's terms require (FR-35, PRD §11), and is signed
 * in to by pasting back a code (`pkce`) or by approving a code on the AI
 * Provider's page (`device`). An account serves every Gateway endpoint,
 * passed through or translated, unless it names the ones it can
 * (`serves`): Gemini's has no Responses API, and nothing translates to
 * Chat Completions from it; a ChatGPT subscription serves Codex's
 * Responses only, at ChatGPT's own Codex backend. Each lists its Models
 * at `modelsPath` (FR-41). A kind whose AI Provider lets it go on past its
 * plan's limits, billed as extra usage, says so (`extraUsage`; FR-41): a
 * Claude subscription. A cloud platform's account (`platform`) reaches
 * Claude Models on AWS Bedrock or Google Vertex AI in a region, signed
 * with that platform's own credentials, and names Models as the platform
 * does (`platformModel`); neither lists its Models (`modelsPath` null).
 * OpenRouter's, DeepSeek's, Z.ai's, Minimax's and Kimi's API keys speak
 * OpenAI's formats, each to its own API; none counts tokens. Z.ai's API
 * lists no Models, so its documented ones are its catalogue
 * (`documentedModels`). Qwen's sign-in is Qwen Code's free one, at the
 * API its login names. Ollama is the Owner's own server (no key) or Ollama
 * Cloud (a key). An Anthropic- or OpenAI-compatible endpoint has no
 * address of its own (`defaultEndpointUrl` null): the Owner gives it, and
 * it is sent any Model asked of it (`anyModel`), since only the Owner
 * knows what it serves.
 */
export const aiAccountKinds = [
  {
    aiProvider: "Claude",
    accountType: "api_key",
    label: "Anthropic Console API key",
    defaultEndpointUrl: "https://api.anthropic.com",
    apiFormat: "anthropic",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
  },
  {
    aiProvider: "Claude",
    accountType: "oauth",
    label: "Claude subscription (Pro or Max)",
    defaultEndpointUrl: "https://api.anthropic.com",
    apiFormat: "anthropic",
    apiPath: "/v1",
    servesOnly: "Claude Code",
    signIn: "pkce",
    extraUsage: true,
  },
  {
    aiProvider: "Grok",
    accountType: "api_key",
    label: "xAI API key",
    defaultEndpointUrl: "https://api.x.ai",
    apiFormat: "openai",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
  },
  {
    aiProvider: "Grok",
    accountType: "oauth",
    label: "Grok subscription (xAI sign-in, or a Grok CLI login)",
    defaultEndpointUrl: "https://api.x.ai",
    apiFormat: "openai",
    apiPath: "/v1",
    servesOnly: "opencode",
    signIn: "device",
  },
  {
    aiProvider: "ChatGPT",
    accountType: "oauth",
    label: "ChatGPT subscription (Plus, Pro or Business), for Codex",
    defaultEndpointUrl: "https://chatgpt.com",
    apiFormat: "openai",
    apiPath: "/backend-api/codex",
    servesOnly: "Codex",
    signIn: "pkce",
    serves: ["responses", "responses_compact"],
    // Its model list answers Codex, which names its version: it lists only
    // the Models that version can use. The sandbox runs the latest Codex,
    // so the list asks as a version newer than any yet.
    modelsPath: "/models?client_version=0.999.0",
  },
  {
    aiProvider: "Gemini",
    accountType: "api_key",
    label: "Gemini API key (Google AI Studio)",
    defaultEndpointUrl: "https://generativelanguage.googleapis.com",
    apiFormat: "openai",
    apiPath: "/v1beta/openai",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "messages"],
  },
  {
    // Claude in Amazon Bedrock: the Messages API, signed with SigV4.
    aiProvider: "Claude",
    accountType: "bedrock",
    label: "AWS Bedrock (IAM credentials or profile)",
    defaultEndpointUrl: "https://bedrock-mantle.{region}.api.aws",
    apiFormat: "anthropic",
    apiPath: "/anthropic/v1",
    servesOnly: null,
    signIn: null,
    // It counts no tokens.
    serves: ["messages", "chat_completions", "responses", "responses_compact"],
    modelsPath: null,
    platform: "bedrock",
  },
  {
    // Claude on Google Vertex AI: `rawPredict`, with a service account's
    // access token.
    aiProvider: "Claude",
    accountType: "vertex",
    label: "Google Vertex AI (service account)",
    defaultEndpointUrl: "https://{region}-aiplatform.googleapis.com",
    apiFormat: "anthropic",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
    modelsPath: null,
    platform: "vertex",
  },
  {
    // Every AI Provider's Models through one key, named `vendor/model`.
    aiProvider: "OpenRouter",
    accountType: "api_key",
    label: "OpenRouter API key",
    defaultEndpointUrl: "https://openrouter.ai",
    apiFormat: "openai",
    apiPath: "/api/v1",
    servesOnly: null,
    signIn: null,
    // And Jev's typed questions (`/api/v1/systemone`), for the Decision
    // Model (FR-17).
    serves: ["chat_completions", "responses", "messages", "systemone"],
    // Its list is paged, 500 to a page unless asked for up to 1000.
    modelsPath: "/models?limit=1000",
  },
  {
    // DeepSeek's API has no /v1 in its paths.
    aiProvider: "DeepSeek",
    accountType: "api_key",
    label: "DeepSeek API key",
    defaultEndpointUrl: "https://api.deepseek.com",
    apiFormat: "openai",
    apiPath: "",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "responses", "messages"],
  },
  {
    // Z.ai's pay-as-you-go API, not its Coding Plan's.
    aiProvider: "Z.ai",
    accountType: "api_key",
    label: "Z.ai API key",
    defaultEndpointUrl: "https://api.z.ai",
    apiFormat: "openai",
    apiPath: "/api/paas/v4",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "messages"],
    modelsPath: null,
    // As Z.ai's model and pricing pages list them, 2026-10-10.
    documentedModels: [
      { model: "glm-5.3", displayName: "GLM-5.3", contextWindow: 1_000_000 },
      { model: "glm-5.2", displayName: "GLM-5.2", contextWindow: 1_000_000 },
      {
        model: "glm-5.3-flashx",
        displayName: "GLM-5.3-FlashX",
        contextWindow: 1_000_000,
      },
      {
        model: "glm-5.3-flash",
        displayName: "GLM-5.3-Flash",
        contextWindow: 1_000_000,
      },
      { model: "glm-5.1", displayName: "GLM-5.1", contextWindow: 200_000 },
      { model: "glm-5", displayName: "GLM-5", contextWindow: 200_000 },
      { model: "glm-4.7", displayName: "GLM-4.7", contextWindow: null },
      { model: "glm-4.6", displayName: "GLM-4.6", contextWindow: null },
    ],
  },
  {
    aiProvider: "Minimax",
    accountType: "api_key",
    label: "MiniMax API key",
    defaultEndpointUrl: "https://api.minimax.io",
    apiFormat: "openai",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "responses", "messages"],
  },
  {
    // Moonshot AI's international platform.
    aiProvider: "Kimi",
    accountType: "api_key",
    label: "Kimi API key (Moonshot AI)",
    defaultEndpointUrl: "https://api.moonshot.ai",
    apiFormat: "openai",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "responses", "messages"],
  },
  {
    // Qwen Code's free sign-in at chat.qwen.ai. Each login names the host
    // its API is at (`resource_url`), Qwen's portal by default.
    aiProvider: "Qwen",
    accountType: "oauth",
    label: "Qwen sign-in (Qwen Code's free tier)",
    defaultEndpointUrl: "https://portal.qwen.ai",
    apiFormat: "openai",
    apiPath: "/v1",
    servesOnly: "opencode",
    signIn: "device",
    serves: ["chat_completions"],
    modelsPath: null,
    // As Qwen Code names the Models its sign-in serves, 2026-10-10.
    documentedModels: [
      { model: "coder-model", displayName: "Qwen Coder", contextWindow: null },
      {
        model: "vision-model",
        displayName: "Qwen Vision",
        contextWindow: null,
      },
      {
        model: "qwen3-coder-plus",
        displayName: "Qwen3-Coder-Plus",
        contextWindow: 1_048_576,
      },
      {
        model: "qwen3-coder-flash",
        displayName: "Qwen3-Coder-Flash",
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    // The Owner's own Ollama server, through its OpenAI-compatible API.
    aiProvider: "Ollama",
    accountType: "endpoint",
    label: "Ollama (your own server)",
    defaultEndpointUrl: ollamaEndpointUrl,
    apiFormat: "openai",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "messages"],
  },
  {
    // Ollama's cloud Models at ollama.com, with an Ollama API key.
    aiProvider: "Ollama",
    accountType: "api_key",
    label: "Ollama Cloud API key",
    defaultEndpointUrl: "https://ollama.com",
    apiFormat: "openai",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "messages"],
  },
  {
    // Its URL is where `/v1/messages` goes after, as ANTHROPIC_BASE_URL
    // is given to Anthropic's own clients.
    aiProvider: "Anthropic-compatible",
    accountType: "endpoint",
    label: "Anthropic-compatible endpoint",
    defaultEndpointUrl: null,
    apiFormat: "anthropic",
    apiPath: "/v1",
    servesOnly: null,
    signIn: null,
    // Few count tokens.
    serves: ["messages", "chat_completions", "responses", "responses_compact"],
    anyModel: true,
    // Most read the key as ANTHROPIC_AUTH_TOKEN sends it; some as
    // ANTHROPIC_API_KEY does.
    bearerToo: true,
  },
  {
    // Its URL is the API's root, `/v1` included, as OPENAI_BASE_URL is
    // given to OpenAI's own clients: `/chat/completions` goes after it.
    aiProvider: "OpenAI-compatible",
    accountType: "endpoint",
    label: "OpenAI-compatible endpoint",
    defaultEndpointUrl: null,
    apiFormat: "openai",
    apiPath: "",
    servesOnly: null,
    signIn: null,
    serves: ["chat_completions", "responses", "messages"],
    anyModel: true,
  },
] as const satisfies readonly {
  aiProvider: (typeof aiProviders)[number];
  accountType: AiAccountType;
  label: string;
  /** Its AI Provider's own API; null where the Owner must give one. */
  defaultEndpointUrl: string | null;
  apiFormat: "anthropic" | "openai";
  apiPath: string;
  servesOnly: AgentTool | null;
  signIn: "pkce" | "device" | null;
  serves?: readonly GatewayEndpointName[];
  /**
   * Where its Models are listed (FR-41), after `apiPath`; `/models` if
   * absent, and null for a kind that lists none.
   */
  modelsPath?: string | null;
  /**
   * Its Models as its AI Provider documents them, for a kind whose API
   * lists none (`modelsPath` null): its catalogue all the same (FR-41).
   */
  documentedModels?: readonly DocumentedModel[];
  /** The cloud platform it reaches Claude through, in a region. */
  platform?: CloudPlatform;
  /** Its AI Provider offers extra usage past the plan's limits (FR-41). */
  extraUsage?: true;
  /** It is sent any Model asked of it, whoever's it is by name. */
  anyModel?: true;
  /** Its key goes as a bearer token too, besides Anthropic's `x-api-key`. */
  bearerToo?: true;
}[];

/** A Model an AI Provider documents, for a kind whose API lists none. */
export interface DocumentedModel {
  readonly model: string;
  readonly displayName: string;
  /** Its context window in tokens; null where it is not documented. */
  readonly contextWindow: number | null;
}

/**
 * Whether an account of `kind` can serve a request to `endpoint`: one that
 * names none serves every endpoint but the Decision Model's (`systemone`,
 * FR-17), which only a kind naming it answers.
 */
export const kindServes = (
  kind: AiAccountKind,
  endpoint: GatewayEndpointName,
): boolean =>
  "serves" in kind
    ? (kind.serves as readonly GatewayEndpointName[]).includes(endpoint)
    : endpoint !== "systemone";
export type AiAccountKind = (typeof aiAccountKinds)[number];

/** The cloud platforms Claude is reached through (FR-35). */
export const cloudPlatforms = ["bedrock", "vertex"] as const;
export type CloudPlatform = (typeof cloudPlatforms)[number];

/** The cloud platform an account of `kind` reaches its Models through. */
export const platformOf = (kind: AiAccountKind): CloudPlatform | undefined =>
  "platform" in kind ? kind.platform : undefined;

/**
 * A cloud platform's own API in `region`: Claude in Amazon Bedrock's
 * `bedrock-mantle` endpoint; Vertex AI's global endpoint, a multi-region
 * one (`us`, `eu`) or a region's.
 */
export const platformEndpointUrl = (
  platform: CloudPlatform,
  region: string,
): string =>
  platform === "bedrock"
    ? `https://bedrock-mantle.${region}.api.aws`
    : region === "global"
      ? "https://aiplatform.googleapis.com"
      : region === "us" || region === "eu"
        ? `https://aiplatform.${region}.rep.googleapis.com`
        : `https://${region}-aiplatform.googleapis.com`;

/**
 * A Claude Model's name as an account of `kind` is sent it: on Bedrock,
 * with its `anthropic.` provider prefix and without a snapshot date
 * (`anthropic.claude-opus-5-5`); on Vertex AI, with a snapshot date after
 * `@` (`claude-haiku-4-5@20251001`). A name the platform already uses, a
 * Bedrock inference profile (`us.anthropic.…`) or another AI Provider's
 * Model is left as it is, and so is every Model for another kind.
 */
export const platformModel = (kind: AiAccountKind, model: string): string => {
  const platform = platformOf(kind);
  if (platform === undefined || !model.startsWith("claude-")) {
    return model;
  }
  const dated = /^(.+)-(\d{8})$/.exec(model);
  return platform === "bedrock"
    ? `anthropic.${dated?.[1] ?? model}`
    : dated === null
      ? model
      : `${dated[1] ?? ""}@${dated[2] ?? ""}`;
};

/**
 * A Model's name without what a platform or router adds to it: a
 * `provider/` prefix, a Bedrock (`anthropic.`) or inference profile
 * (`us.anthropic.`) prefix, a Bedrock version (`-v1:0`) or a Vertex AI
 * snapshot date (`@20251001`), which becomes `-20251001`.
 */
const bareModel = (model: string): string => {
  const name = model
    .trim()
    .toLowerCase()
    .replace(/^[a-z-]+\//, "");
  const bedrock = /^(?:[a-z]{2,6}\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/.exec(
    name,
  );
  return (bedrock?.[1] ?? name).replace(/@(\d{8})$/, "-$1");
};

/**
 * Whether an account of this kind can go on past its plan's limits on
 * extra usage its AI Provider bills (FR-41): only then is the Owner's
 * "extra usage" toggle offered.
 */
export const offersExtraUsage = (account: {
  readonly aiProvider: string;
  readonly accountType: string;
}): boolean => {
  const kind = aiAccountKindOf(account);
  return kind !== undefined && "extraUsage" in kind && kind.extraUsage;
};

/**
 * What the Owner is told before adding a subscription account (PRD §11):
 * the AI Provider's terms allow its subscription only in its own tool.
 */
export const subscriptionTermsWarning =
  "Anthropic's terms allow a Claude subscription to be used only through Claude Code. AI Office uses this account only for requests from Claude Code (your Agents' sandboxes, or your own Claude Code with a Gateway Key), never for other tools or for translated requests. Use an API key for anything else.";

/** Each subscription's warning, by AI Provider. */
export const subscriptionTermsWarnings = {
  Claude: subscriptionTermsWarning,
  Grok: "A Grok subscription signs in with xAI's own CLI client, which xAI does not document for other tools, and xAI may restrict it. AI Office uses this account only for requests from opencode (the agent tool for Grok), unchanged, never for other tools or translated requests. Use an xAI API key for anything else.",
  ChatGPT:
    "OpenAI's terms allow a ChatGPT subscription to be used for coding only through Codex, and its usage limits are those of your plan. AI Office signs in as Codex does, and uses this account only for Codex's Responses requests (your Agents' sandboxes, or your own Codex with a Gateway Key), passed on unchanged, never for other tools or for translated requests. Use an API key for anything else.",
  Qwen: "A Qwen sign-in is Qwen Code's own (its OAuth client at chat.qwen.ai), which Qwen does not document for other tools, and Qwen may restrict it. Its free tier allows a limited number of requests a minute and a day. AI Office uses this account only for requests from opencode (the agent tool for Qwen), unchanged, never for other tools or translated requests.",
} as const satisfies Record<SubscriptionProvider, string>;

/** The AI Providers whose subscriptions can be added. */
export const subscriptionProviders = [
  "Claude",
  "Grok",
  "ChatGPT",
  "Qwen",
] as const;
export type SubscriptionProvider = (typeof subscriptionProviders)[number];

/** The AI Providers whose API keys can be added. */
export const apiKeyProviders = [
  "Claude",
  "Grok",
  "Gemini",
  "OpenRouter",
  "DeepSeek",
  "Z.ai",
  "Minimax",
  "Kimi",
  "Ollama",
] as const;

/**
 * The AI Providers whose endpoints can be added: the Owner's own Ollama
 * server, and any Anthropic- or OpenAI-compatible API.
 */
export const endpointProviders = [
  "Ollama",
  "Anthropic-compatible",
  "OpenAI-compatible",
] as const;

/**
 * The AI Providers whose accounts are sent any Model asked of them,
 * whoever's it is by name: an Anthropic- or OpenAI-compatible endpoint
 * serves whatever its owner put behind it.
 */
export const anyModelProviders = [
  "Anthropic-compatible",
  "OpenAI-compatible",
] as const;

/** Whether `aiProvider`'s accounts are sent any Model asked of them. */
export const servesAnyModel = (aiProvider: string): boolean =>
  (anyModelProviders as readonly string[]).includes(aiProvider);

/**
 * How only Ollama names Models: the Model, a colon, then its tag
 * (`llama3.3:70b`, `gpt-oss:120b`, `qwen3-coder:30b`), but not Bedrock's
 * version (`-v1:0`).
 */
const ollamaModel = /^[a-z0-9][\w.-]*:[\w.-]+$/i;
const bedrockVersion = /-v\d+:\d+$/;

/**
 * How only OpenRouter names Models: its vendor, a slash, then the vendor's
 * Model (`anthropic/claude-sonnet-4.5`, `deepseek/deepseek-chat`,
 * `openrouter/auto`).
 */
const openRouterModel = /^[a-z0-9][\w.-]*\/\S/i;

/**
 * The AI Provider a Model belongs to, by its name (FR-15): OpenRouter's
 * `vendor/model`, whatever the vendor; Ollama's `model:tag`, whoever made
 * the Model; then Claude's `claude-*` (and Bedrock's `anthropic.claude-*`),
 * Grok's `grok-*`, Gemini's `gemini-*` and `gemma-*`, ChatGPT's `gpt-*`,
 * `o1`… and `codex-*`, DeepSeek's `deepseek-*`, Z.ai's `glm-*`, Minimax's
 * `MiniMax-*`, Kimi's `kimi-*` and `moonshot-*`, and Qwen's `qwen*`,
 * `qwq-*` and its sign-in's `coder-model` and `vision-model`; undefined for
 * one it does not know, which any account may be asked for.
 */
export const aiProviderOfModel = (
  model: string,
): (typeof aiProviders)[number] | undefined => {
  const trimmed = model.trim();
  if (openRouterModel.test(trimmed)) {
    return "OpenRouter";
  }
  if (ollamaModel.test(trimmed) && !bedrockVersion.test(trimmed)) {
    return "Ollama";
  }
  const name = bareModel(model);
  return name.startsWith("claude-")
    ? "Claude"
    : name.startsWith("grok-")
      ? "Grok"
      : /^(gemini-|gemma-)/.test(name)
        ? "Gemini"
        : /^(gpt-|o\d|codex-|chatgpt-)/.test(name)
          ? "ChatGPT"
          : name.startsWith("deepseek-")
            ? "DeepSeek"
            : name.startsWith("glm-")
              ? "Z.ai"
              : name.startsWith("minimax-")
                ? "Minimax"
                : /^(kimi-|moonshot-)/.test(name)
                  ? "Kimi"
                  : /^(qwen|qwq-|coder-model$|vision-model$)/.test(name)
                    ? "Qwen"
                    : undefined;
};

/**
 * Whether `aiProvider`'s accounts may be sent `model` (FR-38, FR-41): a
 * Model of a known AI Provider goes only to that AI Provider's, one no AI
 * Provider claims to any, and every Model to a compatible endpoint's.
 */
export const aiProviderTakes = (aiProvider: string, model: string): boolean => {
  if (servesAnyModel(aiProvider)) {
    return true;
  }
  const owner = aiProviderOfModel(model);
  return owner === undefined || owner === aiProvider;
};

/**
 * The family a Model belongs to, by its name (FR-38): an AI Provider's
 * limits for one family (Claude's Opus, Sonnet or Haiku) leave its others
 * be. Claude's Models are `claude-opus`, `claude-sonnet` or
 * `claude-haiku`, whatever their version; another Model is its own family,
 * without a date it is pinned to (`-20250101`, `-2025-01-01`).
 */
export const modelFamilyOf = (model: string): string => {
  const name = bareModel(model);
  const claude = /^claude-(?:[\d.-]+-)?(opus|sonnet|haiku)\b/.exec(name);
  return claude === null
    ? name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    : `claude-${claude[1] ?? ""}`;
};

/**
 * How an OAuth account's access token stands (FR-36): `valid`, `expiring`
 * (within `tokenExpiringWithinMs`, when it is refreshed) or `expired`.
 */
export const tokenHealths = ["valid", "expiring", "expired"] as const;
export type TokenHealth = (typeof tokenHealths)[number];

/** How long before its expiry a token is `expiring`, and refreshed. */
export const tokenExpiringWithinMs = 15 * 60 * 1000;

/** The health of a token that expires at `expiresAt`, at `now`. */
export const tokenHealthOf = (expiresAt: Date, now: Date): TokenHealth => {
  const left = expiresAt.getTime() - now.getTime();
  return left <= 0
    ? "expired"
    : left <= tokenExpiringWithinMs
      ? "expiring"
      : "valid";
};

/**
 * Why the AI Gateway holds an AI Account back for a while (FR-38, FR-39):
 * its AI Provider said it is rate-limited (a capacity exclusion, 429 when
 * nothing else can serve) or overloaded (throttling, 529), or it failed
 * too often in a row and its circuit is open (503). Each lasts until a
 * time: the AI Provider's reset, or the circuit breaker's cooldown. An
 * account whose usage window has reached the Owner's pause threshold is
 * held back too, until that window resets (throttling, 529; FR-36). So is
 * an account that offers extra usage, with the Owner's toggle off, once
 * its plan's limit is reached (a window at 100%, or an answer saying it
 * was served on extra usage), until that resets (capacity, 429; FR-41).
 */
export const aiAccountLimitReasons = [
  "rate_limited",
  "overloaded",
  "circuit_open",
  "usage_threshold",
  "extra_usage",
] as const;
export type AiAccountLimitReason = (typeof aiAccountLimitReasons)[number];

export const aiAccountLimitReasonLabels: Record<AiAccountLimitReason, string> =
  {
    rate_limited: "Rate-limited",
    overloaded: "Overloaded",
    circuit_open: "Failing (circuit open)",
    usage_threshold: "Paused at its usage threshold",
    extra_usage: "At its plan's limit (extra usage off)",
  };

/**
 * An account's usage windows (FR-36, FR-43), as its AI Provider reports
 * them: the five-hour window and the weekly one.
 */
export const usageWindows = ["five_hour", "weekly"] as const;
export type UsageWindow = (typeof usageWindows)[number];

export const usageWindowLabels: Record<UsageWindow, string> = {
  five_hour: "5-hour",
  weekly: "Weekly",
};

/**
 * How much of a window is used (a percentage), and when it resets: null
 * while none is running (it has reset, and no request has started the
 * next), so nothing of it is used.
 */
export const usageWindowStateSchema = z.object({
  /** 0 to 100, or more once the AI Provider lets it go over. */
  utilization: z.number().min(0),
  resetsAt: z.iso.datetime({ offset: true }).nullable(),
});
export type UsageWindowState = z.infer<typeof usageWindowStateSchema>;

/**
 * The per-minute limits an API key's answers report in their headers
 * (Anthropic's `anthropic-ratelimit-*`, OpenAI-style `x-ratelimit-*`):
 * requests, and tokens (or input and output tokens apart, as Anthropic
 * counts them).
 */
export const rateLimitKinds = [
  "requests",
  "tokens",
  "inputTokens",
  "outputTokens",
] as const;
export type RateLimitKind = (typeof rateLimitKinds)[number];

export const rateLimitKindLabels: Record<RateLimitKind, string> = {
  requests: "Requests",
  tokens: "Tokens",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
};

/** One rate limit as an answer reported it. */
export const rateLimitStateSchema = z.object({
  limit: z.number().min(0),
  remaining: z.number().min(0),
  /** When it is full again; null when the answer did not say. */
  resetsAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RateLimitState = z.infer<typeof rateLimitStateSchema>;

/** An account's rate limits, as its latest answer that had them reported. */
export const rateLimitsSchema = z.object({
  requests: rateLimitStateSchema.nullable(),
  tokens: rateLimitStateSchema.nullable(),
  inputTokens: rateLimitStateSchema.nullable(),
  outputTokens: rateLimitStateSchema.nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});
export type RateLimits = z.infer<typeof rateLimitsSchema>;

/**
 * A prepaid account's credit, as its AI Provider's balance endpoint last
 * gave it (OpenRouter's key, DeepSeek's and Kimi's balance): what is
 * left, and, where it says, what was used of a limit. In `currency`.
 */
export const creditBalanceSchema = z.object({
  currency: z.string(),
  remaining: z.number().nullable(),
  used: z.number().nullable(),
  limit: z.number().nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});
export type CreditBalance = z.infer<typeof creditBalanceSchema>;

/** The lowest and highest usage pause threshold, in percent. */
export const minPauseThreshold = 1;
export const maxPauseThreshold = 100;

/** The kind of an account, by its AI Provider and account type. */
export const aiAccountKindOf = (account: {
  readonly aiProvider: string;
  readonly accountType: string;
}): AiAccountKind | undefined =>
  aiAccountKinds.find(
    (kind) =>
      kind.aiProvider === account.aiProvider &&
      kind.accountType === account.accountType,
  );

/** Priority 1 is used first; ties go to the oldest account. */
export const minAiAccountPriority = 1;
export const maxAiAccountPriority = 100;

const name = z
  .string({ error: "Give the AI Account a name." })
  .trim()
  .min(1, { error: "Give the AI Account a name." })
  .max(100, { error: "Use at most 100 characters for the name." });

const priority = z
  .number({ error: "The priority is a whole number." })
  .int({ error: "The priority is a whole number." })
  .min(minAiAccountPriority, {
    error: `The priority is at least ${String(minAiAccountPriority)}.`,
  })
  .max(maxAiAccountPriority, {
    error: `The priority is at most ${String(maxAiAccountPriority)}.`,
  });

/**
 * A custom endpoint URL, in place of the AI Provider's own API (FR-35).
 * It is shown back to the Owner, so it may not carry a password. The
 * Gateway fetches it and hands the answer to its caller, so it may not
 * name an internal host the Owner did not allow, nor be plain http:// to
 * one (ADR 0007, I1-1).
 */
const endpointUrl = z
  .url({
    protocol: /^https?$/,
    error: "The endpoint is an http:// or https:// URL.",
  })
  .refine(
    (value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    },
    {
      error:
        "Leave credentials out of the endpoint URL; the key goes in its own field.",
    },
  )
  .refine((value) => !/[?#]/.test(value), {
    error: "The endpoint URL takes no query or fragment.",
  })
  .superRefine(ownerUrl("The endpoint"));

/** An API key. */
const apiKey = z
  .string({ error: "Enter the API key." })
  .trim()
  .min(1, { error: "Enter the API key." })
  .max(4096, { error: "That is too long for an API key." })
  .regex(/^\S*$/, { error: "An API key has no spaces in it." });

/** An API key's account: its key. */
const apiKeyAccountSchema = z.strictObject({
  name,
  aiProvider: z.enum(apiKeyProviders, {
    error:
      "Only Claude, Grok, Gemini, OpenRouter, DeepSeek, Z.ai, Minimax, Kimi and Ollama API keys can be added so far.",
  }),
  accountType: z.literal("api_key"),
  /** The API key. Stored encrypted; never sent back. */
  credential: apiKey,
  /** Null (or absent) for the AI Provider's own API. */
  endpointUrl: endpointUrl.nullable().optional(),
  /** Absent: after every other account. */
  priority: priority.optional(),
});

/**
 * An endpoint's account: its URL (an Ollama server's is
 * `http://localhost:11434` unless given), and a key if it asks for one.
 */
const endpointAccountSchema = z
  .strictObject({
    name,
    aiProvider: z.enum(endpointProviders, {
      error:
        "Only an Ollama server, or an Anthropic- or OpenAI-compatible endpoint, can be added as an endpoint.",
    }),
    accountType: z.literal("endpoint"),
    /** Its key, if it asks for one. Stored encrypted; never sent back. */
    credential: apiKey.nullable().optional(),
    /** Its URL; null (or absent) only for Ollama's own default. */
    endpointUrl: endpointUrl.nullable().optional(),
    /** Absent: after every other account. */
    priority: priority.optional(),
  })
  .refine(
    (account) => account.aiProvider === "Ollama" || account.endpointUrl != null,
    { path: ["endpointUrl"], error: "Enter the endpoint's URL." },
  )
  // Ollama's own default is on the AI Office host itself.
  .superRefine((account, context) => {
    const problem =
      account.endpointUrl == null
        ? ownerUrlProblem(ollamaEndpointUrl, "Ollama's default endpoint")
        : undefined;
    if (problem !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["endpointUrl"],
        message: problem,
      });
    }
  });

/** A secret that is one token: no spaces, and not too long. */
const secretField = (what: string, max: number) =>
  z
    .string({ error: `Enter the ${what}.` })
    .trim()
    .min(1, { error: `Enter the ${what}.` })
    .max(max, { error: `That is too long for the ${what}.` })
    .regex(/^\S*$/, { error: `The ${what} has no spaces in it.` });

/**
 * An AWS region, such as `us-east-1` or `eu-central-2`, where Claude in
 * Amazon Bedrock serves.
 */
export const awsRegionSchema = z
  .string({ error: "Enter the AWS region, such as us-east-1." })
  .trim()
  .regex(/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/, {
    error: "Enter the AWS region, such as us-east-1.",
  });

/**
 * A Vertex AI location: `global` (Google's recommendation), a
 * multi-region (`us`, `eu`) or a region such as `us-east5`.
 */
export const vertexRegionSchema = z
  .string({ error: "Enter the Vertex AI region, such as global or us-east5." })
  .trim()
  .regex(/^[a-z]+(?:-[a-z]+\d+)?$/, {
    error: "Enter the Vertex AI region, such as global or us-east5.",
  });

/** A Google Cloud project's ID. */
export const gcpProjectIdSchema = z
  .string({ error: "Enter the Google Cloud project ID." })
  .trim()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, {
    error:
      "A Google Cloud project ID is 6 to 30 lowercase letters, digits and hyphens.",
  });

/**
 * An AWS Bedrock account's credentials (FR-35): an IAM access key (with a
 * session token for temporary ones), or the name of a profile in the
 * server's AWS shared credentials file, read each time it is used.
 */
export const awsCredentialsSchema = z.union(
  [
    z.strictObject({
      accessKeyId: secretField("access key ID", 128),
      secretAccessKey: secretField("secret access key", 256),
      sessionToken: secretField("session token", 8192).nullable().optional(),
    }),
    z.strictObject({
      profile: z
        .string({ error: "Enter the AWS profile's name." })
        .trim()
        .regex(/^[\w.+@-]{1,64}$/, {
          error:
            "An AWS profile's name is letters, digits and . _ + @ -, up to 64.",
        }),
    }),
  ],
  { error: "Give an access key ID and secret access key, or a profile." },
);
export type AwsCredentials = z.infer<typeof awsCredentialsSchema>;

/** The parts of a Google service account key that AI Office uses. */
export const serviceAccountKeySchema = z.object({
  type: z.literal("service_account", {
    error:
      "That is not a service account key: its type is not service_account.",
  }),
  client_email: z.email({
    error: "The service account key has no client_email.",
  }),
  private_key: z
    .string({ error: "The service account key has no private_key." })
    .regex(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, {
      error: "The service account key's private_key is not a PEM key.",
    }),
  private_key_id: z.string().optional(),
  project_id: z.string().optional(),
  /** Where its access tokens come from; Google's own by default. */
  token_uri: z
    .url({
      protocol: /^https?$/,
      error: "The service account key's token_uri is not a URL.",
    })
    .superRefine(ownerUrl("The service account key's token_uri"))
    .optional(),
});
export type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;

/**
 * A service account key file's contents (JSON text), as the Owner
 * downloads it from Google Cloud; its project ID is the account's unless
 * the Owner gives another. Problems never quote it.
 */
export const serviceAccountKeyTextSchema = z
  .string({ error: "Paste the service account key file's contents." })
  .trim()
  .min(2, { error: "Paste the service account key file's contents." })
  .max(16_384, { error: "That is too long for a service account key." })
  .transform((text, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      context.addIssue({
        code: "custom",
        message: "The service account key is not JSON.",
      });
      return z.NEVER;
    }
    const key = serviceAccountKeySchema.safeParse(parsed);
    if (!key.success) {
      for (const issue of key.error.issues) {
        context.addIssue({ code: "custom", message: issue.message });
      }
      return z.NEVER;
    }
    return key.data;
  });

/** An AWS Bedrock account: its region and IAM credentials or profile. */
const bedrockAccountSchema = z.strictObject({
  name,
  aiProvider: z.literal("Claude", {
    error: "AWS Bedrock accounts serve Claude Models.",
  }),
  accountType: z.literal("bedrock"),
  region: awsRegionSchema,
  /** Stored encrypted; never sent back. */
  awsCredentials: awsCredentialsSchema,
  /** Null (or absent) for Bedrock's own endpoint in the region. */
  endpointUrl: endpointUrl.nullable().optional(),
  priority: priority.optional(),
});

/** A Google Vertex AI account: its region, project and service account. */
const vertexAccountSchema = z
  .strictObject({
    name,
    aiProvider: z.literal("Claude", {
      error: "Google Vertex AI accounts serve Claude Models.",
    }),
    accountType: z.literal("vertex"),
    region: vertexRegionSchema,
    /** Null (or absent) for the service account's own project. */
    projectId: gcpProjectIdSchema.nullable().optional(),
    /** The key file's contents. Stored encrypted; never sent back. */
    serviceAccount: serviceAccountKeyTextSchema,
    /** Null (or absent) for Vertex AI's own endpoint for the region. */
    endpointUrl: endpointUrl.nullable().optional(),
    priority: priority.optional(),
  })
  .refine(
    (account) =>
      (account.projectId ?? account.serviceAccount.project_id) !== undefined,
    {
      path: ["projectId"],
      error:
        "The service account key names no project: enter the Google Cloud project ID.",
    },
  );

/**
 * The body of `POST /api/ai-accounts`: an API key (FR-35), an endpoint
 * (an Ollama server, or an Anthropic- or OpenAI-compatible API), or a
 * cloud platform's account for Claude: AWS Bedrock or Google Vertex AI.
 */
export const addAiAccountRequestSchema = z.discriminatedUnion(
  "accountType",
  [
    apiKeyAccountSchema,
    endpointAccountSchema,
    bedrockAccountSchema,
    vertexAccountSchema,
  ],
  {
    error:
      "Add an API key, an endpoint, an AWS Bedrock or a Google Vertex AI account here; a subscription signs in instead.",
  },
);
export type AddAiAccountRequest = z.infer<typeof addAiAccountRequestSchema>;

const pauseThreshold = (window: string) =>
  z
    .number({ error: `The ${window} pause threshold is a whole percentage.` })
    .int({ error: `The ${window} pause threshold is a whole percentage.` })
    .min(minPauseThreshold, {
      error: `The ${window} pause threshold is at least ${String(minPauseThreshold)}%.`,
    })
    .max(maxPauseThreshold, {
      error: `The ${window} pause threshold is at most ${String(maxPauseThreshold)}%.`,
    })
    .nullable();

/**
 * The body of `PATCH /api/ai-accounts/:id`: rename, reprioritise, pause,
 * set the usage pause thresholds (null for none), force a Model (null for
 * none) and turn extra usage on or off where its AI Provider offers it.
 */
export const aiAccountUpdateSchema = z
  .strictObject({
    name: name.optional(),
    priority: priority.optional(),
    /** True pauses it: the AI Gateway leaves it alone until resumed. */
    paused: z.boolean({ error: "Paused is true or false." }).optional(),
    /** Hold it back at this share of its five-hour window (FR-36). */
    fiveHourPauseThreshold: pauseThreshold("five-hour").optional(),
    /** Hold it back at this share of its weekly window. */
    weeklyPauseThreshold: pauseThreshold("weekly").optional(),
    /**
     * Send it this Model, whatever was asked for (FR-41); null for the
     * Model asked for. One of its own AI Provider's.
     */
    forcedModel: modelNameSchema
      .regex(/^\S*$/, { error: "A Model's name has no spaces in it." })
      .nullable()
      .optional(),
    /**
     * Let it go on past its plan's limits, on extra usage its AI Provider
     * bills (FR-41); only where the AI Provider offers it. Off by default.
     */
    extraUsage: z
      .boolean({ error: "Extra usage is true or false." })
      .optional(),
  })
  .refine((update) => Object.keys(update).length > 0, {
    error:
      "Change at least one of name, priority, paused, the thresholds, the forced Model and extra usage.",
  });
export type AiAccountUpdate = z.infer<typeof aiAccountUpdateSchema>;

/** An AI Account, as the API sends it: everything but its credential. */
export const aiAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  aiProvider: z.string(),
  accountType: z.enum(aiAccountTypes),
  /** The custom endpoint; null for the AI Provider's own API. */
  endpointUrl: z.string().nullable(),
  /** A cloud platform's account's region (AWS or Vertex AI); else null. */
  region: z.string().nullable(),
  /** A Vertex AI account's Google Cloud project; else null. */
  projectId: z.string().nullable(),
  priority: z.number().int(),
  paused: z.boolean(),
  /** An OAuth account's access token: its health and expiry; else null. */
  tokenHealth: z.enum(tokenHealths).nullable(),
  tokenExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  /**
   * True when its token could not be refreshed and the Owner must sign in
   * again; it serves only until its access token expires.
   */
  reauthenticationNeeded: z.boolean(),
  /**
   * Why the AI Gateway is holding it back, and until when; both null while
   * it is not (FR-39).
   */
  limitReason: z.enum(aiAccountLimitReasons).nullable(),
  limitedUntil: z.iso.datetime({ offset: true }).nullable(),
  /**
   * Its usage windows as its AI Provider last reported them; null for one
   * it does not report, or that has reset since.
   */
  usage: z.object({
    fiveHour: usageWindowStateSchema.nullable(),
    weekly: usageWindowStateSchema.nullable(),
  }),
  /** The share of each window it is held back at; null for none. */
  fiveHourPauseThreshold: z.number().int().nullable(),
  weeklyPauseThreshold: z.number().int().nullable(),
  /** The Model it is always sent (FR-41); null for the Model asked for. */
  forcedModel: z.string().nullable(),
  /**
   * Whether it goes on past its plan's limits on extra usage (FR-41);
   * null where its AI Provider offers none.
   */
  extraUsage: z.boolean().nullable(),
  /**
   * Its per-minute rate limits as its latest answer reported them; null
   * when its AI Provider sends none (or they have all reset since).
   */
  rateLimits: rateLimitsSchema.nullable().optional(),
  /** Its prepaid credit, where its AI Provider can be asked; else null. */
  balance: creditBalanceSchema.nullable().optional(),
  /**
   * The tokens (input and output) it served today (UTC), and every
   * account's together: its share of the Gateway's day.
   */
  tokensToday: z
    .object({
      tokens: z.number().int().min(0),
      gatewayTokens: z.number().int().min(0),
    })
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AiAccount = z.infer<typeof aiAccountSchema>;

/** One reading of a usage window, in an account's usage history. */
export const usageReadingSchema = z.object({
  window: z.enum(usageWindows),
  utilization: z.number().min(0),
  resetsAt: z.iso.datetime({ offset: true }),
  observedAt: z.iso.datetime({ offset: true }),
});
export type UsageReading = z.infer<typeof usageReadingSchema>;

/** The body of `GET /api/ai-accounts/:id/usage`: newest first. */
export const usageHistorySchema = z.object({
  usage: z.array(usageReadingSchema),
});

/** The body of `GET /api/ai-accounts`: in the order they are used. */
export const aiAccountListSchema = z.object({
  accounts: z.array(aiAccountSchema),
});

/**
 * The body of `POST /api/ai-accounts/oauth`: starts adding a subscription
 * account through the AI Provider's OAuth login (PKCE).
 */
export const startOAuthLoginRequestSchema = z.strictObject({
  name,
  aiProvider: z.enum(subscriptionProviders, {
    error: `Only ${subscriptionProviders.join(", ")} subscriptions can be added so far.`,
  }),
  /** Absent: after every other account. */
  priority: priority.optional(),
  /** The Owner has read `subscriptionTermsWarning`. */
  acceptedTerms: z.literal(true, {
    error: "Confirm you have read the AI Provider's terms for subscriptions.",
  }),
});
export type StartOAuthLoginRequest = z.infer<
  typeof startOAuthLoginRequestSchema
>;

/** A login under way: where the Owner signs in, and until when. */
export const oauthLoginSchema = z.object({
  loginId: z.string(),
  /**
   * Open it and sign in; then paste the code the AI Provider shows, or,
   * with a `userCode`, approve that code there.
   */
  authorizeUrl: z.url(),
  /** A device login's code, to check on the AI Provider's page. */
  userCode: z.string().optional(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type OAuthLogin = z.infer<typeof oauthLoginSchema>;

/**
 * `GET /api/ai-accounts/oauth/:loginId`: whether a login still waits for
 * its code, or was finished on AI Office's own callback (ChatGPT's
 * `localhost:1455`), with the account it added or signed in again.
 */
export const oauthLoginStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("done"),
    account: aiAccountSchema,
    added: z.boolean(),
  }),
]);
export type OAuthLoginStatus = z.infer<typeof oauthLoginStatusSchema>;

/**
 * The body of `POST /api/ai-accounts/oauth/:loginId`: the pasted code (or,
 * for ChatGPT, the address the sign-in ended on, which holds it); none for
 * a device login, approved on the AI Provider's page.
 */
export const completeOAuthLoginRequestSchema = z.strictObject({
  code: z
    .string({ error: "Paste the code the sign-in page showed." })
    .trim()
    .min(1, { error: "Paste the code the sign-in page showed." })
    .max(8192, { error: "That is too long for a sign-in code." })
    .regex(/^\S*$/, { error: "A sign-in code has no spaces in it." })
    .optional(),
});

/**
 * The body of `POST /api/ai-accounts/import`: an existing CLI login to
 * add as a subscription account, such as the Grok CLI's
 * `~/.grok/auth.json`. Its tokens are stored encrypted; nothing else of
 * it is kept.
 */
export const importOAuthLoginRequestSchema = z.strictObject({
  name,
  aiProvider: z.literal("Grok", {
    error: "Only a Grok CLI login can be imported so far.",
  }),
  /** Absent: after every other account. */
  priority: priority.optional(),
  /** The Owner has read the AI Provider's terms warning. */
  acceptedTerms: z.literal(true, {
    error: "Confirm you have read the AI Provider's terms for subscriptions.",
  }),
  /** The login file's contents, as JSON text. */
  login: z
    .string({ error: "Paste the contents of the login file." })
    .trim()
    .min(2, { error: "Paste the contents of the login file." })
    .max(65_536, { error: "That is too long for a login file." }),
});
export type ImportOAuthLoginRequest = z.infer<
  typeof importOAuthLoginRequestSchema
>;
export type CompleteOAuthLoginRequest = z.infer<
  typeof completeOAuthLoginRequestSchema
>;

/**
 * Where the Owner sees an AI Provider's AI Accounts, in the web app: when
 * none is left to serve it (FR-49).
 */
export const aiProviderAccountsPath = (aiProvider: string): string =>
  `/ai-settings?aiProvider=${encodeURIComponent(aiProvider)}`;

/** Where the Owner re-authenticates an AI Account, in the web app. */
export const reauthenticatePath = (accountId: string): string =>
  `/ai-settings?reauthenticate=${encodeURIComponent(accountId)}`;

export const aiAccountErrorCodes = {
  aiAccountNotFound: "ai_account_not_found",
  /** Another AI Account already has that name. */
  aiAccountNameTaken: "ai_account_name_taken",
  /** Only an OAuth account signs in again. */
  notOAuthAccount: "not_oauth_account",
  /** The login is unknown, finished or too old: start again. */
  oauthLoginNotFound: "oauth_login_not_found",
  /** The AI Provider refused the code. */
  oauthCodeRefused: "oauth_code_refused",
  /** The AI Provider's sign-in could not be reached. */
  oauthUnavailable: "oauth_unavailable",
  /** A device login the Owner has not approved yet: try again. */
  oauthLoginPending: "oauth_login_pending",
  /** An imported login holds no tokens AI Office can use. */
  loginNotImportable: "login_not_importable",
  /** A forced Model of another AI Provider than the account's. */
  forcedModelMismatch: "forced_model_mismatch",
  /** Extra usage, for an account whose AI Provider offers none. */
  extraUsageNotOffered: "extra_usage_not_offered",
  /** A cloud platform's credentials that cannot be used, such as an unknown AWS profile. */
  cloudCredentialsUnusable: "cloud_credentials_unusable",
} as const;
export type AiAccountErrorCode =
  (typeof aiAccountErrorCodes)[keyof typeof aiAccountErrorCodes];
