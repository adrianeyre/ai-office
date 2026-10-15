import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionResponseSchema } from "@ai-office/shared";
import { encryptorFromKey, type Encryptor } from "@ai-office/shared/crypto";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

import { hashPassword } from "./auth/password.ts";
import type { SessionOptions } from "./auth/sessions.ts";
import { memoryAuthStore } from "./auth/store.ts";

export const testPassword = "Tr0ub4dor&3x-tests";
export const testSessionSecret = "test-session-secret-4f9c2e7a1b3d5f8e0a6c";

/** Seals the TOTP secret in tests (a fixed key: never use it elsewhere). */
export const testEncryptor: Encryptor = encryptorFromKey(Buffer.alloc(32, 7));

let passwordHash: Promise<string> | undefined;

/** Auth for `buildApp`: in memory, set up with `testPassword` unless not. */
export async function testAuth(
  options: { setUp?: boolean } & Partial<SessionOptions> = {},
): Promise<
  SessionOptions & {
    store: ReturnType<typeof memoryAuthStore>;
    encryptor: Encryptor;
  }
> {
  const { setUp = true, ...rest } = options;
  passwordHash ??= hashPassword(testPassword);
  return {
    store: memoryAuthStore(setUp ? { passwordHash: await passwordHash } : {}),
    secret: testSessionSecret,
    secureCookie: false,
    encryptor: testEncryptor,
    ...rest,
  } as SessionOptions & {
    store: ReturnType<typeof memoryAuthStore>;
    encryptor: Encryptor;
  };
}

export interface SignedIn {
  /** The `cookie` request header that carries the session. */
  readonly cookie: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  /** Headers for a state change: the cookie and the CSRF token. */
  readonly headers: Record<string, string>;
}

/** Signs in through `POST /api/login`. */
export async function signIn(
  server: FastifyInstance,
  password = testPassword,
): Promise<SignedIn> {
  const response = await server.inject({
    method: "POST",
    url: "/api/login",
    payload: { password },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = String(response.headers["set-cookie"]);
  const cookie = setCookie.split(";", 1)[0] ?? "";
  const { csrfToken, expiresAt } = sessionResponseSchema.parse(response.json());
  return {
    cookie,
    csrfToken,
    expiresAt,
    headers: { cookie, "x-csrf-token": csrfToken },
  };
}

/** A built web app in a temporary directory; `remove` deletes it. */
export async function webBuild(): Promise<{
  dir: string;
  files: string[];
  remove: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ai-office-web-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<!doctype html><p>AI Office");
  await writeFile(join(dir, "assets", "app.js"), "console.log(1);");
  return {
    dir,
    files: ["/index.html", "/assets/app.js"],
    remove: () => rm(dir, { recursive: true }),
  };
}
