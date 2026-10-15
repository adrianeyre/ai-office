import { apiErrorCodes, type ApiError } from "@ai-office/shared";
import type { FastifyReply } from "fastify";
import type { z } from "zod";

// Bodies the access rules and the auth routes answer with.

export const notFoundBody = { error: "Not Found" } as const;

/** The path of the first-run setup screen. */
export const setupPath = "/setup";
/** The path of the login page. */
export const loginPath = "/login";

export const setupRequiredBody: ApiError = {
  error: apiErrorCodes.setupRequired,
  message: `AI Office has no password yet; set one at ${setupPath}.`,
};

export const unauthorizedBody: ApiError = {
  error: apiErrorCodes.unauthorized,
  message: `Sign in at ${loginPath}.`,
};

/** A 400 listing what was wrong with the request body. */
export const sendInvalidRequest = (reply: FastifyReply, error: z.ZodError) => {
  const body: ApiError = {
    error: apiErrorCodes.invalidRequest,
    problems: error.issues.map((issue) => issue.message),
  };
  return reply.code(400).send(body);
};

/** A 429 for a client locked out after repeated failed sign-ins. */
export const sendTooManyAttempts = (
  reply: FastifyReply,
  retryAfterSeconds: number,
) => {
  const body: ApiError = {
    error: apiErrorCodes.tooManyAttempts,
    message: `Too many failed sign-ins. Try again in ${String(retryAfterSeconds)} ${retryAfterSeconds === 1 ? "second" : "seconds"}.`,
  };
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send(body);
};
