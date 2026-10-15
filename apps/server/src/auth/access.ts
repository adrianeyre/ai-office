import type { EventBus } from "@ai-office/events";
import {
  apiErrorCodes,
  googleRedirectPath,
  type ApiError,
} from "@ai-office/shared";
import type { Encryptor } from "@ai-office/shared/crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from "fastify";

import {
  loginPath,
  notFoundBody,
  setupPath,
  setupRequiredBody,
  unauthorizedBody,
} from "./responses.ts";
import type { LoginLimiter } from "./login-limiter.ts";
import type { ProveOwner } from "./owner-proof.ts";
import { registerAuthRoutes, type UiKeys } from "./routes.ts";
import { isCrossSite, type Session, type Sessions } from "./sessions.ts";
import type { SetupToken } from "./setup-token.ts";
import type { SignInChallenges } from "./sign-in-challenges.ts";
import type { AuthStore } from "./store.ts";
import { registerTotpRoutes } from "./totp-routes.ts";

/**
 * Who may call a route, declared in its `config.access`:
 * - `public`: anyone, always (`/health`, the built web app's files);
 * - `setup`: anyone, but only until the Owner's password exists; after
 *   that the route is a 404 for good (`POST /api/setup`);
 * - `sign-in`: anyone, once the password exists (`POST /api/login`);
 * - `owner`: a signed-in session, and for a state change the session's
 *   CSRF token too. A route that declares nothing is an `owner` route.
 *
 * Before setup, every route but `public` and `setup` ones answers
 * `setup_required`. A state change on any route but a `public` one is
 * refused when it comes from another site.
 */
export type RouteAccess = "public" | "setup" | "sign-in" | "owner";

/** A registered route and the access it declares (if it declares one). */
export interface RouteAccessEntry {
  readonly method: string;
  readonly url: string;
  readonly access: RouteAccess | undefined;
}

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyInstance {
    /** Every route registered so far, with the access it declares. */
    routeAccess(): RouteAccessEntry[];
  }
  interface FastifyRequest {
    /** The session an `owner` route was called with; null elsewhere. */
    session: Session | null;
  }
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** What to do with a request for a page of the web app. */
export type PageDecision =
  | { readonly serve: true }
  | { readonly serve: false; readonly redirect: string }
  | { readonly serve: false; readonly notFound: true };

export interface Access {
  /** Whether the Owner's password exists. Once true, it stays true. */
  passwordExists(): Promise<boolean>;
  /** Who may see the page at `path`. */
  page(path: string, request: FastifyRequest): Promise<PageDecision>;
  /**
   * Answers a request for an API path with no route as an `owner` route
   * would be answered, so unknown paths say no more than known ones.
   */
  apiNotFound(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply>;
}

/**
 * Adds the access rules to `app`: a hook that enforces every route's
 * `config.access` (PRD FR-1, FR-2), and the setup, login and session routes.
 */
export function registerAccess(
  app: FastifyInstance,
  options: {
    readonly store: AuthStore;
    readonly sessions: Sessions;
    readonly challenges: SignInChallenges;
    readonly encryptor: Encryptor;
    readonly loginLimiter: LoginLimiter;
    readonly now: () => Date;
    /** Where sign-ins and sign-outs are published, for the Activity Feed. */
    readonly events: EventBus;
    /** API keys that may sign in to the web app. */
    readonly uiKeys?: UiKeys | undefined;
    /** The address AI Office is reached at (PUBLIC_URL), if known. */
    readonly publicUrl?: string | undefined;
    /** The one-time setup token, while no password exists. */
    readonly setupToken?: SetupToken | undefined;
    /** Checks a fresh proof of the Owner (A1-3). */
    readonly proveOwner: ProveOwner;
  },
): Access {
  const { store, sessions } = options;
  // A password is never removed, so once it is seen it need not be read
  // again; until then every guarded request looks.
  let passwordSeen = false;
  const passwordExists = async (): Promise<boolean> => {
    passwordSeen ||= (await store.passwordHash()) !== undefined;
    return passwordSeen;
  };

  // Kept by reference and read when asked: a plugin's own `onRoute` hook
  // may set a route's access after this one has run.
  const routes: RouteOptions[] = [];
  app.addHook("onRoute", (route) => {
    routes.push(route);
  });
  app.decorate("routeAccess", () =>
    routes.flatMap((route) =>
      [route.method].flat().map((method) => ({
        method,
        url: route.url,
        access: route.config?.access,
      })),
    ),
  );
  app.decorateRequest("session", null);

  /** The session, or undefined once a 401 is sent (clearing a stale cookie). */
  const requireSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Session | undefined> => {
    const session = await sessions.authenticate(request);
    if (session !== undefined) {
      return session;
    }
    if (request.headers.cookie !== undefined) {
      sessions.clearCookie(reply);
    }
    await reply.code(401).send(unauthorizedBody);
    return undefined;
  };

  app.addHook("onRequest", async (request, reply) => {
    // Requests with no route are answered by the not-found handler.
    if (request.is404) {
      return;
    }
    const access = request.routeOptions.config.access ?? "owner";
    if (access === "public") {
      return;
    }
    const exists = await passwordExists();
    if (access === "setup" && exists) {
      return reply.code(404).send(notFoundBody);
    }
    if (access !== "setup" && !exists) {
      return reply.code(403).send(setupRequiredBody);
    }
    const changesState = !safeMethods.has(request.method);
    if (changesState && isCrossSite(request)) {
      const body: ApiError = {
        error: apiErrorCodes.csrf,
        message: "Requests from other sites are refused.",
      };
      return reply.code(403).send(body);
    }
    if (access !== "owner") {
      return;
    }
    const session = await requireSession(request, reply);
    if (session === undefined) {
      return reply;
    }
    if (changesState && !sessions.csrfValid(request, session)) {
      const body: ApiError = {
        error: apiErrorCodes.csrf,
        message: "The x-csrf-token header is missing or does not match.",
      };
      return reply.code(403).send(body);
    }
    request.session = session;
  });

  registerAuthRoutes(app, {
    store,
    sessions,
    challenges: options.challenges,
    encryptor: options.encryptor,
    loginLimiter: options.loginLimiter,
    now: options.now,
    events: options.events,
    uiKeys: options.uiKeys,
    publicUrl: options.publicUrl,
    setupToken: options.setupToken,
    onPasswordSet: () => {
      passwordSeen = true;
    },
  });
  registerTotpRoutes(app, {
    store,
    encryptor: options.encryptor,
    loginLimiter: options.loginLimiter,
    now: options.now,
    proveOwner: options.proveOwner,
    events: options.events,
  });

  return {
    passwordExists,
    async page(path, request) {
      if (!(await passwordExists())) {
        return path === setupPath
          ? { serve: true }
          : { serve: false, redirect: setupPath };
      }
      if (path === setupPath) {
        return { serve: false, notFound: true };
      }
      // Where Google sends the Owner back after consent (FR-91). Its
      // cross-site redirect carries no SameSite=Strict cookie, so the page
      // is served without one; it holds nothing, and hands Google's code to
      // the API, which needs the session.
      if (path === googleRedirectPath) {
        return { serve: true };
      }
      const signedIn = (await sessions.authenticate(request)) !== undefined;
      if (path === loginPath) {
        return signedIn ? { serve: false, redirect: "/" } : { serve: true };
      }
      return signedIn ? { serve: true } : { serve: false, redirect: loginPath };
    },
    async apiNotFound(request, reply) {
      if (!(await passwordExists())) {
        return reply.code(403).send(setupRequiredBody);
      }
      if ((await requireSession(request, reply)) === undefined) {
        return reply;
      }
      return reply.code(404).send(notFoundBody);
    },
  };
}
