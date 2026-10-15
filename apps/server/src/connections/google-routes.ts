import {
  GoogleSignInError,
  type GoogleAuth,
  type GoogleSignInInfo,
} from "@ai-office/communications";
import {
  googleClientRequestSchema,
  googleErrorCodes,
  googleSignInCompleteRequestSchema,
  type ApiError,
  type GoogleErrorCode,
  type GoogleSignIn,
  type GoogleSignInStart,
} from "@ai-office/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendInvalidRequest } from "../auth/responses.ts";

// The Google sign-in API (PRD FR-91, FR-93), a thin adapter over Google
// sign-in: the OAuth client is entered (its secret never sent back); a
// sign-in begins, answering where the Owner consents, and is finished with
// what Google's redirect brought back to the web app; and the account is
// signed out. No answer, log line or event holds a token, a code or the
// secret. Every route needs a signed-in session.

const statusFor: Record<GoogleErrorCode, number> = {
  [googleErrorCodes.notConfigured]: 409,
  [googleErrorCodes.noServices]: 409,
  [googleErrorCodes.signInNotFound]: 404,
  [googleErrorCodes.signInRefused]: 400,
  [googleErrorCodes.unavailable]: 502,
};

/** Google sign-in as the API sends it: each field named, never a secret. */
export const googleSignInBody = (info: GoogleSignInInfo): GoogleSignIn => ({
  status: info.status,
  clientId: info.clientId,
  redirectUri: info.redirectUri,
  services: [...info.services],
  scopes: [...info.scopes],
  grantedScopes: [...info.grantedScopes],
  missingServices: [...info.missingServices],
  signedInAt: info.signedInAt?.toISOString() ?? null,
});

/** Answers a `GoogleSignInError` with its status; anything else is rethrown. */
const sendGoogleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (!(error instanceof GoogleSignInError)) {
    throw error;
  }
  const body: ApiError = { error: error.code, message: error.message };
  return reply.code(statusFor[error.code]).send(body);
};

export function registerGoogleRoutes(
  app: FastifyInstance,
  options: { readonly google: GoogleAuth },
): void {
  const { google } = options;

  app.get("/api/google", { config: { access: "owner" } }, async () =>
    googleSignInBody(await google.info()),
  );

  app.put(
    "/api/google/client",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = googleClientRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      const info = await google.configure(parsed.data);
      request.log.info("Google sign-in's OAuth client was entered.");
      return googleSignInBody(info);
    },
  );

  app.post(
    "/api/google/sign-in",
    { config: { access: "owner" } },
    async (_request, reply) => {
      try {
        const body: GoogleSignInStart = await google.start();
        return body;
      } catch (error) {
        return sendGoogleError(reply, error);
      }
    },
  );

  app.post(
    "/api/google/sign-in/complete",
    { config: { access: "owner" } },
    async (request, reply) => {
      const parsed = googleSignInCompleteRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidRequest(reply, parsed.error);
      }
      try {
        const info = await google.complete(parsed.data);
        request.log.info(
          { scopes: info.grantedScopes },
          "Signed in to Google for the Google Connections.",
        );
        return googleSignInBody(info);
      } catch (error) {
        return sendGoogleError(reply, error);
      }
    },
  );

  app.delete(
    "/api/google/sign-in",
    { config: { access: "owner" } },
    async (request) => {
      const info = await google.signOut();
      request.log.info("Signed out of Google.");
      return googleSignInBody(info);
    },
  );
}
