import { randomBytes, randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  aiAccountErrorCodes,
  aiAccountKindOf,
  autoRefreshBufferMs,
  defaultAutoRefreshSettings,
  type AutoRefreshSettings,
  type UsageWindow,
  maxAiAccountPriority,
  minAiAccountPriority,
  tokenExpiringWithinMs,
  tokenHealthOf,
  defaultGatewayRetrySettings,
  defaultUsageThrottlingSettings,
  modelFamilyOf,
  pacingHeadroomPercent,
  usageWindowLengthsMs,
  type UsageThrottlingSettings,
  type AddAiAccountRequest,
  type AiAccountErrorCode,
  type AiAccountLimitReason,
  type GatewayRetrySettings,
  type AiAccountUpdate,
  aiProviderOfModel,
  aiProviderTakes,
  kindServes,
  servesAnyModel,
  subscriptionPlanOf,
  aliasedModel,
  mappedModel,
  modelSentTo,
  offersExtraUsage,
  platformEndpointUrl,
  platformOf,
  type ModelMappingRule,
  type ImportOAuthLoginRequest,
  type StartOAuthLoginRequest,
  type TokenHealth,
  type DocumentedModel,
  type RateLimitKind,
  type RateLimits,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";

import {
  aheadOfPace,
  AccountsUnavailableError,
  createLoadBalancer,
  ForcedAccountError,
  route,
  type Exclusion,
  type LoadBalancer,
} from "../balancing/balancing.ts";
import {
  defaultAwsConfigFiles,
  readAwsProfile,
  type AwsConfigFiles,
} from "../cloud/aws-profile.ts";
import {
  cloudCredentialText,
  cloudSecrets,
  cloudSigner,
  parseCloudCredential,
  type CloudCredential,
} from "../cloud/cloud.ts";
import { createGoogleTokenCache } from "../cloud/google-auth.ts";
import { comboSlotKey, type Combos } from "../combos/combos.ts";
import type {
  AccountRequest,
  AccountSource,
  ChosenAccount,
  ComboChoice,
  GatewayAccount,
} from "../gateway.ts";
import { sendRefresh, type RefreshAnswer } from "../limits/auto-refresh.ts";
import { balanceSourceOf, readBalance } from "../limits/balances.ts";
import type { AccountOutcome } from "../limits/detect.ts";
import type { RateLimitReadings } from "../limits/rate-limits.ts";
import {
  usageWindowsOfBody,
  type UsageWindowReadings,
} from "../limits/usage-windows.ts";
import { CodeAssistError, codeAssistProject } from "./code-assist.ts";
import {
  anthropicOAuth,
  authorizationUrl,
  exchangeCode,
  googleOAuth,
  OAuthError,
  openaiOAuth,
  pastedCode,
  pkcePair,
  pollDeviceLogin,
  qwenOAuth,
  refreshTokens,
  startDeviceLogin,
  tokensInLoginFile,
  xaiOAuth,
  type Fetch,
  type OAuthClient,
  type OAuthProvider,
  type OAuthTokens,
} from "./oauth.ts";
import type {
  AiAccountChanges,
  AiAccountRecord,
  AiAccountStore,
  UsageRecord,
} from "./store.ts";

// The Owner's AI Accounts (PRD FR-35, FR-36): adding key-based ones, cloud
// platforms' (AWS Bedrock, Google Vertex AI) and subscriptions through
// their OAuth login; renaming, reprioritising,
// pausing, resuming and deleting them; keeping subscriptions' tokens fresh
// and telling their health; and choosing the one the AI Gateway serves the
// next request from, leaving out those it holds back: rate-limited or
// overloaded until their AI Provider's reset, or failing too often in a
// row (their circuit breaker open). A credential is sealed before it is
// stored, and opened only to forward a request or refresh it; nothing here
// hands it back to the Owner.

/** An AI Account without its credentials: all the Owner ever sees of it. */
export type AiAccountInfo = Omit<
  AiAccountRecord,
  "credential" | "refreshToken"
>;

/** Why an AI Account operation was refused. */
export class AiAccountError extends Error {
  readonly code: AiAccountErrorCode;

  constructor(
    code: AiAccountErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiAccountError";
    this.code = code;
  }
}

/** A subscription's login under way: where the Owner signs in. */
export interface OAuthLoginStarted {
  readonly loginId: string;
  readonly authorizeUrl: string;
  /** A device login's code, which the Owner approves at `authorizeUrl`. */
  readonly userCode?: string;
  /**
   * Where a code login's sign-in ends, such as ChatGPT's
   * `http://localhost:1455/auth/callback`: what `completeCallback` is
   * given when AI Office serves it.
   */
  readonly redirectUri?: string;
  readonly expiresAt: Date;
}

/** Whether a login is still waiting, or was finished from its callback. */
export type OAuthLoginStatus =
  | { readonly status: "pending" }
  | {
      readonly status: "done";
      readonly account: AiAccountInfo;
      readonly added: boolean;
    };

/** What one round of reading subscriptions' usage did. */
export interface UsageRefreshReport {
  /** Accounts whose usage windows were read. */
  readonly refreshed: string[];
  /** Accounts whose usage could not be read for now. */
  readonly failed: { readonly id: string; readonly error: unknown }[];
}

/** How long a usage endpoint is given to answer. */
const usageTimeoutMs = 10 * 1000;

/** How often an account's rate limits are stored, at most. */
const rateLimitsStoreMs = 15 * 1000;

/** What one round of auto-refresh did (FR-39). */
export interface WindowRefreshReport {
  /** Accounts whose AI Provider served the request: a new window started. */
  readonly refreshed: string[];
  /** Accounts whose request was not served; not sent again this window. */
  readonly failed: { readonly id: string; readonly error: unknown }[];
}

/** What one round of token refreshing did. */
export interface TokenRefreshReport {
  /** Accounts whose tokens were refreshed. */
  readonly refreshed: string[];
  /** Accounts the AI Provider refused to refresh: sign in again. */
  readonly refused: string[];
  /** Accounts whose refresh failed for now, to try again next round. */
  readonly failed: { readonly id: string; readonly error: unknown }[];
}

export interface AiAccounts extends AccountSource {
  report(
    account: GatewayAccount,
    outcome: AccountOutcome,
    usage?: UsageWindowReadings,
    /** The per-minute rate limits the answer's headers reported, if any. */
    rateLimits?: RateLimitReadings,
  ): Promise<void>;
  /**
   * Force-resets an account's rate-limit state (FR-36): lifts its limit,
   * closes its circuit breaker and forgets its usage windows until its AI
   * Provider reports them again.
   */
  resetLimits(id: string): Promise<AiAccountInfo>;
  /** An account's usage history since `since`, newest first (FR-43). */
  usageHistory(
    id: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<UsageRecord[]>;
  /** In the order the Gateway uses them. */
  list(): Promise<AiAccountInfo[]>;
  add(request: AddAiAccountRequest): Promise<AiAccountInfo>;
  /**
   * Starts adding a subscription through its OAuth login, or signing an
   * OAuth account in again (`accountId`).
   */
  startLogin(
    login: StartOAuthLoginRequest | { readonly accountId: string },
  ): Promise<OAuthLoginStarted>;
  /**
   * Finishes a login with the code the Owner pasted (or, for a device
   * login, once the Owner has approved it): adds the account, or gives the
   * existing one its new tokens.
   */
  completeLogin(
    loginId: string,
    pasted: string | undefined,
  ): Promise<{ account: AiAccountInfo; added: boolean }>;
  /**
   * Finishes the code login whose sign-in ended on `url`, its redirect
   * address with the code and state, as AI Office's own callback listener
   * is given it: the login is the one with that state.
   */
  completeCallback(
    url: string,
  ): Promise<{ account: AiAccountInfo; added: boolean }>;
  /**
   * Whether a login is still waiting for its code, or was finished from
   * its callback (kept until it would have expired); an unknown or expired
   * one is `oauth_login_not_found`.
   */
  loginStatus(loginId: string): Promise<OAuthLoginStatus>;
  /** Whether any code login ending on `redirectUri` is still waiting. */
  awaitingCallback(redirectUri: string): boolean;
  /**
   * Adds a subscription from an existing CLI login (such as the Grok
   * CLI's `~/.grok/auth.json`), refreshed like any other.
   */
  importLogin(request: ImportOAuthLoginRequest): Promise<AiAccountInfo>;
  /**
   * Refreshes every OAuth account's tokens that expire within
   * `tokenExpiringWithinMs`, and tells each change of token health.
   */
  refreshTokens(): Promise<TokenRefreshReport>;
  /**
   * Reads each subscription's usage windows from its AI Provider's usage
   * endpoint (Claude's), or only `id`'s, so they show before any request
   * has gone through it; kept as an answer's windows are. Accounts that
   * must sign in again, or whose token has expired, are left out. And
   * each prepaid API key's credit, where its AI Provider's documented API
   * gives it (`limits/balances.ts`), with its own key.
   */
  refreshUsage(id?: string): Promise<UsageRefreshReport>;
  /**
   * Lifts every limit whose time has passed, telling each, and tells
   * whether its AI Provider has an account again. Returns their ids.
   */
  checkLimits(): Promise<string[]>;
  /**
   * Auto-refresh (FR-39), while it is on: sends each account whose usage
   * windows reset (more than `autoRefreshBufferMs` ago) one minimal
   * request, to start a new window at once. Once per window: a window
   * whose request was sent is not sent another, served or not. Accounts
   * that are paused, held back or signed out wait for a later round.
   */
  refreshWindows(): Promise<WindowRefreshReport>;
  /**
   * Account `id`, ready to send a prompt-cache keep-alive for `model` to
   * (FR-39), while it could serve that request now; undefined when it is
   * gone, paused, held back (or exhausted for the Model's family), signed
   * out or its token has expired. A keep-alive never waits on, or probes,
   * an account that cannot serve.
   */
  keepAliveAccount(
    id: string,
    model: string | null,
  ): Promise<GatewayAccount | undefined>;
  /** Renames, reprioritises, pauses or resumes an account. */
  update(id: string, update: AiAccountUpdate): Promise<AiAccountInfo>;
  remove(id: string): Promise<void>;
  /**
   * Whether `value` holds the credential of any AI Account, paused or not:
   * so that none ever reaches a sandbox (ADR 0001).
   */
  holdsCredential(value: string): Promise<boolean>;
  /**
   * One account of each kind to list its Models from (FR-41): the first
   * unpaused one in the Owner's order, a subscription only while its token
   * has not expired; and every unpaused compatible endpoint, as each lists
   * its own.
   */
  catalogueSources(): Promise<CatalogueSource[]>;
}

/** A kind of AI Account, and an account of it to ask for its Models. */
export interface CatalogueSource {
  readonly aiProvider: string;
  readonly accountType: AiAccountRecord["accountType"];
  readonly account: GatewayAccount;
  /**
   * Where its Models are listed, after its API's start; null for a kind
   * whose API lists none, whose documented Models stand in.
   */
  readonly modelsPath: string | null;
  readonly documentedModels?: readonly DocumentedModel[];
}

export interface AiAccountsOptions {
  readonly store: AiAccountStore;
  /** Seals credentials at rest (ENCRYPTION_KEY). */
  readonly encryptor: Encryptor;
  /**
   * Each change is a `config.changed` event, naming what changed; each
   * change of an OAuth account's token health is `ai_account.token_health`.
   */
  readonly events: Pick<EventBus, "publish">;
  /**
   * Told each credential in clear the first time this process holds it,
   * so it can be redacted from everything AI Office writes.
   */
  readonly onCredential?: (credential: string) => void;
  /** Claude subscriptions' OAuth login; Anthropic's by default. */
  readonly oauth?: OAuthProvider;
  /**
   * Other AI Providers' OAuth logins: xAI's for Grok, OpenAI's for
   * ChatGPT, Qwen's, and Google's for Gemini (as the Google client each
   * Gemini account was given), by default.
   */
  readonly oauthProviders?: Readonly<Record<string, OAuthProvider>>;
  /**
   * How the OAuth login, and AI Providers for auto-refresh, are reached;
   * `fetch` by default.
   */
  readonly fetch?: Fetch;
  /**
   * Where Gemini subscriptions reach Google's Code Assist API; Google's by
   * default.
   */
  readonly codeAssistUrl?: string;
  /**
   * How long to wait, as a Gemini subscription's Code Assist setup waits
   * between asking after it; `setTimeout` by default.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long a started login may take; 15 minutes by default. */
  readonly loginTtlMs?: number;
  /**
   * Chooses each request's account among those that can serve it (FR-37):
   * sessions of five hours by default.
   */
  readonly balancer?: LoadBalancer;
  /**
   * The circuit breaker's settings (FR-39), asked each time an account
   * fails: five failures in a row open it for a minute by default.
   */
  readonly retries?: () => Pick<
    GatewayRetrySettings,
    "circuitBreakerThreshold" | "circuitBreakerCooldownSeconds"
  >;
  /**
   * Usage throttling's pacing gates (FR-38), asked on every request: both
   * off by default.
   */
  readonly throttling?: () => UsageThrottlingSettings;
  /** Auto-refresh (FR-39), asked each round: off by default. */
  readonly autoRefresh?: () => AutoRefreshSettings;
  /**
   * The Combo a request for a Model waterfalls through (FR-40), asked on
   * every request; none by default.
   */
  readonly combos?: Pick<Combos, "forModel">;
  /**
   * The Owner's model mappings and aliases (FR-41), asked on every
   * request; none by default.
   */
  readonly modelMappings?: {
    rules(): Promise<readonly ModelMappingRule[]>;
  };
  /**
   * Where an AWS Bedrock account's profile is read from: the AWS CLI's
   * files (`AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, or `~/.aws`)
   * by default.
   */
  readonly awsConfigFiles?: AwsConfigFiles;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The context a credential is sealed with: it opens only in its own row. */
export const credentialContext = (id: string): string =>
  `ai_account.credential:${id}`;

/**
 * What a refresh token sealed with its Google client (a Gemini
 * account's) starts with: no refresh token does.
 */
const withClient = "aio-oauth-client:";

/** The context a refresh token is sealed with. */
export const refreshTokenContext = (id: string): string =>
  `ai_account.refresh_token:${id}`;

/** Everything but the credentials, field by field. */
const info = (account: AiAccountRecord): AiAccountInfo => ({
  id: account.id,
  name: account.name,
  accountType: account.accountType,
  aiProvider: account.aiProvider,
  endpointUrl: account.endpointUrl,
  region: account.region,
  projectId: account.projectId,
  priority: account.priority,
  paused: account.paused,
  tokenExpiresAt: account.tokenExpiresAt,
  reauthenticationNeeded: account.reauthenticationNeeded,
  limitReason: account.limitReason,
  limitedUntil: account.limitedUntil,
  fiveHourUtilization: account.fiveHourUtilization,
  fiveHourResetsAt: account.fiveHourResetsAt,
  weeklyUtilization: account.weeklyUtilization,
  weeklyResetsAt: account.weeklyResetsAt,
  fiveHourPauseThreshold: account.fiveHourPauseThreshold,
  weeklyPauseThreshold: account.weeklyPauseThreshold,
  forcedModel: account.forcedModel,
  extraUsage: account.extraUsage,
  rateLimits: account.rateLimits ?? null,
  balance: account.balance ?? null,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

/**
 * What tells whether an account is held back; its kind and extra usage
 * only where it may go on past its plan's limits (FR-41).
 */
export type LimitState = Pick<
  AiAccountRecord,
  | "limitReason"
  | "limitedUntil"
  | "fiveHourUtilization"
  | "fiveHourResetsAt"
  | "weeklyUtilization"
  | "weeklyResetsAt"
  | "fiveHourPauseThreshold"
  | "weeklyPauseThreshold"
> &
  Partial<Pick<AiAccountRecord, "aiProvider" | "accountType" | "extraUsage">>;

/** A window is full at 100%: past it, only extra usage serves. */
const planLimitPercent = 100;

/**
 * Why an account is held back at `at`, and until when; undefined if not.
 * A limit the AI Gateway stored comes first; otherwise a usage window that
 * has reached the Owner's pause threshold holds it back until it resets.
 * So does a full window, for an account that offers extra usage while
 * the Owner has it off (FR-41).
 */
export const limitOf = (
  account: LimitState,
  at: Date,
): { reason: AiAccountLimitReason; until: Date } | undefined => {
  if (
    account.limitReason !== null &&
    account.limitedUntil !== null &&
    account.limitedUntil > at
  ) {
    return { reason: account.limitReason, until: account.limitedUntil };
  }
  const windows = [
    [
      account.fiveHourUtilization,
      account.fiveHourResetsAt,
      account.fiveHourPauseThreshold,
    ] as const,
    [
      account.weeklyUtilization,
      account.weeklyResetsAt,
      account.weeklyPauseThreshold,
    ] as const,
  ];
  const reachedAt = (threshold: (owners: number | null) => number | null) =>
    windows
      .filter(([utilization, resetsAt, owners]) => {
        const limit = threshold(owners);
        return (
          utilization !== null &&
          resetsAt !== null &&
          limit !== null &&
          resetsAt > at &&
          utilization >= limit
        );
      })
      .map(([, resetsAt]) => resetsAt?.getTime() ?? 0);
  const reached = reachedAt((owners) => owners);
  if (reached.length > 0) {
    return { reason: "usage_threshold", until: new Date(Math.max(...reached)) };
  }
  const extraUsageOff =
    account.extraUsage === false &&
    account.aiProvider !== undefined &&
    account.accountType !== undefined &&
    offersExtraUsage({
      aiProvider: account.aiProvider,
      accountType: account.accountType,
    });
  const full = extraUsageOff ? reachedAt(() => planLimitPercent) : [];
  return full.length === 0
    ? undefined
    : { reason: "extra_usage", until: new Date(Math.max(...full)) };
};

/** No usage windows reported, and no thresholds: a new account's. */
const noUsage = {
  fiveHourUtilization: null,
  fiveHourResetsAt: null,
  weeklyUtilization: null,
  weeklyResetsAt: null,
  fiveHourPauseThreshold: null,
  weeklyPauseThreshold: null,
} as const;

/** No cloud platform: every account but AWS Bedrock's and Vertex AI's. */
const noCloud = { region: null, projectId: null } as const;

/**
 * Whether an account reaches Claude through a cloud platform: one that
 * reports no usage windows to auto-refresh, and is not kept warm (yet).
 */
const isCloud = (account: AiAccountRecord): boolean => {
  const kind = aiAccountKindOf(account);
  return kind !== undefined && platformOf(kind) !== undefined;
};

/** No forced Model, and extra usage off: a new account's (FR-41). */
const noModelSettings = { forcedModel: null, extraUsage: false } as const;

/** Each window's columns. */
const windowColumns = {
  five_hour: ["fiveHourUtilization", "fiveHourResetsAt"],
  weekly: ["weeklyUtilization", "weeklyResetsAt"],
} as const;

/** The soonest of the accounts' limits ends. */
const soonest = (
  accounts: readonly AiAccountRecord[],
  at: Date,
): Date | undefined => {
  const ends = accounts
    .map((account) => limitOf(account, at)?.until.getTime())
    .filter((end): end is number => end !== undefined);
  return ends.length === 0 ? undefined : new Date(Math.min(...ends));
};

/** Ranks a Combo's slots as the Combo orders them (FR-40). */
const inOrder: Pick<LoadBalancer, "rank" | "served"> = {
  rank: (candidates) => [...candidates],
  served: () => undefined,
};

/** A login waiting for its code, held in memory only. */
interface PendingLogin {
  readonly aiProvider: string;
  readonly state: string;
  readonly verifier: string;
  /** A device login's code, which the Owner approves. */
  readonly deviceCode?: string;
  /** Gemini's: the Google client it signs in as. */
  readonly client?: OAuthClient;
  readonly expiresAt: Date;
  /** A new account's settings, or the account signing in again. */
  readonly target:
    | { readonly kind: "add"; readonly request: StartOAuthLoginRequest }
    | { readonly kind: "reauthenticate"; readonly accountId: string };
}

export function createAiAccounts(options: AiAccountsOptions): AiAccounts {
  const { store, encryptor, events } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const oauthProviders: Readonly<Record<string, OAuthProvider>> = {
    Claude: options.oauth ?? anthropicOAuth,
    Grok: xaiOAuth,
    ChatGPT: openaiOAuth,
    Qwen: qwenOAuth,
    ...options.oauthProviders,
  };
  /**
   * Each Gemini subscription's Code Assist project, which its requests
   * name. Kept in memory: after a restart, it is looked up again.
   */
  const codeAssistProjects = new Map<string, string>();
  /** Whether an account's requests go to Google's Code Assist API. */
  const reachesCodeAssist = (account: AiAccountRecord): boolean =>
    aiAccountKindOf(account)?.apiFormat === "gemini";
  /** The Code Assist project `accessToken`'s Google account is set up with. */
  const lookUpCodeAssistProject = (
    account: Pick<AiAccountRecord, "endpointUrl">,
    accessToken: string,
  ): Promise<string> =>
    codeAssistProject(accessToken, {
      fetch: fetchTokens,
      ...((account.endpointUrl ?? options.codeAssistUrl) === undefined
        ? {}
        : { baseUrl: account.endpointUrl ?? options.codeAssistUrl }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  /** An AI Provider's OAuth login. */
  const oauthFor = (aiProvider: string): OAuthProvider => {
    const provider = oauthProviders[aiProvider];
    if (provider === undefined) {
      throw new AiAccountError(
        aiAccountErrorCodes.notOAuthAccount,
        `${aiProvider} has no subscription sign-in.`,
      );
    }
    return provider;
  };
  /**
   * An AI Provider's OAuth login, as `client` where it signs in as the
   * client the Owner gave (Gemini's, as Gemini CLI's Google client).
   */
  const oauthAs = (
    aiProvider: string,
    client: OAuthClient | undefined,
  ): OAuthProvider => {
    if (aiProvider !== "Gemini") {
      return oauthFor(aiProvider);
    }
    if (client === undefined) {
      throw new AiAccountError(
        aiAccountErrorCodes.notOAuthAccount,
        "A Gemini subscription needs Gemini CLI's OAuth client ID and secret.",
      );
    }
    return { ...(oauthProviders["Gemini"] ?? googleOAuth(client)), ...client };
  };
  const fetchTokens = options.fetch ?? fetch;
  const loginTtlMs = options.loginTtlMs ?? 15 * 60 * 1000;
  const balancer = options.balancer ?? createLoadBalancer();
  const retries = options.retries ?? (() => defaultGatewayRetrySettings);
  const throttling =
    options.throttling ?? (() => defaultUsageThrottlingSettings);
  const autoRefresh = options.autoRefresh ?? (() => defaultAutoRefreshSettings);
  /**
   * The reset each account's windows were last refreshed after, so each
   * window gets one request (FR-39). Kept in memory: after a restart, a
   * window that reset unrefreshed is refreshed then.
   */
  const refreshedAfter = new Map<string, Map<UsageWindow, number>>();
  /**
   * Model families each account is exhausted for, and until when (FR-38):
   * a rate limit for one family leaves the account's others be. Kept in
   * memory: after a restart, the AI Provider says so again.
   */
  const exhausted = new Map<string, Map<string, Date>>();
  const exhaustedFor = (
    id: string,
    family: string,
    at: Date,
  ): Date | undefined => {
    const until = exhausted.get(id)?.get(family);
    if (until !== undefined && until <= at) {
      exhausted.get(id)?.delete(family);
      return undefined;
    }
    return until;
  };
  const told = new Set<string>();
  /** Each account's failures in a row, for its circuit breaker. */
  const failures = new Map<string, number>();
  /** Accounts last seen with a limit stored, to lift it once one serves. */
  const limited = new Set<string>();
  /** The limit last told for each account, to tell only changes. */
  const toldLimit = new Map<string, string>();
  /** Each account's usage windows as last stored, to store only changes. */
  const lastWindows = new Map<
    string,
    Pick<
      AiAccountRecord,
      (typeof windowColumns)[keyof typeof windowColumns][number]
    >
  >();
  const rememberWindows = (account: AiAccountRecord) => {
    lastWindows.set(account.id, {
      fiveHourUtilization: account.fiveHourUtilization,
      fiveHourResetsAt: account.fiveHourResetsAt,
      weeklyUtilization: account.weeklyUtilization,
      weeklyResetsAt: account.weeklyResetsAt,
    });
  };
  /**
   * Each account's rate limits as its latest answer reported them: kept in
   * memory as they arrive, and stored at most every `rateLimitsStoreMs`,
   * as they change with every answer.
   */
  const latestRateLimits = new Map<string, RateLimits>();
  const rateLimitsStoredAt = new Map<string, number>();
  const logins = new Map<string, PendingLogin>();
  /** Refreshes under way, one per account: a refresh token is used once. */
  const refreshing = new Map<string, Promise<"refreshed" | "not_due">>();
  /**
   * The token health (and expiry) last told for each account, to tell only
   * changes.
   */
  const toldHealth = new Map<string, string>();

  const tell = (credential: string): void => {
    // An endpoint that asks for no key has none to redact.
    if (credential !== "" && !told.has(credential)) {
      told.add(credential);
      options.onCredential?.(credential);
    }
  };
  const awsConfigFiles = options.awsConfigFiles ?? defaultAwsConfigFiles();
  /** Vertex AI accounts' access tokens, in memory only. */
  const googleTokens = createGoogleTokenCache({
    fetch: fetchTokens,
    now,
    onToken: tell,
  });
  /**
   * A cloud platform account's credential, opened; undefined for every
   * other account.
   */
  const cloudCredentialOf = (
    account: AiAccountRecord,
    opened: string,
  ): CloudCredential | undefined => {
    const kind = aiAccountKindOf(account);
    const platform = kind === undefined ? undefined : platformOf(kind);
    return platform === undefined
      ? undefined
      : parseCloudCredential(platform, opened);
  };
  /**
   * The secrets in an account's opened credential: none for an endpoint
   * that asks for no key.
   */
  const secretsOf = (account: AiAccountRecord, opened: string): string[] => {
    const cloud = cloudCredentialOf(account, opened);
    return (cloud === undefined ? [opened] : cloudSecrets(cloud)).filter(
      (secret) => secret !== "",
    );
  };

  const changed = (keys: string[]) =>
    events.publish({
      type: "config.changed",
      version: 1,
      scope: "gateway",
      keys,
    });

  const notFound = (id: string) =>
    new AiAccountError(
      aiAccountErrorCodes.aiAccountNotFound,
      `There is no AI Account "${id}".`,
    );

  const nameTaken = (name: string) =>
    new AiAccountError(
      aiAccountErrorCodes.aiAccountNameTaken,
      `Another AI Account is already called "${name}".`,
    );

  /** The priority after every other account's. */
  const lastPriority = (accounts: readonly AiAccountRecord[]): number =>
    Math.min(
      maxAiAccountPriority,
      Math.max(
        minAiAccountPriority - 1,
        ...accounts.map((existing) => existing.priority),
      ) + 1,
    );

  /** Tells an OAuth account's token health, if it changed since last told. */
  const tellHealth = async (account: AiAccountRecord): Promise<void> => {
    if (account.tokenExpiresAt === null) {
      return;
    }
    const health: TokenHealth = tokenHealthOf(account.tokenExpiresAt, now());
    const key = `${health}:${String(account.reauthenticationNeeded)}:${account.tokenExpiresAt.toISOString()}`;
    if (toldHealth.get(account.id) === key) {
      return;
    }
    toldHealth.set(account.id, key);
    await events.publish({
      type: "ai_account.token_health",
      version: 1,
      aiAccountId: account.id,
      name: account.name,
      health,
      expiresAt: account.tokenExpiresAt.toISOString(),
      reauthenticationNeeded: account.reauthenticationNeeded,
    });
  };

  /**
   * Tells an account's limit (or that it has none), if it changed since
   * last told, with whether any account of its AI Provider can serve.
   */
  const tellLimit = async (account: AiAccountRecord): Promise<void> => {
    const at = now();
    const limit = limitOf(account, at);
    const key =
      limit === undefined
        ? "none"
        : `${limit.reason}:${limit.until.toISOString()}`;
    if ((toldLimit.get(account.id) ?? "none") === key) {
      return;
    }
    toldLimit.set(account.id, key);
    const providerAvailable = (await store.list()).some(
      (other) =>
        other.aiProvider === account.aiProvider &&
        !other.paused &&
        limitOf(other, at) === undefined,
    );
    await events.publish({
      type: "ai_account.limit_changed",
      version: 1,
      aiAccountId: account.id,
      name: account.name,
      aiProvider: account.aiProvider,
      reason: limit?.reason ?? null,
      until: limit?.until.toISOString() ?? null,
      providerAvailable,
    });
  };

  /** Holds an account back until `until`, or (null) no longer. */
  const setLimit = async (
    id: string,
    limit: { reason: AiAccountLimitReason; until: Date } | null,
  ): Promise<void> => {
    const updated = await store.update(id, {
      limitReason: limit?.reason ?? null,
      limitedUntil: limit?.until ?? null,
      updatedAt: now(),
    });
    if (updated === undefined || updated === "name_taken") {
      limited.delete(id);
      return;
    }
    if (limit === null) {
      limited.delete(id);
    } else {
      limited.add(id);
    }
    await tellLimit(updated);
  };

  /**
   * Stores the usage windows an answer reported, and keeps each reading
   * in the history, when it differs from the last by a whole percent or a
   * new reset; then tells whether that holds the account back.
   */
  const recordUsage = async (
    id: string,
    usage: UsageWindowReadings,
  ): Promise<void> => {
    let last = lastWindows.get(id);
    if (last === undefined) {
      const stored = await store.get(id);
      if (stored === undefined) {
        return;
      }
      rememberWindows(stored);
      last = lastWindows.get(id);
    }
    const at = now();
    const changes: Record<string, number | Date> = {};
    const readings: UsageRecord[] = [];
    for (const [window, [utilizationKey, resetsAtKey]] of Object.entries(
      windowColumns,
    ) as [keyof typeof windowColumns, readonly [string, string]][]) {
      const reading = usage[window];
      if (reading === undefined) {
        continue;
      }
      const before = last as Record<string, number | Date | null> | undefined;
      const utilization = before?.[utilizationKey] as number | null;
      const resetsAt = before?.[resetsAtKey] as Date | null;
      // A window not running is kept as one that reset now, once: until a
      // request starts the next, nothing of it is used.
      if (reading.resetsAt === null && resetsAt !== null && resetsAt <= at) {
        continue;
      }
      const readingResetsAt = reading.resetsAt ?? at;
      if (
        utilization !== null &&
        resetsAt !== null &&
        Math.floor(utilization) === Math.floor(reading.utilization) &&
        Math.abs(resetsAt.getTime() - readingResetsAt.getTime()) < 1000
      ) {
        continue;
      }
      changes[utilizationKey] = reading.utilization;
      changes[resetsAtKey] = readingResetsAt;
      readings.push({
        aiAccountId: id,
        window,
        utilization: reading.utilization,
        resetsAt: readingResetsAt,
        observedAt: at,
      });
    }
    if (readings.length === 0) {
      return;
    }
    const updated = await store.update(id, {
      ...(changes as Partial<AiAccountChanges>),
      updatedAt: at,
    });
    if (updated === undefined || updated === "name_taken") {
      return;
    }
    rememberWindows(updated);
    for (const reading of readings) {
      await store.addUsage(reading);
    }
    await tellLimit(updated);
  };

  /** Keeps the rate limits an answer reported (FR-36), for the card. */
  const recordRateLimits = async (
    id: string,
    readings: RateLimitReadings,
  ): Promise<void> => {
    const at = now();
    const state = (kind: RateLimitKind) => {
      const reading = readings[kind];
      return reading === undefined
        ? null
        : {
            limit: reading.limit,
            remaining: reading.remaining,
            resetsAt: reading.resetsAt?.toISOString() ?? null,
          };
    };
    const rateLimits: RateLimits = {
      requests: state("requests"),
      tokens: state("tokens"),
      inputTokens: state("inputTokens"),
      outputTokens: state("outputTokens"),
      observedAt: at.toISOString(),
    };
    latestRateLimits.set(id, rateLimits);
    const stored = rateLimitsStoredAt.get(id);
    if (stored !== undefined && at.getTime() - stored < rateLimitsStoreMs) {
      return;
    }
    rateLimitsStoredAt.set(id, at.getTime());
    await store.update(id, { rateLimits, updatedAt: at });
  };

  /**
   * The sealed form of a login's tokens, for `id`'s row: a Gemini
   * account's refresh token with the Google client it refreshes as.
   */
  const sealed = (id: string, tokens: OAuthTokens, client?: OAuthClient) => {
    tell(tokens.accessToken);
    tell(tokens.refreshToken);
    return {
      credential: encryptor.encrypt(tokens.accessToken, credentialContext(id)),
      refreshToken: encryptor.encrypt(
        client === undefined
          ? tokens.refreshToken
          : `${withClient}${JSON.stringify({ refreshToken: tokens.refreshToken, ...client })}`,
        refreshTokenContext(id),
      ),
      tokenExpiresAt: tokens.expiresAt,
    };
  };

  /** An OAuth account's refresh token opened, and the client it is for. */
  const openRefreshToken = (
    account: Pick<AiAccountRecord, "id" | "refreshToken">,
  ): { refreshToken: string; client?: OAuthClient } | undefined => {
    if (account.refreshToken === null) {
      return undefined;
    }
    const text = encryptor.decrypt(
      account.refreshToken,
      refreshTokenContext(account.id),
    );
    if (!text.startsWith(withClient)) {
      tell(text);
      return { refreshToken: text };
    }
    const { refreshToken, clientId, clientSecret } = JSON.parse(
      text.slice(withClient.length),
    ) as { refreshToken: string; clientId: string; clientSecret: string };
    tell(refreshToken);
    return { refreshToken, client: { clientId, clientSecret } };
  };

  /**
   * A sign-in's new API address (Qwen's `resource_url`), when it names one
   * other than the account's.
   */
  const apiUrlChange = (
    account: Pick<AiAccountRecord, "endpointUrl"> | undefined,
    tokens: OAuthTokens,
  ): { endpointUrl?: string } =>
    tokens.apiUrl === undefined || tokens.apiUrl === account?.endpointUrl
      ? {}
      : { endpointUrl: tokens.apiUrl };

  /** Whether an OAuth account's token is due to be refreshed. */
  const due = (account: AiAccountRecord): boolean =>
    account.refreshToken !== null &&
    account.tokenExpiresAt !== null &&
    !account.reauthenticationNeeded &&
    account.tokenExpiresAt.getTime() - now().getTime() <= tokenExpiringWithinMs;

  /**
   * Refreshes one account's tokens, once at a time. The account is read
   * again inside the turn: a round that read it before another refreshed
   * it must not use the refresh token that refresh used up.
   */
  const refresh = (id: string): Promise<"refreshed" | "not_due"> => {
    const running = refreshing.get(id);
    if (running !== undefined) {
      return running;
    }
    const done = (async (): Promise<"refreshed" | "not_due"> => {
      const account = await store.get(id);
      const opened =
        account === undefined || !due(account)
          ? undefined
          : openRefreshToken(account);
      if (account === undefined || opened === undefined) {
        return "not_due";
      }
      const { refreshToken, client } = opened;
      let tokens: OAuthTokens;
      try {
        tokens = await refreshTokens(
          oauthAs(account.aiProvider, client),
          refreshToken,
          {
            fetch: fetchTokens,
            now: now(),
          },
        );
      } catch (error) {
        if (error instanceof OAuthError && error.reason === "refused") {
          // It will not refresh again: the Owner must sign in.
          const updated = await store.update(id, {
            reauthenticationNeeded: true,
            updatedAt: now(),
          });
          if (updated !== undefined && updated !== "name_taken") {
            await tellHealth(updated);
          }
        }
        throw error;
      }
      const updated = await store.update(id, {
        ...sealed(id, tokens, client),
        ...apiUrlChange(account, tokens),
        reauthenticationNeeded: false,
        updatedAt: now(),
      });
      if (updated !== undefined && updated !== "name_taken") {
        await tellHealth(updated);
      }
      return "refreshed";
    })().finally(() => {
      refreshing.delete(id);
    });
    refreshing.set(id, done);
    return done;
  };

  /** An account, ready to forward a request to: its credential opened. */
  const open = (account: AiAccountRecord): GatewayAccount => {
    const kind = aiAccountKindOf(account);
    const apiKey = encryptor.decrypt(
      account.credential,
      credentialContext(account.id),
    );
    const cloud = cloudCredentialOf(account, apiKey);
    if (cloud !== undefined) {
      // Signed with the platform's credentials: there is no key to send.
      cloudSecrets(cloud).forEach(tell);
      const region = account.region ?? "";
      const baseUrl =
        account.endpointUrl ?? platformEndpointUrl(cloud.platform, region);
      return {
        id: account.id,
        name: account.name,
        apiKey: "",
        baseUrl,
        apiFormat: "anthropic",
        apiPath: kind?.apiPath ?? "/v1",
        cloud: cloudSigner({
          credential: cloud,
          accountId: account.id,
          baseUrl,
          region,
          projectId: account.projectId,
          awsConfigFiles,
          googleTokens,
          onSecret: tell,
          now,
        }),
      };
    }
    tell(apiKey);
    return {
      id: account.id,
      name: account.name,
      apiKey,
      baseUrl:
        account.endpointUrl ??
        (kind?.apiFormat === "gemini" ? options.codeAssistUrl : undefined) ??
        kind?.defaultEndpointUrl ??
        "https://api.anthropic.com",
      apiFormat: kind?.apiFormat ?? "anthropic",
      // A coding plan's API may start its paths elsewhere (Z.ai's).
      apiPath: subscriptionPlanOf(account)?.apiPath ?? kind?.apiPath ?? "/v1",
      ...(kind !== undefined && "bearerToo" in kind
        ? { authorization: "both" as const }
        : {}),
      ...(() => {
        const project = codeAssistProjects.get(account.id);
        return project === undefined ? {} : { codeAssistProject: project };
      })(),
      ...(account.accountType === "oauth"
        ? (() => {
            const oauth = oauthProviders[account.aiProvider];
            const headers = oauth?.requestHeaders?.(apiKey) ?? {};
            return {
              authorization: "bearer" as const,
              betas: oauth?.betas ?? [],
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            };
          })()
        : {}),
    };
  };

  /** Logins finished from their callback, for `loginStatus` to tell. */
  const finished = new Map<
    string,
    { account: AiAccountInfo; added: boolean; expiresAt: Date }
  >();

  /** The login waiting for `loginId`, if it has not expired. */
  const pendingLogin = (loginId: string): PendingLogin => {
    const login = logins.get(loginId);
    if (login === undefined || login.expiresAt <= now()) {
      logins.delete(loginId);
      throw new AiAccountError(
        aiAccountErrorCodes.oauthLoginNotFound,
        "That sign-in has expired or is unknown: start again.",
      );
    }
    return login;
  };

  const aiAccounts: AiAccounts = {
    async list() {
      // With the rate limits the latest answers reported, stored or not.
      return (await store.list()).map((account) => ({
        ...info(account),
        rateLimits:
          latestRateLimits.get(account.id) ?? account.rateLimits ?? null,
      }));
    },

    async add(request) {
      // A cloud platform's credentials are kept as JSON, with its region
      // (and Vertex AI's project) beside them.
      let credential: string;
      let cloud: Pick<AiAccountRecord, "region" | "projectId"> = noCloud;
      if (request.accountType === "api_key") {
        credential = request.credential;
        tell(credential);
      } else if (request.accountType === "endpoint") {
        // An endpoint that asks for no key is sent none.
        credential = request.credential ?? "";
        tell(credential);
      } else {
        const parsed: CloudCredential =
          request.accountType === "bedrock"
            ? { platform: "bedrock", aws: request.awsCredentials }
            : { platform: "vertex", serviceAccount: request.serviceAccount };
        cloudSecrets(parsed).forEach(tell);
        if (parsed.platform === "bedrock" && "profile" in parsed.aws) {
          // A profile that cannot be read now would fail every request.
          try {
            const key = await readAwsProfile(
              parsed.aws.profile,
              awsConfigFiles,
            );
            tell(key.accessKeyId);
            tell(key.secretAccessKey);
          } catch (error) {
            throw new AiAccountError(
              aiAccountErrorCodes.cloudCredentialsUnusable,
              error instanceof Error
                ? error.message
                : "The AWS profile could not be read.",
            );
          }
        }
        credential = cloudCredentialText(parsed);
        cloud = {
          region: request.region,
          projectId:
            request.accountType === "vertex"
              ? (request.projectId ?? request.serviceAccount.project_id ?? null)
              : null,
        };
      }
      const accounts = await store.list();
      const id = newId();
      const at = now();
      const account: AiAccountRecord = {
        id,
        name: request.name,
        accountType: request.accountType,
        aiProvider: request.aiProvider,
        credential: encryptor.encrypt(credential, credentialContext(id)),
        endpointUrl: request.endpointUrl ?? null,
        ...cloud,
        // After every other account, unless told otherwise.
        priority: request.priority ?? lastPriority(accounts),
        paused: false,
        refreshToken: null,
        tokenExpiresAt: null,
        reauthenticationNeeded: false,
        limitReason: null,
        limitedUntil: null,
        ...noUsage,
        ...noModelSettings,
        createdAt: at,
        updatedAt: at,
      };
      if ((await store.add(account)) === "name_taken") {
        throw nameTaken(request.name);
      }
      await changed(["aiAccounts.added"]);
      return info(account);
    },

    async startLogin(login) {
      let aiProvider: string;
      let client: OAuthClient | undefined;
      if ("accountId" in login) {
        const account = await store.get(login.accountId);
        if (account === undefined) {
          throw notFound(login.accountId);
        }
        if (account.accountType !== "oauth") {
          throw new AiAccountError(
            aiAccountErrorCodes.notOAuthAccount,
            "Only a subscription signs in again; change an API key by adding the account anew.",
          );
        }
        aiProvider = account.aiProvider;
        client = openRefreshToken(account)?.client;
      } else {
        if (
          (await store.list()).some((account) => account.name === login.name)
        ) {
          throw nameTaken(login.name);
        }
        aiProvider = login.aiProvider;
        client = login.client;
      }
      const oauth = oauthAs(aiProvider, client);
      // Logins that were never finished go.
      for (const [id, pending] of logins) {
        if (pending.expiresAt <= now()) {
          logins.delete(id);
        }
      }
      const loginId = newId();
      const state = randomBytes(32).toString("base64url");
      const { verifier, challenge } = pkcePair();
      const target =
        "accountId" in login
          ? { kind: "reauthenticate" as const, accountId: login.accountId }
          : { kind: "add" as const, request: login };
      if (oauth.flow === "device") {
        let device;
        try {
          device = await startDeviceLogin(oauth, {
            fetch: fetchTokens,
            now: now(),
            challenge,
          });
        } catch (error) {
          throw new AiAccountError(
            aiAccountErrorCodes.oauthUnavailable,
            error instanceof OAuthError
              ? error.message
              : "The AI Provider's sign-in could not be reached.",
            { cause: error },
          );
        }
        const expiresAt = new Date(
          Math.min(device.expiresAt.getTime(), now().getTime() + loginTtlMs),
        );
        logins.set(loginId, {
          aiProvider,
          state,
          verifier,
          ...(client === undefined ? {} : { client }),
          deviceCode: device.deviceCode,
          expiresAt,
          target,
        });
        return {
          loginId,
          authorizeUrl: device.verificationUrl,
          userCode: device.userCode,
          expiresAt,
        };
      }
      const expiresAt = new Date(now().getTime() + loginTtlMs);
      logins.set(loginId, {
        aiProvider,
        state,
        verifier,
        ...(client === undefined ? {} : { client }),
        expiresAt,
        target,
      });
      return {
        loginId,
        authorizeUrl: authorizationUrl(oauth, { challenge, state }),
        redirectUri: oauth.redirectUri,
        expiresAt,
      };
    },

    async completeCallback(url) {
      const { state } = pastedCode(url);
      const found = [...logins].find(
        ([, login]) =>
          state !== undefined &&
          login.deviceCode === undefined &&
          login.state === state,
      );
      if (found === undefined) {
        throw new AiAccountError(
          aiAccountErrorCodes.oauthLoginNotFound,
          "That sign-in has expired or is unknown: start again in AI Office.",
        );
      }
      const [loginId, login] = found;
      const result = await aiAccounts.completeLogin(loginId, url);
      finished.set(loginId, { ...result, expiresAt: login.expiresAt });
      return result;
    },

    loginStatus(loginId) {
      for (const [id, done] of finished) {
        if (done.expiresAt <= now()) {
          finished.delete(id);
        }
      }
      const done = finished.get(loginId);
      if (done !== undefined) {
        return Promise.resolve({
          status: "done",
          account: done.account,
          added: done.added,
        });
      }
      try {
        pendingLogin(loginId);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return Promise.resolve({ status: "pending" });
    },

    awaitingCallback(redirectUri) {
      return [...logins.values()].some(
        (login) =>
          login.deviceCode === undefined &&
          login.expiresAt > now() &&
          oauthProviders[login.aiProvider]?.redirectUri === redirectUri,
      );
    },

    async completeLogin(loginId, pasted) {
      const login = pendingLogin(loginId);
      const oauth = oauthAs(login.aiProvider, login.client);
      let tokens: OAuthTokens;
      try {
        if (login.deviceCode !== undefined) {
          tokens = await pollDeviceLogin(oauth, login.deviceCode, {
            fetch: fetchTokens,
            now: now(),
            verifier: login.verifier,
          });
        } else {
          const { code, state } = pastedCode(pasted ?? "");
          if (code === "") {
            throw new AiAccountError(
              aiAccountErrorCodes.oauthCodeRefused,
              "Paste the code the sign-in page showed.",
            );
          }
          if (state !== undefined && state !== login.state) {
            throw new AiAccountError(
              aiAccountErrorCodes.oauthCodeRefused,
              "That code is from another sign-in: paste the code this one showed.",
            );
          }
          tokens = await exchangeCode(
            oauth,
            { code, state: login.state, verifier: login.verifier },
            { fetch: fetchTokens, now: now() },
          );
        }
      } catch (error) {
        if (error instanceof OAuthError && error.reason === "pending") {
          throw new AiAccountError(
            aiAccountErrorCodes.oauthLoginPending,
            "Approve the sign-in on the AI Provider's page first, then finish it.",
            { cause: error },
          );
        }
        if (error instanceof OAuthError) {
          if (error.reason === "refused") {
            // A code is used once; this login cannot be finished now.
            logins.delete(loginId);
          }
          throw new AiAccountError(
            error.reason === "refused"
              ? aiAccountErrorCodes.oauthCodeRefused
              : aiAccountErrorCodes.oauthUnavailable,
            error.reason === "refused"
              ? login.deviceCode === undefined
                ? "The AI Provider refused that code: start the sign-in again."
                : "The AI Provider refused the sign-in (denied or expired): start it again."
              : error.message,
            { cause: error },
          );
        }
        throw error;
      }
      logins.delete(loginId);
      // A Gemini login serves only through its Code Assist project: one
      // that has none cannot serve, so it is not added.
      let project: string | undefined;
      if (
        aiAccountKindOf({ aiProvider: login.aiProvider, accountType: "oauth" })
          ?.apiFormat === "gemini"
      ) {
        tell(tokens.accessToken);
        try {
          project = await lookUpCodeAssistProject(
            { endpointUrl: null },
            tokens.accessToken,
          );
        } catch (error) {
          if (error instanceof CodeAssistError) {
            throw new AiAccountError(
              aiAccountErrorCodes.oauthUnavailable,
              error.message,
              { cause: error },
            );
          }
          throw error;
        }
      }
      const at = now();
      const { target } = login;
      if (target.kind === "reauthenticate") {
        if (project !== undefined) {
          codeAssistProjects.set(target.accountId, project);
        }
        const updated = await store.update(target.accountId, {
          ...sealed(target.accountId, tokens, login.client),
          ...apiUrlChange(await store.get(target.accountId), tokens),
          reauthenticationNeeded: false,
          updatedAt: at,
        });
        if (updated === undefined || updated === "name_taken") {
          throw notFound(target.accountId);
        }
        await changed(["aiAccounts.reauthenticated"]);
        await tellHealth(updated);
        return { account: info(updated), added: false };
      }
      const id = newId();
      const account: AiAccountRecord = {
        id,
        name: target.request.name,
        accountType: "oauth",
        aiProvider: target.request.aiProvider,
        ...sealed(id, tokens, login.client),
        endpointUrl: tokens.apiUrl ?? null,
        ...noCloud,
        priority: target.request.priority ?? lastPriority(await store.list()),
        paused: false,
        reauthenticationNeeded: false,
        limitReason: null,
        limitedUntil: null,
        ...noUsage,
        ...noModelSettings,
        createdAt: at,
        updatedAt: at,
      };
      if ((await store.add(account)) === "name_taken") {
        throw nameTaken(account.name);
      }
      if (project !== undefined) {
        codeAssistProjects.set(id, project);
      }
      await changed(["aiAccounts.added"]);
      await tellHealth(account);
      return { account: info(account), added: true };
    },

    async importLogin(request) {
      const tokens = tokensInLoginFile(request.login, now());
      if (tokens === undefined) {
        throw new AiAccountError(
          aiAccountErrorCodes.loginNotImportable,
          "That login holds no access and refresh token: paste the whole login file.",
        );
      }
      oauthAs(request.aiProvider, request.client);
      const at = now();
      const id = newId();
      const account: AiAccountRecord = {
        id,
        name: request.name,
        accountType: "oauth",
        aiProvider: request.aiProvider,
        ...sealed(id, tokens, request.client),
        endpointUrl: null,
        ...noCloud,
        priority: request.priority ?? lastPriority(await store.list()),
        paused: false,
        reauthenticationNeeded: false,
        limitReason: null,
        limitedUntil: null,
        ...noUsage,
        ...noModelSettings,
        createdAt: at,
        updatedAt: at,
      };
      if ((await store.add(account)) === "name_taken") {
        throw nameTaken(account.name);
      }
      await changed(["aiAccounts.imported"]);
      await tellHealth(account);
      return info(account);
    },

    async refreshTokens() {
      const report: {
        refreshed: string[];
        refused: string[];
        failed: { id: string; error: unknown }[];
      } = { refreshed: [], refused: [], failed: [] };
      for (const account of await store.list()) {
        if (account.tokenExpiresAt === null) {
          continue;
        }
        if (due(account)) {
          try {
            if ((await refresh(account.id)) === "refreshed") {
              report.refreshed.push(account.id);
            }
            continue;
          } catch (error) {
            if (error instanceof OAuthError && error.reason === "refused") {
              report.refused.push(account.id);
              continue;
            }
            report.failed.push({ id: account.id, error });
          }
        }
        // Expiring, then expired, while nothing could refresh it.
        await tellHealth(account);
      }
      return report;
    },

    async refreshUsage(id) {
      const report: {
        refreshed: string[];
        failed: { id: string; error: unknown }[];
      } = { refreshed: [], failed: [] };
      let candidates: AiAccountRecord[];
      if (id === undefined) {
        candidates = await store.list();
      } else {
        const account = await store.get(id);
        if (account === undefined) {
          throw notFound(id);
        }
        candidates = [account];
      }
      for (const account of candidates) {
        const balanceSource = account.paused
          ? undefined
          : balanceSourceOf(account);
        if (balanceSource !== undefined) {
          try {
            const key = encryptor.decrypt(
              account.credential,
              credentialContext(account.id),
            );
            tell(key);
            const kind = aiAccountKindOf(account);
            const reading = await readBalance(
              balanceSource,
              account.endpointUrl ?? kind?.defaultEndpointUrl ?? "",
              key,
              fetchTokens,
            );
            await store.update(account.id, {
              balance: { ...reading, observedAt: now().toISOString() },
              updatedAt: now(),
            });
            report.refreshed.push(account.id);
          } catch (error) {
            report.failed.push({ id: account.id, error });
          }
          continue;
        }
        const usageUrl =
          account.accountType === "oauth"
            ? oauthProviders[account.aiProvider]?.usageUrl
            : undefined;
        if (usageUrl === undefined || account.reauthenticationNeeded) {
          continue;
        }
        try {
          if (due(account)) {
            await refresh(account.id);
          }
          const current = (await store.get(account.id)) ?? account;
          if (
            current.tokenExpiresAt !== null &&
            current.tokenExpiresAt <= now()
          ) {
            continue;
          }
          const accessToken = encryptor.decrypt(
            current.credential,
            credentialContext(current.id),
          );
          tell(accessToken);
          const oauth = oauthFor(current.aiProvider);
          const response = await fetchTokens(usageUrl, {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
              // Anthropic's alone: a ChatGPT subscription has none.
              ...(oauth.betas.length > 0
                ? { "anthropic-beta": oauth.betas.join(",") }
                : {}),
              ...oauth.requestHeaders?.(accessToken),
            },
            signal: AbortSignal.timeout(usageTimeoutMs),
            // Its token goes to its own usage endpoint only (pen-testing
            // G1-7).
            redirect: "manual",
          });
          if (!response.ok) {
            // Never the body: it is the AI Provider's, and may echo the token.
            throw new Error(
              `The usage endpoint answered ${String(response.status)}.`,
            );
          }
          await recordUsage(
            current.id,
            usageWindowsOfBody(await response.json(), now()),
          );
          report.refreshed.push(current.id);
        } catch (error) {
          report.failed.push({ id: account.id, error });
        }
      }
      return report;
    },

    async checkLimits() {
      const at = now();
      const lifted: string[] = [];
      for (const account of await store.list()) {
        if (account.limitedUntil !== null && account.limitedUntil <= at) {
          await setLimit(account.id, null);
          lifted.push(account.id);
        } else {
          // A usage window that reset lets its account go.
          await tellLimit(account);
        }
      }
      return lifted;
    },

    async refreshWindows() {
      const report: {
        refreshed: string[];
        failed: { id: string; error: unknown }[];
      } = { refreshed: [], failed: [] };
      if (!autoRefresh().enabled) {
        return report;
      }
      for (const account of await store.list()) {
        const at = now();
        const refreshed =
          refreshedAfter.get(account.id) ?? new Map<UsageWindow, number>();
        const reset = (
          Object.entries(windowColumns) as [
            UsageWindow,
            (typeof windowColumns)[UsageWindow],
          ][]
        ).flatMap(([window, [, resetsAtKey]]) => {
          const resetsAt = account[resetsAtKey];
          return resetsAt !== null &&
            resetsAt.getTime() + autoRefreshBufferMs <= at.getTime() &&
            refreshed.get(window) !== resetsAt.getTime()
            ? [[window, resetsAt.getTime()] as const]
            : [];
        });
        if (
          reset.length === 0 ||
          account.paused ||
          aiAccountKindOf(account)?.apiFormat !== "anthropic" ||
          isCloud(account) ||
          (account.accountType === "oauth" &&
            (account.reauthenticationNeeded ||
              account.tokenExpiresAt === null ||
              account.tokenExpiresAt <= at)) ||
          limitOf(account, at) !== undefined
        ) {
          continue;
        }
        // As `select` does: an answer that serves lifts a limit still stored.
        if (account.limitReason !== null) {
          limited.add(account.id);
        }
        // Marked before it is sent, so a round that overlaps this one does
        // not send another.
        for (const [window, resetsAt] of reset) {
          refreshed.set(window, resetsAt);
        }
        refreshedAfter.set(account.id, refreshed);
        const opened = open(account);
        let answer: RefreshAnswer | undefined;
        try {
          answer = await sendRefresh(opened, { fetch: fetchTokens, now: at });
        } catch (error) {
          report.failed.push({ id: account.id, error });
        }
        // Read like any answer: a limit holds the account back, a failure
        // counts towards its circuit breaker, and the new window is stored.
        await aiAccounts.report(
          opened,
          answer?.outcome ?? { kind: "failed" },
          answer?.usage,
        );
        const served = answer?.outcome.kind === "served";
        if (served) {
          report.refreshed.push(account.id);
        } else if (answer !== undefined) {
          report.failed.push({
            id: account.id,
            error: new Error(
              `The AI Provider answered auto-refresh with ${String(answer.status)}.`,
            ),
          });
        }
        await events.publish({
          type: "ai_account.window_refreshed",
          version: 1,
          aiAccountId: account.id,
          name: account.name,
          windows: reset.map(([window]) => window),
          served,
          resetsAt: served
            ? (answer?.usage.five_hour?.resetsAt?.toISOString() ?? null)
            : null,
        });
      }
      return report;
    },

    async keepAliveAccount(id, model) {
      const account = await store.get(id);
      const at = now();
      const family = model === null ? undefined : modelFamilyOf(model);
      if (
        account === undefined ||
        account.paused ||
        isCloud(account) ||
        (account.accountType === "oauth" &&
          (account.reauthenticationNeeded ||
            account.tokenExpiresAt === null ||
            account.tokenExpiresAt <= at)) ||
        limitOf(account, at) !== undefined ||
        (family !== undefined && exhaustedFor(id, family, at) !== undefined)
      ) {
        return undefined;
      }
      // As `select` does: an answer that serves lifts a limit still stored.
      if (account.limitReason !== null) {
        limited.add(account.id);
      }
      return open(account);
    },

    async resetLimits(id) {
      if ((await store.get(id)) === undefined) {
        throw notFound(id);
      }
      failures.delete(id);
      exhausted.delete(id);
      const updated = await store.update(id, {
        limitReason: null,
        limitedUntil: null,
        fiveHourUtilization: null,
        fiveHourResetsAt: null,
        weeklyUtilization: null,
        weeklyResetsAt: null,
        updatedAt: now(),
      });
      if (updated === undefined || updated === "name_taken") {
        throw notFound(id);
      }
      limited.delete(id);
      rememberWindows(updated);
      await changed(["aiAccounts.limitsReset"]);
      await tellLimit(updated);
      return info(updated);
    },

    async usageHistory(id, options) {
      if ((await store.get(id)) === undefined) {
        throw notFound(id);
      }
      return store.usageHistory(id, options);
    },

    // What an AI Provider's answer said about the account that gave it
    // (FR-39): a rate limit or an overload holds it back until the AI
    // Provider's reset; failures in a row open its circuit breaker for a
    // cooldown, and the first failure once it is over opens it again (it is
    // half-open) until the account serves.
    async report(
      account,
      outcome: AccountOutcome,
      usage = {},
      rateLimits = {},
    ) {
      const { id } = account;
      if (id === null) {
        return;
      }
      if (Object.keys(usage).length > 0) {
        await recordUsage(id, usage);
      }
      if (Object.keys(rateLimits).length > 0) {
        await recordRateLimits(id, rateLimits);
      }
      switch (outcome.kind) {
        case "served":
        case "refused": {
          // It answered: whatever held it back is over.
          failures.delete(id);
          const until =
            outcome.kind === "served" ? outcome.extraUsageUntil : undefined;
          if (until !== undefined) {
            // Served on extra usage (FR-41): with the Owner's toggle off,
            // it serves nothing more until its plan's limit resets.
            const record = await store.get(id);
            if (
              record !== undefined &&
              !record.extraUsage &&
              offersExtraUsage(record)
            ) {
              await setLimit(id, { reason: "extra_usage", until });
              return;
            }
          }
          if (limited.has(id)) {
            await setLimit(id, null);
          }
          return;
        }
        case "rate_limited":
          if (outcome.modelFamily !== undefined) {
            // Only that family: the account serves the others.
            const families = exhausted.get(id) ?? new Map<string, Date>();
            families.set(outcome.modelFamily, outcome.until);
            exhausted.set(id, families);
            return;
          }
          await setLimit(id, { reason: outcome.kind, until: outcome.until });
          return;
        case "overloaded":
          await setLimit(id, { reason: outcome.kind, until: outcome.until });
          return;
        case "failed": {
          const count = (failures.get(id) ?? 0) + 1;
          failures.set(id, count);
          const breaker = retries();
          if (count >= breaker.circuitBreakerThreshold) {
            await setLimit(id, {
              reason: "circuit_open",
              until: new Date(
                now().getTime() + breaker.circuitBreakerCooldownSeconds * 1000,
              ),
            });
          }
          return;
        }
      }
    },

    async update(id, update) {
      const current = await store.get(id);
      if (current === undefined) {
        throw notFound(id);
      }
      const {
        name,
        priority,
        paused,
        fiveHourPauseThreshold,
        weeklyPauseThreshold,
        forcedModel,
        extraUsage,
      } = update;
      // A forced Model is one of its own AI Provider's (FR-41), or any
      // for a compatible endpoint.
      if (
        forcedModel != null &&
        !aiProviderTakes(current.aiProvider, forcedModel)
      ) {
        throw new AiAccountError(
          aiAccountErrorCodes.forcedModelMismatch,
          `${forcedModel} is ${aiProviderOfModel(forcedModel) ?? ""}'s, but ${current.name} is a ${current.aiProvider} account.`,
        );
      }
      if (extraUsage === true && !offersExtraUsage(current)) {
        throw new AiAccountError(
          aiAccountErrorCodes.extraUsageNotOffered,
          `${current.aiProvider} offers no extra usage for this kind of AI Account.`,
        );
      }
      const changes = {
        ...(name !== undefined && name !== current.name ? { name } : {}),
        ...(priority !== undefined && priority !== current.priority
          ? { priority }
          : {}),
        ...(paused !== undefined && paused !== current.paused
          ? { paused }
          : {}),
        ...(fiveHourPauseThreshold !== undefined &&
        fiveHourPauseThreshold !== current.fiveHourPauseThreshold
          ? { fiveHourPauseThreshold }
          : {}),
        ...(weeklyPauseThreshold !== undefined &&
        weeklyPauseThreshold !== current.weeklyPauseThreshold
          ? { weeklyPauseThreshold }
          : {}),
        ...(forcedModel !== undefined && forcedModel !== current.forcedModel
          ? { forcedModel }
          : {}),
        ...(extraUsage !== undefined && extraUsage !== current.extraUsage
          ? { extraUsage }
          : {}),
      };
      const keys = Object.keys(changes);
      if (keys.length === 0) {
        return info(current);
      }
      const updated = await store.update(id, {
        ...changes,
        updatedAt: now(),
      });
      if (updated === undefined) {
        throw notFound(id);
      }
      if (updated === "name_taken") {
        throw nameTaken(update.name ?? "");
      }
      // Which settings changed, never their values.
      await changed(keys.map((key) => `aiAccounts.${key}`));
      // Extra usage turned on lets it serve again at once (FR-41).
      if (updated.extraUsage && updated.limitReason === "extra_usage") {
        await setLimit(id, null);
        return info((await store.get(id)) ?? updated);
      }
      // A threshold, or extra usage, may now hold it back, or let it go.
      if (
        "fiveHourPauseThreshold" in changes ||
        "weeklyPauseThreshold" in changes ||
        "extraUsage" in changes
      ) {
        await tellLimit(updated);
      }
      return info(updated);
    },

    async remove(id) {
      if (!(await store.remove(id))) {
        throw notFound(id);
      }
      toldHealth.delete(id);
      toldLimit.delete(id);
      failures.delete(id);
      limited.delete(id);
      lastWindows.delete(id);
      refreshedAfter.delete(id);
      googleTokens.forget(id);
      await changed(["aiAccounts.deleted"]);
    },

    async catalogueSources() {
      const at = now();
      const sources = new Map<string, CatalogueSource>();
      for (const account of await store.list()) {
        const kind = aiAccountKindOf(account);
        // Each compatible endpoint lists what its owner put behind it, so
        // each is asked; one account of every other kind is enough.
        const key =
          kind !== undefined && "anyModel" in kind
            ? `${account.aiProvider}:${account.accountType}:${account.id}`
            : `${account.aiProvider}:${account.accountType}`;
        const modelsPath =
          kind === undefined || !("modelsPath" in kind)
            ? "/models"
            : kind.modelsPath;
        const documentedModels =
          kind !== undefined && "documentedModels" in kind
            ? kind.documentedModels
            : undefined;
        if (
          kind === undefined ||
          // A kind that lists no Models, and documents none.
          (modelsPath === null && documentedModels === undefined) ||
          account.paused ||
          sources.has(key) ||
          (account.accountType === "oauth" &&
            (account.tokenExpiresAt === null || account.tokenExpiresAt <= at))
        ) {
          continue;
        }
        sources.set(key, {
          aiProvider: account.aiProvider,
          accountType: account.accountType,
          account: open(account),
          modelsPath,
          ...(documentedModels === undefined ? {} : { documentedModels }),
        });
      }
      return [...sources.values()];
    },

    async holdsCredential(value) {
      for (const account of await store.list()) {
        const credentials: string[] = [
          ...secretsOf(
            account,
            encryptor.decrypt(
              account.credential,
              credentialContext(account.id),
            ),
          ),
          ...(account.refreshToken === null
            ? []
            : [openRefreshToken(account)?.refreshToken ?? ""]),
        ];
        for (const credential of credentials) {
          tell(credential);
          if (value.includes(credential)) {
            return true;
          }
        }
      }
      return false;
    },

    // The account for this request (FR-37, FR-38, FR-40): the one it
    // forces, if it names one; otherwise, for a Model of a family an
    // enabled Combo is assigned to, the first of the Combo's slots that can
    // serve it; otherwise the balancer's choice among the unpaused accounts
    // that can serve it. Either way less those held back, in the order of
    // FR-38's checks. A subscription serves only its own agent tool's
    // requests (FR-35), and only while its access token has not expired.
    // An alias stands for its Model throughout; each account is sent the
    // Model `modelSentTo` gives it (FR-41), and judged by that Model.
    async select(request: AccountRequest): Promise<ChosenAccount | undefined> {
      const at = now();
      const accounts = await store.list();
      const mappings = (await options.modelMappings?.rules()) ?? [];
      const requested = request.model ?? null;
      /** The Model an account would be sent, before its forced one. */
      const mapped = (account: AiAccountRecord): string | null =>
        requested === null ? null : mappedModel(requested, account, mappings);
      /** The Model an account is sent, from a Combo's slot or not. */
      const sentTo = (account: AiAccountRecord, comboModel?: string) =>
        modelSentTo({ requested, comboModel }, account, mappings);
      /** An account, opened, with the Model it is sent if not the one asked. */
      const chosenWith = (
        account: AiAccountRecord,
        model: string | undefined,
        combo?: ComboChoice,
      ): ChosenAccount => ({
        ...open(account),
        ...(combo === undefined ? {} : { combo }),
        ...(model === undefined || model === requested ? {} : { model }),
      });
      for (const account of accounts) {
        if (account.limitReason === null) {
          limited.delete(account.id);
        } else {
          limited.add(account.id);
        }
        rememberWindows(account);
      }
      // A Model of a known AI Provider is served only by its accounts, and
      // by compatible endpoints, which are sent any Model.
      const servable = (
        account: AiAccountRecord,
        model: string | null,
      ): boolean => {
        const kind = aiAccountKindOf(account);
        return (
          kind !== undefined &&
          (model == null || aiProviderTakes(account.aiProvider, model)) &&
          (request.endpoint === undefined ||
            kindServes(kind, request.endpoint)) &&
          (kind.servesOnly === null ||
            (kind.servesOnly === request.agentTool &&
              account.tokenExpiresAt !== null &&
              account.tokenExpiresAt > at))
        );
      };
      // A Model no AI Provider claims by name goes only to the Owner's
      // compatible endpoints while one of them can serve it: only they
      // know what they serve. Without one, any account may be asked.
      const toEndpoints = accounts.some(
        (account) =>
          !account.paused &&
          servesAnyModel(account.aiProvider) &&
          servable(account, mapped(account)),
      );
      const canServe = (
        account: AiAccountRecord,
        model: string | null,
      ): boolean =>
        servable(account, model) &&
        (!toEndpoints ||
          model == null ||
          servesAnyModel(account.aiProvider) ||
          aiProviderOfModel(model) !== undefined);
      const forced = request.forcedAccount ?? null;
      if (forced !== null) {
        const account = accounts.find(
          ({ id, name }) => id === forced || name === forced,
        );
        if (account === undefined) {
          throw new ForcedAccountError(
            `The forced AI Account "${forced}" does not exist.`,
          );
        }
        if (account.paused) {
          throw new ForcedAccountError(
            `The forced AI Account "${account.name}" is paused.`,
          );
        }
        if (!servable(account, mapped(account))) {
          throw new ForcedAccountError(
            `The forced AI Account "${account.name}" cannot serve this request.`,
          );
        }
        return chosenWith(account, sentTo(account));
      }

      // A forced account is a probe, so it is tried even while held back.
      // Otherwise FR-38's checks follow, in order: the strategy ranks the
      // accounts that can serve (or a Combo's slots stand in their order),
      // the model-capacity filter leaves out those exhausted for the
      // request's model family (or rate-limited outright), and usage
      // throttling those overloaded, at a pause threshold or ahead of their
      // pace. When a check leaves none, the error says which: capacity is a
      // 429, throttling a 529; failing accounts, or none at all, a 503.
      const reasonOf = (account: AiAccountRecord) =>
        limitOf(account, at)?.reason;
      const allFailing = (serving: readonly AiAccountRecord[]) =>
        new AccountsUnavailableError(
          503,
          "Every AI Account that can serve this request is failing; the AI Gateway is giving them a rest.",
          soonest(serving, at),
        );
      const pacing = throttling();
      const capacity = (
        account: AiAccountRecord,
        family: string | undefined,
      ): Exclusion | undefined => {
        const limit = limitOf(account, at);
        if (limit?.reason === "rate_limited") {
          return {
            message:
              "Every AI Account that can serve this request is rate-limited.",
            until: limit.until,
          };
        }
        if (limit?.reason === "extra_usage") {
          return {
            message:
              "Every AI Account that can serve this request has reached its plan's limit, and extra usage is off.",
            until: limit.until,
          };
        }
        const until =
          family === undefined
            ? undefined
            : exhaustedFor(account.id, family, at);
        return until === undefined
          ? undefined
          : {
              message: `Every AI Account that can serve this request has no capacity left for ${family ?? ""} models.`,
              until,
            };
      };
      const throttled = (account: AiAccountRecord): Exclusion | undefined => {
        const limit = limitOf(account, at);
        if (limit?.reason === "overloaded") {
          return {
            message:
              "Every AI Account that can serve this request is overloaded.",
            until: limit.until,
          };
        }
        if (limit?.reason === "usage_threshold") {
          return {
            message:
              "Every AI Account that can serve this request has reached its usage pause threshold.",
            until: limit.until,
          };
        }
        const gates = [
          [
            pacing.fiveHourPacing,
            account.fiveHourUtilization,
            account.fiveHourResetsAt,
            usageWindowLengthsMs.five_hour,
            "five-hour",
          ],
          [
            pacing.weeklyPacing,
            account.weeklyUtilization,
            account.weeklyResetsAt,
            usageWindowLengthsMs.weekly,
            "weekly",
          ],
        ] as const;
        for (const [on, utilization, resetsAt, windowMs, name] of gates) {
          const until =
            on && utilization !== null && resetsAt !== null
              ? aheadOfPace(
                  { utilization, resetsAt },
                  windowMs,
                  pacingHeadroomPercent,
                  at,
                )
              : undefined;
          if (until !== undefined) {
            return {
              message: `Every AI Account that can serve this request is ahead of its ${name} pace.`,
              until,
            };
          }
        }
        return undefined;
      };

      const combo =
        requested === null
          ? undefined
          : await options.combos?.forModel(aliasedModel(requested, mappings));
      if (combo !== undefined) {
        // The Combo's slots, in its order, skipping those whose account is
        // gone, paused or cannot serve the slot's Model for this request.
        // The first not held back serves (one not yet tried for this
        // request, if there is one); the strategy has no say.
        const slots = combo.slots.flatMap((slot) => {
          const account = accounts.find(({ id }) => id === slot.aiAccountId);
          return account !== undefined &&
            !account.paused &&
            servable(account, slot.model)
            ? [
                {
                  id: comboSlotKey(account.id, slot.model),
                  priority: 1,
                  account,
                  model: slot.model,
                },
              ]
            : [];
        });
        if (slots.length === 0) {
          throw new AccountsUnavailableError(
            503,
            `No AI Account in the Combo "${combo.name}" can serve this request.`,
            undefined,
          );
        }
        const working = slots.filter(
          ({ account }) => reasonOf(account) !== "circuit_open",
        );
        if (working.length === 0) {
          throw allFailing(slots.map(({ account }) => account));
        }
        const chosen = route(
          inOrder,
          working,
          { sessionKey: null, avoid: request.avoid ?? [] },
          at,
          {
            capacity: ({ account, model }) =>
              capacity(account, modelFamilyOf(sentTo(account, model) ?? model)),
            throttling: ({ account }) => throttled(account),
          },
        );
        return chosen === undefined
          ? undefined
          : chosenWith(chosen.account, sentTo(chosen.account, chosen.model), {
              name: combo.name,
              model: chosen.model,
              slots: combo.slots.length,
            });
      }

      const serving = accounts.filter(
        (account) => !account.paused && canServe(account, mapped(account)),
      );
      if (serving.length === 0) {
        return undefined;
      }
      const working = serving.filter(
        (account) => reasonOf(account) !== "circuit_open",
      );
      if (working.length === 0) {
        throw allFailing(serving);
      }
      const familyOf = (account: AiAccountRecord) => {
        const model = sentTo(account);
        return model === undefined ? undefined : modelFamilyOf(model);
      };
      const chosen = route(
        balancer,
        working,
        { sessionKey: request.sessionKey ?? null, avoid: request.avoid ?? [] },
        at,
        {
          capacity: (account) => capacity(account, familyOf(account)),
          throttling: throttled,
        },
      );
      return chosen === undefined
        ? undefined
        : chosenWith(chosen, sentTo(chosen));
    },
  };
  // A Gemini subscription chosen before its Code Assist project is known
  // (after a restart, or an imported login) looks it up first; one that
  // cannot is sent as it is, and Code Assist's answer says why.
  const selectAccount = aiAccounts.select.bind(aiAccounts);
  aiAccounts.select = async (request) => {
    const chosen = await selectAccount(request);
    if (
      chosen?.id == null ||
      chosen.codeAssistProject !== undefined ||
      chosen.cloud !== undefined
    ) {
      return chosen;
    }
    const account = await store.get(chosen.id);
    if (account === undefined || !reachesCodeAssist(account)) {
      return chosen;
    }
    try {
      const project = await lookUpCodeAssistProject(account, chosen.apiKey);
      codeAssistProjects.set(account.id, project);
      return { ...chosen, codeAssistProject: project };
    } catch (error) {
      if (error instanceof CodeAssistError) {
        return chosen;
      }
      throw error;
    }
  };
  return aiAccounts;
}
