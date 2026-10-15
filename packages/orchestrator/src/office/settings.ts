import { officeSettings, type Database } from "@ai-office/db";
import type { EventBus } from "@ai-office/events";
import {
  defaultAutoRefreshSettings,
  defaultComboSettings,
  defaultDecisionModelSettings,
  defaultGatewayRetrySettings,
  defaultGitIdentity,
  defaultLobbyCast,
  defaultOwnerProfile,
  floorActivitiesSchema,
  defaultSeasonalEvents,
  seasonalEventsSchema,
  type SeasonalEvents,
  lobbyCharacterSchema,
  lobbyRoles,
  ownerProfileSchema,
  defaultIntakeSettings,
  defaultLoadBalancingSettings,
  defaultPromptCacheKeepAliveSettings,
  defaultOutboundProxySettings,
  defaultPromptCacheSettings,
  defaultRetentionSettings,
  defaultSandboxConcurrencyLimit,
  defaultUsageThrottlingSettings,
  floorErrorCodes,
  type AutoRefreshSettings,
  type ComboSettings,
  type DecisionModelSettings,
  retentionRules,
  type GatewayRetrySettings,
  type GitIdentity,
  type IntakeSettings,
  type LoadBalancingSettings,
  type LoadBalancingStrategy,
  type LobbyCast,
  type LobbyCharacter,
  type LobbyRole,
  type OwnerProfile,
  type OfficeGitIdentity,
  type OutboundProxy,
  type OutboundProxySettings,
  type OutboundProxyUpdate,
  type PromptCacheKeepAliveSettings,
  type PromptCacheSettings,
  type PromptCacheTtl,
  type RequestBodiesSettings,
  type RetentionSettings,
  type SandboxSettings,
  type UsageThrottlingSettings,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";
import { eq } from "drizzle-orm";

import { FloorError } from "../floors/errors.ts";
import type { FloorStore } from "../floors/store.ts";
import { gitIdentityFor } from "../git/identity.ts";

// Office-wide settings (PRD FR-65). So far: the Git identity agent commits
// are by (FR-68), the Owner's by default; and intake's (FR-8): the Owner's
// GitHub login and how often intake checks for issues; and how many
// sandboxes may run at once (FR-22); whether the AI Gateway keeps
// request and response bodies (FR-44), on unless the Owner turns it off;
// how the Gateway balances requests across AI Accounts (FR-37); how it
// retries them, and when it stops using a failing account (FR-39); the TTL
// it gives prompt-cache breakpoints (§6.8); whether it starts each usage
// window anew once it resets (FR-39); whether it keeps Agents' prompt
// caches warm (FR-39); whether requests waterfall through the Owner's
// Combos (FR-40); the outbound HTTP proxy every upstream request goes
// through (FR-35), its password sealed and never handed back; the Decision
// Model (FR-17, FR-89); and how long what AI Office records is kept
// (retention, §7).

/** The outbound proxy as it is stored: its password sealed. */
export interface StoredOutboundProxy {
  readonly url: string;
  readonly username: string | null;
  /** Sealed with ENCRYPTION_KEY; null for none. */
  readonly password: string | null;
  readonly noProxy: readonly string[];
}

/** The context the proxy's password is sealed with. */
export const outboundProxyPasswordContext =
  "office_settings.gateway_outbound_proxy_password";

/** Where office settings live. */
export interface OfficeSettingsStore {
  /** The Git identity set in the office admin; undefined if never set. */
  gitIdentity(): Promise<GitIdentity | undefined>;
  setGitIdentity(identity: GitIdentity, at: Date): Promise<void>;
  /** The intake settings set in the office admin; each unset one absent. */
  intakeSettings(): Promise<Partial<IntakeSettings>>;
  setIntakeSettings(settings: IntakeSettings, at: Date): Promise<void>;
  /** The office-wide sandbox limit set in the admin; undefined if never. */
  sandboxConcurrencyLimit(): Promise<number | undefined>;
  setSandboxConcurrencyLimit(limit: number, at: Date): Promise<void>;
  /** Whether the Gateway keeps request bodies; undefined if never set. */
  gatewayStoreBodies(): Promise<boolean | undefined>;
  setGatewayStoreBodies(store: boolean, at: Date): Promise<void>;
  /** The load-balancing settings set in the admin; each unset one absent. */
  loadBalancing(): Promise<Partial<LoadBalancingSettings>>;
  setLoadBalancing(settings: LoadBalancingSettings, at: Date): Promise<void>;
  /** The retry settings set in the admin; each unset one absent. */
  gatewayRetries(): Promise<Partial<GatewayRetrySettings>>;
  setGatewayRetries(settings: GatewayRetrySettings, at: Date): Promise<void>;
  /** The usage throttling settings set in the admin; each unset one absent. */
  usageThrottling(): Promise<Partial<UsageThrottlingSettings>>;
  setUsageThrottling(
    settings: UsageThrottlingSettings,
    at: Date,
  ): Promise<void>;
  /** The prompt-cache TTL set in the admin; undefined for as sent. */
  promptCacheTtl(): Promise<Exclude<PromptCacheTtl, "as_sent"> | undefined>;
  setPromptCacheTtl(ttl: PromptCacheTtl, at: Date): Promise<void>;
  /** Whether auto-refresh is on; undefined if never set. */
  gatewayAutoRefresh(): Promise<boolean | undefined>;
  setGatewayAutoRefresh(enabled: boolean, at: Date): Promise<void>;
  /** Whether Combos are on; undefined if never set. */
  gatewayCombos(): Promise<boolean | undefined>;
  setGatewayCombos(enabled: boolean, at: Date): Promise<void>;
  /** Prompt-cache keep-alive's settings; each unset one absent. */
  promptCacheKeepAlive(): Promise<Partial<PromptCacheKeepAliveSettings>>;
  setPromptCacheKeepAlive(
    settings: PromptCacheKeepAliveSettings,
    at: Date,
  ): Promise<void>;
  /** The outbound proxy; undefined while there is none. */
  gatewayOutboundProxy(): Promise<StoredOutboundProxy | undefined>;
  /** Sets the outbound proxy, or (null) removes it. */
  setGatewayOutboundProxy(
    proxy: StoredOutboundProxy | null,
    at: Date,
  ): Promise<void>;
  /** The Decision Model's settings; each unset one absent. */
  decisionModel(): Promise<Partial<DecisionModelSettings>>;
  setDecisionModel(settings: DecisionModelSettings, at: Date): Promise<void>;
  /** The retention periods set in the admin; each unset one absent. */
  retention(): Promise<Partial<RetentionSettings>>;
  setRetention(settings: RetentionSettings, at: Date): Promise<void>;
  /** Whether GitHub's webhooks are taken, and their secret, sealed. */
  githubWebhooks(): Promise<StoredWebhooks>;
  setGithubWebhooks(webhooks: StoredWebhooks, at: Date): Promise<void>;
  /** The Owner's profile; undefined if never set. */
  ownerProfile(): Promise<OwnerProfile | undefined>;
  setOwnerProfile(profile: OwnerProfile, at: Date): Promise<void>;
  /** The lobby's cast as set; each role never set absent. */
  lobbyCast(): Promise<Partial<LobbyCast>>;
  setLobbyCast(cast: Partial<LobbyCast>, at: Date): Promise<void>;
  /** The idle activities turned off, by Floor id. */
  floorActivities(): Promise<Record<string, string[]>>;
  setFloorActivities(
    activities: Record<string, string[]>,
    at: Date,
  ): Promise<void>;
  /** The seasonal events as set; undefined until set. */
  seasonalEvents(): Promise<SeasonalEvents | undefined>;
  setSeasonalEvents(events: SeasonalEvents, at: Date): Promise<void>;
}

/** The webhook settings as kept: off, and no secret, until set. */
export interface StoredWebhooks {
  readonly enabled: boolean;
  /** Sealed with ENCRYPTION_KEY; never in clear. */
  readonly sealedSecret: string | null;
}

/** Keeps office settings in memory: for tests. */
export function memoryOfficeSettingsStore(): OfficeSettingsStore {
  let seasonal: SeasonalEvents | undefined;
  let gitIdentity: GitIdentity | undefined;
  let intake: Partial<IntakeSettings> = {};
  let sandboxLimit: number | undefined;
  let storeBodies: boolean | undefined;
  let balancing: Partial<LoadBalancingSettings> = {};
  let retries: Partial<GatewayRetrySettings> = {};
  let throttling: Partial<UsageThrottlingSettings> = {};
  let cacheTtl: Exclude<PromptCacheTtl, "as_sent"> | undefined;
  let autoRefresh: boolean | undefined;
  let combos: boolean | undefined;
  let keepAlive: Partial<PromptCacheKeepAliveSettings> = {};
  let outboundProxy: StoredOutboundProxy | undefined;
  let decisionModel: Partial<DecisionModelSettings> = {};
  let retention: Partial<RetentionSettings> = {};
  let webhooks: StoredWebhooks = { enabled: false, sealedSecret: null };
  let profile: OwnerProfile | undefined;
  let cast: Partial<LobbyCast> = {};
  let activities: Record<string, string[]> = {};
  return {
    gitIdentity: () =>
      Promise.resolve(
        gitIdentity === undefined ? undefined : { ...gitIdentity },
      ),
    setGitIdentity(identity) {
      gitIdentity = { ...identity };
      return Promise.resolve();
    },
    intakeSettings: () => Promise.resolve({ ...intake }),
    setIntakeSettings(settings) {
      intake = { ...settings };
      return Promise.resolve();
    },
    sandboxConcurrencyLimit: () => Promise.resolve(sandboxLimit),
    setSandboxConcurrencyLimit(limit) {
      sandboxLimit = limit;
      return Promise.resolve();
    },
    gatewayStoreBodies: () => Promise.resolve(storeBodies),
    setGatewayStoreBodies(store) {
      storeBodies = store;
      return Promise.resolve();
    },
    loadBalancing: () => Promise.resolve({ ...balancing }),
    setLoadBalancing(settings) {
      balancing = { ...settings };
      return Promise.resolve();
    },
    gatewayRetries: () => Promise.resolve({ ...retries }),
    setGatewayRetries(settings) {
      retries = { ...settings };
      return Promise.resolve();
    },
    usageThrottling: () => Promise.resolve({ ...throttling }),
    setUsageThrottling(settings) {
      throttling = { ...settings };
      return Promise.resolve();
    },
    promptCacheTtl: () => Promise.resolve(cacheTtl),
    setPromptCacheTtl(ttl) {
      cacheTtl = ttl === "as_sent" ? undefined : ttl;
      return Promise.resolve();
    },
    gatewayAutoRefresh: () => Promise.resolve(autoRefresh),
    setGatewayAutoRefresh(enabled) {
      autoRefresh = enabled;
      return Promise.resolve();
    },
    gatewayCombos: () => Promise.resolve(combos),
    setGatewayCombos(enabled) {
      combos = enabled;
      return Promise.resolve();
    },
    promptCacheKeepAlive: () => Promise.resolve({ ...keepAlive }),
    setPromptCacheKeepAlive(settings) {
      keepAlive = { ...settings };
      return Promise.resolve();
    },
    gatewayOutboundProxy: () =>
      Promise.resolve(
        outboundProxy === undefined ? undefined : { ...outboundProxy },
      ),
    setGatewayOutboundProxy(proxy) {
      outboundProxy = proxy === null ? undefined : { ...proxy };
      return Promise.resolve();
    },
    decisionModel: () => Promise.resolve({ ...decisionModel }),
    setDecisionModel(settings) {
      decisionModel = { ...settings };
      return Promise.resolve();
    },
    retention: () => Promise.resolve({ ...retention }),
    setRetention(settings) {
      retention = { ...settings };
      return Promise.resolve();
    },
    githubWebhooks: () => Promise.resolve({ ...webhooks }),
    setGithubWebhooks(set) {
      webhooks = { ...set };
      return Promise.resolve();
    },
    ownerProfile: () =>
      Promise.resolve(profile === undefined ? undefined : { ...profile }),
    setOwnerProfile(set) {
      profile = { ...set };
      return Promise.resolve();
    },
    lobbyCast: () => Promise.resolve(structuredClone(cast)),
    setLobbyCast(set) {
      cast = structuredClone(set);
      return Promise.resolve();
    },
    floorActivities: () => Promise.resolve(structuredClone(activities)),
    setFloorActivities(set) {
      activities = structuredClone(set);
      return Promise.resolve();
    },
    seasonalEvents: () => Promise.resolve(structuredClone(seasonal)),
    setSeasonalEvents(set) {
      seasonal = structuredClone(set);
      return Promise.resolve();
    },
  };
}

/** A stored lobby cast, each role kept only if it is still valid. */
function storedLobbyCast(value: unknown): Partial<LobbyCast> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const cast: Partial<Record<LobbyRole, LobbyCharacter>> = {};
  for (const role of lobbyRoles) {
    const parsed = lobbyCharacterSchema.safeParse(
      (value as Record<string, unknown>)[role],
    );
    if (parsed.success) {
      cast[role] = parsed.data;
    }
  }
  return cast;
}

/** The retry settings, each named as `config.changed` names it. */
const retryKeys = [
  "attempts",
  "delayMs",
  "multiplier",
  "circuitBreakerThreshold",
  "circuitBreakerCooldownSeconds",
] as const;

/** The usage throttling settings, each named as `config.changed` names it. */
const throttlingKeys = ["fiveHourPacing", "weeklyPacing"] as const;

/** Keep-alive's settings, each named as `config.changed` names it. */
const keepAliveKeys = [
  "enabled",
  "idleMinutes",
  "maxPerAccountPerHour",
] as const;

/** The Decision Model's settings, each named as `config.changed` names it. */
const decisionModelKeys = ["enabled", "model", "summaries"] as const;

/** The retention periods, each named as `config.changed` names it. */
const retentionKeys = retentionRules;

/** Keeps office settings in the one-row `office_settings` table. */
export function databaseOfficeSettingsStore(db: Database): OfficeSettingsStore {
  return {
    async gitIdentity() {
      const [row] = await db
        .select()
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      const name = row?.gitName ?? null;
      const email = row?.gitEmail ?? null;
      return name === null || email === null ? undefined : { name, email };
    },
    async setGitIdentity(identity, at) {
      const values = {
        gitName: identity.name,
        gitEmail: identity.email,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async intakeSettings() {
      const [row] = await db
        .select()
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return {
        ...(row?.ownerLogin == null ? {} : { ownerLogin: row.ownerLogin }),
        ...(row?.intakeIntervalSeconds == null
          ? {}
          : { intervalSeconds: row.intakeIntervalSeconds }),
      };
    },
    async setIntakeSettings(settings, at) {
      const values = {
        ownerLogin: settings.ownerLogin,
        intakeIntervalSeconds: settings.intervalSeconds,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async sandboxConcurrencyLimit() {
      const [row] = await db
        .select({ limit: officeSettings.sandboxConcurrencyLimit })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return row?.limit ?? undefined;
    },
    async setSandboxConcurrencyLimit(limit, at) {
      const values = { sandboxConcurrencyLimit: limit, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async gatewayStoreBodies() {
      const [row] = await db
        .select({ store: officeSettings.gatewayStoreBodies })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return row?.store ?? undefined;
    },
    async setGatewayStoreBodies(store, at) {
      const values = { gatewayStoreBodies: store, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async loadBalancing() {
      const [row] = await db
        .select({
          strategy: officeSettings.gatewayStrategy,
          sessionWindowMinutes: officeSettings.gatewaySessionWindowMinutes,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return {
        ...(row?.strategy == null
          ? {}
          : { strategy: row.strategy as LoadBalancingStrategy }),
        ...(row?.sessionWindowMinutes == null
          ? {}
          : { sessionWindowMinutes: row.sessionWindowMinutes }),
      };
    },
    async setLoadBalancing(settings, at) {
      const values = {
        gatewayStrategy: settings.strategy,
        gatewaySessionWindowMinutes: settings.sessionWindowMinutes,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async gatewayRetries() {
      const [row] = await db
        .select({
          attempts: officeSettings.gatewayRetryAttempts,
          delayMs: officeSettings.gatewayRetryDelayMs,
          multiplier: officeSettings.gatewayRetryMultiplier,
          circuitBreakerThreshold:
            officeSettings.gatewayCircuitBreakerThreshold,
          circuitBreakerCooldownSeconds:
            officeSettings.gatewayCircuitBreakerCooldownSeconds,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      const set: Partial<GatewayRetrySettings> = {};
      for (const key of retryKeys) {
        const value = row?.[key];
        if (value != null) {
          set[key] = value;
        }
      }
      return set;
    },
    async setGatewayRetries(settings, at) {
      const values = {
        gatewayRetryAttempts: settings.attempts,
        gatewayRetryDelayMs: settings.delayMs,
        gatewayRetryMultiplier: settings.multiplier,
        gatewayCircuitBreakerThreshold: settings.circuitBreakerThreshold,
        gatewayCircuitBreakerCooldownSeconds:
          settings.circuitBreakerCooldownSeconds,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async usageThrottling() {
      const [row] = await db
        .select({
          fiveHourPacing: officeSettings.gatewayFiveHourPacing,
          weeklyPacing: officeSettings.gatewayWeeklyPacing,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      const set: Partial<UsageThrottlingSettings> = {};
      for (const key of throttlingKeys) {
        const value = row?.[key];
        if (value != null) {
          set[key] = value;
        }
      }
      return set;
    },
    async setUsageThrottling(settings, at) {
      const values = {
        gatewayFiveHourPacing: settings.fiveHourPacing,
        gatewayWeeklyPacing: settings.weeklyPacing,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async promptCacheTtl() {
      const [row] = await db
        .select({ ttl: officeSettings.gatewayPromptCacheTtl })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return row?.ttl === "5m" || row?.ttl === "1h" ? row.ttl : undefined;
    },
    async setPromptCacheTtl(ttl, at) {
      const values = {
        gatewayPromptCacheTtl: ttl === "as_sent" ? null : ttl,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async gatewayAutoRefresh() {
      const [row] = await db
        .select({ enabled: officeSettings.gatewayAutoRefresh })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return row?.enabled ?? undefined;
    },
    async setGatewayAutoRefresh(enabled, at) {
      const values = { gatewayAutoRefresh: enabled, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async gatewayCombos() {
      const [row] = await db
        .select({ enabled: officeSettings.gatewayCombos })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return row?.enabled ?? undefined;
    },
    async setGatewayCombos(enabled, at) {
      const values = { gatewayCombos: enabled, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async promptCacheKeepAlive() {
      const [row] = await db
        .select({
          enabled: officeSettings.gatewayKeepAlive,
          idleMinutes: officeSettings.gatewayKeepAliveIdleMinutes,
          maxPerAccountPerHour:
            officeSettings.gatewayKeepAliveMaxPerAccountPerHour,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return {
        ...(row?.enabled == null ? {} : { enabled: row.enabled }),
        ...(row?.idleMinutes == null ? {} : { idleMinutes: row.idleMinutes }),
        ...(row?.maxPerAccountPerHour == null
          ? {}
          : { maxPerAccountPerHour: row.maxPerAccountPerHour }),
      };
    },
    async setPromptCacheKeepAlive(settings, at) {
      const values = {
        gatewayKeepAlive: settings.enabled,
        gatewayKeepAliveIdleMinutes: settings.idleMinutes,
        gatewayKeepAliveMaxPerAccountPerHour: settings.maxPerAccountPerHour,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async gatewayOutboundProxy() {
      const [row] = await db
        .select({
          url: officeSettings.gatewayOutboundProxyUrl,
          username: officeSettings.gatewayOutboundProxyUsername,
          password: officeSettings.gatewayOutboundProxyPassword,
          noProxy: officeSettings.gatewayOutboundProxyNoProxy,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return row?.url == null
        ? undefined
        : {
            url: row.url,
            username: row.username,
            password: row.password,
            noProxy: row.noProxy ?? [],
          };
    },
    async setGatewayOutboundProxy(proxy, at) {
      const values = {
        gatewayOutboundProxyUrl: proxy?.url ?? null,
        gatewayOutboundProxyUsername: proxy?.username ?? null,
        gatewayOutboundProxyPassword: proxy?.password ?? null,
        gatewayOutboundProxyNoProxy: proxy === null ? null : [...proxy.noProxy],
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async decisionModel() {
      const [row] = await db
        .select({
          enabled: officeSettings.decisionModelEnabled,
          model: officeSettings.decisionModel,
          summaries: officeSettings.decisionModelSummaries,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return {
        ...(row?.enabled == null ? {} : { enabled: row.enabled }),
        ...(row?.model == null ? {} : { model: row.model }),
        ...(row?.summaries == null ? {} : { summaries: row.summaries }),
      };
    },
    async setDecisionModel(settings, at) {
      const values = {
        decisionModelEnabled: settings.enabled,
        decisionModel: settings.model,
        decisionModelSummaries: settings.summaries,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async retention() {
      const [row] = await db
        .select({
          requestBodiesDays: officeSettings.retentionRequestBodiesDays,
          requestMetadataDays: officeSettings.retentionRequestMetadataDays,
          activityDays: officeSettings.retentionActivityDays,
          connectionDeliveriesDays:
            officeSettings.retentionConnectionDeliveriesDays,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      const set: Partial<RetentionSettings> = {};
      for (const key of retentionKeys) {
        const value = row?.[key];
        if (value != null) {
          set[key] = value;
        }
      }
      return set;
    },
    async setRetention(settings, at) {
      const values = {
        retentionRequestBodiesDays: settings.requestBodiesDays,
        retentionRequestMetadataDays: settings.requestMetadataDays,
        retentionActivityDays: settings.activityDays,
        retentionConnectionDeliveriesDays: settings.connectionDeliveriesDays,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async githubWebhooks() {
      const [row] = await db
        .select({
          enabled: officeSettings.githubWebhooksEnabled,
          sealedSecret: officeSettings.githubWebhookSecret,
        })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return {
        enabled: row?.enabled ?? false,
        sealedSecret: row?.sealedSecret ?? null,
      };
    },
    async setGithubWebhooks(webhooks, at) {
      const values = {
        githubWebhooksEnabled: webhooks.enabled,
        githubWebhookSecret: webhooks.sealedSecret,
        updatedAt: at,
      };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async ownerProfile() {
      const [row] = await db
        .select({ profile: officeSettings.ownerProfile })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      const parsed = ownerProfileSchema.safeParse(row?.profile);
      return parsed.success ? parsed.data : undefined;
    },
    async setOwnerProfile(profile, at) {
      const values = { ownerProfile: profile, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async lobbyCast() {
      const [row] = await db
        .select({ cast: officeSettings.lobbyCast })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      return storedLobbyCast(row?.cast);
    },
    async setLobbyCast(cast, at) {
      const values = { lobbyCast: cast, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async floorActivities() {
      const [row] = await db
        .select({ activities: officeSettings.floorActivities })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      const parsed = floorActivitiesSchema.shape.disabled.safeParse(
        row?.activities,
      );
      return parsed.success ? parsed.data : {};
    },
    async setFloorActivities(activities, at) {
      const values = { floorActivities: activities, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
    async seasonalEvents() {
      const [row] = await db
        .select({ seasonal: officeSettings.seasonalEvents })
        .from(officeSettings)
        .where(eq(officeSettings.id, 1));
      const parsed = seasonalEventsSchema.safeParse(row?.seasonal);
      return parsed.success ? parsed.data : undefined;
    },
    async setSeasonalEvents(seasonal, at) {
      const values = { seasonalEvents: seasonal, updatedAt: at };
      await db
        .insert(officeSettings)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: officeSettings.id, set: values });
    },
  };
}

export interface OfficeSettings {
  /** The office's Git identity, and whether it is still the default. */
  gitIdentity(): Promise<OfficeGitIdentity>;
  /** Sets the office's Git identity, recording that it changed. */
  setGitIdentity(identity: GitIdentity): Promise<OfficeGitIdentity>;
  /** Who a Floor's commits are by: its own identity, or the office's. */
  floorGitIdentity(floorId: string): Promise<GitIdentity>;
  /** The Owner's profile: empty names and British time until set. */
  ownerProfile(): Promise<OwnerProfile>;
  /** Sets the Owner's profile, recording that it changed. */
  setOwnerProfile(profile: OwnerProfile): Promise<OwnerProfile>;
  /** The lobby's receptionist and visitor, each the default until set. */
  lobbyCast(): Promise<LobbyCast>;
  /** The idle activities turned off on each Floor, by its id. */
  floorActivities(): Promise<Record<string, string[]>>;
  /** Turns off a Floor's `disabled` activities, the rest on. */
  setFloorActivities(
    floorId: string,
    disabled: readonly string[],
  ): Promise<Record<string, string[]>>;
  /** The seasonal events: each on, on its usual dates, until set. */
  seasonalEvents(): Promise<SeasonalEvents>;
  /** Sets the seasonal events, recording that they changed. */
  setSeasonalEvents(events: SeasonalEvents): Promise<SeasonalEvents>;
  /** Sets one of the lobby's cast, recording that it changed. */
  setLobbyCharacter(
    role: LobbyRole,
    character: LobbyCharacter,
  ): Promise<LobbyCast>;
  /** Intake's settings, each the default until it is set. */
  intakeSettings(): Promise<IntakeSettings>;
  /** Sets intake's settings, recording which changed. */
  setIntakeSettings(settings: IntakeSettings): Promise<IntakeSettings>;
  /** How many sandboxes may run at once: 3 until it is set. */
  sandboxSettings(): Promise<SandboxSettings>;
  /** Sets the office-wide sandbox limit, recording that it changed. */
  setSandboxSettings(settings: SandboxSettings): Promise<SandboxSettings>;
  /** Whether the AI Gateway keeps request bodies: on until it is set. */
  requestBodiesSettings(): Promise<RequestBodiesSettings>;
  /** Turns body storage on or off, recording that it changed. */
  setRequestBodiesSettings(
    settings: RequestBodiesSettings,
  ): Promise<RequestBodiesSettings>;
  /** How the Gateway balances requests: sessions of 5 hours until set. */
  loadBalancingSettings(): Promise<LoadBalancingSettings>;
  /** Sets the strategy and session window, recording which changed. */
  setLoadBalancingSettings(
    settings: LoadBalancingSettings,
  ): Promise<LoadBalancingSettings>;
  /**
   * How the Gateway retries and when a failing account's circuit opens:
   * three attempts from 500 ms, doubling; five failures, for a minute.
   */
  retrySettings(): Promise<GatewayRetrySettings>;
  /** Sets them, recording which changed. */
  setRetrySettings(
    settings: GatewayRetrySettings,
  ): Promise<GatewayRetrySettings>;
  /** The Gateway's pacing gates (FR-38): both off until set. */
  usageThrottlingSettings(): Promise<UsageThrottlingSettings>;
  /** Sets them, recording which changed. */
  setUsageThrottlingSettings(
    settings: UsageThrottlingSettings,
  ): Promise<UsageThrottlingSettings>;
  /** The Gateway's prompt-cache TTL: as each request sends it until set. */
  promptCacheSettings(): Promise<PromptCacheSettings>;
  /** Sets it, recording that it changed. */
  setPromptCacheSettings(
    settings: PromptCacheSettings,
  ): Promise<PromptCacheSettings>;
  /** Whether the Gateway auto-refreshes usage windows (FR-39): off until set. */
  autoRefreshSettings(): Promise<AutoRefreshSettings>;
  /** Turns auto-refresh on or off, recording that it changed. */
  setAutoRefreshSettings(
    settings: AutoRefreshSettings,
  ): Promise<AutoRefreshSettings>;
  /** Whether requests waterfall through Combos (FR-40): off until set. */
  comboSettings(): Promise<ComboSettings>;
  /** Turns every Combo on or off, recording that it changed. */
  setComboSettings(settings: ComboSettings): Promise<ComboSettings>;
  /**
   * Prompt-cache keep-alive (FR-39): off until set; then sessions are kept
   * warm for 30 minutes after their last request, 60 keep-alives an hour
   * per AI Account.
   */
  keepAliveSettings(): Promise<PromptCacheKeepAliveSettings>;
  /** Sets them, recording which changed. */
  setKeepAliveSettings(
    settings: PromptCacheKeepAliveSettings,
  ): Promise<PromptCacheKeepAliveSettings>;
  /**
   * The Gateway's outbound proxy (FR-35): none until set. Whether it has
   * a password, never the password.
   */
  outboundProxySettings(): Promise<OutboundProxySettings>;
  /**
   * Sets it, or (a null `url`) removes it, recording which parts changed;
   * an absent password keeps the one stored while the username stays.
   */
  setOutboundProxySettings(
    update: OutboundProxyUpdate,
  ): Promise<OutboundProxySettings>;
  /** The proxy as the Gateway uses it, its password opened; null for none. */
  outboundProxy(): Promise<OutboundProxy | null>;
  /**
   * The Decision Model (FR-17, FR-89): off until set; then Jev 1.13,
   * without writing summaries.
   */
  decisionModelSettings(): Promise<DecisionModelSettings>;
  /** Sets it, recording which settings changed. */
  setDecisionModelSettings(
    settings: DecisionModelSettings,
  ): Promise<DecisionModelSettings>;
  /**
   * How long records are kept (PRD §7): bodies 7 days, requests' records
   * 90 and the Activity Feed a year, until set.
   */
  retentionSettings(): Promise<RetentionSettings>;
  /** Sets them, recording which changed. */
  setRetentionSettings(settings: RetentionSettings): Promise<RetentionSettings>;
}

/** Why the outbound proxy's settings could not be stored. */
export class OutboundProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundProxyError";
  }
}

export function createOfficeSettings(options: {
  readonly store: OfficeSettingsStore;
  readonly floors: FloorStore;
  readonly events: EventBus;
  /**
   * Seals the outbound proxy's password (ENCRYPTION_KEY); without it, a
   * proxy can be set only without one.
   */
  readonly encryptor?: Encryptor;
  /** Told the proxy's password in clear, so it can be redacted. */
  readonly onSecret?: (secret: string) => void;
  readonly now?: () => Date;
}): OfficeSettings {
  const { store, events, encryptor } = options;
  const now = options.now ?? (() => new Date());

  /** What the Owner sees of a stored proxy: never its password. */
  const proxySettingsOf = (
    stored: StoredOutboundProxy | undefined,
  ): OutboundProxySettings =>
    stored === undefined
      ? { ...defaultOutboundProxySettings }
      : {
          url: stored.url,
          username: stored.username,
          hasPassword: stored.password !== null,
          noProxy: [...stored.noProxy],
        };

  const gitIdentity = async (): Promise<OfficeGitIdentity> => {
    const set = await store.gitIdentity();
    return set === undefined
      ? { ...defaultGitIdentity, isDefault: true }
      : { ...set, isDefault: false };
  };

  return {
    gitIdentity,

    async setGitIdentity(identity) {
      const current = await gitIdentity();
      if (
        !current.isDefault &&
        current.name === identity.name &&
        current.email === identity.email
      ) {
        return current;
      }
      await store.setGitIdentity(identity, now());
      // Which setting changed, never its value.
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["gitIdentity"],
      });
      return { ...identity, isDefault: false };
    },

    async intakeSettings() {
      return { ...defaultIntakeSettings, ...(await store.intakeSettings()) };
    },

    async setIntakeSettings(settings) {
      const current = {
        ...defaultIntakeSettings,
        ...(await store.intakeSettings()),
      };
      const keys = (["ownerLogin", "intervalSeconds"] as const)
        .filter((key) => current[key] !== settings[key])
        .map((key) => `intake.${key}`);
      await store.setIntakeSettings(settings, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "office",
          keys,
        });
      }
      return { ...settings };
    },

    async sandboxSettings() {
      return {
        concurrencyLimit:
          (await store.sandboxConcurrencyLimit()) ??
          defaultSandboxConcurrencyLimit,
      };
    },

    async setSandboxSettings({ concurrencyLimit }) {
      const current =
        (await store.sandboxConcurrencyLimit()) ??
        defaultSandboxConcurrencyLimit;
      await store.setSandboxConcurrencyLimit(concurrencyLimit, now());
      if (current !== concurrencyLimit) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "office",
          keys: ["sandboxes.concurrencyLimit"],
        });
      }
      return { concurrencyLimit };
    },

    async requestBodiesSettings() {
      return { store: (await store.gatewayStoreBodies()) ?? true };
    },

    async setRequestBodiesSettings(settings) {
      const current = (await store.gatewayStoreBodies()) ?? true;
      await store.setGatewayStoreBodies(settings.store, now());
      if (current !== settings.store) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["requestBodies.store"],
        });
      }
      return { store: settings.store };
    },

    async loadBalancingSettings() {
      return {
        ...defaultLoadBalancingSettings,
        ...(await store.loadBalancing()),
      };
    },

    async setLoadBalancingSettings(settings) {
      const current = {
        ...defaultLoadBalancingSettings,
        ...(await store.loadBalancing()),
      };
      const keys = (["strategy", "sessionWindowMinutes"] as const)
        .filter((key) => current[key] !== settings[key])
        .map((key) => `loadBalancing.${key}`);
      await store.setLoadBalancing(settings, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys,
        });
      }
      return { ...settings };
    },

    async retrySettings() {
      return {
        ...defaultGatewayRetrySettings,
        ...(await store.gatewayRetries()),
      };
    },

    async setRetrySettings(settings) {
      const current = {
        ...defaultGatewayRetrySettings,
        ...(await store.gatewayRetries()),
      };
      const keys = retryKeys
        .filter((key) => current[key] !== settings[key])
        .map((key) => `retries.${key}`);
      await store.setGatewayRetries(settings, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys,
        });
      }
      return { ...settings };
    },

    async usageThrottlingSettings() {
      return {
        ...defaultUsageThrottlingSettings,
        ...(await store.usageThrottling()),
      };
    },

    async setUsageThrottlingSettings(settings) {
      const current = {
        ...defaultUsageThrottlingSettings,
        ...(await store.usageThrottling()),
      };
      const keys = throttlingKeys
        .filter((key) => current[key] !== settings[key])
        .map((key) => `usageThrottling.${key}`);
      await store.setUsageThrottling(settings, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys,
        });
      }
      return { ...settings };
    },

    async promptCacheSettings() {
      return {
        ttl: (await store.promptCacheTtl()) ?? defaultPromptCacheSettings.ttl,
      };
    },

    async setPromptCacheSettings(settings) {
      const current =
        (await store.promptCacheTtl()) ?? defaultPromptCacheSettings.ttl;
      await store.setPromptCacheTtl(settings.ttl, now());
      if (current !== settings.ttl) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["promptCache.ttl"],
        });
      }
      return { ttl: settings.ttl };
    },

    async autoRefreshSettings() {
      return {
        enabled:
          (await store.gatewayAutoRefresh()) ??
          defaultAutoRefreshSettings.enabled,
      };
    },

    async setAutoRefreshSettings(settings) {
      const current =
        (await store.gatewayAutoRefresh()) ??
        defaultAutoRefreshSettings.enabled;
      await store.setGatewayAutoRefresh(settings.enabled, now());
      if (current !== settings.enabled) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["autoRefresh.enabled"],
        });
      }
      return { enabled: settings.enabled };
    },

    async comboSettings() {
      return {
        enabled: (await store.gatewayCombos()) ?? defaultComboSettings.enabled,
      };
    },

    async setComboSettings(settings) {
      const current =
        (await store.gatewayCombos()) ?? defaultComboSettings.enabled;
      await store.setGatewayCombos(settings.enabled, now());
      if (current !== settings.enabled) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys: ["comboSettings.enabled"],
        });
      }
      return { enabled: settings.enabled };
    },

    async keepAliveSettings() {
      return {
        ...defaultPromptCacheKeepAliveSettings,
        ...(await store.promptCacheKeepAlive()),
      };
    },

    async setKeepAliveSettings(settings) {
      const current = {
        ...defaultPromptCacheKeepAliveSettings,
        ...(await store.promptCacheKeepAlive()),
      };
      const keys = keepAliveKeys
        .filter((key) => current[key] !== settings[key])
        .map((key) => `keepAlive.${key}`);
      await store.setPromptCacheKeepAlive(settings, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys,
        });
      }
      return { ...settings };
    },

    async outboundProxySettings() {
      return proxySettingsOf(await store.gatewayOutboundProxy());
    },

    async setOutboundProxySettings(update) {
      const current = await store.gatewayOutboundProxy();
      let next: StoredOutboundProxy | null = null;
      if (update.url !== null) {
        const username = update.username ?? null;
        let password: string | null;
        if (update.password === undefined) {
          // Kept while it is for the same username.
          password =
            username !== null && username === current?.username
              ? current.password
              : null;
        } else if (update.password === null) {
          password = null;
        } else {
          if (encryptor === undefined) {
            throw new OutboundProxyError(
              "A proxy password cannot be stored without an encryption key.",
            );
          }
          options.onSecret?.(update.password);
          password = encryptor.encrypt(
            update.password,
            outboundProxyPasswordContext,
          );
        }
        next = {
          url: update.url,
          username,
          password,
          noProxy: [...new Set(update.noProxy ?? current?.noProxy ?? [])],
        };
      }
      // Which parts changed, never their values.
      const keys = [
        (current?.url ?? null) !== (next?.url ?? null) ? "url" : undefined,
        (current?.username ?? null) !== (next?.username ?? null)
          ? "username"
          : undefined,
        (current?.password ?? null) !== (next?.password ?? null)
          ? "password"
          : undefined,
        JSON.stringify(current?.noProxy ?? []) !==
        JSON.stringify(next?.noProxy ?? [])
          ? "noProxy"
          : undefined,
      ]
        .filter((key) => key !== undefined)
        .map((key) => `outboundProxy.${key}`);
      await store.setGatewayOutboundProxy(next, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "gateway",
          keys,
        });
      }
      return proxySettingsOf(next ?? undefined);
    },

    async decisionModelSettings() {
      return {
        ...defaultDecisionModelSettings,
        ...(await store.decisionModel()),
      };
    },

    async setDecisionModelSettings(settings) {
      const current = {
        ...defaultDecisionModelSettings,
        ...(await store.decisionModel()),
      };
      const keys = decisionModelKeys
        .filter((key) => current[key] !== settings[key])
        .map((key) => `decisionModel.${key}`);
      await store.setDecisionModel(settings, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "office",
          keys,
        });
      }
      return { ...settings };
    },

    async outboundProxy() {
      const stored = await store.gatewayOutboundProxy();
      if (stored === undefined) {
        return null;
      }
      let password: string | null = null;
      if (stored.password !== null) {
        if (encryptor === undefined) {
          throw new OutboundProxyError(
            "The proxy's password cannot be opened without the encryption key.",
          );
        }
        password = encryptor.decrypt(
          stored.password,
          outboundProxyPasswordContext,
        );
        options.onSecret?.(password);
      }
      return {
        url: stored.url,
        username: stored.username,
        password,
        noProxy: stored.noProxy,
      };
    },

    async retentionSettings() {
      return { ...defaultRetentionSettings, ...(await store.retention()) };
    },

    async setRetentionSettings(settings) {
      const current = {
        ...defaultRetentionSettings,
        ...(await store.retention()),
      };
      const keys = retentionKeys
        .filter((key) => current[key] !== settings[key])
        .map((key) => `retention.${key}`);
      await store.setRetention(settings, now());
      if (keys.length > 0) {
        await events.publish({
          type: "config.changed",
          version: 1,
          scope: "office",
          keys,
        });
      }
      return { ...settings };
    },

    async floorGitIdentity(floorId) {
      const floor = await options.floors.get(floorId);
      if (floor === undefined) {
        throw new FloorError(
          floorErrorCodes.floorNotFound,
          `There is no Floor "${floorId}".`,
        );
      }
      const { name, email } = await gitIdentity();
      return gitIdentityFor({ name, email }, floor);
    },

    async ownerProfile() {
      return { ...defaultOwnerProfile, ...(await store.ownerProfile()) };
    },

    async setOwnerProfile(profile) {
      await store.setOwnerProfile(profile, now());
      // Which setting changed, never its value.
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["ownerProfile"],
      });
      return { ...profile };
    },

    async lobbyCast() {
      return { ...defaultLobbyCast, ...(await store.lobbyCast()) };
    },

    floorActivities: () => store.floorActivities(),

    async setFloorActivities(floorId, disabled) {
      if ((await options.floors.get(floorId)) === undefined) {
        throw new FloorError(
          floorErrorCodes.floorNotFound,
          `There is no Floor "${floorId}".`,
        );
      }
      const activities = Object.fromEntries([
        ...Object.entries(await store.floorActivities()).filter(
          ([id]) => id !== floorId,
        ),
        ...(disabled.length === 0 ? [] : [[floorId, [...disabled]]]),
      ]) as Record<string, string[]>;
      await store.setFloorActivities(activities, now());
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "floor",
        floorId,
        keys: ["activities"],
      });
      return activities;
    },

    async seasonalEvents() {
      return (
        (await store.seasonalEvents()) ?? structuredClone(defaultSeasonalEvents)
      );
    },

    async setSeasonalEvents(seasonal) {
      await store.setSeasonalEvents(seasonal, now());
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["seasonalEvents"],
      });
      return structuredClone(seasonal);
    },

    async setLobbyCharacter(role, character) {
      const cast = { ...(await store.lobbyCast()), [role]: character };
      await store.setLobbyCast(cast, now());
      await events.publish({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: [`lobbyCast.${role}`],
      });
      return { ...defaultLobbyCast, ...cast };
    },
  };
}
