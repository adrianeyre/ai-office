import type { OfficeSettings } from "@ai-office/orchestrator";
import {
  decisionModelSettingsSchema,
  gatewayRetrySettingsSchema,
  gitIdentitySchema,
  intakeSettingsSchema,
  loadBalancingSettingsSchema,
  lobbyCharacterSchema,
  lobbyRoles,
  ownerProfileSchema,
  setFloorActivitiesRequestSchema,
  promptCacheKeepAliveSettingsSchema,
  promptCacheSettingsSchema,
  seasonalEventsSchema,
  usageThrottlingSettingsSchema,
  autoRefreshSettingsSchema,
  comboSettingsSchema,
  outboundProxyUpdateSchema,
  requestBodiesSettingsSchema,
  retentionSettingsSchema,
  sandboxSettingsSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sendInvalidRequest } from "../auth/responses.ts";
import { sendFloorError } from "../floors/routes.ts";

// The office admin's settings (PRD FR-65). So far: the Git identity agent
// commits are by (FR-68), which each Floor can override in its own
// settings; intake's (FR-8): the Owner's GitHub login and how often intake
// checks for issues; how many sandboxes may run at once (FR-22); and
// whether the AI Gateway keeps request and response bodies (FR-44); how it
// balances requests (FR-37); how it retries them (FR-39); the TTL it
// gives prompt-cache breakpoints (§6.8), and whether it keeps Agents'
// prompt caches warm (FR-39); whether requests waterfall through Combos
// (FR-40), whose chains are the Gateway's own routes; the outbound HTTP
// proxy every upstream request goes through (FR-35), whose password goes
// in and never comes back out; the Decision Model (FR-17, FR-89); how long
// records are kept (retention, §7); the Owner's profile, which the lobby's
// receptionist greets them by; and the lobby's cast, the receptionist and
// the visitor.

export function registerOfficeRoutes(
  app: FastifyInstance,
  options: { readonly settings: OfficeSettings },
): void {
  const { settings } = options;

  app.get("/api/office/git-identity", { config: { access: "owner" } }, () =>
    settings.gitIdentity(),
  );

  app.put(
    "/api/office/git-identity",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = gitIdentitySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const identity = await settings.setGitIdentity(parsed.data);
      request.log.info("The office's Git identity was set.");
      return identity;
    },
  );

  app.get("/api/office/profile", { config: { access: "owner" } }, () =>
    settings.ownerProfile(),
  );

  app.put(
    "/api/office/profile",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = ownerProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const profile = await settings.setOwnerProfile(parsed.data);
      request.log.info("The Owner's profile was set.");
      return profile;
    },
  );

  app.get(
    "/api/office/activities",
    { config: { access: "owner" } },
    async () => ({
      disabled: await settings.floorActivities(),
    }),
  );

  app.put<{ Params: { readonly floorId: string } }>(
    "/api/floors/:floorId/activities",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = setFloorActivitiesRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const disabled = await settings.setFloorActivities(
          request.params.floorId,
          parsed.data.disabled,
        );
        request.log.info(
          { floorId: request.params.floorId },
          "A Floor's idle activities were set.",
        );
        return { disabled };
      } catch (error) {
        return sendFloorError(reply, error);
      }
    },
  );

  app.get("/api/office/lobby-cast", { config: { access: "owner" } }, () =>
    settings.lobbyCast(),
  );

  app.put(
    "/api/office/lobby-cast/:role",
    { config: { access: "owner" } },
    async (request, reply) => {
      const role = z
        .object({ role: z.enum(lobbyRoles) })
        .safeParse(request.params);
      if (!role.success) {
        return sendInvalidRequest(reply, role.error);
      }
      const parsed = lobbyCharacterSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const cast = await settings.setLobbyCharacter(
        role.data.role,
        parsed.data,
      );
      request.log.info(`The lobby's ${role.data.role} was set.`);
      return cast;
    },
  );

  app.get("/api/office/intake", { config: { access: "owner" } }, () =>
    settings.intakeSettings(),
  );

  app.put(
    "/api/office/intake",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = intakeSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const intake = await settings.setIntakeSettings(parsed.data);
      request.log.info("The office's intake settings were set.");
      return intake;
    },
  );

  app.get("/api/office/sandboxes", { config: { access: "owner" } }, () =>
    settings.sandboxSettings(),
  );

  app.put(
    "/api/office/sandboxes",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = sandboxSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const sandboxes = await settings.setSandboxSettings(parsed.data);
      request.log.info("The office's sandbox limit was set.");
      return sandboxes;
    },
  );

  app.get("/api/office/request-bodies", { config: { access: "owner" } }, () =>
    settings.requestBodiesSettings(),
  );

  app.put(
    "/api/office/request-bodies",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = requestBodiesSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const bodies = await settings.setRequestBodiesSettings(parsed.data);
      request.log.info(
        { store: bodies.store },
        "Request body storage was turned on or off.",
      );
      return bodies;
    },
  );

  // The seasonal events: Christmas, Halloween, Easter and New Year, each
  // on or off, its dates, actors and extras.
  app.get("/api/office/seasonal-events", { config: { access: "owner" } }, () =>
    settings.seasonalEvents(),
  );

  app.put(
    "/api/office/seasonal-events",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = seasonalEventsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const seasonal = await settings.setSeasonalEvents(parsed.data);
      request.log.info("The seasonal events were set.");
      return seasonal;
    },
  );

  app.get("/api/office/prompt-cache", { config: { access: "owner" } }, () =>
    settings.promptCacheSettings(),
  );

  app.put(
    "/api/office/prompt-cache",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = promptCacheSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const cache = await settings.setPromptCacheSettings(parsed.data);
      request.log.info(
        { ttl: cache.ttl },
        "The AI Gateway's prompt-cache TTL was set.",
      );
      return cache;
    },
  );

  app.get("/api/office/load-balancing", { config: { access: "owner" } }, () =>
    settings.loadBalancingSettings(),
  );

  app.put(
    "/api/office/load-balancing",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = loadBalancingSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const balancing = await settings.setLoadBalancingSettings(parsed.data);
      request.log.info(
        { strategy: balancing.strategy },
        "The AI Gateway's load balancing was set.",
      );
      return balancing;
    },
  );

  app.get("/api/office/usage-throttling", { config: { access: "owner" } }, () =>
    settings.usageThrottlingSettings(),
  );

  app.put(
    "/api/office/usage-throttling",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = usageThrottlingSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const throttling = await settings.setUsageThrottlingSettings(parsed.data);
      request.log.info(
        throttling,
        "The AI Gateway's usage throttling was set.",
      );
      return throttling;
    },
  );

  app.get("/api/office/auto-refresh", { config: { access: "owner" } }, () =>
    settings.autoRefreshSettings(),
  );

  app.put(
    "/api/office/auto-refresh",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = autoRefreshSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const autoRefresh = await settings.setAutoRefreshSettings(parsed.data);
      request.log.info(autoRefresh, "The AI Gateway's auto-refresh was set.");
      return autoRefresh;
    },
  );

  app.get(
    "/api/office/prompt-cache-keep-alive",
    { config: { access: "owner" } },
    () => settings.keepAliveSettings(),
  );

  app.put(
    "/api/office/prompt-cache-keep-alive",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = promptCacheKeepAliveSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const keepAlive = await settings.setKeepAliveSettings(parsed.data);
      request.log.info(
        keepAlive,
        "The AI Gateway's prompt-cache keep-alive was set.",
      );
      return keepAlive;
    },
  );

  app.get("/api/office/decision-model", { config: { access: "owner" } }, () =>
    settings.decisionModelSettings(),
  );

  app.put(
    "/api/office/decision-model",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = decisionModelSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const decisionModel = await settings.setDecisionModelSettings(
        parsed.data,
      );
      request.log.info(decisionModel, "The Decision Model was set.");
      return decisionModel;
    },
  );

  app.get("/api/office/outbound-proxy", { config: { access: "owner" } }, () =>
    settings.outboundProxySettings(),
  );

  app.put(
    "/api/office/outbound-proxy",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = outboundProxyUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const proxy = await settings.setOutboundProxySettings(parsed.data);
      // What the Owner sees of it: never the password.
      request.log.info(proxy, "The AI Gateway's outbound proxy was set.");
      return proxy;
    },
  );

  app.get("/api/office/combos", { config: { access: "owner" } }, () =>
    settings.comboSettings(),
  );

  app.put(
    "/api/office/combos",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = comboSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const combos = await settings.setComboSettings(parsed.data);
      request.log.info(
        combos,
        "The AI Gateway's Combos were turned on or off.",
      );
      return combos;
    },
  );

  app.get("/api/office/retries", { config: { access: "owner" } }, () =>
    settings.retrySettings(),
  );

  app.put(
    "/api/office/retries",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = gatewayRetrySettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const retries = await settings.setRetrySettings(parsed.data);
      request.log.info(
        { attempts: retries.attempts },
        "The AI Gateway's retries were set.",
      );
      return retries;
    },
  );

  app.get("/api/office/retention", { config: { access: "owner" } }, () =>
    settings.retentionSettings(),
  );

  app.put(
    "/api/office/retention",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = retentionSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const retention = await settings.setRetentionSettings(parsed.data);
      request.log.info(retention, "Retention was set.");
      return retention;
    },
  );
}
