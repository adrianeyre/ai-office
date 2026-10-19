import {
  AiAccountError,
  limitOf,
  type AiAccountInfo,
  type AiAccounts,
  type OAuthLoginStarted,
} from "@ai-office/gateway";
import {
  addAiAccountRequestSchema,
  aiAccountErrorCodes,
  aiAccountUpdateSchema,
  completeOAuthLoginRequestSchema,
  importOAuthLoginRequestSchema,
  offersExtraUsage,
  startOAuthLoginRequestSchema,
  tokenHealthOf,
  type AiAccount,
  type AiAccountErrorCode,
  type ApiError,
  type OAuthLogin,
  type OAuthLoginStatus,
  type RateLimits,
  type RateLimitState,
  type UsageReading,
  type UsageWindowState,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";
import type { OAuthCallbacks } from "./oauth-callback.ts";

// The AI Accounts API (PRD FR-35, FR-36), a thin adapter over the
// Gateway's AI Accounts: list, add a key-based account (an API key, or an
// AWS Bedrock or Google Vertex AI account), add a subscription
// through its OAuth login (or sign one in again), rename, reprioritise,
// pause, resume, set its usage pause thresholds, force a Model, turn extra
// usage on or off (FR-41), force-reset its rate-limit state, read its usage history (and its usage windows from its AI
// Provider, for a Claude subscription) and delete it. A credential is taken once, when the account
// is added; no answer ever carries it, nor a subscription's tokens. Every
// route needs a signed-in session.

const statusFor: Record<AiAccountErrorCode, number> = {
  [aiAccountErrorCodes.aiAccountNotFound]: 404,
  [aiAccountErrorCodes.aiAccountNameTaken]: 409,
  [aiAccountErrorCodes.notOAuthAccount]: 409,
  [aiAccountErrorCodes.oauthLoginNotFound]: 404,
  [aiAccountErrorCodes.oauthCodeRefused]: 400,
  [aiAccountErrorCodes.oauthUnavailable]: 502,
  [aiAccountErrorCodes.oauthLoginPending]: 409,
  [aiAccountErrorCodes.loginNotImportable]: 400,
  [aiAccountErrorCodes.forcedModelMismatch]: 400,
  [aiAccountErrorCodes.extraUsageNotOffered]: 400,
  [aiAccountErrorCodes.cloudCredentialsUnusable]: 400,
};

/**
 * An AI Account as the API sends it. Each field is named, so a credential
 * could not slip in with a spread.
 */
export const aiAccountBody = (
  account: AiAccountInfo,
  now: Date,
): AiAccount => ({
  id: account.id,
  name: account.name,
  aiProvider: account.aiProvider,
  accountType: account.accountType,
  endpointUrl: account.endpointUrl,
  region: account.region,
  projectId: account.projectId,
  priority: account.priority,
  paused: account.paused,
  tokenHealth:
    account.tokenExpiresAt === null
      ? null
      : tokenHealthOf(account.tokenExpiresAt, now),
  tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
  reauthenticationNeeded: account.reauthenticationNeeded,
  // Only a limit that has not yet run out holds the account back.
  ...(() => {
    const limit = limitOf(account, now);
    return {
      limitReason: limit?.reason ?? null,
      limitedUntil: limit?.until.toISOString() ?? null,
    };
  })(),
  // A window that has reset since it was reported is not running.
  usage: {
    fiveHour: windowBody(
      account.fiveHourUtilization,
      account.fiveHourResetsAt,
      now,
    ),
    weekly: windowBody(account.weeklyUtilization, account.weeklyResetsAt, now),
  },
  fiveHourPauseThreshold: account.fiveHourPauseThreshold,
  weeklyPauseThreshold: account.weeklyPauseThreshold,
  forcedModel: account.forcedModel,
  extraUsage: offersExtraUsage(account) ? account.extraUsage : null,
  rateLimits: rateLimitsBody(account.rateLimits ?? null, now),
  balance: account.balance ?? null,
  createdAt: account.createdAt.toISOString(),
  updatedAt: account.updatedAt.toISOString(),
});

/**
 * Rate limits as the API sends them: one whose reset has passed is full
 * again (the AI Provider replenishes it by then), and its reset unknown.
 */
const rateLimitsBody = (
  rateLimits: RateLimits | null,
  now: Date,
): RateLimits | null => {
  if (rateLimits === null) {
    return null;
  }
  const state = (limit: RateLimitState | null): RateLimitState | null =>
    limit?.resetsAt == null || new Date(limit.resetsAt) > now
      ? limit
      : { limit: limit.limit, remaining: limit.limit, resetsAt: null };
  return {
    requests: state(rateLimits.requests),
    tokens: state(rateLimits.tokens),
    inputTokens: state(rateLimits.inputTokens),
    outputTokens: state(rateLimits.outputTokens),
    observedAt: rateLimits.observedAt,
  };
};

/**
 * A usage window as the API sends it: one that has reset is not running,
 * and nothing of it is used until a request starts the next.
 */
const windowBody = (
  utilization: number | null,
  resetsAt: Date | null,
  now: Date,
): UsageWindowState | null =>
  utilization === null || resetsAt === null
    ? null
    : resetsAt <= now
      ? { utilization: 0, resetsAt: null }
      : { utilization, resetsAt: resetsAt.toISOString() };

/** How far back an account's usage history goes, and how much of it. */
const usageHistoryDays = 7;
const usageHistoryLimit = 500;

const loginBody = (login: OAuthLoginStarted): OAuthLogin => ({
  loginId: login.loginId,
  authorizeUrl: login.authorizeUrl,
  ...(login.userCode === undefined ? {} : { userCode: login.userCode }),
  expiresAt: login.expiresAt.toISOString(),
});

/** Answers an `AiAccountError` with its status; anything else is rethrown. */
const sendAiAccountError = (
  reply: FastifyReply,
  error: unknown,
): FastifyReply => {
  if (!(error instanceof AiAccountError)) {
    throw error;
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

interface AccountParams {
  readonly accountId: string;
}

export function registerAiAccountRoutes(
  app: FastifyInstance,
  options: {
    readonly accounts: AiAccounts;
    /** The clock token health is told against. */
    readonly now?: () => Date;
    /**
     * Listens on a sign-in's local callback, such as ChatGPT's, while it
     * waits; without it, the Owner always pastes the address back.
     */
    readonly callbacks?: OAuthCallbacks;
    /**
     * The tokens each request an AI Account served since `since` used (the
     * request history's); without it, no account says its share of the day.
     */
    readonly accountTokensSince?: (
      since: Date,
    ) => Promise<
      readonly { readonly accountId: string; readonly tokens: number }[]
    >;
  },
): void {
  const { accounts } = options;
  /** Listens for the login's callback, if AI Office can serve it. */
  const expectCallback = async (login: OAuthLoginStarted): Promise<void> => {
    if (login.redirectUri !== undefined) {
      await options.callbacks?.expect(login.redirectUri);
    }
  };
  const now = options.now ?? (() => new Date());
  const body = (account: AiAccountInfo) => aiAccountBody(account, now());

  /**
   * A subscription just signed in, with its usage windows read from its AI
   * Provider when it reports them, so they show at once (FR-36). Not
   * reading them leaves it as it was: the next round tries again.
   */
  const withUsage = async (account: AiAccountInfo): Promise<AiAccountInfo> => {
    const report = await accounts.refreshUsage(account.id).catch(() => null);
    if (report === null || report.refreshed.length === 0) {
      return account;
    }
    return (
      (await accounts.list()).find(({ id }) => id === account.id) ?? account
    );
  };

  app.get("/api/ai-accounts", { config: { access: "owner" } }, async () => {
    const at = now();
    const listed = (await accounts.list()).map((account) =>
      aiAccountBody(account, at),
    );
    if (options.accountTokensSince === undefined) {
      return { accounts: listed };
    }
    // Each account's share of the Gateway's tokens today (UTC), for the
    // accounts whose AI Provider reports nothing else.
    const today = new Date(at);
    today.setUTCHours(0, 0, 0, 0);
    const served = new Map<string, number>();
    let gatewayTokens = 0;
    for (const { accountId, tokens } of await options.accountTokensSince(
      today,
    )) {
      served.set(accountId, (served.get(accountId) ?? 0) + tokens);
      gatewayTokens += tokens;
    }
    return {
      accounts: listed.map((account) => ({
        ...account,
        tokensToday: { tokens: served.get(account.id) ?? 0, gatewayTokens },
      })),
    };
  });

  app.post(
    "/api/ai-accounts",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = addAiAccountRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        // The problems name what was wrong, never the values given.
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const account = await accounts.add(parsed.data);
        request.log.info(
          { aiAccountId: account.id },
          "An AI Account was added.",
        );
        return await reply.code(201).send(body(account));
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  // A subscription's OAuth login (PKCE): start it, have the Owner sign in
  // at `authorizeUrl`, then finish it with the code they paste back.
  app.post(
    "/api/ai-accounts/oauth",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = startOAuthLoginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const login = await accounts.startLogin(parsed.data);
        await expectCallback(login);
        return await reply
          .code(201)
          .header("cache-control", "no-store")
          .send(loginBody(login));
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  // An existing CLI login, such as the Grok CLI's `~/.grok/auth.json`,
  // added as a subscription. Its tokens never come back out.
  app.post(
    "/api/ai-accounts/import",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = importOAuthLoginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        // Never the login itself.
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const account = await withUsage(
          await accounts.importLogin(parsed.data),
        );
        request.log.info(
          { aiAccountId: account.id },
          "A subscription AI Account was imported.",
        );
        return await reply.code(201).send(body(account));
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  app.post<{ Params: AccountParams }>(
    "/api/ai-accounts/:accountId/reauthenticate",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const login = await accounts.startLogin({
          accountId: request.params.accountId,
        });
        await expectCallback(login);
        return await reply
          .code(201)
          .header("cache-control", "no-store")
          .send(loginBody(login));
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  // Whether a login was finished on its callback, for the page to stop
  // waiting for a pasted address.
  app.get<{ Params: { readonly loginId: string } }>(
    "/api/ai-accounts/oauth/:loginId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const status = await accounts.loginStatus(request.params.loginId);
        const sent: OAuthLoginStatus =
          status.status === "pending"
            ? { status: "pending" }
            : {
                status: "done",
                account: body(await withUsage(status.account)),
                added: status.added,
              };
        return await reply.header("cache-control", "no-store").send(sent);
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  app.post<{ Params: { readonly loginId: string } }>(
    "/api/ai-accounts/oauth/:loginId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = completeOAuthLoginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        // Never the code itself.
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const { account, added } = await accounts.completeLogin(
          request.params.loginId,
          parsed.data.code,
        );
        request.log.info(
          { aiAccountId: account.id },
          added
            ? "A subscription AI Account was added."
            : "An AI Account signed in again.",
        );
        return await reply
          .code(added ? 201 : 200)
          .send(body(await withUsage(account)));
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  app.patch<{ Params: AccountParams }>(
    "/api/ai-accounts/:accountId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = aiAccountUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const account = await accounts.update(
          request.params.accountId,
          parsed.data,
        );
        request.log.info(
          { aiAccountId: account.id },
          "An AI Account was changed.",
        );
        return body(account);
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  // Force-reset (FR-36): the AI Gateway uses the account again at once.
  app.post<{ Params: AccountParams }>(
    "/api/ai-accounts/:accountId/reset-limits",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const account = await accounts.resetLimits(request.params.accountId);
        request.log.info(
          { aiAccountId: account.id },
          "An AI Account's rate-limit state was reset.",
        );
        return body(account);
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  // A subscription's usage windows, read now from its AI Provider rather
  // than from the last request through it (FR-36).
  app.post<{ Params: AccountParams }>(
    "/api/ai-accounts/:accountId/refresh-usage",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const { accountId } = request.params;
        const report = await accounts.refreshUsage(accountId);
        if (report.failed.length > 0) {
          request.log.warn(
            { err: report.failed[0]?.error, aiAccountId: accountId },
            "An AI Account's usage could not be read.",
          );
          const error: ApiError = {
            error: aiAccountErrorCodes.oauthUnavailable,
            message: "Its AI Provider did not say how much has been used.",
          };
          return await reply.code(502).send(error);
        }
        const account = (await accounts.list()).find(
          ({ id }) => id === accountId,
        );
        return account === undefined
          ? await reply.code(404).send()
          : body(account);
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  // Usage history (FR-43): each change of its windows, for the last week.
  app.get<{ Params: AccountParams }>(
    "/api/ai-accounts/:accountId/usage",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        const readings = await accounts.usageHistory(request.params.accountId, {
          since: new Date(now().getTime() - usageHistoryDays * 86_400_000),
          limit: usageHistoryLimit,
        });
        return {
          usage: readings.map((reading): UsageReading => ({
            window: reading.window,
            utilization: reading.utilization,
            resetsAt: reading.resetsAt.toISOString(),
            observedAt: reading.observedAt.toISOString(),
          })),
        };
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );

  app.delete<{ Params: AccountParams }>(
    "/api/ai-accounts/:accountId",
    { config: { access: "owner" } },
    async (request, reply) => {
      try {
        await accounts.remove(request.params.accountId);
        request.log.info(
          { aiAccountId: request.params.accountId },
          "An AI Account was deleted.",
        );
        return await reply.code(204).send();
      } catch (error) {
        return sendAiAccountError(reply, error);
      }
    },
  );
}
