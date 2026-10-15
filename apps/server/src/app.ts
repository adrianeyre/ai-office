import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import proxyAddr from "@fastify/proxy-addr";
import fastifyStatic from "@fastify/static";
import {
  createCommunications,
  createGoogleAuth,
  defaultTransports,
  memoryCommunicationsStore,
  type Communications,
  type GoogleAuth,
} from "@ai-office/communications";
import {
  createEventBus,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import {
  createAiAccounts,
  createCombos,
  createGatewayKeys,
  createModelCatalogue,
  createModelMappings,
  createPricing,
  createRequestHistory,
  limitKeyCheck,
  memoryAiAccountStore,
  memoryComboStore,
  memoryGatewayKeyStore,
  memoryModelCatalogueStore,
  memoryModelMappingStore,
  memoryModelPriceStore,
  memoryRequestHistoryStore,
  type AiAccounts,
  type Combos,
  type GatewayKeys,
  type ModelCatalogue,
  type ModelMappings,
  type Pricing,
  type RequestHistory,
} from "@ai-office/gateway";
import type { GitHubApp } from "@ai-office/github";
import {
  createAgents,
  workingAgentStore,
  createConfiguration,
  createAiProviders,
  createGitHubConnections,
  createGitHubWebhooks,
  createContextUsage,
  followSandboxSessions,
  createFloors,
  createFloorStops,
  type FloorStops,
  createDirectChats,
  createManagerChat,
  publishingGrillingStore,
  createNotices,
  createOfficeSettings,
  createTokenCaps,
  createFloorSkills,
  floorChatSkills,
  createRepositoryMemoryShelf,
  createSharedMemory,
  createRoleLibrary,
  createSkillLibrary,
  createBranches,
  createStatusUpdates,
  createWallBoard,
  gitSkillRepository,
  loadFloorTemplates,
  createFloorTemplateLibrary,
  gitTemplateRepository,
  memoryStores,
  memoryWorkQueueStore,
  ModelCallError,
  type Agents,
  type AiProviders,
  type Batches,
  type Branches,
  type ContextUsage,
  type FreshStarts,
  type GitHubConnections,
  type DirectChats,
  type ChatRepositoryFiles,
  type ChatTasks,
  type ManagerChat,
  type StatusUpdates,
  type ModelClient,
  type Notices,
  type OfficeStores,
  type SharedMemory,
  type RoleLibrary,
  type SkillLibrary,
  type WebhookTargets,
  type WorkingAgentStore,
  type WorkQueueStore,
} from "@ai-office/orchestrator";
import type {
  FloorTemplate,
  HealthResponse,
  Redactor,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

import type { OAuthCallbacks } from "./ai-accounts/oauth-callback.ts";
import { registerAiAccountRoutes } from "./ai-accounts/routes.ts";
import { registerComboRoutes } from "./combos/routes.ts";
import { registerModelMappingRoutes } from "./model-mappings/routes.ts";
import {
  catalogueOf,
  registerAiProviderRoutes,
} from "./ai-providers/routes.ts";
import { registerAccess } from "./auth/access.ts";
import { restoreLimiter } from "./auth/attempts.ts";
import { registerOwnerPasswordRoutes } from "./auth/password-routes.ts";
import { notFoundBody } from "./auth/responses.ts";
import { createOwnerProof } from "./auth/owner-proof.ts";
import { believeOnlyTheProxy } from "./auth/proxy.ts";
import type { SetupToken } from "./auth/setup-token.ts";
import {
  createLoginLimiter,
  defaultLoginLimits,
  type LoginLimitOptions,
} from "./auth/login-limiter.ts";
import { createSessions, type SessionOptions } from "./auth/sessions.ts";
import { createSignInChallenges } from "./auth/sign-in-challenges.ts";
import { registerAgentRoutes } from "./agents/routes.ts";
import { registerBatchRoutes } from "./batches/routes.ts";
import { registerGoogleRoutes } from "./connections/google-routes.ts";
import { registerConnectionRoutes } from "./connections/routes.ts";
import {
  contextWindowOf,
  observeModelCalls,
  registerContextUsageRoutes,
} from "./context-usage/routes.ts";
import { registerEventHistory } from "./events/history.ts";
import { registerEventStream } from "./events/stream.ts";
import { registerFloorTemplateRoutes } from "./floor-templates/routes.ts";
import { registerBranchRoutes } from "./branches/routes.ts";
import { registerFloorRoutes } from "./floors/routes.ts";
import { gatewayEntry } from "./gateway-entry.ts";
import { keepAgentKeys } from "./gateway-keys/agent-keys.ts";
import { createKeyGuesses } from "./gateway-keys/key-guesses.ts";
import { createLogHub, type LogHub } from "./gateway-requests/log-hub.ts";
import { registerGatewayRequestRoutes } from "./gateway-requests/routes.ts";
import { registerGatewayKeyRoutes } from "./gateway-keys/routes.ts";
import { registerNoticeRoutes } from "./notices/routes.ts";
import { registerConfigurationRoutes } from "./configuration/routes.ts";
import { registerPricingRoutes } from "./pricing/routes.ts";
import { registerOfficeRoutes } from "./office/routes.ts";
import { registerStorageRoutes } from "./storage/routes.ts";
import { registerTokenCapRoutes } from "./token-caps/routes.ts";
import { registerAnalyticsRoutes } from "./analytics/routes.ts";
import { registerDirectChatRoutes } from "./direct-chats/routes.ts";
import { directChatUsageOf } from "./direct-chats/usage.ts";
import { registerManagerChatRoutes } from "./manager-chat/routes.ts";
import { registerMemoryRoutes } from "./memory/routes.ts";
import {
  registerFloorSkillRoutes,
  registerSkillRoutes,
} from "./skills/routes.ts";
import {
  originOf,
  renderIndexHtml,
  robotsTxt,
  sitemapXml,
} from "./web-page.ts";
import { registerRoleRoutes } from "./roles/routes.ts";
import { registerStatusUpdateRoutes } from "./status-updates/routes.ts";
import { registerWallBoardRoutes } from "./wall-board/routes.ts";
import {
  registerVersionRoutes,
  type VersionCheckOptions,
} from "./version/routes.ts";
import { registerGitHubConnectionRoutes } from "./github-connections/routes.ts";
import { createDeliveryLimiter } from "./webhooks/delivery-limiter.ts";
import { registerWebhookRoutes } from "./webhooks/routes.ts";
import {
  contentSecurityPolicy,
  inlineScriptHashes,
  securityHeaders,
} from "./security-headers.ts";

export interface AppOptions {
  readonly logger: FastifyBaseLogger;
  /** Whether the database answers; `/health` reports it. */
  readonly checkDatabase: () => Promise<boolean>;
  /** The built web app. Missing until it has been built. */
  readonly webDistDir: string;
  /**
   * The address AI Office is reached at (PUBLIC_URL), for the absolute URLs
   * link previews and search engines need. Without one, each request's own.
   */
  readonly publicUrl?: string;
  /** How long `/health` waits for the database. */
  readonly healthTimeoutMs?: number;
  /** The Owner's password and sessions: where they live, and how. */
  readonly auth: SessionOptions & {
    /** Seals the TOTP secret at rest (ENCRYPTION_KEY). */
    readonly encryptor: Encryptor;
    /** Overrides the sign-in rate limits (5 failures, then 1 min, doubling). */
    readonly loginLimits?: Partial<LoginLimitOptions>;
  };
  /**
   * Which proxies to believe about the client's address (`X-Forwarded-For`):
   * a hop count, or a list of addresses and CIDR ranges.
   * Sign-in rate limits are per client address, so behind a reverse proxy
   * this must be set; otherwise every client looks like the proxy. It is
   * believed only for a request that carries `proxySecret` (A1-1).
   */
  readonly trustProxy?: number | readonly string[];
  /**
   * What the proxy in front of AI Office sends in `x-ai-office-proxy`
   * (PROXY_SECRET). Without it, no request's X-Forwarded-* is believed.
   */
  readonly proxySecret?: string;
  /**
   * The one-time setup token the server wrote to a file as it started with
   * no password (A1-2). Without one, only a request from this machine's
   * loopback may set the first password.
   */
  readonly setupToken?: SetupToken;
  /**
   * The AI Gateway, served on the app's own port too, at `/v1` and below
   * (one entry point): `ANTHROPIC_BASE_URL` is the app's address, and an
   * OpenAI client's base URL that with `/v1`. Its requests go straight to
   * it, never through the app's hooks; the Gateway authenticates them by
   * Gateway Key alone. Without one (in tests), `/v1` is the app's.
   */
  readonly gateway?: FastifyInstance;
  /**
   * The event bus the live stream (`GET /api/events/stream`) serves.
   * The server passes one backed by the `events` table; without one (in
   * tests) the log is kept in memory.
   */
  readonly events?: EventBus;
  /** How often the live stream sends a heartbeat; 15 seconds by default. */
  readonly heartbeatMs?: number;
  /** GitHub, through the GitHub Apps and access tokens the Owner added. */
  readonly github?: GitHubApp;
  /**
   * The GitHub Apps and access tokens themselves (ADR 0011), kept to the
   * server's live GitHub. Made from `stores` when not given (in tests),
   * with no GitHub to keep up to date.
   */
  readonly githubConnections?: GitHubConnections;
  /**
   * Where office settings, Floors, Agents and Notices live. The server
   * passes their tables; without them (in tests) they are kept in memory.
   */
  readonly stores?: OfficeStores;
  /**
   * The Notices, with the action handlers their sources registered. Made
   * from `stores` and `events` when not given.
   */
  readonly notices?: Notices;
  /**
   * Each Floor's AI Office branches, for the Branches page. Made from
   * `stores`, the work queue, `github` and `events` when not given.
   */
  readonly branches?: Branches;
  /**
   * The AI Gateway's AI Accounts. The server passes the ones the Gateway
   * serves from, kept in `ai_accounts`; without them (in tests) they are
   * kept in memory, sealed with `auth.encryptor`.
   */
  readonly aiAccounts?: AiAccounts;
  /**
   * Serves subscription sign-ins' local callbacks, such as ChatGPT's
   * `localhost:1455`, while they wait. The server passes its own; without
   * it (in tests) the Owner always pastes the address back.
   */
  readonly oauthCallbacks?: OAuthCallbacks;
  /**
   * The AI Gateway's Gateway Keys. The server passes the ones the Gateway
   * checks, kept in `gateway_keys`; without them (in tests) they are kept
   * in memory, Agents' sealed with `auth.encryptor`. Each new Agent gets
   * one, and every Agent without one gets one when the app is ready.
   */
  readonly gatewayKeys?: GatewayKeys;
  /**
   * The Gateway's Model prices. The server passes the ones the Gateway
   * estimates costs with; without them (in tests) overrides are kept in
   * memory, over the pricing table.
   */
  readonly pricing?: Pricing;
  /**
   * The Gateway's Combos (FR-40). The server passes the ones its AI
   * Accounts waterfall through, kept in `gateway_combos`; without them (in
   * tests) they are kept in memory, their slots naming `aiAccounts`.
   */
  readonly combos?: Combos;
  /**
   * The Gateway's model mappings and aliases (FR-41). The server passes the
   * ones its AI Accounts apply, kept in `gateway_model_mappings`; without
   * them (in tests) they are kept in memory, and applied by the AI
   * Accounts kept in memory.
   */
  readonly modelMappings?: ModelMappings;
  /**
   * The Gateway's request history. The server passes the one the Gateway
   * records into; without it (in tests) it is kept in memory.
   */
  readonly requestHistory?: RequestHistory;
  /** The Gateway's log lines, for the live log stream. */
  readonly gatewayLogs?: LogHub;
  /**
   * The Gateway's model catalogue. The server passes the one kept in
   * `model_catalogue`; without it (in tests) it is kept in memory, fetched
   * through `aiAccounts`.
   */
  readonly modelCatalogue?: ModelCatalogue;
  /**
   * The AI Providers' default Models. The server passes its own; without
   * them they are kept in `stores`, chosen from `modelCatalogue`.
   */
  readonly aiProviders?: AiProviders;
  /**
   * The office Skill library. Made from `stores` and `events` when not
   * given, importing from public Git repositories over HTTPS.
   */
  readonly skills?: SkillLibrary;
  /**
   * The office Role library's admin (FR-98). Made from `stores`, `events`
   * and the model catalogue when not given.
   */
  readonly roles?: RoleLibrary;
  /**
   * The Floor Templates a Floor is added from (FR-97). The built-in ones,
   * loaded from `templates/`, when not given.
   */
  readonly templates?: readonly FloorTemplate[];
  /**
   * Makes Agents' model calls outside sandboxes, through the AI Gateway.
   * The server passes its own Gateway's; without it, every call fails.
   */
  readonly models?: ModelClient;
  /** Removes credentials from what the Manager chat keeps and sends. */
  readonly redactor?: Redactor;
  /**
   * Each Floor's Manager chat (FR-24). Made from `stores` and `models` when
   * not given.
   */
  readonly managerChat?: ManagerChat;
  /**
   * Each Floor's Status updates (FR-23a): the server's own, which its
   * hourly ones share, so the latest given is the same for both. Made from
   * `stores` and the Manager chat when not given.
   */
  readonly statusUpdates?: StatusUpdates;
  /**
   * The repository's files the Manager chat's `@` mentions offer (FR-24),
   * through the GitHub App; none without it.
   */
  readonly chatFiles?: Pick<ChatRepositoryFiles, "search">;
  /** The Manager chat's live task list (FR-24); empty without it. */
  readonly chatTasks?: Pick<ChatTasks, "list">;
  /**
   * Makes the Terminal's model calls, with its own key. The server passes
   * its own Gateway's; without it, every call fails.
   */
  readonly terminalModels?: ModelClient;
  /**
   * Direct chats with each Agent and the Terminal. Made from `stores`,
   * `models` and `terminalModels` when not given.
   */
  readonly directChats?: DirectChats;
  /**
   * Edits and approves Batches' Plans on the whiteboard (FR-25.3). Batches
   * need the GitHub App; without it, those routes answer 503.
   */
  readonly plans?: Pick<Batches, "edit" | "approve">;
  /**
   * The office-wide and Role memory (FR-54, FR-55). Made from `stores` and
   * `redactor` when not given.
   */
  readonly sharedMemory?: SharedMemory;
  /**
   * Where the work queue lives, which Floors' wall boards read, and which
   * says which Agents are in the middle of a task. The server passes the
   * `work_queue` table; without it (in tests) it is in memory.
   */
  readonly workQueue?: WorkQueueStore;
  /**
   * The Floors' Agents and their teams (FR-10). The server passes its own,
   * whose leaving Agents go as the work queue's work ends; without them
   * they are made from `stores`, `workQueue` and the AI Providers.
   */
  readonly agents?: Agents;
  /**
   * The Agents as the flows read them, one on any AI Provider given one
   * for its task or session (FR-11). The server passes its own, which its
   * flows share; without it, one is made from `stores` and `workQueue`.
   */
  readonly workingAgents?: WorkingAgentStore;
  /**
   * Whether an Agent is paused at a Token Cap, which wall boards show. The
   * server passes its cap enforcement's; without it none is.
   */
  readonly capPaused?: (agentId: string) => boolean;
  /**
   * The Floors where the Owner stopped everything. The server passes its
   * own, which interrupt its work queue's work; without them (in tests)
   * they are kept in `stores` and interrupt nothing.
   */
  readonly floorStops?: FloorStops;
  /**
   * What a GitHub webhook delivery starts (FR-8): intake, the Batches'
   * check and the Merge Policy's wait for CI. The server passes its own,
   * once the GitHub App is configured; without them a delivery is checked
   * and starts nothing.
   */
  readonly webhookTargets?: WebhookTargets;
  /**
   * The Communications Agent and its Connections (FR-90, FR-93). The
   * server passes its own, kept in their tables and started; without it
   * (in tests) they are kept in memory, sealed with `auth.encryptor`.
   */
  readonly communications?: Communications;
  /**
   * Google sign-in for the Google Connections (FR-91). The server passes
   * its own, kept beside the Connections; without it (in tests) one is
   * kept in memory with the Connections made here.
   */
  readonly google?: GoogleAuth;
  /**
   * Each Agent's Context Usage (FR-84). The server passes its own, told of
   * every model call its Gateway records; without it one is made, told of
   * `requestHistory`'s.
   */
  readonly contextUsage?: ContextUsage;
  /**
   * Fresh Starts (FR-86, FR-87), for the "Fresh start" action. The server
   * passes the ones its sandbox runner uses; without them, no session can
   * be ended.
   */
  readonly freshStarts?: Pick<FreshStarts, "request">;
  /**
   * How the version check asks GitHub for the latest version. Tests pass
   * a fake `fetch`; the server, nothing.
   */
  readonly versionCheck?: VersionCheckOptions;
}

/** Model calls when there is no AI Gateway to make them through. */
const noModels: ModelClient = {
  complete: () =>
    Promise.reject(new ModelCallError(0, "There is no AI Gateway to call.")),
  stream: () =>
    Promise.reject(new ModelCallError(0, "There is no AI Gateway to call.")),
};

const isUp = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, false);
  });
  try {
    return await Promise.race([check().catch(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Trusts the nearest `hops` proxies (what Fastify does for a number). */
const trustHops =
  (hops: number) =>
  (_address: string, hop: number): boolean =>
    hop < hops;

/**
 * The protocol the proxy says a request came over, as Fastify reads it for
 * `request.protocol`: the last X-Forwarded-Proto. Only a proven proxy's is
 * still there (A1-1).
 */
const forwardedProto = (request: IncomingMessage): string | undefined => {
  const value = request.headers["x-forwarded-proto"];
  return (Array.isArray(value) ? value.join(",") : value)
    ?.split(",")
    .at(-1)
    ?.trim();
};

/** The HTTP server, without listening. Routes are added here as they arrive. */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const believeProxy = believeOnlyTheProxy(options.proxySecret);
  const servedOverHttps = options.publicUrl?.startsWith("https:") === true;
  // Which proxies say who the client is: Fastify's, for `request.ip`, and
  // the same for a `/v1` request, which never reaches Fastify's.
  const trust =
    options.trustProxy === undefined
      ? undefined
      : typeof options.trustProxy === "number"
        ? trustHops(options.trustProxy)
        : proxyAddr.compile([...options.trustProxy]);
  /** A request's client address, as `request.ip` would give it. */
  const clientAddress = (request: IncomingMessage): string =>
    trust === undefined
      ? (request.socket.remoteAddress ?? "")
      : proxyAddr(request, trust);
  const app = Fastify({
    loggerInstance: options.logger,
    // Runs on every request before anything reads it, the request's own log
    // line included: a request that is not from the proxy loses its
    // X-Forwarded-* headers here. The URL itself is left as it is.
    rewriteUrl: (request) => {
      believeProxy(request);
      return request.url ?? "/";
    },
    ...(options.gateway === undefined
      ? {}
      : {
          // The Gateway's `/v1` requests never reach `rewriteUrl` or the
          // hooks below, so they are given the same things first: the
          // proxy's proof is taken off (A1-1), never reaching the Gateway's
          // request history or an AI Provider; the answer carries the
          // security headers (A1-6); and the Gateway Key a client presents
          // is limited and recorded, as a sign-in is (I2-3).
          serverFactory: gatewayEntry(options.gateway, (request, response) => {
            believeProxy(request);
            limitKeyCheck(request, () =>
              keyGuesses.check(
                clientAddress(request),
                request.headers["user-agent"],
              ),
            );
            const headers = securityHeaders({
              https:
                servedOverHttps ||
                (options.trustProxy !== undefined &&
                  forwardedProto(request) === "https"),
            });
            for (const [name, value] of Object.entries(headers)) {
              response.setHeader(name, value);
            }
          }),
        }),
    ...(trust === undefined ? {} : { trustProxy: trust }),
  });
  // Every answer carries the security headers (A1-6), set first so that
  // refusals, live streams (which write their own head) and errors have
  // them too. A route's own header of the same name replaces one.
  app.addHook("onRequest", (request, reply, done) => {
    const headers = securityHeaders({
      https: servedOverHttps || request.protocol === "https",
    });
    for (const [name, value] of Object.entries(headers)) {
      reply.raw.setHeader(name, value);
    }
    done();
  });
  const now = options.auth.now ?? (() => new Date());
  // The API keys that may use the web app: the Gateway Keys, made below.
  const uiKeys: { keys?: GatewayKeys } = {};
  const sessions = createSessions({
    ...options.auth,
    keyAllowsUi: async (id) => (await uiKeys.keys?.allowsUi(id)) ?? false,
  });
  const events =
    options.events ?? createEventBus({ store: memoryEventStore() });
  // One limit for every check of the Owner's credentials: sign-ins, and
  // the fresh proof a change that adds a way to sign in needs (A1-3, A1-4).
  const loginLimits = { ...defaultLoginLimits, ...options.auth.loginLimits };
  const loginLimiter = createLoginLimiter({ ...loginLimits, now });
  // Gateway Keys presented at /v1: the same limits, apart (I2-3).
  const keyGuesses = createKeyGuesses({
    events,
    logger: app.log,
    now,
    limits: loginLimits,
  });
  // A lockout outlives a restart (A1-7): the limiter starts from the
  // attempts `sign_in_events` kept for as long as it remembers a client.
  // Without the database AI Office still starts (and `/health` says so);
  // no one signs in until it answers, as every password is in it.
  await restoreLimiter(
    loginLimiter,
    options.auth.store,
    new Date(now().getTime() - loginLimits.forgetAfterMs),
  ).catch((error: unknown) => {
    app.log.warn(
      { err: error },
      "The sign-in limiter could not read sign_in_events: lockouts from before this start are forgotten.",
    );
  });
  const proveOwner = createOwnerProof({
    store: options.auth.store,
    encryptor: options.auth.encryptor,
    loginLimiter,
    events,
    now,
  });
  const access = registerAccess(app, {
    store: options.auth.store,
    sessions,
    challenges: createSignInChallenges({
      secureCookie: options.auth.secureCookie,
      now,
    }),
    encryptor: options.auth.encryptor,
    loginLimiter,
    now,
    events,
    uiKeys: {
      uiKey: async (key) => uiKeys.keys?.uiKey(key),
      signInKeys: async () =>
        ((await uiKeys.keys?.list()) ?? [])
          .filter(
            (key) =>
              key.kind === "owner_tool" &&
              key.revokedAt === null &&
              key.access === "proxy_and_ui" &&
              key.enabled !== false,
          )
          .map(({ id, name }) => ({ id, name })),
    },
    publicUrl: options.publicUrl,
    setupToken: options.setupToken,
    proveOwner,
  });

  registerEventStream(app, {
    bus: events,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    signedIn: async (request) =>
      (await sessions.authenticate(request)) !== undefined,
  });
  registerEventHistory(app, { bus: events });
  const stores = options.stores ?? memoryStores();
  const modelMappings =
    options.modelMappings ??
    createModelMappings({ store: memoryModelMappingStore(), events, now });
  const aiAccounts =
    options.aiAccounts ??
    createAiAccounts({
      store: memoryAiAccountStore(),
      encryptor: options.auth.encryptor,
      events,
      now,
      modelMappings,
    });
  const modelCatalogue =
    options.modelCatalogue ??
    createModelCatalogue({
      store: memoryModelCatalogueStore(),
      sources: () => aiAccounts.catalogueSources(),
      now,
    });
  // The Models an AI Provider's default, or an Agent's own, is chosen from.
  const catalogue = catalogueOf(modelCatalogue);
  const aiProviders =
    options.aiProviders ??
    createAiProviders({
      store: stores.aiProviders,
      events,
      catalogue,
      now,
    });
  const defaultModels = () => aiProviders.defaultModels();
  // The Agents as the flows read them when a task starts: one on any AI
  // Provider (FR-11) is given the first available that has a default Model.
  const work = options.workQueue ?? memoryWorkQueueStore(stores.floors);
  const workingAgents =
    options.workingAgents ??
    workingAgentStore({
      store: stores.agents,
      availability: async () => ({
        defaults: await defaultModels(),
        accounts: await aiAccounts.list(),
      }),
      work,
      floors: stores.floors,
      events,
    });
  // A new Agent starts on its Role's suggested AI Provider only when the
  // Owner has an AI Account for it (FR-98).
  const aiAccountProviders = async () =>
    new Set((await aiAccounts.list()).map(({ aiProvider }) => aiProvider));
  // A broken template stops AI Office starting, naming the file at fault.
  const templates = options.templates ?? (await loadFloorTemplates());
  // The built-in Floor Templates and the Owner's own (FR-101): a Floor is
  // added from any but those waiting for review.
  const floorTemplates = createFloorTemplateLibrary({
    builtIn: templates,
    store: stores.floorTemplates,
    roles: stores.roles,
    skills: stores.skills,
    floors: stores.floors,
    agents: stores.agents,
    events,
    repository: gitTemplateRepository({ scratchDir: tmpdir() }),
    now,
  });
  registerFloorTemplateRoutes(app, {
    templates: floorTemplates,
    roles: () => stores.roles.list(),
  });
  registerFloorRoutes(app, {
    stops:
      options.floorStops ??
      createFloorStops({
        store: stores.floorStops,
        events,
        work,
        queue: () => ({
          interrupt: () => Promise.resolve(false),
          wake: () => undefined,
        }),
      }),
    floors: createFloors({
      store: stores.floors,
      github: options.github,
      events,
      agents: stores.agents,
      defaultModels,
      roles: stores.roles,
      skills: stores.skills,
      templates: () => floorTemplates.enabled(),
      aiAccountProviders,
      now,
    }),
  });
  const officeSettings = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events,
    // The outbound proxy's password is sealed, and redacted once opened.
    encryptor: options.auth.encryptor,
    ...(options.redactor === undefined
      ? {}
      : { onSecret: (secret: string) => options.redactor?.register(secret) }),
    now,
  });
  registerOfficeRoutes(app, { settings: officeSettings });
  // The Owner's passwords, the first's settings being the Owner's profile.
  registerOwnerPasswordRoutes(app, {
    store: options.auth.store,
    settings: officeSettings,
    now,
    proveOwner,
    events,
    sessions,
  });
  registerStorageRoutes(app, { storage: stores.storage, now });
  registerGitHubConnectionRoutes(app, {
    connections:
      options.githubConnections ??
      createGitHubConnections({
        store: stores.githubConnections,
        encryptor: options.auth.encryptor,
        now,
      }),
  });
  // The GitHub App's webhooks (FR-8), their secret sealed at rest.
  await registerWebhookRoutes(app, {
    webhooks: createGitHubWebhooks({
      store: stores.office,
      floors: stores.floors,
      encryptor: options.auth.encryptor,
      events,
      ...(options.webhookTargets === undefined
        ? {}
        : { targets: options.webhookTargets }),
      ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
      now,
    }),
    limiter: createDeliveryLimiter({ now }),
  });
  const notices =
    options.notices ?? createNotices({ store: stores.notices, events, now });
  registerNoticeRoutes(app, { notices });
  // The Communications Agent and its Connections (FR-90 to FR-94), and the
  // Google sign-in the Google Connections publish through (FR-91).
  const communicationsStore = memoryCommunicationsStore();
  const google =
    options.google ??
    createGoogleAuth({
      store: communicationsStore,
      events,
      encryptor: options.auth.encryptor,
      publicUrl: options.publicUrl ?? "http://localhost:3046",
      ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
      now,
    });
  registerGoogleRoutes(app, { google });
  registerConnectionRoutes(app, {
    communications:
      options.communications ??
      createCommunications({
        store: communicationsStore,
        events,
        encryptor: options.auth.encryptor,
        transports: defaultTransports({ google }),
        google,
        publicUrl: options.publicUrl ?? "http://localhost:3046",
        floorName: async (floorId) => (await stores.floors.get(floorId))?.name,
        notice: (noticeId) => notices.get(noticeId).catch(() => undefined),
        raiseNotice: (notice) => notices.raise(notice),
        defaultModels: () => aiProviders.defaultModels(),
        ...(options.redactor === undefined
          ? {}
          : { redactor: options.redactor }),
        now,
      }),
  });
  const requestHistory =
    options.requestHistory ??
    createRequestHistory({
      store: memoryRequestHistoryStore(),
      encryptor: options.auth.encryptor,
    });
  registerAiAccountRoutes(app, {
    accounts: aiAccounts,
    now,
    accountTokensSince: (since) => requestHistory.accountUsageSince(since),
    ...(options.oauthCallbacks === undefined
      ? {}
      : { callbacks: options.oauthCallbacks }),
  });
  registerComboRoutes(app, {
    combos:
      options.combos ??
      createCombos({
        store: memoryComboStore(),
        accounts: aiAccounts,
        events,
        now,
      }),
  });
  registerModelMappingRoutes(app, { mappings: modelMappings });
  registerAiProviderRoutes(app, {
    aiProviders,
    catalogue: modelCatalogue,
    withAccounts: async () =>
      (await aiAccounts.list()).map(({ aiProvider }) => aiProvider),
  });
  const agents =
    options.agents ??
    createAgents({
      store: stores.agents,
      floors: stores.floors,
      events,
      defaultModels,
      catalogue,
      roles: stores.roles,
      aiAccountProviders,
      work,
      now,
    });
  registerSkillRoutes(app, {
    skills:
      options.skills ??
      createSkillLibrary({
        store: stores.skills,
        events,
        repository: gitSkillRepository({ scratchDir: tmpdir() }),
        now,
      }),
  });
  // The office Role library (FR-98): editing a Role reaches every Agent
  // with it, and one no Agent fills can be deleted.
  registerRoleRoutes(app, {
    roles:
      options.roles ??
      createRoleLibrary({
        store: stores.roles,
        agents: stores.agents,
        skills: stores.skills,
        catalogue,
        events,
        templates,
        now,
      }),
  });
  // Each Floor's Skills, its repository's read through the GitHub App.
  const floorSkills = createFloorSkills({
    floors: stores.floors,
    library: stores.skills,
    toggles: stores.floorSkills,
    reviews: stores.repositorySkillReviews,
    roles: stores.roles,
    events,
    ...(options.github === undefined ? {} : { github: options.github }),
    now,
  });
  registerFloorSkillRoutes(app, { floorSkills });
  registerAgentRoutes(app, {
    agents,
    defaultModels,
    oneOffRoles: (floorId) => stores.roles.oneOffs(floorId),
  });
  // The office-wide memory, each Floor's Role memory (FR-54, FR-55), and
  // its repository memory for the bookshelf (FR-53, FR-58), read through
  // the GitHub App.
  registerMemoryRoutes(app, {
    memory:
      options.sharedMemory ??
      createSharedMemory({
        store: stores.officeMemory,
        floors: stores.floors,
        events,
        ...(options.redactor === undefined
          ? {}
          : { redactor: options.redactor }),
        now,
      }),
    repositoryMemory: createRepositoryMemoryShelf({
      floors: stores.floors,
      store: stores.memory,
      ...(options.github === undefined ? {} : { github: options.github }),
      ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
    }),
  });
  // Each Agent's Context Usage (FR-84, FR-85), from its model calls.
  let contextUsage = options.contextUsage;
  if (contextUsage === undefined) {
    contextUsage = createContextUsage({
      events,
      agents: workingAgents,
      defaultModels,
      contextWindow: contextWindowOf(modelCatalogue),
      now,
    });
    const report = (error: unknown) => {
      app.log.warn({ err: error }, "Context Usage could not be measured.");
    };
    observeModelCalls(requestHistory, contextUsage, report);
    followSandboxSessions(events, contextUsage);
  }
  // Each Floor's Manager chat (FR-24): commands in plain code, anything
  // else to the Manager's Model through the AI Gateway.
  const managerChat =
    options.managerChat ??
    createManagerChat({
      store: stores.managerChat,
      floors: stores.floors,
      agents: workingAgents,
      // Each change to a session is published, for the Office (FR-83).
      grilling: publishingGrillingStore(stores.grilling, {
        events,
        agents: workingAgents,
        onError: (error) => {
          app.log.warn(
            { err: error },
            "A Grilling Session changed, but its event could not be published.",
          );
        },
      }),
      contextUsage,
      models: options.models ?? noModels,
      defaultModels,
      skills: floorChatSkills(floorSkills),
      // The files and images the Owner attaches (FR-24).
      attachments: stores.chatAttachments,
      ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
      now,
      onError: (error) => {
        app.log.error({ err: error }, "The Manager chat failed.");
      },
    });
  // Each Floor's Status update (FR-23a), said in its Manager chat, in the
  // Owner's days.
  registerStatusUpdateRoutes(app, {
    statusUpdates:
      options.statusUpdates ??
      createStatusUpdates({
        floors: stores.floors,
        agents: workingAgents,
        work,
        batches: stores.batches,
        events,
        store: stores.statusUpdates,
        chat: managerChat,
        timeZone: async () => (await officeSettings.ownerProfile()).timeZone,
        now,
      }),
  });
  registerManagerChatRoutes(app, {
    chat: managerChat,
    heartbeatMs: options.heartbeatMs ?? 15_000,
    signedIn: async (request) =>
      (await sessions.authenticate(request)) !== undefined,
    // Attachments, `@` mentions and the live task list (FR-24).
    attachments: stores.chatAttachments,
    ...(options.chatFiles === undefined ? {} : { files: options.chatFiles }),
    ...(options.chatTasks === undefined ? {} : { tasks: options.chatTasks }),
    now,
  });
  // Each Floor's Batches and the versions of their Plans (FR-25).
  registerBatchRoutes(app, {
    batches: stores.batches,
    floors: stores.floors,
    plans: options.plans,
  });
  const gatewayKeys =
    options.gatewayKeys ??
    createGatewayKeys({
      store: memoryGatewayKeyStore(),
      encryptor: options.auth.encryptor,
      events,
      now,
    });
  uiKeys.keys = gatewayKeys;
  // Direct chats: the Owner talks one to one with any Agent (its own Model
  // and Gateway Key), or with the AI itself in the Terminal.
  registerDirectChatRoutes(app, {
    chats:
      options.directChats ??
      createDirectChats({
        store: stores.directChats,
        floors: stores.floors,
        agents: workingAgents,
        roles: stores.roles,
        models: options.models ?? noModels,
        terminalModels: options.terminalModels ?? noModels,
        defaultModels,
        ...(options.redactor === undefined
          ? {}
          : { redactor: options.redactor }),
        now,
        onError: (error) => {
          app.log.error({ err: error }, "A direct chat failed.");
        },
      }),
    usage: directChatUsageOf({
      history: requestHistory,
      contextWindow: contextWindowOf(modelCatalogue),
    }),
    heartbeatMs: options.heartbeatMs ?? 15_000,
    signedIn: async (request) =>
      (await sessions.authenticate(request)) !== undefined,
  });
  registerGatewayKeyRoutes(app, {
    keys: gatewayKeys,
    agents,
    usage: () => requestHistory.keyUsage(),
    proveOwner,
  });
  registerContextUsageRoutes(app, {
    agents,
    contextUsage,
    freshStarts: options.freshStarts,
  });
  registerGatewayRequestRoutes(app, {
    history: requestHistory,
    logs: options.gatewayLogs ?? createLogHub(),
    heartbeatMs: options.heartbeatMs ?? 15_000,
    signedIn: async (request) =>
      (await sessions.authenticate(request)) !== undefined,
  });
  // The Gateway's analytics (FR-43), from the request history.
  registerAnalyticsRoutes(app, {
    history: requestHistory,
    accounts: aiAccounts,
    floors: stores.floors,
    agents: stores.agents,
    now,
  });
  // Token accounting and caps (FR-31, FR-32), from the request history.
  registerTokenCapRoutes(app, {
    caps: createTokenCaps({
      store: stores.tokenCaps,
      floors: stores.floors,
      agents: stores.agents,
      events,
      usage: (from, to) => requestHistory.tokenUsage(from, to),
      now,
    }),
  });
  // Each Floor's wall board (FR-50, FR-57): its issues in progress and its
  // queues, from the work queue, the Review Loop and the events, and what
  // the Office shows of each Agent (FR-62).
  registerWallBoardRoutes(app, {
    wallBoard: createWallBoard({
      floors: stores.floors,
      agents: stores.agents,
      work,
      reviews: stores.reviews,
      events,
      ...(options.capPaused === undefined
        ? {}
        : { capPaused: options.capPaused }),
    }),
  });
  // Each Floor's AI Office branches, as lanes off its default branch: read
  // from GitHub at most once a minute, or after its repository changes.
  registerBranchRoutes(app, {
    branches:
      options.branches ??
      createBranches({
        floors: stores.floors,
        agents: stores.agents,
        roles: stores.roles,
        work,
        grilling: stores.grilling,
        batches: stores.batches,
        github: options.github,
        events,
        now,
      }),
  });
  const pricing =
    options.pricing ??
    createPricing({ store: memoryModelPriceStore(), events, now });
  registerPricingRoutes(app, { pricing });
  registerVersionRoutes(app, options.versionCheck);
  // Configuration export and import (FR-65), without a credential.
  registerConfigurationRoutes(app, {
    configuration: createConfiguration({
      stores,
      events,
      builtInTemplates: templates,
      modelPrices: {
        list: () =>
          Promise.resolve(
            pricing
              .list()
              .filter(({ source }) => source === "override")
              .map(({ model, price }) => ({ model, price })),
          ),
        set: async (model, price) => {
          await pricing.setOverride(model, price);
        },
      },
      ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
      now,
    }),
  });
  const { gateway } = options;
  if (gateway !== undefined) {
    // Its routes must be in place before the first request reaches them.
    app.addHook("onReady", async () => {
      await gateway.ready();
    });
  }
  const agentKeys = keepAgentKeys({ events, keys: gatewayKeys, stores });
  app.addHook("onReady", async () => {
    try {
      await agentKeys.catchUp();
    } catch (error) {
      app.log.error(
        { err: error },
        "Agents without a Gateway Key could not be given one.",
      );
    }
  });
  app.addHook("onClose", (_instance, done) => {
    agentKeys.stop();
    if (options.workingAgents === undefined) {
      workingAgents.stop();
    }
    done();
  });

  // Public: compose health checks call it, before setup and without a session.
  app.get(
    "/health",
    { config: { access: "public" } },
    async (_request, reply) => {
      const databaseUp = await isUp(
        options.checkDatabase,
        options.healthTimeoutMs ?? 2000,
      );
      const body: HealthResponse = databaseUp
        ? { status: "ok", database: "up" }
        : { status: "unavailable", database: "down" };
      return reply.code(databaseUp ? 200 : 503).send(body);
    },
  );

  const originFor = (request: FastifyRequest): string =>
    options.publicUrl === undefined
      ? `${request.protocol}://${request.host}`
      : originOf(options.publicUrl);

  // Public: crawlers read them without a session.
  app.get(
    "/robots.txt",
    { config: { access: "public" } },
    async (request, reply) =>
      reply
        .type("text/plain; charset=utf-8")
        .send(robotsTxt(originFor(request))),
  );
  app.get(
    "/sitemap.xml",
    { config: { access: "public" } },
    async (request, reply) =>
      reply
        .type("application/xml; charset=utf-8")
        .send(sitemapXml(originFor(request))),
  );

  const indexHtml = join(options.webDistDir, "index.html");
  const serveWeb = existsSync(indexHtml);
  if (serveWeb) {
    // The built files are public: the setup and login pages need them, and
    // they hold no data. Pages themselves are served by the not-found
    // handler below, which decides who may see each one.
    await app.register(async (files) => {
      files.addHook("onRoute", (route) => {
        route.config = { ...route.config, access: "public" };
      });
      await files.register(fastifyStatic, {
        root: options.webDistDir,
        wildcard: false,
        index: false,
      });
    });
  } else {
    app.log.warn(
      { webDistDir: options.webDistDir },
      "The web app is not built, so only the API is served.",
    );
  }

  // The web app routes in the browser, so any other page GET gets its
  // index.html, once access allows it. Unknown API paths are answered as a
  // guarded route would be; anything that looks like a file gets a 404.
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "/";
    if (path === "/api" || path.startsWith("/api/")) {
      return access.apiNotFound(request, reply);
    }
    const isPage =
      (request.method === "GET" || request.method === "HEAD") &&
      !/\.[^/]+$/.test(path);
    if (!isPage) {
      return reply.code(404).send(notFoundBody);
    }
    const decision = await access.page(path, request);
    if ("redirect" in decision) {
      return reply.redirect(decision.redirect);
    }
    if (serveWeb && decision.serve) {
      // Read on each request, so a rebuild is picked up. (The static files
      // plugin's `sendFile` belongs to the scope it was registered in.)
      const html = renderIndexHtml(await readFile(indexHtml, "utf8"), {
        origin: originFor(request),
        path,
      });
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .header(
          "content-security-policy",
          contentSecurityPolicy(inlineScriptHashes(html)),
        )
        .send(html);
    }
    return reply.code(404).send(notFoundBody);
  });

  return app;
}
