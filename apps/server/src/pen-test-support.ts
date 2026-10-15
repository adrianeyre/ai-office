import {
  createEventBus,
  memoryEventStore,
  type StoredEvent,
} from "@ai-office/events";
import {
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { generate } from "otplib";
import { expect } from "vitest";

import { buildApp, type AppOptions } from "./app.ts";
import type { memoryAuthStore } from "./auth/store.ts";
import { createLogger } from "./logger.ts";
import { testAuth, testPassword, type SignedIn } from "./test-support.ts";

// Test-only support for the A1 probe (pen-testing, "Sign-in and sessions"):
// the real app, built as the server builds it, on a clock the probe moves,
// with its Activity Feed and its log where the probe can read them.

export const probeStart = new Date("2026-10-11T12:00:00.000Z");

export interface ProbedApp {
  readonly server: FastifyInstance;
  readonly store: ReturnType<typeof memoryAuthStore>;
  /** Every event published, oldest first: what the Activity Feed shows. */
  readonly feed: StoredEvent[];
  /** Every log line, as JSON text. */
  readonly lines: string[];
  readonly clock: { now: Date };
  /** Moves the clock `ms` on. */
  wait(ms: number): void;
}

/**
 * The whole app on a fresh in-memory store, set up with `testPassword`
 * unless `setUp` is false. `store` reuses an auth store, as a restart
 * against the same database would.
 */
export async function probedApp(
  options: Partial<AppOptions> & {
    readonly setUp?: boolean;
    readonly store?: ReturnType<typeof memoryAuthStore>;
    readonly clock?: { now: Date };
    /** Mark the session cookie `Secure`, as an https PUBLIC_URL does. */
    readonly secureCookie?: boolean;
  } = {},
): Promise<ProbedApp> {
  const {
    setUp = true,
    store,
    clock = { now: probeStart },
    secureCookie = false,
    ...rest
  } = options;
  const auth = await testAuth({ setUp, now: () => clock.now, secureCookie });
  const authStore = store ?? auth.store;
  const eventStore = memoryEventStore();
  const lines: string[] = [];
  const server = await buildApp({
    logger: createLogger({
      level: "debug",
      secrets: [],
      destination: { write: (line) => lines.push(line) },
    }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    events: createEventBus({
      store: eventStore,
      now: () => clock.now,
    }),
    ...rest,
    auth: { ...auth, store: authStore },
  });
  return {
    server,
    store: authStore,
    feed: eventStore.events,
    lines,
    clock,
    wait(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
}

/** The first cookie pair named `name` in a `set-cookie` header. */
export const cookieFrom = (
  setCookie: unknown,
  name: string,
): string | undefined =>
  [setCookie]
    .flat()
    .map((header) => String(header).split(";", 1)[0] ?? "")
    .find((pair) => pair.startsWith(`${name}=`) && pair !== `${name}=`);

/** The code an authenticator app shows for `secret` at `at`. */
export const codeAt = (secret: string, at: Date): Promise<string> =>
  generate({ secret, epoch: Math.floor(at.getTime() / 1000) });

/** Turns TOTP on through the API; returns the secret and recovery codes. */
export async function enableTotp(
  { server, clock }: Pick<ProbedApp, "server" | "clock">,
  owner: SignedIn,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await server.inject({
    method: "POST",
    url: "/api/totp/setup",
    headers: owner.headers,
    // Turning TOTP on needs the current password (A1-3).
    payload: { currentPassword: testPassword },
  });
  expect(setup.statusCode).toBe(200);
  const { secret } = totpSetupResponseSchema.parse(setup.json());
  const enable = await server.inject({
    method: "POST",
    url: "/api/totp/enable",
    headers: owner.headers,
    payload: { code: await codeAt(secret, clock.now) },
  });
  expect(enable.statusCode).toBe(200);
  const { recoveryCodes } = totpEnableResponseSchema.parse(enable.json());
  return { secret, recoveryCodes };
}
