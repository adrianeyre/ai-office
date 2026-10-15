import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  csrfHeader,
  sessionIdleMs,
  sessionLifetimeMs,
} from "@ai-office/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthStore, SessionRecord } from "./store.ts";

// Server-side sessions (PRD FR-2): the cookie holds a random token, the
// `sessions` table holds its SHA-256, and a session lasts 7 days from
// sign-in, or until it goes 24 hours unused (A1-8), so a stolen cookie
// left unused stops working. No third-party authentication framework
// (PRD §8).

export const sessionCookie = "ai_office_session";

/** A session the current request was authenticated with. */
export interface Session extends SessionRecord {
  readonly csrfToken: string;
}

export interface SessionOptions {
  readonly store: AuthStore;
  /** `SESSION_SECRET`: keys the CSRF tokens. */
  readonly secret: string;
  /** Mark the cookie `Secure` (when `PUBLIC_URL` is https). */
  readonly secureCookie: boolean;
  /** The clock; tests move it. */
  readonly now?: () => Date;
  /**
   * Whether the API key with this id may still use the web app: a session
   * an API key began ends once it is disabled, revoked or loses UI access.
   */
  readonly keyAllowsUi?: (gatewayKeyId: string) => Promise<boolean>;
}

export interface Sessions {
  /**
   * Starts a session and sets its cookie on `reply`; `gatewayKeyId` is the
   * API key that signed in, if one did.
   */
  start(
    reply: FastifyReply,
    by?: {
      readonly gatewayKeyId?: string;
      readonly passwordId?: string | null;
    },
  ): Promise<Session>;
  /** The request's session, if its cookie names one that has not expired. */
  authenticate(request: FastifyRequest): Promise<Session | undefined>;
  /** Ends `session` and clears the cookie. */
  end(session: Session, reply: FastifyReply): Promise<void>;
  /** Ends every session ("sign out everywhere") and clears the cookie. */
  endAll(reply: FastifyReply): Promise<number>;
  /** Clears the session cookie on `reply`. */
  clearCookie(reply: FastifyReply): void;
  /** Whether the request carries `session`'s CSRF token. */
  csrfValid(request: FastifyRequest, session: Session): boolean;
}

/** The session of a request to an `owner` route, which the hook has set. */
export function sessionOf(request: FastifyRequest): Session {
  if (request.session === null) {
    throw new Error(
      `${request.method} ${request.url} has no session; is it an owner route?`,
    );
  }
  return request.session;
}

/**
 * How stale a session's last use may be before a request notes it again:
 * a busy page writes at most once a minute.
 */
const touchAfterMs = 60_000;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** The value of the cookie `name` in a `Cookie` header. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator !== -1 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
}

const sameBytes = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createSessions(options: SessionOptions): Sessions {
  const { store, secret } = options;
  const now = options.now ?? (() => new Date());

  const csrfTokenFor = (id: string): string =>
    createHmac("sha256", secret).update(`csrf:${id}`).digest("base64url");

  const cookie = (value: string, maxAgeSeconds: number): string =>
    [
      `${sessionCookie}=${value}`,
      "Path=/",
      `Max-Age=${String(maxAgeSeconds)}`,
      "HttpOnly",
      "SameSite=Strict",
      ...(options.secureCookie ? ["Secure"] : []),
    ].join("; ");

  const clearCookie = (reply: FastifyReply): void => {
    void reply.header("set-cookie", cookie("", 0));
  };

  return {
    async start(reply, by = {}) {
      const { gatewayKeyId, passwordId } = by;
      const token = randomBytes(32).toString("base64url");
      const createdAt = now();
      const record: SessionRecord = {
        id: sha256(token),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + sessionLifetimeMs),
        ...(gatewayKeyId === undefined ? {} : { gatewayKeyId }),
        ...(passwordId === undefined || passwordId === null
          ? {}
          : { passwordId }),
      };
      // Sessions that ran out are removed as new ones begin.
      await store.deleteExpiredSessions(createdAt);
      await store.createSession(record);
      void reply.header(
        "set-cookie",
        cookie(token, Math.floor(sessionLifetimeMs / 1000)),
      );
      return { ...record, csrfToken: csrfTokenFor(record.id) };
    },

    async authenticate(request) {
      const token = readCookie(request.headers.cookie, sessionCookie);
      if (token === undefined || token === "") {
        return undefined;
      }
      const record = await store.findSession(sha256(token));
      if (record === undefined) {
        return undefined;
      }
      const keyId = record.gatewayKeyId ?? null;
      const at = now();
      const lastSeenAt = record.lastSeenAt ?? record.createdAt;
      if (
        record.expiresAt <= at ||
        at.getTime() - lastSeenAt.getTime() > sessionIdleMs ||
        (keyId !== null &&
          options.keyAllowsUi !== undefined &&
          !(await options.keyAllowsUi(keyId)))
      ) {
        await store.deleteSession(record.id);
        return undefined;
      }
      if (at.getTime() - lastSeenAt.getTime() >= touchAfterMs) {
        await store.touchSession(record.id, at);
      }
      return { ...record, csrfToken: csrfTokenFor(record.id) };
    },

    async end(session, reply) {
      await store.deleteSession(session.id);
      clearCookie(reply);
    },

    async endAll(reply) {
      const ended = await store.deleteAllSessions();
      clearCookie(reply);
      return ended;
    },

    clearCookie,

    csrfValid(request, session) {
      const header = request.headers[csrfHeader];
      return typeof header === "string" && sameBytes(header, session.csrfToken);
    },
  };
}

/**
 * Whether a state-changing request came from another site, judged by the
 * browser's `Sec-Fetch-Site` and `Origin` headers. Requests without either
 * (curl, scripts) are not cross-site: they carry no ambient cookie to abuse.
 */
export function isCrossSite(request: FastifyRequest): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") {
    return true;
  }
  const origin = request.headers.origin;
  if (origin === undefined) {
    return false;
  }
  try {
    return new URL(origin).host !== request.headers.host;
  } catch {
    // `Origin: null` (a sandboxed frame, a redirect) or garbage.
    return true;
  }
}
