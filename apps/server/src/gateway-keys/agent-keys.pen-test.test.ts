import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  buildGateway,
  createGatewayKeys,
  gatewayKeyContext,
  hashGatewayKey,
  memoryGatewayKeyStore,
  memoryRequestLog,
  servedAs,
  staticAccounts,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createFloors, memoryStores } from "@ai-office/orchestrator";
import { gatewayKeyErrorCodes } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { testEncryptor } from "../test-support.ts";
import { keepAgentKeys, keysAtWork } from "./agent-keys.ts";

// G1 (issue #195), "AI Gateway and credentials": what an Agent's Gateway
// Key is (FR-46, ADR 0001), wired as the server wires it: the real
// `createGatewayKeys` (sealed with ENCRYPTION_KEY), `keepAgentKeys`
// following Agents, real Floors, and the real AI Gateway asking those keys
// who is calling. A sandbox is given its Agent's key in its environment;
// code in it (position 3), or whoever it sends the key to (position 4,
// S2-1, P2-1), holds it from then on. These probes show:
// - G1-4: the key is the Agent's, not the sandbox's: it keeps calling
//   models after its Agent is paused and after its Floor is archived; only
//   the Owner rotating it, or removing the Agent, ends it.
// - G1-5 (fixed): the Gateway is told each Agent's AI Provider as it is
//   now, so its key is served only as that AI Provider's agent tool.
// And keep holding: each Agent has its own key, which names its Agent and
// Floor; it cannot sign in to the web app; rotation and removal revoke it;
// it is kept as a hash, and sealed to its own row.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/G1.md.

let upstream: Server | undefined;
let gateway: FastifyInstance | undefined;

afterEach(async () => {
  await gateway?.close();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (upstream === undefined) {
      resolve();
    } else {
      upstream.close(() => {
        resolve();
      });
    }
  });
  gateway = undefined;
  upstream = undefined;
});

/** The Office's Agents and their keys, and a Gateway in front of them. */
async function office() {
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const floors = createFloors({ store: stores.floors, github, events: bus });
  const keyStore = memoryGatewayKeyStore();
  const keys = createGatewayKeys({
    store: keyStore,
    encryptor: testEncryptor,
    events: bus,
  });
  const following = keepAgentKeys({ events: bus, keys, stores });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");
  await following.catchUp();
  const agent = async (floorId: string, role: string) => {
    const found = (await stores.agents.list(floorId)).find(
      (candidate) => candidate.role === role,
    );
    if (found === undefined) {
      throw new Error(`${floorId} has no ${role}.`);
    }
    return found;
  };
  const coder = await agent("web-shop", "coder");
  const blogCoder = await agent("blog", "coder");
  const manager = await agent("web-shop", "manager");
  let communicationsEnabled = true;

  upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "message",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    upstream?.listen(0, "127.0.0.1", resolve),
  );
  const { port } = upstream.address() as AddressInfo;
  gateway = await buildGateway({
    logger: pino({ level: "silent" }),
    accounts: staticAccounts({
      id: null,
      name: "claude-key",
      apiKey: "sk-ant-api03-thekeyprobesaccountkey-000000000",
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiFormat: "anthropic",
    }),
    // As the server wires them (fixed: G1-4).
    keys: keysAtWork({
      keys,
      stores,
      communicationsEnabled: () => Promise.resolve(communicationsEnabled),
    }),
    requestLog: memoryRequestLog(),
  });
  const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
  /** A model call with `key`, as a sandbox's agent tool makes it. */
  const call = async (key: string): Promise<number> =>
    (
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 8 }),
      })
    ).status;
  /** The key a sandbox of `agentId` is given now. */
  const sandboxKey = async (agentId: string): Promise<string> => {
    const key = await keys.agentKey(agentId);
    if (key === undefined) {
      throw new Error(`${agentId} has no key.`);
    }
    return key;
  };
  return {
    stores,
    floors,
    keys,
    keyStore,
    coder,
    blogCoder,
    manager,
    call,
    sandboxKey,
    bus,
    /** Pauses or resumes the Communications Agent (FR-90). */
    setCommunicationsEnabled: (enabled: boolean) => {
      communicationsEnabled = enabled;
    },
  };
}

describe("a Gateway Key's scope", () => {
  it("is one Agent's: it names that Agent and its Floor, and no other Agent has it", async () => {
    const { keys, coder, blogCoder, sandboxKey } = await office();
    const key = await sandboxKey(coder.id);
    expect(await keys.authenticate(key)).toEqual({
      kind: "agent",
      keyId: expect.any(String) as string,
      agentId: coder.id,
      floorId: "web-shop",
      name: coder.name,
    });
    expect(await sandboxKey(blogCoder.id)).not.toBe(key);
  });

  it("only calls models: it cannot sign in to the web app, nor be given UI access", async () => {
    const { keys, coder, sandboxKey } = await office();
    const key = await sandboxKey(coder.id);
    expect(await keys.uiKey(key)).toBeUndefined();
    const info = await keys.agentKeyInfo(coder.id);
    expect(info?.access).toBe("proxy");
    await expect(
      keys.update(info?.id ?? "", { access: "proxy_and_ui" }),
    ).rejects.toMatchObject({ code: gatewayKeyErrorCodes.agentKeyNoUi });
    expect(await keys.allowsUi(info?.id ?? "")).toBe(false);
  });

  it("is kept as a SHA-256 and sealed to its own row: it opens in no other key's context", async () => {
    const { keyStore, coder, blogCoder, sandboxKey } = await office();
    const key = await sandboxKey(coder.id);
    const stored = await keyStore.forAgent(coder.id);
    const other = await keyStore.forAgent(blogCoder.id);
    expect(stored?.keyHash).toBe(hashGatewayKey(key));
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(
      testEncryptor.decrypt(
        stored?.sealedKey ?? "",
        gatewayKeyContext(stored?.id ?? ""),
      ),
    ).toBe(key);
    // Moved to another row, or opened with another key: refused.
    expect(() =>
      testEncryptor.decrypt(
        stored?.sealedKey ?? "",
        gatewayKeyContext(other?.id ?? ""),
      ),
    ).toThrow(/wrong context/);
    expect(() =>
      encryptorFromKey(Buffer.alloc(32, 1)).decrypt(
        stored?.sealedKey ?? "",
        gatewayKeyContext(stored?.id ?? ""),
      ),
    ).toThrow();
  });

  it("is revoked at once by rotation and by removing its Agent", async () => {
    const { keys, stores, coder, blogCoder, call, sandboxKey, bus } =
      await office();
    const before = await sandboxKey(coder.id);
    expect(await call(before)).toBe(200);
    await keys.issueAgentKey(coder);
    expect(await call(before)).toBe(401);
    expect(await call(await sandboxKey(coder.id))).toBe(200);

    const blogKey = await sandboxKey(blogCoder.id);
    await stores.agents.remove(blogCoder.floorId, blogCoder.id, new Date());
    await bus.publish({
      type: "agent.removed",
      version: 1,
      floorId: blogCoder.floorId,
      agentId: blogCoder.id,
    });
    expect(await call(blogKey)).toBe(401);
  });
});

describe("G1-4: an Agent's Gateway Key outlives its Agent's work", () => {
  it("regression (G1-4): a key taken from a sandbox no longer calls models after its Agent is paused, nor after its Floor is archived", async () => {
    const { stores, floors, coder, call, sandboxKey } = await office();
    const taken = await sandboxKey(coder.id);
    expect(await call(taken)).toBe(200);
    // The Owner pauses the Agent (FR-11): before the fix, still a 200.
    await stores.agents.update({ ...coder, enabled: false });
    expect(await call(taken)).toBe(401);
    // Resumed, its key works again: pausing does not rotate it.
    await stores.agents.update({ ...coder, enabled: true });
    expect(await call(taken)).toBe(200);
    // The Owner archives its Floor, "which stops all work" (FR-9): before
    // the fix, still a 200.
    await floors.archive("web-shop");
    expect(await call(taken)).toBe(401);
  });

  it("G1-4: a paused Agent's Gateway Key calls no model", async () => {
    const { stores, coder, call, sandboxKey } = await office();
    const taken = await sandboxKey(coder.id);
    await stores.agents.update({ ...coder, enabled: false });
    expect(await call(taken)).not.toBe(200);
  });

  it("G1-4: an archived Floor's Gateway Keys call no model", async () => {
    const { floors, coder, call, sandboxKey } = await office();
    const taken = await sandboxKey(coder.id);
    await floors.archive("web-shop");
    expect(await call(taken)).not.toBe(200);
  });

  it("G1-4: an archived Floor's Manager's key, which its chat sessions hold, calls no model either; another Floor's keys still do", async () => {
    const { floors, manager, blogCoder, call, sandboxKey } = await office();
    const managers = await sandboxKey(manager.id);
    expect(await call(managers)).toBe(200);
    await floors.archive("web-shop");
    expect(await call(managers)).toBe(401);
    expect(await call(await sandboxKey(blogCoder.id))).toBe(200);
  });

  it("G1-4: the paused Communications Agent's key calls no model", async () => {
    const { keys, call, setCommunicationsEnabled } = await office();
    await keys.ensureCommunicationsKey("Reception");
    const key = (await keys.communicationsKey()) ?? "";
    expect(await call(key)).toBe(200);
    setCommunicationsEnabled(false);
    expect(await call(key)).toBe(401);
    setCommunicationsEnabled(true);
    expect(await call(key)).toBe(200);
  });

  it("G1-4: an Owner tool's key is not an Agent's: pausing Agents and archiving Floors leave it be", async () => {
    const { keys, stores, floors, coder, call } = await office();
    const tool = await keys.createOwnerToolKey("Laptop Claude Code");
    await stores.agents.update({ ...coder, enabled: false });
    await floors.archive("web-shop");
    expect(await call(tool.key)).toBe(200);
  });
});

describe("G1-5: the agent tool an Agent's calls are served as", () => {
  it("G1-5: the Gateway is told each Agent's AI Provider as it is now, read at each call, so its key is served only as that AI Provider's agent tool", async () => {
    const { keys, stores, coder, sandboxKey } = await office();
    const atWork = keysAtWork({ keys, stores });
    const key = await sandboxKey(coder.id);
    const caller = await atWork.authenticate(key);
    expect(caller).toMatchObject({ kind: "agent", aiProvider: "Claude" });
    if (caller === undefined) {
      throw new Error("The coder's key is in use.");
    }
    expect(servedAs(caller, "Claude Code")).toBe("Claude Code");
    // The Owner moves the coder to Grok (opencode): from its next call, a
    // Claude Code User-Agent from its sandbox is served as no agent tool.
    await stores.agents.update({ ...coder, aiProvider: "Grok" });
    const moved = await atWork.authenticate(key);
    expect(moved).toMatchObject({ aiProvider: "Grok" });
    if (moved === undefined) {
      throw new Error("The coder's key is in use.");
    }
    expect(servedAs(moved, "Claude Code")).toBeNull();
    expect(servedAs(moved, "opencode")).toBe("opencode");
  });
});
