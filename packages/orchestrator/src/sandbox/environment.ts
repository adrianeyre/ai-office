import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import {
  credentialPatterns,
  aiOfficeHeaders,
  gatewayKeyPrefix,
  type GitIdentity,
} from "@ai-office/shared";

import { gitEnvironment } from "../git/identity.ts";

// What a sandbox's environment may hold (PRD FR-19, §7 Security): the Git
// identity its commits are by (FR-68), a GitHub token that can read but
// not write, and the way to the AI Gateway: its URL and the Agent's own
// Gateway Key, never an AI Account's credential (ADR 0001). Nothing else
// from AI Office or its host reaches a sandbox: every provider is wrapped so
// that whatever else Sandcastle gathers (it also reads keys named in the
// repository's own `.sandcastle/.env`, from the host's environment) is
// dropped, and a sandbox whose environment holds anything shaped like an AI
// Account's credential, under any key, is refused.

/** The Git identity's variables (`gitEnvironment`). */
export const gitEnvironmentKeys = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/** The read-only GitHub token, as `gh` reads it. */
export const githubTokenKey = "GH_TOKEN";

/**
 * The way to models, as Claude Code reads it: the AI Gateway's URL, the
 * Agent's Gateway Key (sent as a bearer token), and the headers naming the
 * issue and pull request each model call is for (FR-42) and its session
 * (FR-37).
 */
export const modelEnvironmentKeys = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

/**
 * The way to models, as Codex reads it: the AI Gateway's OpenAI API
 * (`OPENAI_BASE_URL`), the Agent's Gateway Key, and what each model call
 * is for (FR-42) and its session (FR-37), which Codex's `ai_office` model
 * provider sends as AI Office's headers (`codexTool`).
 */
export const codexEnvironmentKeys = [
  "OPENAI_BASE_URL",
  "AI_OFFICE_GATEWAY_KEY",
  "AI_OFFICE_ISSUE",
  "AI_OFFICE_PULL_REQUEST",
  "AI_OFFICE_SESSION",
] as const;

/**
 * The way to models, as opencode reads it: its whole configuration, with
 * one model provider, the AI Gateway's OpenAI API, given the Agent's
 * Gateway Key and AI Office's headers; and, so that the repository it
 * works on configures nothing of it (P1-9), no project configuration
 * (`opencode.json`, `.opencode/` agents, commands and plugins) and none of
 * Claude Code's files (`CLAUDE.md`, `.claude/skills/`).
 */
export const opencodeEnvironmentKeys = [
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
] as const;

/**
 * The sandbox relay's HTTPS proxy, as the sandbox images name it
 * (`docker/sandbox-relay/relay.ts`, pen-testing S2-1): a sandbox's only way
 * beyond its network, to the hosts SANDBOX_EGRESS_HOSTS names.
 */
export const sandboxRelayProxy = "http://sandbox-relay:3128";

/**
 * How a sandbox reaches beyond its network, set by AI Office for every
 * container it starts for an Agent rather than left to the image: the
 * relay's proxy for everything, except the relay itself and the AI
 * Gateway, which are reached directly. The Docker CLI sets the proxy
 * variables from its own configuration (Docker Desktop's proxy settings,
 * a company's `~/.docker/config.json`) in every container, over the
 * image's, and a NO_PROXY that does not name the Gateway sends the agent
 * tool's model calls to the relay's proxy, which refuses them: Claude Code
 * then says "Failed to authenticate. API Error: 403". Variables given with
 * the container win over the CLI's. Claude Code's telemetry, error
 * reports and update checks, which the relay would refuse anyway, are
 * not sent.
 */
export const proxyEnvironmentKeys = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

/** A sandbox's proxy variables, given the Gateway's URL as it reaches it. */
export function proxyEnvironment(gatewayUrl: string): ModelEnvironment {
  const relay = new URL(sandboxRelayProxy).hostname;
  const direct = [...new Set([relay, new URL(gatewayUrl).hostname])].join(",");
  return {
    HTTPS_PROXY: sandboxRelayProxy,
    https_proxy: sandboxRelayProxy,
    HTTP_PROXY: sandboxRelayProxy,
    http_proxy: sandboxRelayProxy,
    NO_PROXY: direct,
    no_proxy: direct,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** One agent tool's way to models: some of the keys above. */
export type ModelEnvironment = Readonly<Record<string, string>>;

/** How an Agent's sandbox reaches the AI Gateway. */
export interface GatewayAccess {
  /** The Gateway's URL, as the sandbox's Docker network reaches it. */
  readonly url: string;
  /** The Agent's own Gateway Key. */
  readonly key: string;
}

/** What a sandbox's model calls are for (FR-42), and their session. */
export interface ModelAttribution {
  /** The issue worked; none for a Grilling Session's fact-finding (FR-79). */
  readonly issue?: number | undefined;
  /** The issue's open pull request, once it has one. */
  readonly pullRequest?: number | undefined;
  /**
   * The Agent session (the sandbox run) they belong to, which the
   * Gateway's session strategy keeps on one AI Account (FR-37).
   */
  readonly session?: string | undefined;
  /**
   * The token of the work AI Office opened for one of its own calls run
   * through an agent tool (pen-testing G1-1), which Codex is given as
   * `AI_OFFICE_WORK`. A sandbox has none: a task's work is held for its
   * Agent while it runs.
   */
  readonly work?: string | undefined;
}

/** Why a sandbox was refused the environment it was to be given. */
export class SandboxEnvironmentError extends Error {
  /** The key at fault; never its value. */
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = "SandboxEnvironmentError";
    this.key = key;
  }
}

const gatewayKeyShape = new RegExp(`^${gatewayKeyPrefix}[A-Za-z0-9_-]{16,}$`);

/** Refuses anything but a Gateway Key, naming the key it was to go in. */
function refuseAllButGatewayKey(access: GatewayAccess, key: string): void {
  if (!gatewayKeyShape.test(access.key)) {
    throw new SandboxEnvironmentError(
      key,
      "A sandbox reaches models only with its Agent's Gateway Key, and this is not one.",
    );
  }
}

/** The Gateway's OpenAI API, under its URL: what OpenAI clients call. */
const openAiBaseUrl = (url: string): string => `${url.replace(/\/+$/, "")}/v1`;

/** AI Office's headers for a model call, by name. */
const attributionHeaders = (
  attribution: ModelAttribution,
): Record<string, string> => ({
  ...(attribution.issue === undefined
    ? {}
    : { [aiOfficeHeaders.issue]: String(attribution.issue) }),
  ...(attribution.pullRequest === undefined
    ? {}
    : { [aiOfficeHeaders.pullRequest]: String(attribution.pullRequest) }),
  ...(attribution.session === undefined
    ? {}
    : { [aiOfficeHeaders.session]: attribution.session }),
  ...(attribution.work === undefined
    ? {}
    : { [aiOfficeHeaders.work]: attribution.work }),
});

/**
 * The model environment of a sandbox whose Agent reaches models through
 * the Gateway with its own Gateway Key, its calls attributed to the issue
 * (and its pull request). Anything but a Gateway Key is refused.
 */
export function gatewayModelEnvironment(
  access: GatewayAccess,
  attribution: ModelAttribution,
): Readonly<Record<(typeof modelEnvironmentKeys)[number], string>> {
  refuseAllButGatewayKey(access, "ANTHROPIC_AUTH_TOKEN");
  return {
    ...proxyEnvironment(access.url),
    ANTHROPIC_BASE_URL: access.url,
    ANTHROPIC_AUTH_TOKEN: access.key,
    // Claude Code's `Name: Value` lines, one per header.
    ANTHROPIC_CUSTOM_HEADERS: Object.entries(attributionHeaders(attribution))
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
  };
}

/**
 * Codex's model environment (FR-16): the Gateway's OpenAI API and the
 * Agent's Gateway Key, with what its calls are for. Anything but a Gateway
 * Key is refused.
 */
export function codexModelEnvironment(
  access: GatewayAccess,
  attribution: ModelAttribution,
): ModelEnvironment {
  refuseAllButGatewayKey(access, "AI_OFFICE_GATEWAY_KEY");
  return {
    ...proxyEnvironment(access.url),
    OPENAI_BASE_URL: openAiBaseUrl(access.url),
    AI_OFFICE_GATEWAY_KEY: access.key,
    ...(attribution.issue === undefined
      ? {}
      : { AI_OFFICE_ISSUE: String(attribution.issue) }),
    ...(attribution.pullRequest === undefined
      ? {}
      : { AI_OFFICE_PULL_REQUEST: String(attribution.pullRequest) }),
    ...(attribution.session === undefined
      ? {}
      : { AI_OFFICE_SESSION: attribution.session }),
    ...(attribution.work === undefined
      ? {}
      : { AI_OFFICE_WORK: attribution.work }),
  };
}

/** opencode's name for the AI Gateway, as a model provider. */
export const opencodeProviderId = "ai-office";

/**
 * opencode's model environment (FR-16): a configuration whose only model
 * provider is the Gateway's OpenAI API (Chat Completions, which every AI
 * Account can serve), with the Agent's Gateway Key, AI Office's headers on
 * every call, and `model` as its only Model, for its titles too. Anything
 * but a Gateway Key is refused.
 */
export function opencodeModelEnvironment(
  access: GatewayAccess,
  attribution: ModelAttribution,
  model: string,
): ModelEnvironment {
  refuseAllButGatewayKey(access, "OPENCODE_CONFIG_CONTENT");
  const qualified = `${opencodeProviderId}/${model}`;
  return {
    ...proxyEnvironment(access.url),
    // The repository's configuration and Claude Code's files are not read.
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      enabled_providers: [opencodeProviderId],
      model: qualified,
      small_model: qualified,
      provider: {
        [opencodeProviderId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "AI Office",
          options: {
            baseURL: openAiBaseUrl(access.url),
            apiKey: access.key,
            headers: attributionHeaders(attribution),
          },
          models: { [model]: { name: model } },
        },
      },
    }),
  };
}

/** Every key a sandbox's environment may hold. */
export const sandboxEnvironmentKeys: readonly string[] = [
  ...gitEnvironmentKeys,
  githubTokenKey,
  ...modelEnvironmentKeys,
  ...codexEnvironmentKeys,
  ...opencodeEnvironmentKeys,
  ...proxyEnvironmentKeys,
];

/** A sandbox's environment: only `sandboxEnvironmentKeys`. */
export type SandboxEnvironment = Readonly<Record<string, string>>;

/**
 * Tells whether a value holds one of the Owner's AI Account credentials
 * (`AiAccounts.holdsCredential`), whatever its shape.
 */
export type AiAccountCredentialCheck = (value: string) => Promise<boolean>;

/** The shapes of AI Providers' credentials, from the central redactor. */
const aiAccountCredentialShapes = credentialPatterns
  .filter(({ name }) =>
    [
      "Anthropic key or token",
      "OpenAI key",
      "xAI key",
      "Google API key",
      "Google OAuth token",
      "AWS access key ID",
      "JWT",
    ].includes(name),
  )
  .map(
    ({ pattern }) => new RegExp(pattern.source, pattern.flags.replace("g", "")),
  );

const refused = (key: string) =>
  new SandboxEnvironmentError(
    key,
    `A sandbox never holds an AI Account's credential, and ${key} looks like one.`,
  );

/**
 * Refuses `environment` if any of its values, under any key, is shaped like
 * an AI Provider's credential.
 */
export function refuseAiAccountCredentialShapes(
  environment: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(environment)) {
    if (aiAccountCredentialShapes.some((shape) => shape.test(value))) {
      throw refused(key);
    }
  }
}

/**
 * Refuses `environment` if any of its values, under any key, is shaped like
 * an AI Provider's credential or holds one of the Owner's AI Account
 * credentials, whatever its shape.
 */
export async function refuseAiAccountCredentials(
  environment: Readonly<Record<string, string>>,
  isAiAccountCredential: AiAccountCredentialCheck,
): Promise<void> {
  refuseAiAccountCredentialShapes(environment);
  for (const [key, value] of Object.entries(environment)) {
    if (await isAiAccountCredential(value)) {
      throw refused(key);
    }
  }
}

/**
 * Whether `value` is AI Office's own for the proxy variable `key`: the
 * relay's proxy, host names to reach directly, or the switch that stops
 * Claude Code's non-essential traffic. Whatever else names them (a
 * repository's `.sandcastle/.env`, the app's own environment) is dropped.
 */
const ownProxyValue = (key: string, value: string): boolean =>
  /^no_proxy$/i.test(key)
    ? /^[a-z0-9.-]+(,[a-z0-9.-]+)*$/i.test(value)
    : key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
      ? value === "1"
      : value === sandboxRelayProxy;

/**
 * Only the allowed keys of `environment`, and only those with a value; the
 * proxy variables only with AI Office's own values.
 */
export function allowedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        sandboxEnvironmentKeys.includes(entry[0]) &&
        entry[1] !== undefined &&
        entry[1] !== "" &&
        (!(proxyEnvironmentKeys as readonly string[]).includes(entry[0]) ||
          ownProxyValue(entry[0], entry[1])),
    ),
  );
}

/**
 * The environment for a sandbox whose commits are by `identity`; without
 * one, for a read-only sandbox, which commits nothing (FR-79).
 */
export function sandboxEnvironment(options: {
  readonly identity?: GitIdentity;
  /** A token that can read the Floor's repository but not write. */
  readonly githubToken: string;
  readonly model: ModelEnvironment;
}): SandboxEnvironment {
  const environment = allowedEnvironment({
    ...options.model,
    ...(options.identity === undefined ? {} : gitEnvironment(options.identity)),
    [githubTokenKey]: options.githubToken,
  });
  refuseAiAccountCredentialShapes(environment);
  return environment;
}

/** What Sandcastle's bind-mount providers (such as Docker) are at run time. */
interface BindMountProviderInternals {
  readonly tag?: string;
  readonly name: string;
  readonly env: Record<string, string>;
  readonly sandboxHomedir?: string | undefined;
  readonly create?: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

/**
 * `provider`, starting each sandbox with only the allowed keys of the
 * environment Sandcastle gives it, and refusing to start one whose
 * environment holds anything shaped like an AI Provider's credential. Only
 * bind-mount providers (Docker) are supported.
 */
export function allowListed(provider: SandboxProvider): SandboxProvider {
  const inner = provider as BindMountProviderInternals;
  const create = inner.create;
  if (inner.tag !== "bind-mount" || create === undefined) {
    throw new Error(
      `AI Office runs sandboxes with bind-mount providers such as Docker, not ${inner.name}.`,
    );
  }
  const env = allowedEnvironment(inner.env);
  refuseAiAccountCredentialShapes(env);
  return createBindMountSandboxProvider({
    name: inner.name,
    env,
    ...(inner.sandboxHomedir === undefined
      ? {}
      : { sandboxHomedir: inner.sandboxHomedir }),
    create: (options) =>
      Promise.resolve(allowedEnvironment(options.env)).then((env) => {
        refuseAiAccountCredentialShapes(env);
        return create({ ...options, env });
      }),
  });
}
