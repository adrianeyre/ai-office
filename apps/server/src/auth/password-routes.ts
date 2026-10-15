import { randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import type { OfficeSettings } from "@ai-office/orchestrator";
import {
  addOwnerPasswordRequestSchema,
  apiErrorCodes,
  firstPasswordId,
  ownerPasswordSettingsSchema,
  replaceOwnerPasswordRequestSchema,
  type ApiError,
  type OwnerPasswordInfo,
  type OwnerProfile,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";

import { matchingPassword } from "./attempts.ts";
import type { ProveOwner } from "./owner-proof.ts";
import { hashPassword } from "./password.ts";
import { sendInvalidRequest } from "./responses.ts";
import { sessionOf, type Sessions } from "./sessions.ts";
import { signInChanged } from "./sign-in-changes.ts";
import type { AuthStore, OwnerPasswordRecord } from "./store.ts";

// The Owner's passwords (shown in API Key Management): the first, set at
// setup, and any further ones, each for one of the people who share the
// Owner's access to the web app. Each has a name, and the nickname and
// time zone the lobby's receptionist greets them by. The first's are the
// Owner's profile (`office_settings.owner_profile`, its name kept as the
// forename). Any of them signs in; two-factor sign-in, when on, applies to
// all. No two may be the same password, so a password says who signed in.
// The first cannot be removed, but any can be replaced (A1-9). Each one
// added, replaced or removed is in the Activity Feed (A1-5), never itself.

const firstOf = (profile: OwnerProfile): OwnerPasswordInfo => ({
  id: firstPasswordId,
  first: true,
  name: `${profile.forename} ${profile.surname}`.trim() || "Owner",
  nickname: profile.nickname,
  timeZone: profile.timeZone,
  createdAt: null,
  lastUsedAt: null,
});

const infoOf = (record: OwnerPasswordRecord): OwnerPasswordInfo => ({
  id: record.id,
  first: false,
  name: record.name,
  nickname: record.nickname,
  timeZone: record.timeZone,
  createdAt: record.createdAt.toISOString(),
  lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
});

const passwordInUse: ApiError = {
  error: apiErrorCodes.passwordInUse,
  message: "Another Owner password is already that password: choose another.",
};

const notFound = (id: string): ApiError => ({
  error: apiErrorCodes.ownerPasswordNotFound,
  message: `There is no Owner password "${id}".`,
});

export function registerOwnerPasswordRoutes(
  app: FastifyInstance,
  options: {
    readonly store: AuthStore;
    readonly settings: Pick<OfficeSettings, "ownerProfile" | "setOwnerProfile">;
    readonly now: () => Date;
    readonly newId?: () => string;
    /** Checks a fresh proof of the Owner (A1-3). */
    readonly proveOwner: ProveOwner;
    /** Where each password added, replaced or removed is published (A1-5). */
    readonly events: EventBus;
    /** Clears the cookie of a session a replaced password ended (A1-9). */
    readonly sessions: Pick<Sessions, "clearCookie">;
  },
): void {
  const { store, settings, now, events, sessions } = options;
  const newId = options.newId ?? randomUUID;

  /** Whether `password` is already one of the Owner's, this one included. */
  const isInUse = async (password: string): Promise<boolean> =>
    (await matchingPassword(store, password)) !== undefined;

  app.get(
    "/api/owner-passwords",
    { config: { access: "owner" } },
    async () => ({
      passwords: [
        firstOf(await settings.ownerProfile()),
        ...(await store.ownerPasswords()).map(infoOf),
      ],
    }),
  );

  app.post(
    "/api/owner-passwords",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = addOwnerPasswordRequestSchema.safeParse(request.body);
      const settingsParsed = ownerPasswordSettingsSchema.safeParse(
        parsed.data ?? {},
      );
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      if (!settingsParsed.success) {
        return sendInvalidRequest(reply, settingsParsed.error);
      }
      // A further password signs in after sign-out-everywhere, so adding
      // one needs a fresh proof of the Owner (A1-3).
      const { password, currentPassword, code } = parsed.data;
      if (
        !(await options.proveOwner(request, reply, { currentPassword, code }))
      ) {
        return reply;
      }
      if (await isInUse(password)) {
        return reply.code(409).send(passwordInUse);
      }
      const record: OwnerPasswordRecord = {
        id: newId(),
        ...settingsParsed.data,
        passwordHash: await hashPassword(password),
        createdAt: now(),
        lastUsedAt: null,
      };
      await store.addOwnerPassword(record);
      await signInChanged(events, "ownerPasswords.added");
      request.log.info(
        { ownerPasswordId: record.id },
        "An Owner password was added.",
      );
      return reply.code(201).send(infoOf(record));
    },
  );

  // Sets a password's name, nickname and time zone; with `password`, also
  // replaces the password itself (A1-9), the first's included, so a leaked
  // one can be retired. That needs a fresh proof of the password being
  // replaced, and ends every session it began, this one too if it did.
  app.put<{ Params: { readonly passwordId: string } }>(
    "/api/owner-passwords/:passwordId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = ownerPasswordSettingsSchema.safeParse(request.body);
      const replacing = replaceOwnerPasswordRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      if (!replacing.success) {
        return sendInvalidRequest(reply, replacing.error);
      }
      const { passwordId } = request.params;
      const first = passwordId === firstPasswordId;
      const { password, currentPassword, code } = replacing.data;
      if (password !== undefined) {
        if (
          !first &&
          !(await store.ownerPasswords()).some(({ id }) => id === passwordId)
        ) {
          return reply.code(404).send(notFound(passwordId));
        }
        const of = first ? null : passwordId;
        if (
          !(await options.proveOwner(
            request,
            reply,
            { currentPassword, code },
            { of },
          ))
        ) {
          return reply;
        }
        if (await isInUse(password)) {
          return reply.code(409).send(passwordInUse);
        }
        await store.replaceOwnerPassword(of, await hashPassword(password));
        await signInChanged(events, "ownerPasswords.replaced");
        const session = sessionOf(request);
        if (
          (session.gatewayKeyId ?? null) === null &&
          (session.passwordId ?? null) === of
        ) {
          sessions.clearCookie(reply);
        }
        request.log.info(
          { ownerPasswordId: passwordId },
          "An Owner password was replaced; its sessions ended.",
        );
      }
      if (first) {
        const profile = await settings.setOwnerProfile({
          forename: parsed.data.name,
          surname: "",
          nickname: parsed.data.nickname,
          timeZone: parsed.data.timeZone,
        });
        return firstOf(profile);
      }
      const updated = await store.updateOwnerPassword(passwordId, parsed.data);
      if (updated === undefined) {
        return reply.code(404).send(notFound(passwordId));
      }
      return infoOf(updated);
    },
  );

  app.delete<{ Params: { readonly passwordId: string } }>(
    "/api/owner-passwords/:passwordId",
    { config: { access: "owner" } },
    async (request, reply) => {
      const { passwordId } = request.params;
      if (passwordId === firstPasswordId) {
        const body: ApiError = {
          error: apiErrorCodes.firstPasswordNotRemovable,
          message: "The first Owner password, set at setup, cannot be removed.",
        };
        return reply.code(409).send(body);
      }
      if (!(await store.deleteOwnerPassword(passwordId))) {
        return reply.code(404).send(notFound(passwordId));
      }
      await signInChanged(events, "ownerPasswords.removed");
      request.log.info(
        { ownerPasswordId: passwordId },
        "An Owner password was removed; its sessions ended.",
      );
      return reply.code(204).send();
    },
  );
}
