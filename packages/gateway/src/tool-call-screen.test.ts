import { request } from "node:http";

import { aiOfficeHeaders, toolCallScreenPath } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { staticKeys } from "./keys/keys.ts";
import { memoryRequestLog } from "./request-log.ts";
import {
  gatewayKey,
  startGateway,
  testCaller,
  type RunningGateway,
} from "./test-support.ts";

// The tool-call screen's route (FR-17, P1-8): an Agent's sandbox asks it,
// with the Agent's own Gateway Key, before each of its agent tool's calls
// runs, and the Gateway passes the call on to AI Office's screen with the
// Agent its key belongs to. Every value is a fake.

const agentKey = "aio_gk_thefakeagentkeyforthescreen000000000000";

let gateway: RunningGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function setUp() {
  const asked: unknown[] = [];
  gateway = await startGateway({
    account: undefined,
    keys: staticKeys({
      [gatewayKey]: testCaller,
      [agentKey]: {
        kind: "agent",
        keyId: "ada-key",
        agentId: "ada",
        floorId: "web-shop",
        name: "Ada",
      },
    }),
    toolCallScreen: (request) => {
      asked.push(request);
      return Promise.resolve({ decided: "here" });
    },
  });
  const running = gateway;
  const ask = (key: string | undefined) =>
    fetch(`${running.url}${toolCallScreenPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        [aiOfficeHeaders.session]: "sbx-1",
      },
      body: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      }),
    });
  return { asked, ask, running };
}

describe("the tool-call screen's route", () => {
  it("passes an Agent's call on with the Agent its key belongs to and its session, and answers what the screen says", async () => {
    const { asked, ask, running } = await setUp();
    const response = await ask(agentKey);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decided: "here" });
    expect(asked).toEqual([
      {
        agentId: "ada",
        floorId: "web-shop",
        session: "sbx-1",
        body: { tool_name: "Bash", tool_input: { command: "pnpm test" } },
      },
    ]);
    // Not a model call: nothing is recorded as one.
    expect(
      (running.requestLog as ReturnType<typeof memoryRequestLog>).records,
    ).toEqual([]);
  });

  it("refuses a request with no key in use, and an Owner tool's key, asking nothing", async () => {
    const { asked, ask } = await setUp();
    expect((await ask(undefined)).status).toBe(401);
    expect((await ask("aio_gk_notakeyinuse000000000000000000000")).status).toBe(
      401,
    );
    expect((await ask(gatewayKey)).status).toBe(403);
    expect(asked).toEqual([]);
  });

  // Pen-testing I2-2: the key is checked before the body is read.
  it("refuses a request with no key in use before reading its body", async () => {
    const { asked, running } = await setUp();
    const { port, hostname } = new URL(running.url);
    const answer = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(
        {
          host: hostname,
          port,
          method: "POST",
          path: toolCallScreenPath,
          headers: {
            "content-type": "application/json",
            "content-length": 1024 * 1024,
          },
          agent: false,
        },
        (response) => {
          response.resume();
          clearTimeout(timer);
          outgoing.destroy();
          resolve(response.statusCode);
        },
      );
      // The rest of the body is held back: an answer must not wait for it.
      const timer = setTimeout(() => {
        outgoing.destroy();
        resolve(undefined);
      }, 1000);
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") {
          reject(error);
        }
      });
      outgoing.write("{");
    });
    expect(answer).toBe(401);
    expect(asked).toEqual([]);
  });

  it("is not served when AI Office gives the Gateway no screen", async () => {
    gateway = await startGateway({ account: undefined });
    const response = await fetch(`${gateway.url}${toolCallScreenPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${gatewayKey}` },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});
