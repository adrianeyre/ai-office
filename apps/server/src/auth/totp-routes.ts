import {
  apiErrorCodes,
  isTotpCode,
  totpCodeRequestSchema,
  totpSetupRequestSchema,
  type ApiError,
  type TotpEnableResponse,
  type TotpSetupResponse,
  type TotpStatus,
} from "@ai-office/shared";
import type { EventBus } from "@ai-office/events";
import type { Encryptor } from "@ai-office/shared/crypto";
import type { FastifyInstance, FastifyReply } from "fastify";

import { clientOf, recordAttempt } from "./attempts.ts";
import { clientKey, type LoginLimiter } from "./login-limiter.ts";
import type { ProveOwner } from "./owner-proof.ts";
import { sendInvalidRequest, sendTooManyAttempts } from "./responses.ts";
import { signInChanged } from "./sign-in-changes.ts";
import type { AuthStore, TotpRecord } from "./store.ts";
import {
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  openTotpSecret,
  sealTotpSecret,
  verifyTotpCode,
} from "./totp.ts";

export type SecondFactor = "totp" | "recovery_code";

/**
 * Checks `code` against the Owner's TOTP secret, or else their unused
 * recovery codes, and uses it up: a TOTP code's time step cannot be used
 * again, and a recovery code works once.
 */
export async function useSecondFactor(options: {
  readonly store: AuthStore;
  readonly encryptor: Encryptor;
  readonly totp: TotpRecord & { readonly secret: string };
  readonly code: string;
  readonly now: Date;
}): Promise<{ readonly factor: SecondFactor; readonly valid: boolean }> {
  const { store, totp, code, now } = options;
  if (!isTotpCode(code)) {
    return {
      factor: "recovery_code",
      valid: await store.useRecoveryCode(hashRecoveryCode(code), now),
    };
  }
  const timeStep = await verifyTotpCode({
    secret: openTotpSecret(options.encryptor, totp.secret),
    code,
    now,
    afterTimeStep: totp.lastTimeStep ?? undefined,
  });
  return {
    factor: "totp",
    valid: timeStep !== undefined && (await store.useTotpTimeStep(timeStep)),
  };
}

const conflict = (reply: FastifyReply, error: string, message: string) =>
  reply.code(409).send({ error, message } satisfies ApiError);

const wrongCode = (reply: FastifyReply, message: string) =>
  // 422, not 401: the session is fine, the code is not.
  reply
    .code(422)
    .send({ error: apiErrorCodes.wrongCode, message } satisfies ApiError);

/**
 * The Owner's TOTP settings in the office admin (PRD FR-3, FR-65): set up
 * a secret, confirm it with a code to turn TOTP on (getting the recovery
 * codes once), and turn it off with a current code. Turning it on or off is
 * in the Activity Feed, and so is each code refused for turning it off
 * (A1-5): never the secret or a code.
 */
export function registerTotpRoutes(
  app: FastifyInstance,
  options: {
    readonly store: AuthStore;
    readonly encryptor: Encryptor;
    readonly loginLimiter: LoginLimiter;
    readonly now: () => Date;
    /** Checks a fresh proof of the Owner (A1-3). */
    readonly proveOwner: ProveOwner;
    /** Where TOTP turned on or off, and refused codes, are published. */
    readonly events: EventBus;
  },
): void {
  const { store, encryptor, loginLimiter, now, events } = options;

  app.get("/api/totp", { config: { access: "owner" } }, async () => {
    const totp = await store.totp();
    const enabled = totp.secret !== null;
    return {
      enabled,
      recoveryCodesLeft: enabled ? totp.recoveryCodesLeft : 0,
    } satisfies TotpStatus;
  });

  // Turning TOTP on needs the current password (A1-3): otherwise a stolen
  // session could turn it on with its own secret, keep the recovery codes,
  // and lock the Owner out.
  app.post(
    "/api/totp/setup",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = totpSetupRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      if ((await store.totp()).secret !== null) {
        return conflict(
          reply,
          apiErrorCodes.totpEnabled,
          "TOTP is already on. Turn it off first.",
        );
      }
      if (!(await options.proveOwner(request, reply, parsed.data))) {
        return reply;
      }
      const { secret, otpauthUrl, qrCode } = await newTotpSecret();
      await store.setPendingTotpSecret(sealTotpSecret(encryptor, secret));
      request.log.info("A new TOTP secret was set up, awaiting a code.");
      return reply
        .header("cache-control", "no-store")
        .send({ secret, otpauthUrl, qrCode } satisfies TotpSetupResponse);
    },
  );

  app.post(
    "/api/totp/enable",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = totpCodeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const totp = await store.totp();
      if (totp.secret !== null) {
        return conflict(
          reply,
          apiErrorCodes.totpEnabled,
          "TOTP is already on.",
        );
      }
      if (totp.pendingSecret === null) {
        return conflict(
          reply,
          apiErrorCodes.totpNotSetUp,
          "Set up TOTP first.",
        );
      }
      const timeStep = await verifyTotpCode({
        secret: openTotpSecret(encryptor, totp.pendingSecret),
        code: parsed.data.code,
        now: now(),
      });
      if (timeStep === undefined) {
        return wrongCode(
          reply,
          "That code is not right. Check the app's clock and try the next code.",
        );
      }
      const recoveryCodes = newRecoveryCodes();
      const enabled = await store.enableTotp({
        pendingSecret: totp.pendingSecret,
        timeStep,
        recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
        at: now(),
      });
      if (!enabled) {
        // Another tab set up a new secret, or turned TOTP on, meanwhile.
        return conflict(
          reply,
          apiErrorCodes.totpNotSetUp,
          "TOTP was set up again elsewhere. Start over.",
        );
      }
      await signInChanged(events, "totp.enabled");
      request.log.info("TOTP was turned on.");
      return reply
        .header("cache-control", "no-store")
        .send({ recoveryCodes } satisfies TotpEnableResponse);
    },
  );

  // Limited and recorded like sign-ins: a stolen session must not be able
  // to guess its way to turning TOTP off, nor try unseen (A1-5).
  app.post(
    "/api/totp/disable",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = totpCodeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const totp = await store.totp();
      if (totp.secret === null) {
        return conflict(reply, apiErrorCodes.totpDisabled, "TOTP is off.");
      }
      const client = clientKey(request.ip);
      const attempt = loginLimiter.attempt(client);
      if (!attempt.allowed) {
        return sendTooManyAttempts(reply, attempt.retryAfterSeconds);
      }
      const event = clientOf(request, now);
      const { factor, valid } = await useSecondFactor({
        store,
        encryptor,
        totp: { ...totp, secret: totp.secret },
        code: parsed.data.code,
        now: event.occurredAt,
      });
      if (!valid) {
        await recordAttempt(
          { store, events },
          { ...event, outcome: "failed", secondFactor: factor },
          { lockoutMs: attempt.lockoutMs },
        );
        request.log.warn(
          { client, secondFactor: factor },
          "Turning TOTP off was refused: wrong code.",
        );
        return wrongCode(reply, "That code is not right, or was already used.");
      }
      attempt.succeeded();
      // In `sign_in_events`, but no sign-in: the change itself is announced.
      await recordAttempt(
        { store, events },
        { ...event, outcome: "succeeded", secondFactor: factor },
        { announceSuccess: false },
      );
      await store.disableTotp();
      await signInChanged(events, "totp.disabled");
      request.log.info("TOTP was turned off.");
      return reply.code(204).send();
    },
  );
}
