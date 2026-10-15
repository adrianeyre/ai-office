import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { OfficeEvent } from "@ai-office/events/schema";
import {
  githubConnectionSecretContext,
  type NewNotice,
} from "@ai-office/shared";
import { encryptorFromVersionedKey } from "@ai-office/shared/crypto";
import {
  createAppKeys,
  createFakeGitHub,
  serveFakeGitHub,
  type FakeGitHub,
} from "@ai-office/github/testing";
import { test as base, type Page } from "@playwright/test";
import pg from "pg";

import {
  postgresServerEnv,
  repositoryRoot,
  skipEnv,
  templateDatabase,
  urlFor,
} from "./paths.ts";
import type {
  ControlMessage,
  ControlReply,
  ControlRequest,
  ControlResult,
  SandboxTaskRecord,
  SeededGatewayRequest,
} from "./control.ts";

// Each test gets a fresh AI Office: its own database, copied from the
// migrated template, and its own server process (`server/main.ts`,
// which starts it as `apps/server/src/main.ts` does), serving the built web
// app on a free port. The server's GitHub App, added to the database as the
// Owner adds one in Floor Settings, talks to the test's own fake GitHub
// (GITHUB_API_URL), which the test sets up through `office.github`.
// What nothing in AI Office does yet, such as raising a Notice, the test
// asks the server to do over IPC (`office.raiseNotice`, `office.publish`).
// Agents' tasks go to a stand-in sandbox runner (there is no Docker), which
// records each one (`office.sandboxTasks`) and fails it.

export const ownerPassword = "Tr0ub4dor&3x-e2e";

/** The fake GitHub App's id. */
const appId = "4242";

export interface Office {
  readonly baseURL: string;
  /** The server's AI Gateway. */
  readonly gatewayURL: string;
  /** Everything the server has logged so far. */
  log(): string;
  /** The GitHub the server's App sees: install repositories here. */
  readonly github: FakeGitHub;
  /** Sets the Owner's password through the API, as the setup screen does. */
  setUp(password?: string): Promise<void>;
  /**
   * Raises a Notice in the server. Its actions may be only `testAction`
   * (`support/control.ts`), whose handler does nothing. Resolves with its
   * id.
   */
  raiseNotice(notice: NewNotice): Promise<string>;
  /** Publishes an event on the server's event bus; resolves with its id. */
  publish(event: OfficeEvent): Promise<number>;
  /** Runs issue intake now; resolves with how many issues it picked up. */
  pollIntake(): Promise<number>;
  /**
   * The tasks Agents were given so far, oldest first: each Agent, issue,
   * AI Provider, Model and effort. The stand-in runner fails every one.
   */
  sandboxTasks(): Promise<readonly SandboxTaskRecord[]>;
  /** The prompt the Agent's latest task on `issue` was given. */
  sandboxPrompt(agentId: string, issue: number): Promise<string>;
  /** Records requests in the Gateway's history; answers how many. */
  recordGatewayRequests(
    requests: readonly SeededGatewayRequest[],
  ): Promise<number>;
}

/** Signs in on the login page. */
export async function signIn(
  page: Page,
  password = ownerPassword,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Makes a Gateway Key for one of the Owner's tools in AI Settings' Gateway Keys
 * card, as the Owner would, and resolves with the key it shows once.
 */
export async function makeGatewayKey(
  page: Page,
  name: string,
): Promise<string> {
  if (!new URL(page.url()).pathname.startsWith("/ai-settings")) {
    await page.goto("/ai-settings");
  }
  const form = page.getByRole("form", { name: "Make a Gateway Key" });
  await form.getByLabel("Tool").fill(name);
  await form.getByRole("button", { name: "Make Gateway Key" }).click();
  const shown = form.getByLabel(`The key for ${name}`);
  await shown.waitFor();
  const key = await shown.inputValue();
  await form.getByRole("button", { name: "Done" }).click();
  return key;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

/** Creates `name` from the template, retrying while another copy holds it. */
async function createDatabase(admin: pg.Client, name: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${templateDatabase}`);
      return;
    } catch (error) {
      // 55006: the template is being copied by another test right now.
      if ((error as { code?: string }).code !== "55006" || attempt === 20) {
        throw error;
      }
      await sleep(100 * attempt);
    }
  }
}

/**
 * The fake GitHub's App, as the Owner adds one in Floor Settings: kept in
 * the test's database, its private key sealed with the server's key.
 */
async function addGitHubApp(
  databaseUrl: string,
  encryptionKey: string,
  privateKey: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const id = "e2e-github-app";
    const sealed = encryptorFromVersionedKey(encryptionKey).encrypt(
      privateKey,
      githubConnectionSecretContext(id, "private_key"),
    );
    await client.query(
      `INSERT INTO github_connections (id, kind, name, app_id, private_key, hint, created_at)
       VALUES ($1, 'app', 'The fake GitHub App', $2, $3, 'fake', now())`,
      [id, appId, sealed],
    );
  } finally {
    await client.end();
  }
}

async function waitUntilHealthy(
  baseURL: string,
  server: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `The server exited with ${String(server.exitCode)}:\n${output()}`,
      );
    }
    try {
      if ((await fetch(`${baseURL}/health`)).ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`The server did not become healthy in time:\n${output()}`);
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(5000).then(() => true),
  ]);
  if (timedOut) {
    server.kill("SIGKILL");
    await exited;
  }
}

/** `result`, checked to be of the type a command answers with. */
function expectType<Type extends "string" | "number">(
  type: Type,
  result: ControlResult,
): Type extends "string" ? string : number {
  if (typeof result !== type) {
    throw new TypeError(
      `The server answered a ${typeof result}, not a ${type}.`,
    );
  }
  return result as Type extends "string" ? string : number;
}

/** Sends `request` to the server over IPC and waits for its reply. */
function controller(server: ChildProcess) {
  let nextId = 0;
  const waiting = new Map<number, (reply: ControlReply) => void>();
  server.on("message", (reply: ControlReply) => {
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  return async (request: ControlRequest): Promise<ControlResult> => {
    const id = ++nextId;
    const replied = new Promise<ControlReply>((resolve) => {
      waiting.set(id, resolve);
    });
    server.send({ ...request, id } satisfies ControlMessage);
    const reply = await replied;
    if (!reply.ok) {
      throw new Error(`The server refused ${request.command}: ${reply.error}`);
    }
    return reply.result;
  };
}

export const test = base.extend<{ office: Office }>({
  // Playwright reads a fixture's dependencies from its destructuring
  // pattern, so a fixture that depends on nothing destructures nothing.
  // eslint-disable-next-line no-empty-pattern
  office: async ({}, use, testInfo) => {
    const skipReason = process.env[skipEnv];
    testInfo.skip(skipReason !== undefined, skipReason);
    const serverUrl = process.env[postgresServerEnv];
    if (serverUrl === undefined) {
      throw new Error("The global setup did not prepare Postgres.");
    }

    const database = `ai_office_e2e_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: urlFor(serverUrl, "postgres"),
    });
    await admin.connect();
    const output: string[] = [];
    let server: ChildProcess | undefined;
    const github = createFakeGitHub();
    const keys = createAppKeys();
    const githubServer = await serveFakeGitHub(github, {
      appId,
      publicKey: keys.publicKey,
    });
    try {
      await createDatabase(admin, database);
      const encryptionKey = randomBytes(32).toString("base64");
      await addGitHubApp(
        urlFor(serverUrl, database),
        encryptionKey,
        keys.privateKey,
      );
      // A free port can be taken by another test's process before the
      // server binds it; then the server is started again on fresh ones.
      let baseURL = "";
      let gatewayURL = "";
      let started: ChildProcess | undefined;
      for (let attempt = 1; started === undefined; attempt += 1) {
        const [port, gatewayPort] = [await freePort(), await freePort()];
        baseURL = `http://127.0.0.1:${String(port)}`;
        gatewayURL = `http://127.0.0.1:${String(gatewayPort)}`;
        output.length = 0;
        server = spawn(
          process.execPath,
          [join(repositoryRoot, "e2e/server/main.ts")],
          {
            cwd: repositoryRoot,
            // Only what the server needs: nothing leaks in from the shell.
            env: {
              DATABASE_URL: urlFor(serverUrl, database),
              SESSION_SECRET: randomBytes(32).toString("hex"),
              ENCRYPTION_KEY: encryptionKey,
              HOST: "127.0.0.1",
              PORT: String(port),
              PUBLIC_URL: baseURL,
              GATEWAY_HOST: "127.0.0.1",
              GATEWAY_PORT: String(gatewayPort),
              LOG_LEVEL: "info",
              GITHUB_API_URL: githubServer.url,
              // The tests' fake AI Providers and webhook receivers are on
              // loopback, which they allow (ADR 0007).
              ALLOWED_INTERNAL_HOSTS: "127.0.0.1",
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        server.stdout?.on("data", (chunk: Buffer) =>
          output.push(chunk.toString()),
        );
        server.stderr?.on("data", (chunk: Buffer) =>
          output.push(chunk.toString()),
        );
        try {
          await waitUntilHealthy(baseURL, server, () => output.join(""));
          started = server;
        } catch (error) {
          if (attempt === 3 || !output.join("").includes("EADDRINUSE")) {
            throw error;
          }
          await stop(server);
        }
      }
      const control = controller(started);

      await use({
        baseURL,
        gatewayURL,
        log: () => output.join(""),
        github,
        async setUp(password = ownerPassword) {
          const response = await fetch(`${baseURL}/api/setup`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password }),
          });
          if (response.status !== 204) {
            throw new Error(
              `POST /api/setup answered ${String(response.status)}.`,
            );
          }
        },
        raiseNotice: async (notice) =>
          expectType(
            "string",
            await control({ command: "raiseNotice", notice }),
          ),
        publish: async (event) =>
          expectType("number", await control({ command: "publish", event })),
        pollIntake: async () =>
          expectType("number", await control({ command: "pollIntake" })),
        recordGatewayRequests: async (requests) =>
          expectType(
            "number",
            await control({ command: "recordGatewayRequests", requests }),
          ),
        sandboxPrompt: async (agentId, issue) =>
          expectType(
            "string",
            await control({ command: "sandboxPrompt", agentId, issue }),
          ),
        async sandboxTasks() {
          const tasks = await control({ command: "sandboxTasks" });
          if (typeof tasks === "string" || typeof tasks === "number") {
            throw new TypeError("The server answered no list of tasks.");
          }
          return tasks;
        },
      });
    } finally {
      if (server !== undefined) {
        await stop(server);
      }
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("server.log", {
          body: output.join(""),
          contentType: "text/plain",
        });
      }
      await githubServer.close();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  },

  // Pages are opened relative to this test's own server.
  baseURL: async ({ office }, use) => {
    await use(office.baseURL);
  },
});

export { expect } from "@playwright/test";
