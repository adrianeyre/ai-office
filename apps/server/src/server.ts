import { join } from "node:path";

import {
  createCommunications,
  createGoogleAuth,
  databaseCommunicationsStore,
  defaultTransports,
  gatewayDigestWriter,
  gatewayReportWriter,
} from "@ai-office/communications";
import { connect, ping } from "@ai-office/db";
import {
  createEventBus,
  databaseEventStore,
  type EventBus,
} from "@ai-office/events";
import { createLiveGitHub } from "@ai-office/github";
import {
  agentName,
  approvedIssues,
  createAiProviders,
  createBatchBranches,
  createBatches,
  communicationsCapRefusal,
  ownerToolCapRefusal,
  createCapEnforcement,
  createFloorStops,
  createGitHubConnections,
  createCoderFlow,
  createDecisionModel,
  createDesignFlow,
  createDocsFlow,
  createIntake,
  withApprovedIssues,
  createManagerChat,
  createManagerChatSessions,
  dockerSessionTool,
  createChatReports,
  createChatRepositoryFiles,
  createChatRequests,
  createChatTasks,
  createContractorDepartures,
  makeWorkDir,
  managerChatIssues,
  modelRequestBindingCheck,
  publishingGrillingStore,
  createMemoryCuration,
  createMergeFlow,
  createNotices,
  createOfficeSettings,
  createPipeline,
  createNoAccountLeftNotices,
  createProgressComments,
  createReauthenticationNotices,
  createQaFlow,
  createRetention,
  createRepositoryMemory,
  createRoleMemoryReview,
  createSharedMemory,
  createReviewFlow,
  renameRetiredLabels,
  createFloorSkills,
  floorChatSkills,
  createSandboxFactFinder,
  createGrillingDocuments,
  createGrillingIssues,
  createSandboxRunner,
  createToolCallScreens,
  createStatusReports,
  createStatusUpdates,
  createHourlyStatusUpdates,
  createTokenCaps,
  createTriage,
  createWorkTurns,
  createUsageTally,
  createWatchdog,
  createWorkQueue,
  createAgents,
  workingAgentStore,
  createContextUsage,
  createFreshStarts,
  databaseStores,
  databaseWorkQueueStore,
  dockerSandbox,
  executeByStage,
  followSandboxSessions,
  gatewayDecisionModelClient,
  gatewayModelClient,
  agentToolModelClient,
  dockerToolRunner,
  withAgentToolFallback,
  ModelCallError,
  type ModelClient,
  toolCallCheck,
  toolCallRules,
  type ExecuteWork,
  type Intake,
  type Notices,
  type SandboxRunner,
} from "@ai-office/orchestrator";
import {
  allowInternalHosts,
  createRedactor,
  defaultAutoRefreshSettings,
  defaultComboSettings,
  defaultGatewayRetrySettings,
  defaultLoadBalancingSettings,
  defaultDecisionModelSettings,
  defaultPromptCacheKeepAliveSettings,
  defaultPromptCacheSettings,
  defaultUsageThrottlingSettings,
  designerRole,
  leastUsedWindowMs,
  type OutboundProxy,
  type PromptCacheTtl,
} from "@ai-office/shared";
import { pino } from "pino";
import { createEncryptor } from "@ai-office/shared/crypto";
import {
  buildGateway,
  createAgentWork,
  createAiAccounts,
  createCombos,
  createPromptCacheKeepAlive,
  createUpstreamFetch,
  keepAliveRoundMs,
  createModelMappings,
  createLoadBalancer,
  createUsageTracker,
  createGatewayKeys,
  createModelCatalogue,
  createPricing,
  createRequestHistory,
  databaseAiAccountStore,
  databaseComboStore,
  databaseModelMappingStore,
  databaseGatewayKeyStore,
  databaseModelCatalogueStore,
  databaseModelPriceStore,
  databaseRequestHistoryStore,
  limitOf,
  publishedPricesFor,
  directoryFixtureRecorder,
  requestTokens,
  type RequestHistory,
} from "@ai-office/gateway";
import type { FastifyInstance } from "fastify";

import { catalogueOf } from "./ai-providers/routes.ts";
import { contextWindowOf, observeModelCalls } from "./context-usage/routes.ts";
import { createOAuthCallbacks } from "./ai-accounts/oauth-callback.ts";
import { buildApp } from "./app.ts";
import { writeSetupToken } from "./auth/setup-token.ts";
import { databaseAuthStore } from "./auth/store.ts";
import {
  developmentSecretsInUse,
  loadConfig,
  retiredGitHubVariables,
  secretValues,
} from "./config.ts";
import {
  batchReportOf,
  completedIssueOf,
  issueTitleOf,
} from "./connections/publishing.ts";
import { keysAtWork } from "./gateway-keys/agent-keys.ts";
import { createLogHub } from "./gateway-requests/log-hub.ts";
import { createLogger } from "./logger.ts";
import { resealWithCurrentKey } from "./reseal.ts";
import { retentionTargets } from "./retention.ts";

/** Where this process reaches its own AI Gateway, listening on `host`. */
const ownGatewayUrl = (host: string, port: number): string => {
  const reachable =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${String(port)}`;
};

/** A running AI Office: its HTTP server and what the server runs on. */
export interface RunningOffice {
  /** Closing it stops everything else too. */
  readonly app: FastifyInstance;
  readonly events: EventBus;
  /** Where Notice sources raise Notices and register their actions. */
  readonly notices: Notices;
  /** Issue intake, when the GitHub App is configured. */
  readonly intake?: Intake;
  /** Every request through the AI Gateway (FR-44). */
  readonly requestHistory: RequestHistory;
}

/** What a test may put in place of what AI Office starts itself. */
export interface OfficeOptions {
  /**
   * Runs Agents' tasks in place of Docker sandboxes, as the end-to-end
   * tests do. Agents then work issues whenever the GitHub App is
   * configured, without `SANDBOX_GATEWAY_URL`.
   */
  readonly sandboxRunner?: SandboxRunner;
}

/**
 * Loads the configuration from `env`, connects to the database and starts
 * listening: the app on PORT, which also serves the AI Gateway's `/v1`
 * paths, and the AI Gateway alone on GATEWAY_PORT, the sandboxes' way to
 * it. Throws a `ConfigError` before doing anything else when the
 * configuration is invalid. Closing the returned app closes the Gateway too.
 */
export async function startServer(
  env: Readonly<Record<string, string | undefined>>,
): Promise<FastifyInstance> {
  return (await startOffice(env)).app;
}

/** `startServer`, also giving the event bus and the Notices. */
export async function startOffice(
  env: Readonly<Record<string, string | undefined>>,
  options: OfficeOptions = {},
): Promise<RunningOffice> {
  const config = loadConfig(env);
  // Every address the Owner gives (an AI Account's endpoint, the outbound
  // proxy, a Connection's, an imported repository's) may name these
  // internal hosts, and no others (ADR 0007).
  allowInternalHosts(config.allowedInternalHosts);
  const secrets = secretValues(config);
  // One redactor for everything AI Office writes: logs, events, Notices
  // and fixtures. Each AI Account's credential is registered with it once
  // this process holds it in clear.
  const redactor = createRedactor({ secrets });
  // The Gateway's log lines also go to the live log stream (FR-44).
  const gatewayLogs = createLogHub();
  const stdout = pino.destination(1);
  const logger = createLogger({
    level: config.logLevel,
    secrets,
    redactor,
    destination: {
      write(line: string) {
        stdout.write(line);
        gatewayLogs.write(line);
      },
    },
  });
  for (const name of retiredGitHubVariables(env)) {
    logger.warn(
      { variable: name },
      `${name} is no longer read: add GitHub Apps and access tokens in Floor Settings, then remove it.`,
    );
  }
  const database = connect(config.databaseUrl);
  // Every configured key, so a value sealed with a retired one still opens
  // (pen-testing G1-9); new values are sealed with ENCRYPTION_KEY.
  const encryptor = createEncryptor(config.encryptionKeyring);
  if (config.encryptionKeyring.keys.size > 1) {
    await resealWithCurrentKey(database.db, encryptor, logger);
  }
  const eventStore = databaseEventStore(database.db);
  const events = createEventBus({
    store: eventStore,
    redactor,
    onListenerError: (error, stored) => {
      logger.error(
        { err: error, eventId: stored.id, type: stored.event.type },
        "An event subscriber failed.",
      );
    },
  });
  const stores = databaseStores(database.db);
  const officeSettings = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events,
    // The outbound proxy's password is sealed, and redacted once opened.
    encryptor,
    onSecret: (secret) => {
      redactor.register(secret);
    },
  });
  // The outbound proxy (FR-35), read at start and again whenever it
  // changes: every request the AI Gateway makes upstream goes through it.
  let outboundProxy: OutboundProxy | null = null;
  const readOutboundProxy = async () => {
    outboundProxy = await officeSettings.outboundProxy();
  };
  await readOutboundProxy().catch((error: unknown) => {
    logger.warn({ err: error }, "The outbound proxy could not be read.");
  });
  const upstream = createUpstreamFetch({ proxy: () => outboundProxy });
  // Load balancing (FR-37): the Owner's strategy, read at start and again
  // whenever it changes, and the tokens each AI Account used lately.
  let balancing = defaultLoadBalancingSettings;
  const readBalancing = async () => {
    balancing = await officeSettings.loadBalancingSettings();
  };
  await readBalancing().catch((error: unknown) => {
    logger.warn(
      { err: error },
      "The load-balancing settings could not be read.",
    );
  });
  // Retries and the circuit breaker (FR-39), likewise.
  let retries = defaultGatewayRetrySettings;
  const readRetries = async () => {
    retries = await officeSettings.retrySettings();
  };
  await readRetries().catch((error: unknown) => {
    logger.warn({ err: error }, "The retry settings could not be read.");
  });
  // Usage throttling's pacing gates (FR-38), likewise.
  let throttling = defaultUsageThrottlingSettings;
  const readThrottling = async () => {
    throttling = await officeSettings.usageThrottlingSettings();
  };
  await readThrottling().catch((error: unknown) => {
    logger.warn(
      { err: error },
      "The usage throttling settings could not be read.",
    );
  });
  // Auto-refresh (FR-39), likewise: off until the Owner turns it on.
  let autoRefresh = defaultAutoRefreshSettings;
  const readAutoRefresh = async () => {
    autoRefresh = await officeSettings.autoRefreshSettings();
  };
  await readAutoRefresh().catch((error: unknown) => {
    logger.warn({ err: error }, "The auto-refresh setting could not be read.");
  });
  // Combos (FR-40), likewise: off until the Owner turns them on.
  let comboSettings = defaultComboSettings;
  const readComboSettings = async () => {
    comboSettings = await officeSettings.comboSettings();
  };
  await readComboSettings().catch((error: unknown) => {
    logger.warn({ err: error }, "Whether Combos are on could not be read.");
  });
  const aiAccountStore = databaseAiAccountStore(database.db);
  // The Owner's Combos, kept in `gateway_combos`: a request for a family
  // an enabled one is assigned to waterfalls through its slots.
  const combos = createCombos({
    store: databaseComboStore(database.db),
    accounts: aiAccountStore,
    events,
    settings: () => comboSettings,
  });
  // The Owner's model mappings and aliases (FR-41), kept in
  // `gateway_model_mappings`: each AI Account is sent the Model they give.
  const modelMappings = createModelMappings({
    store: databaseModelMappingStore(database.db),
    events,
  });
  const usage = createUsageTracker();
  // The AI Gateway serves each request from the AI Accounts the Owner
  // added in Admin (FR-35, FR-36), read from `ai_accounts` every time.
  const aiAccounts = createAiAccounts({
    store: aiAccountStore,
    encryptor,
    events,
    balancer: createLoadBalancer({ settings: () => balancing, usage }),
    retries: () => retries,
    throttling: () => throttling,
    autoRefresh: () => autoRefresh,
    combos,
    modelMappings,
    onCredential: (credential) => {
      redactor.register(credential);
    },
    fetch: upstream.fetch,
  });
  // The work AI Office gives each Agent (FR-42; pen-testing G1-1): a
  // sandbox's issue, held while it runs, and each of AI Office's own calls'
  // issue, opened for that call. An Agent's calls count against it at the
  // Gateway, whatever they name.
  const agentWork = createAgentWork();
  const openWork = (
    agentId: string,
    work: { readonly issue?: number; readonly pullRequest?: number },
  ) => agentWork.open(agentId, work);
  // Every caller presents a Gateway Key (FR-46): each Agent its own, and
  // the Owner's tools theirs. Keys are registered with the redactor too.
  const gatewayKeys = createGatewayKeys({
    store: databaseGatewayKeyStore(database.db),
    encryptor,
    events,
    onKey: (key) => {
      redactor.register(key);
    },
  });
  // Each request's estimated cost (FR-43): the pricing table, AI Providers'
  // published prices and the Owner's overrides.
  const pricing = createPricing({
    store: databaseModelPriceStore(database.db),
    sources: async () =>
      publishedPricesFor(
        (await aiAccounts.list())
          .filter(({ paused }) => !paused)
          .map(({ aiProvider }) => aiProvider),
        { fetch: upstream.fetch },
      ),
    events,
  });
  // Until the stored prices can be read, the pricing table's are used.
  await pricing.load().catch((error: unknown) => {
    logger.warn({ err: error }, "Stored Model prices could not be read.");
  });
  // The live model catalogue (FR-41): each kind of AI Account's Models,
  // fetched with one of its accounts at start, once a day and on demand;
  // and each AI Provider's default Model, chosen from it (FR-15).
  const modelCatalogue = createModelCatalogue({
    store: databaseModelCatalogueStore(database.db),
    sources: () => aiAccounts.catalogueSources(),
    fetch: upstream.fetch,
  });
  const aiProviders = createAiProviders({
    store: stores.aiProviders,
    events,
    catalogue: catalogueOf(modelCatalogue),
  });
  // The Agents as the flows read them: one on any AI Provider (FR-11) is
  // given the first available, by the AI Accounts' priority, that has a
  // default Model, and keeps it until its task or session ends.
  const workingAgents = workingAgentStore({
    store: stores.agents,
    availability: async () => ({
      defaults: await aiProviders.defaultModels(),
      accounts: await aiAccounts.list(),
    }),
    // The work queue is made further on.
    work: { active: () => workQueueStore.active() },
    floors: stores.floors,
    events,
  });
  // Request history (FR-44): every request, and its bodies, sealed, while
  // the Owner has body storage on. The setting is read at start and again
  // whenever it changes, so the Gateway asks it without a query.
  const requestStore = databaseRequestHistoryStore(database.db);
  const requestHistory = createRequestHistory({
    store: requestStore,
    encryptor,
    redactor,
    onListenerError: (error) => {
      logger.error({ err: error }, "A request stream subscriber failed.");
    },
  });
  // The prompt-cache TTL (§6.8), likewise.
  let promptCacheTtl: PromptCacheTtl = defaultPromptCacheSettings.ttl;
  const readPromptCache = async () => {
    promptCacheTtl = (await officeSettings.promptCacheSettings()).ttl;
  };
  await readPromptCache().catch((error: unknown) => {
    logger.warn({ err: error }, "The prompt-cache TTL could not be read.");
  });
  // Prompt-cache keep-alive (FR-39), likewise: off until the Owner turns
  // it on.
  let keepAliveSettings = defaultPromptCacheKeepAliveSettings;
  const readKeepAlive = async () => {
    keepAliveSettings = await officeSettings.keepAliveSettings();
  };
  await readKeepAlive().catch((error: unknown) => {
    logger.warn(
      { err: error },
      "The prompt-cache keep-alive settings could not be read.",
    );
  });
  // The Decision Model (FR-17), likewise: off until the Owner turns it on.
  let decisionModelSettings = defaultDecisionModelSettings;
  const readDecisionModel = async () => {
    decisionModelSettings = await officeSettings.decisionModelSettings();
  };
  await readDecisionModel().catch((error: unknown) => {
    logger.warn(
      { err: error },
      "The Decision Model's settings could not be read.",
    );
  });
  let storeBodies = true;
  const readStoreBodies = async () => {
    storeBodies = (await officeSettings.requestBodiesSettings()).store;
  };
  await readStoreBodies().catch((error: unknown) => {
    logger.warn({ err: error }, "The body storage setting could not be read.");
  });
  events.subscribe(
    async ({ event }) => {
      if (event.type !== "config.changed") {
        return;
      }
      if (event.keys.includes("requestBodies.store")) {
        await readStoreBodies();
      }
      if (event.keys.some((key) => key.startsWith("loadBalancing."))) {
        await readBalancing();
      }
      if (event.keys.some((key) => key.startsWith("retries."))) {
        await readRetries();
      }
      if (event.keys.some((key) => key.startsWith("usageThrottling."))) {
        await readThrottling();
      }
      if (event.keys.includes("promptCache.ttl")) {
        await readPromptCache();
      }
      if (event.keys.includes("autoRefresh.enabled")) {
        await readAutoRefresh();
      }
      if (event.keys.includes("comboSettings.enabled")) {
        await readComboSettings();
      }
      if (event.keys.some((key) => key.startsWith("keepAlive."))) {
        await readKeepAlive();
      }
      if (event.keys.some((key) => key.startsWith("outboundProxy."))) {
        await readOutboundProxy();
      }
      if (event.keys.some((key) => key.startsWith("decisionModel."))) {
        await readDecisionModel();
      }
    },
    { types: ["config.changed"] },
  );
  // Least-used counts each request's tokens as it is recorded, starting
  // from the last five hours' requests.
  requestHistory.subscribe((request) => {
    if (request.accountId !== null) {
      usage.record(
        request.accountId,
        (request.inputTokens ?? 0) + (request.outputTokens ?? 0),
        request.startedAt,
      );
    }
  });
  await requestHistory
    .accountUsageSince(new Date(Date.now() - leastUsedWindowMs))
    .then((rows) => {
      for (const { accountId, tokens, at } of rows) {
        usage.record(accountId, tokens, at);
      }
    })
    .catch((error: unknown) => {
      logger.warn({ err: error }, "Recent AI Account usage could not be read.");
    });
  const notices = createNotices({ store: stores.notices, events, redactor });
  const authStore = databaseAuthStore(database.db);
  const communicationsStore = databaseCommunicationsStore(database.db);
  // Retention (PRD §7): every hour, and as soon as a period changes, what
  // is past the period the Owner set is deleted. What Token Caps count is
  // kept a day at a time as requests' records go.
  const retention = createRetention({
    settings: () => officeSettings.retentionSettings(),
    targets: retentionTargets({
      requests: requestStore,
      aiAccounts: aiAccountStore,
      events: eventStore,
      notices: stores.notices,
      auth: authStore,
      communications: communicationsStore,
      chatAttachments: stores.chatAttachments,
    }),
    onReport: ({ deleted, failed }) => {
      for (const { rule, error } of failed) {
        logger.warn({ err: error, rule }, "Retention could not delete.");
      }
      const counts = Object.fromEntries(
        deleted.map(({ rule, count }) => [rule, count]),
      );
      if (deleted.some(({ count }) => count > 0)) {
        logger.info({ deleted: counts }, "Retention deleted old records.");
      }
    },
    onError: (error) => {
      logger.warn({ err: error }, "Retention could not run.");
    },
  });
  events.subscribe(
    ({ event }) => {
      if (
        event.type === "config.changed" &&
        event.keys.some((key) => key.startsWith("retention."))
      ) {
        void retention.run().catch((error: unknown) => {
          logger.warn({ err: error }, "Retention could not run.");
        });
      }
    },
    { types: ["config.changed"] },
  );
  // Token Caps are enforced as Agents call models (FR-33): the day's and
  // the month's use is kept in memory, from the request history and each
  // request as it is recorded, so the Gateway asks it before every call
  // without adding up a month of records.
  const tally = createUsageTally({
    load: (from, to) => requestHistory.tokenUsage(from, to),
  });
  const tokenCaps = createTokenCaps({
    store: stores.tokenCaps,
    floors: stores.floors,
    agents: workingAgents,
    events,
    usage: (from, to) => tally.usage(from, to),
  });
  const capEnforcement = createCapEnforcement({
    caps: tokenCaps,
    agents: workingAgents,
    pauses: stores.capPauses,
    notices,
    events,
    // A resumed Agent's work starts.
    onResume: () => {
      workQueue.wake();
    },
    onError: (error) => {
      logger.warn({ err: error }, "Token Caps could not be enforced.");
    },
  });
  requestHistory.subscribe((request) => {
    tally.record({ ...request, totals: requestTokens(request) });
    if (request.floorId !== null && request.agentId !== null) {
      void capEnforcement
        .observe({
          floorId: request.floorId,
          agentId: request.agentId,
          issue: request.issue ?? undefined,
        })
        .catch((error: unknown) => {
          logger.warn({ err: error }, "A Token Cap could not be checked.");
        });
    }
  });
  // Each Agent's Context Usage (FR-84): every model call the Gateway
  // records counts against its Agent's session, which a sandbox's run is.
  const contextUsage = createContextUsage({
    events,
    agents: workingAgents,
    defaultModels: () => aiProviders.defaultModels(),
    contextWindow: contextWindowOf(modelCatalogue),
    onError: (error) => {
      logger.warn({ err: error }, "A Context Usage listener failed.");
    },
  });
  observeModelCalls(requestHistory, contextUsage, (error) => {
    logger.warn({ err: error }, "Context Usage could not be measured.");
  });
  followSandboxSessions(events, contextUsage);
  // Agents' prompt caches, kept warm through their pauses (FR-39): each
  // keep-alive is recorded in the request history like any request.
  const keepAlive = createPromptCacheKeepAlive({
    accounts: aiAccounts,
    requestLog: requestHistory,
    settings: () => keepAliveSettings,
    pricing,
    capCheck: (subject) => capEnforcement.check(subject),
    fetch: upstream.fetch,
  });
  // AI Office's tool-call screen, which Agents' sandboxes ask through the
  // Gateway before each call runs (FR-17, P1-8): each sandbox session,
  // an Agent's task or a fact found, opens its own here.
  const toolCallScreens = createToolCallScreens();
  const gateway = await buildGateway({
    logger: logger.child({ component: "gateway" }),
    toolCallScreen: (request) => toolCallScreens.answer(request),
    accounts: aiAccounts,
    // A paused Agent's key, an archived Floor's and a paused
    // Communications Agent's call no model (pen-testing G1-4).
    keys: keysAtWork({
      keys: gatewayKeys,
      // An Agent on any AI Provider calls as the one it is given now.
      stores: { floors: stores.floors, agents: workingAgents },
      communicationsEnabled: async () =>
        (await communicationsStore.agent())?.enabled === true,
    }),
    pricing,
    storeBodies: () => storeBodies,
    promptCacheTtl: () => promptCacheTtl,
    retries: () => retries,
    requestLog: requestHistory,
    capCheck: (subject) => capEnforcement.check(subject),
    // The Communications Agent's Digests count against the office's caps.
    communicationsCapCheck: () => communicationsCapRefusal(tokenCaps),
    // So do the Owner's tools', the Terminal's too, each its own.
    ownerToolCapCheck: (ownerTool) => ownerToolCapRefusal(tokenCaps, ownerTool),
    work: agentWork,
    keepAlive,
    fetch: upstream.fetch,
    fixtureRecorder:
      config.gateway.fixturesDir === undefined
        ? undefined
        : directoryFixtureRecorder(config.gateway.fixturesDir, { redactor }),
  });
  // A subscription whose token can no longer be refreshed asks the Owner
  // to sign in again (FR-36, FR-49).
  const reauthentication = createReauthenticationNotices({
    notices,
    events,
    needsReauthentication: async (id) =>
      (await aiAccounts.list()).some(
        (account) => account.id === id && account.reauthenticationNeeded,
      ),
    onError: (error) => {
      logger.warn({ err: error }, "A re-authentication Notice failed.");
    },
  });
  // An AI Provider whose last AI Account is held back (rate-limited,
  // overloaded or failing) tells the Owner nothing is left (FR-49).
  const noAccountLeft = createNoAccountLeftNotices({
    notices,
    events,
    providerAvailable: async (aiProvider) => {
      const at = new Date();
      return (await aiAccounts.list()).some(
        (account) =>
          account.aiProvider === aiProvider &&
          !account.paused &&
          limitOf(account, at) === undefined,
      );
    },
    onError: (error) => {
      logger.warn({ err: error }, "A no-account-left Notice failed.");
    },
  });
  // Every GitHub App and access token the Owner added in Floor Settings,
  // as one GitHub (ADR 0011): each repository is acted on through the
  // first that reaches it, Apps first. It is always there, with no
  // connection yet too, when each call says GitHub is not set up; a
  // connection added, changed or removed is taken up at once, and one
  // added elsewhere (a seed) at the next minute's check.
  const github = createLiveGitHub();
  const githubConnections = createGitHubConnections({
    store: stores.githubConnections,
    encryptor,
    live: github,
    baseUrl: config.githubApiUrl,
    // The key and tokens are redacted once opened.
    onSecret: (secret) => {
      redactor.register(secret);
    },
    onUnreadable: (id, error) => {
      logger.warn(
        { err: error, connectionId: id },
        "A GitHub connection's secrets open with neither ENCRYPTION_KEY nor RETIRED_ENCRYPTION_KEYS: it is not used. Add it again in Floor Settings.",
      );
    },
  });
  const refreshGitHub = () =>
    githubConnections.refresh().catch((error: unknown) => {
      logger.warn({ err: error }, "The GitHub connections were not read.");
    });
  await refreshGitHub();
  const githubRefresh = setInterval(() => void refreshGitHub(), 60_000);
  githubRefresh.unref();
  // The sandboxes' work directory, where everything the GitHub App clones,
  // publishes or imports is made: taken only as this user's own directory,
  // never through a link (pen-testing I2-4), or AI Office does not start.
  await makeWorkDir(config.sandboxes.workDir);
  // The repository's memory (PRD FR-53): every Agent reads it from the
  // Floor's repository through the GitHub App, and proposes entries to it.
  const repositoryMemory = createRepositoryMemory({
    github,
    store: stores.memory,
    events,
    redactor,
    onError: (error) => {
      logger.warn({ err: error }, "The repository's memory could not be read.");
    },
  });
  const memory = { memory: repositoryMemory };
  // The office-wide and Role memory (PRD FR-54, FR-55), kept in AI Office:
  // mounted read-only into every sandbox and quoted in every reviewer's
  // prompt; Agents propose to their Role's, and the Manager or the Owner
  // decides. The credential check knows the Owner's own secrets.
  const sharedMemory = createSharedMemory({
    store: stores.officeMemory,
    floors: stores.floors,
    events,
    redactor,
  });
  // Reviewers (PRD FR-20) and the Manager chat (FR-24) use no sandbox:
  // they call models through this process's own AI Gateway, each with its
  // own Gateway Key (ADR 0001).
  // When no AI Account can serve such a call directly, as when the Owner's
  // only accounts for its Model's AI Provider are subscriptions, which
  // serve only their agent tool (FR-35), the call is made by that tool,
  // run once in its sandbox image on the sandboxes' Docker network.
  const throughAgentTool = (
    client: ModelClient,
    key: (agentId: string) => Promise<string | undefined>,
  ): ModelClient => {
    const sandboxGateway = config.sandboxes.gatewayUrl;
    // Without a way for sandboxes to reach the Gateway, the call cannot be
    // made by the agent tool either: the Owner is told what to set.
    const unreachable = new ModelCallError(
      503,
      "No AI Account can serve this call directly. A Claude or ChatGPT subscription serves it through Claude Code or Codex in a sandbox, which needs SANDBOX_GATEWAY_URL set (see Running AI Office); or add an API key for this AI Provider.",
    );
    return sandboxGateway === undefined
      ? withAgentToolFallback(client, {
          complete: () => Promise.reject(unreachable),
          stream: () => Promise.reject(unreachable),
        })
      : withAgentToolFallback(
          client,
          agentToolModelClient({
            gateway: async (agentId) => {
              const found = await key(agentId);
              return found === undefined
                ? undefined
                : { url: sandboxGateway, key: found };
            },
            run: dockerToolRunner({ network: config.sandboxes.network }),
            work: openWork,
          }),
        );
  };
  const models = throughAgentTool(
    gatewayModelClient({
      url: ownGatewayUrl(config.gateway.host, config.gateway.port),
      key: (agentId) => gatewayKeys.agentKey(agentId),
      work: openWork,
    }),
    (agentId) => gatewayKeys.agentKey(agentId),
  );
  // The Terminal's calls present its own Owner tool key, made when first
  // needed.
  const terminalModels = throughAgentTool(
    gatewayModelClient({
      url: ownGatewayUrl(config.gateway.host, config.gateway.port),
      key: () => gatewayKeys.terminalKey(),
    }),
    () => gatewayKeys.terminalKey(),
  );
  // Fresh Starts (FR-86, FR-87): a sandbox Agent's session ends when its
  // Context Usage crosses its threshold, or when the Owner asks; its own
  // Model writes the summary the next session starts from (FR-89).
  const freshStarts = createFreshStarts({
    contextUsage,
    floors: stores.floors,
    agents: workingAgents,
    models,
    events,
    notices,
    redactor,
  });
  // The Decision Model (FR-17): while the Owner has it on, Jev's typed
  // questions go through the same AI Gateway with the Floor's Manager's
  // Gateway Key, for triage, stalled Review Loops and Agents' tool calls.
  // When it cannot be asked, each judgement is made as it is while it is
  // off.
  const decisionModel = createDecisionModel({
    settings: () => Promise.resolve(decisionModelSettings),
    client: gatewayDecisionModelClient({
      url: ownGatewayUrl(config.gateway.host, config.gateway.port),
      key: (agentId) => gatewayKeys.agentKey(agentId),
      work: openWork,
    }),
    agents: workingAgents,
    redactor,
    onError: (error) => {
      logger.warn(
        { err: error },
        "The Decision Model could not be asked; AI Office judged without it.",
      );
    },
  });
  // Where the work queue lives (PRD FR-22), which wall boards read too.
  const workQueueStore = databaseWorkQueueStore(database.db);
  // "Stop everything" from the Meeting Room: a stopped Floor's work waits
  // in the queue until the Owner continues.
  const floorStops = createFloorStops({
    store: stores.floorStops,
    events,
    work: workQueueStore,
    queue: () => workQueue,
  });
  // Each Floor's Agents and team (FR-10): an Agent removed in the middle
  // of a task leaves once the work queue says its work has ended.
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events,
    defaultModels: () => aiProviders.defaultModels(),
    catalogue: catalogueOf(modelCatalogue),
    // A Role's suggested AI Provider needs an AI Account (FR-98).
    roles: stores.roles,
    aiAccountProviders: async () =>
      new Set((await aiAccounts.list()).map(({ aiProvider }) => aiProvider)),
    work: workQueueStore,
  });
  const settle = (floorId?: string) => {
    void agents.settle(floorId).catch((error: unknown) => {
      logger.warn({ err: error }, "Leaving Agents were not removed.");
    });
  };
  // Adrian, each Floor's coder, looks the same everywhere: on Floors from
  // before, he takes that look once, and keeps any the Owner gives him
  // after. It runs again at the next start if it failed.
  try {
    const changed = await agents.giveRoleAvatars();
    if (changed.length > 0) {
      logger.info({ agentIds: changed }, "Gave Adrian his own look.");
    }
  } catch (error) {
    logger.warn({ err: error }, "Adrian was not given his own look.");
  }

  // Each Floor's Skills (FR-72): the library's and its repository's, read
  // through the GitHub App for the Manager chat and from the run's clone
  // for a sandbox.
  const floorSkills = createFloorSkills({
    floors: stores.floors,
    library: stores.skills,
    toggles: stores.floorSkills,
    // A repository Skill is used only as the Owner reviewed it (P1-10).
    reviews: stores.repositorySkillReviews,
    roles: stores.roles,
    events,
    github,
  });

  // A Grilling Session's facts (FR-79), found in read-only sandboxes that
  // reach models through the AI Gateway with the Agent's own Gateway Key
  // (ADR 0001), when the GitHub App and the sandboxes' Gateway are set.
  const factsGatewayUrl = config.sandboxes.gatewayUrl;
  const factFinder =
    factsGatewayUrl === undefined
      ? undefined
      : createSandboxFactFinder({
          github,
          events,
          sandbox: dockerSandbox({ network: config.sandboxes.network }),
          gateway: async (agent) => {
            const key = await gatewayKeys.agentKey(agent.id);
            if (key === undefined) {
              throw new Error(`The Agent ${agent.name} has no Gateway Key.`);
            }
            return { url: factsGatewayUrl, key };
          },
          isAiAccountCredential: (value) => aiAccounts.holdsCredential(value),
          // Each tool call screened by AI Office's rules, before it runs
          // where the agent tool asks (P1-8).
          toolCallCheck: (call) => Promise.resolve(toolCallRules(call)),
          screens: toolCallScreens,
          workDir: join(config.sandboxes.workDir, "facts"),
        });

  // The Manager chat's continuing, read-only agent sessions (FR-24, ADR
  // 0004): a Manager whose AI Provider has Claude Code or Codex answers in
  // that tool's sandbox image, on a read-only clone of its Floor's
  // repository, reaching models through the AI Gateway with its own Gateway
  // Key whether a subscription or an API key serves them; when the GitHub
  // App and the sandboxes' Gateway are set, like the fact finder.
  const chatSessions =
    factsGatewayUrl === undefined
      ? undefined
      : createManagerChatSessions({
          store: stores.managerChatSessions,
          tool: dockerSessionTool({
            github,
            gateway: async (managerId) => {
              const key = await gatewayKeys.agentKey(managerId);
              return key === undefined
                ? undefined
                : { url: factsGatewayUrl, key };
            },
            run: dockerToolRunner({ network: config.sandboxes.network }),
            isAiAccountCredential: (value) => aiAccounts.holdsCredential(value),
            workDir: join(config.sandboxes.workDir, "manager-chat"),
          }),
        });

  // A Grilling Session's documents (FR-80), which AI Office, as the GitHub
  // App, commits on the session's own branch as decisions settle and
  // proposes in one pull request when it ends.
  const grillingDocuments = createGrillingDocuments({
    github,
    events,
    notices,
    gitIdentity: (floorId) => officeSettings.floorGitIdentity(floorId),
    scratchDir: config.sandboxes.workDir,
    onError: (error) => {
      logger.warn(
        { err: error },
        "A Grilling Session's pull request was opened, but its Notice could not be raised.",
      );
    },
  });

  // A Grilling Session's issues (FR-81), which the Manager drafts once its
  // documents are proposed and AI Office, as the GitHub App, files in
  // order once the Owner approves them.
  const grillingIssues = createGrillingIssues({ github, events });

  // The Owner's requests become Batches the Manager files and staffs with
  // Contractors (ADR 0004), through the GitHub App's narrow filing path,
  // once Batches can be made.
  const chatRequests = createChatRequests({
    agents,
    agentStore: workingAgents,
    roles: stores.roles,
    issues: managerChatIssues(github),
    batches: {
      create: (floorId, issues, request) =>
        batches.create(floorId, issues, request),
      describe: (floorId, outcome) => batches.describe(floorId, outcome),
    },
    work: workQueueStore,
    sandboxLimit: async () =>
      (await officeSettings.sandboxSettings()).concurrencyLimit,
    // What is filed or sent is bound to the Owner's own words, by a
    // call to the Manager's Model that read nothing else (P2-3).
    binding: modelRequestBindingCheck({
      models,
      defaultModels: () => aiProviders.defaultModels(),
    }),
    ...(factFinder === undefined ? {} : { facts: factFinder }),
    defaultModels: () => aiProviders.defaultModels(),
    onFiled: async (filed) => {
      await events.publish({
        type: "manager.issue_filed",
        version: 1,
        floorId: filed.floorId,
        issue: filed.issue,
        agentId: filed.managerId,
        title: filed.title,
        url: filed.url,
        messageId: filed.messageId,
      });
    },
    publicUrl: config.publicUrl,
    // Each research run is on the chat's task list (FR-24).
    onResearch: (floorId: string) => {
      managerChat.tasksChanged(floorId);
    },
  });
  // The repository's files the Manager chat's `@` mentions offer and read
  // (FR-24), through the GitHub App, which only reads them.
  const chatFiles = createChatRepositoryFiles({
    floors: stores.floors,
    github,
  });

  // Each Floor's Manager chat (FR-24), whose "status" is answered with the
  // Manager's status report (FR-23), whose "complete issues …" hands the
  // Manager a Batch (FR-25), below, and whose "skip" and "move" change it.
  const managerChat = createManagerChat({
    store: stores.managerChat,
    // "/grilling" starts a Grilling Session (FR-77), whose Manager finds
    // facts in read-only sandboxes (FR-79) and keeps the Floor's documents
    // on a branch, ending with one pull request (FR-80). Each change to a
    // session is published, for the Office to show it (FR-83).
    grilling: publishingGrillingStore(stores.grilling, {
      events,
      agents: workingAgents,
      onError: (error) => {
        logger.warn(
          { err: error },
          "A Grilling Session changed, but its event could not be published.",
        );
      },
    }),
    ...(factFinder === undefined ? {} : { facts: factFinder }),
    ...(chatSessions === undefined ? {} : { sessions: chatSessions }),
    documents: grillingDocuments,
    // …then drafts its issues, and files them once approved (FR-81).
    issues: grillingIssues,
    // Compacts itself at the Manager's Context Usage threshold (FR-87).
    contextUsage,
    floors: stores.floors,
    agents: workingAgents,
    models,
    defaultModels: () => aiProviders.defaultModels(),
    redactor,
    ...memory,
    // "/skill-name" runs one of the Floor's Skills, and the Manager may
    // choose one (FR-74).
    skills: floorChatSkills(floorSkills),
    // The files and images the Owner attaches, and the repository files
    // they mention with `@`, go to the Manager with their message (FR-24).
    attachments: stores.chatAttachments,
    files: chatFiles,
    // The Owner's requests become Batches the Manager files and staffs with
    // Contractors (ADR 0004), as above.
    requests: chatRequests,
    report: (floorId, replyTo) => statusReports.write(floorId, { replyTo }),
    carryOut: (floorId, command) => {
      if (
        command.kind !== "complete" &&
        command.kind !== "skip" &&
        command.kind !== "move"
      ) {
        return Promise.resolve(undefined);
      }
      // "skip 4" and "move 5 up" change the open Batch holding the issue (FR-25.4).
      return command.kind === "complete"
        ? batches.command(floorId, command.issues, {
            onePullRequest: command.onePullRequest === true,
          })
        : batches.changeCommand(floorId, command);
    },
    onError: (error) => {
      logger.error({ err: error }, "The Manager chat failed.");
    },
  });
  // Each Floor's Status updates (PRD FR-23a): the Owner's and the day's,
  // given through the app's routes, and every hour while a Floor's Agents
  // work, below. One for both, so the latest given is the same.
  const statusUpdates = createStatusUpdates({
    floors: stores.floors,
    agents: workingAgents,
    work: workQueueStore,
    batches: stores.batches,
    events,
    store: stores.statusUpdates,
    chat: managerChat,
    timeZone: async () => (await officeSettings.ownerProfile()).timeZone,
  });
  const hourlyStatusUpdates = createHourlyStatusUpdates({
    floors: stores.floors,
    work: workQueueStore,
    statusUpdates,
    onError: (error) => {
      logger.warn({ err: error }, "An hourly Status update was not given.");
    },
  });
  // Google sign-in (PRD FR-91), kept beside the Connections: the Google
  // Connections publish through the Owner's one Google account.
  const google = createGoogleAuth({
    store: communicationsStore,
    events,
    encryptor,
    publicUrl: config.publicUrl,
    redactor,
  });
  // The Communications Agent (PRD FR-90 to FR-94) queues what Connections
  // are sent in Postgres, from the event bus, and sends it as it falls due.
  const communications = createCommunications({
    store: communicationsStore,
    events,
    encryptor,
    transports: defaultTransports({ google }),
    google,
    publicUrl: config.publicUrl,
    floorName: async (floorId) => (await stores.floors.get(floorId))?.name,
    notice: (noticeId) => notices.get(noticeId).catch(() => undefined),
    raiseNotice: (notice) => notices.raise(notice),
    defaultModels: () => aiProviders.defaultModels(),
    agentName: () => agentName(Math.random, []),
    // Digests are written by its Model through this process's own AI
    // Gateway, with its own Gateway Key (FR-90, ADR 0001).
    digestWriter: gatewayDigestWriter({
      url: ownGatewayUrl(config.gateway.host, config.gateway.port),
      key: () => gatewayKeys.communicationsKey(),
    }),
    // So are published Wrap-up reports' summaries (FR-90, FR-92), made
    // from each finished Batch's Wrap-up and the event log.
    reportWriter: gatewayReportWriter({
      url: ownGatewayUrl(config.gateway.host, config.gateway.port),
      key: () => gatewayKeys.communicationsKey(),
    }),
    batchReport: (floorId, batchId) => batchReportOf(stores, floorId, batchId),
    issueTitle: (floorId, issue) => issueTitleOf(events, floorId, issue),
    // A work log's row per completed issue (FR-92), from the event log and
    // the AI Gateway's usage.
    completedIssue: (floorId, issue) =>
      completedIssueOf(
        {
          events,
          agents: workingAgents,
          usage: (from, to) => requestHistory.tokenUsage(from, to),
          now: () => new Date(),
        },
        floorId,
        issue,
      ),
    redactor,
    onError: (error) => {
      logger.warn(
        { err: error },
        "The Communications Agent could not queue or send; it tries again.",
      );
    },
  });
  // ChatGPT's sign-in ends on localhost:1455: served here while one
  // waits, so a browser on this machine finishes it without pasting.
  const oauthCallbacks = createOAuthCallbacks({
    host: config.oauthCallbackHost,
    complete: (url) => aiAccounts.completeCallback(url),
    awaiting: (redirectUri) => aiAccounts.awaitingCallback(redirectUri),
    logger,
  });
  // Until the Owner sets the password, only this machine, or someone who
  // can read this one-time token's file on it, may set it (A1-2). When the
  // database cannot say yet, the token is written anyway: once a password
  // exists, setup is a 404 whatever it holds.
  const passwordSet = await authStore.passwordHash().then(
    (hash) => hash !== undefined,
    () => false,
  );
  const setupToken = passwordSet ? undefined : await writeSetupToken();
  const app = await buildApp({
    floorStops,
    logger,
    ...(setupToken === undefined ? {} : { setupToken }),
    // One entry point: the app's port serves the Gateway's `/v1` paths too.
    gateway,
    oauthCallbacks,
    communications,
    google,
    publicUrl: config.publicUrl,
    checkDatabase: () => ping(database.pool),
    events,
    stores,
    notices,
    aiAccounts,
    combos,
    modelMappings,
    gatewayKeys,
    pricing,
    requestHistory,
    gatewayLogs,
    modelCatalogue,
    contextUsage,
    freshStarts,
    aiProviders,
    models,
    terminalModels,
    redactor,
    managerChat,
    statusUpdates,
    // `@` mentions and the chat's task list (FR-24); the task list is made
    // below, once the Batches are.
    chatFiles,
    chatTasks: { list: (floorId) => chatTasks.list(floorId) },
    // Made below, once the pipeline is: Plans are edited and approved there.
    plans: {
      edit: (...args) => batches.edit(...args),
      approve: (...args) => batches.approve(...args),
    },
    sharedMemory,
    workQueue: workQueueStore,
    agents,
    workingAgents,
    capPaused: (agentId) => capEnforcement.isPaused(agentId),
    githubConnections,
    github,
    // Made below; a delivery arrives only once the server listens.
    webhookTargets: {
      intake: {
        trigger: () => intake.trigger(),
        recheckLabels: (floorId: string) => {
          intake.recheckLabels(floorId);
        },
      },
      batches: {
        trigger: () => batches.trigger(),
      },
      merge: {
        ciChanged: (floorId: string) => {
          mergeFlow.ciChanged(floorId);
        },
      },
    },
    webDistDir: config.webDistDir,
    ...(config.trustProxy === undefined
      ? {}
      : { trustProxy: config.trustProxy }),
    ...(config.proxySecret === undefined
      ? {}
      : { proxySecret: config.proxySecret }),
    auth: {
      store: authStore,
      secret: config.sessionSecret,
      secureCookie: new URL(config.publicUrl).protocol === "https:",
      encryptor,
    },
  });
  const pipeline = createPipeline({ github, events });
  // Progress on each issue, as one comment edited at most once a minute.
  const progress = createProgressComments({
    github,
    events,
    publicUrl: config.publicUrl,
    redactor,
    onError: (error) => {
      logger.warn({ err: error }, "A progress comment was not written.");
    },
  });
  // The coder flow (PRD FR-19, FR-21) needs the GitHub App, and sandboxes
  // that reach models through the AI Gateway (ADR 0001).
  const { gatewayUrl, network, workDir } = config.sandboxes;
  const runner =
    options.sandboxRunner ??
    (gatewayUrl === undefined
      ? undefined
      : createSandboxRunner({
          github,
          events,
          // On the Docker network the Gateway is reachable on, if set.
          sandbox: dockerSandbox({ network }),
          // The Gateway's URL and the Agent's own Gateway Key; never an
          // AI Account's credential (ADR 0001), which is checked for.
          gateway: async (agent) => {
            const key = await gatewayKeys.agentKey(agent.id);
            if (key === undefined) {
              throw new Error(`The Agent ${agent.id} has no Gateway Key.`);
            }
            return { url: gatewayUrl, key };
          },
          // Its Agent's calls count against the issue while it runs.
          holdWork: ({ agentId, ...work }) => agentWork.hold(agentId, work),
          isAiAccountCredential: (value) => aiAccounts.holdsCredential(value),
          // Each tool call, and the setup command, screened by AI Office's
          // rules and the Decision Model while it is on: before it runs,
          // where the agent tool asks through the Gateway (P1-8).
          toolCallCheck: toolCallCheck(decisionModel),
          screens: toolCallScreens,
          // The Floor's Skills on for the Agent's Role, mounted read-only
          // (FR-75); the repository's read from the run's clone.
          skills: async (task, clone) => {
            const { skills, ignored } = await floorSkills.forSandbox(
              task.floor.id,
              task.agent.role,
              clone,
            );
            if (ignored.length > 0) {
              logger.info(
                {
                  floorId: task.floor.id,
                  folders: ignored.map(({ folder }) => folder),
                },
                "Some of the repository's Skill folders hold no usable Skill.",
              );
            }
            return skills;
          },
          workDir: join(workDir, "runs"),
          freshStarts,
        }));
  // The Batches handed over "in one PR" (ADR 0010): every Stage works
  // their issues on the Batch's one branch, into its one pull request.
  const batchBranches = createBatchBranches(stores.batches);
  // The Merge Policy (PRD FR-29) at ready-to-merge, and the "Approve and
  // merge" action of the Notices it raises: the GitHub App merges.
  const mergeFlow = createMergeFlow({
    floors: stores.floors,
    agents: workingAgents,
    github,
    notices,
    events,
    reviews: stores.reviews,
    batches: stores.batches,
    batchBranches,
    pipeline,
    // Commits pushed after the reviewers approved go back to them.
    queue: { enqueue: (work) => workQueue.enqueue(work) },
    ownerLogin: async () => (await officeSettings.intakeSettings()).ownerLogin,
  });
  // The turns of the work Roles a Plan gives an issue (PRD FR-25 (1)): the
  // coder flow hands it from one to the next, the Review Loop sends a fix
  // to the Role it concerns, and the work queue dispatches by them.
  const turns = createWorkTurns({ store: stores.workTurns });
  // Every Stage works the issue's text as the Owner approved it, never an
  // edit by someone else since (PRD FR-8; pen-test finding P1-5).
  const stageGitHub = withApprovedIssues(
    github,
    async () => (await officeSettings.intakeSettings()).ownerLogin,
  );
  const execute: ExecuteWork | undefined =
    runner === undefined
      ? undefined
      : executeByStage(
          {
            "needs-work": createCoderFlow({
              floors: stores.floors,
              agents: workingAgents,
              github: stageGitHub,
              pipeline,
              notices,
              events,
              runner,
              gitIdentity: (floorId) =>
                officeSettings.floorGitIdentity(floorId),
              defaultModels: () => aiProviders.defaultModels(),
              scratchDir: workDir,
              publicUrl: config.publicUrl,
              // Its review round, once the pull request is ready.
              queue: { enqueue: (work) => workQueue.enqueue(work) },
              reviews: stores.reviews,
              progress,
              capPaused: (agentId) => capEnforcement.isPaused(agentId),
              ...memory,
              sharedMemory,
              roles: stores.roles,
              turns,
              batchBranches,
              onError: (error) => {
                logger.warn(
                  { err: error },
                  "The coder flow could not tidy up.",
                );
              },
            }),
            "needs-review": createReviewFlow({
              floors: stores.floors,
              agents: workingAgents,
              github: stageGitHub,
              pipeline,
              notices,
              events,
              models,
              defaultModels: () => aiProviders.defaultModels(),
              capPaused: (agentId) => capEnforcement.isPaused(agentId),
              // Stalls judged by the Decision Model, while it is on.
              decisionModel,
              // The Review Loop: back to the coder, until the Round Cap.
              reviews: stores.reviews,
              queue: { enqueue: (work) => workQueue.enqueue(work) },
              redactor,
              ...memory,
              sharedMemory,
              roles: stores.roles,
              turns,
              batchBranches,
              onError: (error) => {
                logger.warn(
                  { err: error },
                  "The reviewer flow could not tidy up.",
                );
              },
            }),
            // QA (PRD FR-28) checks what the reviewers approved, in a sandbox.
            "needs-qa": createQaFlow({
              floors: stores.floors,
              agents: workingAgents,
              github: stageGitHub,
              pipeline,
              notices,
              events,
              runner,
              gitIdentity: (floorId) =>
                officeSettings.floorGitIdentity(floorId),
              defaultModels: () => aiProviders.defaultModels(),
              scratchDir: workDir,
              reviews: stores.reviews,
              queue: { enqueue: (work) => workQueue.enqueue(work) },
              progress,
              capPaused: (agentId) => capEnforcement.isPaused(agentId),
              redactor,
              ...memory,
              sharedMemory,
              roles: stores.roles,
              batchBranches,
              onError: (error) => {
                logger.warn({ err: error }, "The QA flow could not tidy up.");
              },
            }),
            // The docs Agent (PRD FR-18) documents what passed QA.
            "needs-docs": createDocsFlow({
              floors: stores.floors,
              agents: workingAgents,
              github: stageGitHub,
              pipeline,
              notices,
              events,
              runner,
              gitIdentity: (floorId) =>
                officeSettings.floorGitIdentity(floorId),
              defaultModels: () => aiProviders.defaultModels(),
              scratchDir: workDir,
              reviews: stores.reviews,
              // The Merge Policy's work, once it is ready to merge.
              queue: { enqueue: (work) => workQueue.enqueue(work) },
              progress,
              capPaused: (agentId) => capEnforcement.isPaused(agentId),
              ...memory,
              sharedMemory,
              roles: stores.roles,
              batchBranches,
              onError: (error) => {
                logger.warn({ err: error }, "The docs flow could not tidy up.");
              },
            }),
            "ready-to-merge": mergeFlow.execute,
          },
          {
            // A designer (PRD FR-10), on a Floor with one, reviews the UI of
            // what QA passed, at needs-qa, in a sandbox.
            [designerRole]: createDesignFlow({
              floors: stores.floors,
              agents: workingAgents,
              github: stageGitHub,
              pipeline,
              notices,
              events,
              runner,
              gitIdentity: (floorId) =>
                officeSettings.floorGitIdentity(floorId),
              defaultModels: () => aiProviders.defaultModels(),
              scratchDir: workDir,
              reviews: stores.reviews,
              // Docs', or the Merge Policy's work, or the coder's changes.
              queue: { enqueue: (work) => workQueue.enqueue(work) },
              progress,
              capPaused: (agentId) => capEnforcement.isPaused(agentId),
              redactor,
              ...memory,
              sharedMemory,
              batchBranches,
              onError: (error) => {
                logger.warn(
                  { err: error },
                  "The designer flow could not tidy up.",
                );
              },
            }),
          },
        );
  // The Manager's triage (PRD FR-23): before work starts, each picked-up
  // issue is checked for clarity, through the Manager's own Model (or the
  // Decision Model, while it is on), and given the priority the work queue
  // dispatches by, and on a Floor with several work Roles, the Role to work
  // it (ADR 0003).
  const triage = createTriage({
    floors: stores.floors,
    agents: workingAgents,
    github,
    models,
    // Jev, while the Decision Model is on (FR-17).
    decisionModel,
    defaultModels: () => aiProviders.defaultModels(),
    notices,
    events,
    store: stores.triage,
    roles: stores.roles,
    redactor,
    ...memory,
    onError: (error) => {
      logger.warn(
        { err: error },
        "Triage could not write a comment or close a Notice.",
      );
    },
  });
  // The work queue (PRD FR-22) keeps picked-up issues in the database, and
  // starts them once Agents can work them.
  const workQueue = createWorkQueue({
    store: workQueueStore,
    agents: workingAgents,
    events,
    limit: async () =>
      (await officeSettings.sandboxSettings()).concurrencyLimit,
    ...(execute === undefined ? {} : { execute }),
    pausedAgents: () => capEnforcement.pausedAgents(),
    stoppedFloors: () => floorStops.stopped(),
    issuePriority: (floorId: string, issue: number) =>
      triage.priority(floorId, issue),
    // The Role whose turn it is, of those a Plan gave the issue; otherwise
    // the one its triage chose.
    issueRole: async (floorId: string, issue: number) =>
      (await turns.role(floorId, issue)) ?? triage.role(floorId, issue),
    onError: (error) => {
      logger.error({ err: error }, "The work queue failed.");
    },
    onEnded: (work) => {
      settle(work.floorId);
    },
  });
  // A change to a limit, a Floor's settings or a team may let waiting work
  // start, or move it to another Agent (FR-22, FR-23): the queue looks at
  // once, rather than at its next poll.
  events.subscribe(
    ({ event }) => {
      if (
        event.type !== "config.changed" ||
        event.scope === "floor" ||
        event.scope === "agent" ||
        event.keys.includes("sandboxes.concurrencyLimit")
      ) {
        workQueue.wake();
      }
    },
    { types: ["config.changed", "agent.created", "agent.removed"] },
  );
  // The Manager's watchdog (PRD FR-23) looks over the work every minute:
  // stalled or failing work, and Review Loops near their Round Cap. It
  // retries, reassigns, relabels, pauses or escalates, and is refused
  // anything more.
  const watchdog =
    execute === undefined
      ? undefined
      : createWatchdog({
          floors: stores.floors,
          agents: workingAgents,
          github,
          queue: workQueue,
          work: workQueueStore,
          reviews: stores.reviews,
          notices,
          events,
          decisions: stores.decisions,
          pausedAgents: () => capEnforcement.pausedAgents(),
          redactor,
          onError: (error) => {
            logger.warn(
              { err: error },
              "The Manager's watchdog could not take a decision.",
            );
          },
        });
  // The Manager's status reports (PRD FR-23): on request in the chat, and
  // each Floor's once a day, in its chat and as an info Notice.
  const statusReports = createStatusReports({
    floors: stores.floors,
    agents: workingAgents,
    work: workQueueStore,
    github,
    notices,
    chat: managerChat,
    chatStore: stores.managerChat,
    usage: (from, to) => tally.usage(from, to),
    pausedAgents: () => capEnforcement.pausedAgents(),
    publicUrl: config.publicUrl,
    redactor,
    onError: (error) => {
      logger.warn({ err: error }, "A status report could not be written.");
    },
  });
  // Batches (PRD FR-25): the Manager drafts each one's Plan, holds the
  // Kickoff, and starts its issues as the Plan says once it is approved (or
  // at once, with plan approval off), checking every minute for issues whose
  // dependencies are done and for Batches finished, whose Wrap-up it
  // presents. Starting work needs the GitHub App.
  const batches = createBatches({
    floors: stores.floors,
    agents: workingAgents,
    github,
    models,
    defaultModels: () => aiProviders.defaultModels(),
    store: stores.batches,
    work: workQueueStore,
    pipeline,
    queue: workQueue,
    events,
    notices,
    triage,
    turns,
    settings: () => officeSettings.intakeSettings(),
    // Issues the App filed as the Owner approved them (FR-81).
    approved: (floorId) => approvedIssues(stores.grilling, floorId),
    pausedAgents: () => capEnforcement.pausedAgents(),
    publicUrl: config.publicUrl,
    redactor,
    ...memory,
    // Each issue's tokens and estimated cost, for its Wrap-up (FR-25.6).
    usage: (from, to) => requestHistory.tokenUsage(from, to),
    onError: (error) => {
      logger.warn(
        { err: error },
        "A Batch's Kickoff, issue or Wrap-up could not be handled.",
      );
    },
  });
  // The Manager reports back on each chat request's Batch in its chat
  // (ADR 0004), and its Contractors leave once no running Batch needs them.
  const chatReports = createChatReports({
    events,
    batches: stores.batches,
    chat: managerChat,
    publicUrl: config.publicUrl,
    onError: (error) => {
      logger.warn({ err: error }, "A chat request's progress was not posted.");
    },
  });
  // The chat's live task list (FR-24): each chat request's issues,
  // Contractors and research, told to the chat's clients as they change.
  const chatTasks = createChatTasks({
    floors: stores.floors,
    batches: stores.batches,
    agents: workingAgents,
    work: workQueueStore,
    events,
    research: chatRequests,
    changed: (floorId) => {
      managerChat.tasksChanged(floorId);
    },
    onError: (error) => {
      logger.warn({ err: error }, "The chat's task list was not refreshed.");
    },
  });
  const contractorDepartures = createContractorDepartures({
    agents,
    floors: stores.floors,
    batches: stores.batches,
    events,
    onError: (error) => {
      logger.warn({ err: error }, "A Contractor could not be let go.");
    },
  });
  // The Manager curates each Floor's repository memory (PRD FR-53) into
  // one pull request: at the end of each Batch and weekly, checked every
  // hour. AI Office, as the GitHub App, pushes and opens it.
  const memoryCuration = createMemoryCuration({
    floors: stores.floors,
    agents: workingAgents,
    github,
    models,
    defaultModels: () => aiProviders.defaultModels(),
    store: stores.memory,
    batches: stores.batches,
    events,
    notices,
    gitIdentity: (floorId) => officeSettings.floorGitIdentity(floorId),
    scratchDir: workDir,
    redactor,
    onError: (error) => {
      logger.warn(
        { err: error },
        "The repository's memory could not be curated.",
      );
    },
  });
  // Each Floor's Manager decides on its Agents' Role memory proposals
  // (PRD FR-55), checked every hour; what it cannot decide waits for the
  // Owner.
  const roleMemoryReview = createRoleMemoryReview({
    floors: stores.floors,
    agents: workingAgents,
    memory: sharedMemory,
    store: stores.officeMemory,
    models,
    defaultModels: () => aiProviders.defaultModels(),
    onError: (error) => {
      logger.warn(
        { err: error },
        "The Manager could not decide on Role memory proposals.",
      );
    },
  });
  // Issue intake (PRD FR-8) needs the GitHub App.
  const intake = createIntake({
    floors: stores.floors,
    github,
    pipeline,
    queue: workQueue,
    events,
    settings: () => officeSettings.intakeSettings(),
    triage,
    // The issues a Batch holds are the Batch's to start.
    held: (floorId: string) => batches.held(floorId),
    onReport: (report) => {
      const log = logger.child({ component: "intake" });
      for (const { floorId, issue } of report.pickedUp) {
        log.info({ floorId, issue }, "Picked up an issue.");
      }
      for (const { floorId, issue, error } of report.failed) {
        log.warn(
          { floorId, issue, err: error },
          "Intake could not take in a Floor's issues.",
        );
      }
    },
  });
  // The Owner's choice of a waiting issue's work Role (FR-23) lets it into
  // the pipeline: intake looks at once, rather than at its next poll.
  events.subscribe(
    ({ event }) => {
      if (event.type === "issue.routed" && event.routedBy === "owner") {
        intake.wake();
      }
    },
    { types: ["issue.routed"] },
  );
  // Published prices are refreshed at start and once a day.
  const refreshPrices = () => {
    // Read again first, in case the database was down at start.
    void pricing
      .load()
      .then(() => pricing.refresh())
      .then(
        (report) => {
          for (const { source, error } of report.failed) {
            logger.warn(
              { err: error, source },
              "Published prices could not be refreshed.",
            );
          }
        },
        (error: unknown) => {
          logger.warn(
            { err: error },
            "Published prices could not be refreshed.",
          );
        },
      );
  };
  // The model catalogue too. Then an AI Provider the Owner has an AI
  // Account for, but no default Model, gets the first its catalogue lists,
  // so its Agents can use it at once (FR-15); the Owner may choose another.
  const refreshCatalogue = () => {
    void modelCatalogue
      .refresh()
      .then(async (report) => {
        for (const failed of report.failed) {
          logger.warn(failed, "A model list could not be refreshed.");
        }
        const chosen = await aiProviders.chooseMissingDefaults(
          (await aiAccounts.list()).map(({ aiProvider }) => aiProvider),
        );
        if (chosen.length > 0) {
          logger.info(
            { aiProviders: chosen },
            "AI Providers with a new AI Account were given a default Model.",
          );
        }
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, "The model catalogue was not refreshed.");
      });
  };
  // A new AI Account (or one signed in again) may list Models the
  // catalogue does not have yet: it is read again at once, not tomorrow.
  events.subscribe(
    ({ event }) => {
      if (
        event.type === "config.changed" &&
        event.keys.some(
          (key) =>
            key === "aiAccounts.added" ||
            key === "aiAccounts.imported" ||
            key === "aiAccounts.reauthenticated",
        )
      ) {
        refreshCatalogue();
      }
    },
    { types: ["config.changed"] },
  );
  const priceRefresh = setInterval(
    () => {
      refreshPrices();
      refreshCatalogue();
    },
    24 * 60 * 60 * 1000,
  );
  priceRefresh.unref();
  // Subscriptions' tokens are refreshed ahead of expiry, and their health
  // told as it changes, every minute (FR-36).
  const refreshTokens = () => {
    void aiAccounts.refreshTokens().then(
      (report) => {
        for (const id of report.refused) {
          logger.warn(
            { aiAccountId: id },
            "An AI Account's token refresh was refused: sign in to it again.",
          );
        }
        for (const { id, error } of report.failed) {
          logger.warn(
            { err: error, aiAccountId: id },
            "An AI Account's token could not be refreshed; trying again.",
          );
        }
      },
      (error: unknown) => {
        logger.warn({ err: error }, "AI Accounts' tokens were not refreshed.");
      },
    );
  };
  // Limits whose reset has passed are lifted, and told, every minute too.
  const checkLimits = () => {
    void aiAccounts.checkLimits().catch((error: unknown) => {
      logger.warn({ err: error }, "AI Accounts' limits were not checked.");
    });
  };
  // With auto-refresh on, each usage window that reset gets its one
  // minimal request, starting the next at once (FR-39), every minute too.
  const refreshWindows = () => {
    void aiAccounts.refreshWindows().then(
      (report) => {
        for (const id of report.refreshed) {
          logger.info(
            { aiAccountId: id },
            "Auto-refresh started an AI Account's new usage window.",
          );
        }
        for (const { id, error } of report.failed) {
          logger.warn(
            { err: error, aiAccountId: id },
            "Auto-refresh could not start an AI Account's new usage window.",
          );
        }
      },
      (error: unknown) => {
        logger.warn(
          { err: error },
          "AI Accounts' usage windows were not refreshed.",
        );
      },
    );
  };
  const tokenRefresh = setInterval(() => {
    refreshTokens();
    checkLimits();
    refreshWindows();
  }, 60 * 1000);
  tokenRefresh.unref();
  // Claude subscriptions' usage windows are read from Anthropic every five
  // minutes too, so they show (and pace the account) even while no request
  // goes through it (FR-36); and so is the prepaid credit of the API keys
  // whose AI Provider documents a balance (OpenRouter, DeepSeek, Kimi).
  const refreshUsage = () => {
    void aiAccounts.refreshUsage().then(
      (report) => {
        for (const { id, error } of report.failed) {
          logger.warn(
            { err: error, aiAccountId: id },
            "An AI Account's usage could not be read; trying again.",
          );
        }
      },
      (error: unknown) => {
        logger.warn({ err: error }, "AI Accounts' usage was not read.");
      },
    );
  };
  const usageRefresh = setInterval(refreshUsage, 5 * 60 * 1000);
  usageRefresh.unref();
  // Each Agent session whose prompt cache is about to expire gets its
  // keep-alive, every 15 seconds, while keep-alive is on (FR-39).
  const keepCachesWarm = setInterval(() => {
    void keepAlive.run().then(
      (report) => {
        for (const { agentId, error } of report.failed) {
          logger.warn(
            { err: error, agentId },
            "An Agent's prompt cache could not be kept warm.",
          );
        }
      },
      (error: unknown) => {
        logger.warn({ err: error }, "Prompt caches were not kept warm.");
      },
    );
  }, keepAliveRoundMs);
  keepCachesWarm.unref();
  app.addHook("onClose", async () => {
    // A restart writes a new setup token; this one's file goes.
    await setupToken?.spend();
    await oauthCallbacks.close();
    clearInterval(priceRefresh);
    clearInterval(githubRefresh);
    clearInterval(tokenRefresh);
    clearInterval(usageRefresh);
    await retention.stop();
    clearInterval(keepCachesWarm);
    reauthentication.stop();
    noAccountLeft.stop();
    capEnforcement.stop();
    workingAgents.stop();
    await intake.stop();
    await batches.stop();
    chatReports.stop();
    chatTasks.stop();
    contractorDepartures.stop();
    await memoryCuration.stop();
    await roleMemoryReview.stop();
    triage.stop();
    mergeFlow.stop();
    await watchdog?.stop();
    await statusReports.stop();
    await hourlyStatusUpdates.stop();
    await communications.stop();
    await workQueue.stop();
    await progress.stop();
    await gateway.close();
    await upstream.close();
    await database.close();
  });

  try {
    await gateway.listen({
      port: config.gateway.port,
      host: config.gateway.host,
    });
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    await app.close();
    throw error;
  }
  // Before the queue starts, so a stopped Floor's work waits.
  await floorStops.start().catch((error: unknown) => {
    logger.warn({ err: error }, "The stopped Floors could not be read.");
  });
  await capEnforcement.start().catch((error: unknown) => {
    logger.warn({ err: error }, "Agents paused at Token Caps were not read.");
  });
  // The pipeline's renamed labels (ADR 0003: `needs-code` is now
  // `needs-work`) are renamed on each Floor's repository before its work
  // resumes, so its issues keep their place. Intake tries again for a
  // Floor whose repository could not be reached.
  const floorsAtStart = await stores.floors.list().catch((error: unknown) => {
    logger.warn(
      { err: error },
      "The Floors could not be read: the pipeline's retired labels were not renamed.",
    );
    return [];
  });
  for (const floor of floorsAtStart) {
    try {
      const renamed = await renameRetiredLabels(
        github.repository(floor.repository),
      );
      if (renamed.length > 0) {
        logger.info(
          { floorId: floor.id, renamed },
          "Renamed the pipeline's retired labels.",
        );
      }
    } catch (error) {
      logger.warn(
        { err: error, floorId: floor.id },
        "The pipeline's retired labels were not renamed.",
      );
    }
  }
  if (execute !== undefined) {
    await workQueue.start();
  }
  // Agents left leaving by a server that stopped: their work is queued
  // again (for another Agent of their Role), so they go now.
  settle();
  watchdog?.start();
  statusReports.start();
  hourlyStatusUpdates.start();
  batches.start();
  chatReports.start();
  chatTasks.start();
  contractorDepartures.start();
  memoryCuration.start();
  roleMemoryReview.start();
  retention.start();
  await communications
    .start()
    .then(async () =>
      gatewayKeys.ensureCommunicationsKey((await communications.agent()).name),
    )
    .catch((error: unknown) => {
      logger.warn({ err: error }, "The Communications Agent did not start.");
    });
  intake.start();
  refreshPrices();
  refreshCatalogue();
  refreshTokens();
  refreshUsage();
  if (setupToken !== undefined) {
    // The file's path, never the token. A restart writes a new one.
    app.log.warn(
      { file: setupToken.where },
      "Until the Owner's password is set at /setup, setting it from another machine takes the one-time setup token in this file (under docker compose: docker compose exec app cat <file>).",
    );
  }
  if (config.sandboxes.givenGatewayUrl !== undefined) {
    app.log.warn(
      {
        given: config.sandboxes.givenGatewayUrl,
        used: config.sandboxes.gatewayUrl,
      },
      "SANDBOX_GATEWAY_URL names a host sandboxes cannot reach: they reach only the sandbox relay, so its address is used instead. Set SANDBOX_GATEWAY_URL=http://sandbox-relay:3047 in .env, as .env.example has it.",
    );
  }
  const sampleSecrets = developmentSecretsInUse(config);
  if (sampleSecrets.length > 0) {
    app.log.warn(
      { keys: sampleSecrets },
      "Using the sample secrets from .env.example, which are public. Fine for development on this machine, and refused once AI Office is served beyond it; generate new ones for anything else (see .env.example).",
    );
  }
  if (config.gateway.fixturesDir !== undefined) {
    app.log.warn(
      { fixturesDir: config.gateway.fixturesDir },
      "The AI Gateway is in recorder mode: every request and response is written to disk, with credentials redacted.",
    );
  }
  app.log.info(
    {
      publicUrl: config.publicUrl,
      github:
        github.size === 0
          ? "not set up: add a GitHub App or an access token in Floor Settings"
          : { connections: github.size },
      agents:
        execute === undefined
          ? "not working issues (needs SANDBOX_GATEWAY_URL)"
          : "working issues",
      gateway: {
        // On the app's port at /v1, and here for the sandboxes.
        address: `${config.gateway.host}:${String(config.gateway.port)}`,
      },
    },
    "AI Office is listening.",
  );
  return {
    app,
    events,
    notices,
    requestHistory,
    intake,
  };
}
