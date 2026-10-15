import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createEventBus,
  memoryEventStore,
  type OfficeEvent,
} from "@ai-office/events";
import {
  buildGateway,
  createAgentWork,
  createRequestHistory,
  memoryRequestHistoryStore,
  requestTokens,
  staticAccounts,
  staticKeys,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createCapEnforcement,
  createFloors,
  createNotices,
  createTokenCaps,
  createUsageTally,
  createWorkQueue,
  memoryStores,
  memoryWorkQueueStore,
} from "@ai-office/orchestrator";
import { tokenCapActions } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testEncryptor } from "../test-support.ts";

// PRD §5 scenario 5, "Cap reached", as the server wires it: an Agent
// calls models through the real AI Gateway, its requests are recorded,
// and Token Caps are enforced from the usage tally. It crosses 80% of its
// daily cap (a warning Notice), then 100%: its next call is refused, it is
// paused (its queued work waits) and an action Notice offers to raise the
// cap or resume tomorrow. Raising the cap from the Notice resumes it.

const agentKey = "aio_gk_adasownkeyforhersandboxcalls00000000000";
// Each call uses 300 input and 125 output tokens: 425 against the cap.
const answer = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "Working on it." }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 300,
    output_tokens: 125,
    cache_read_input_tokens: 40,
  },
});

let upstream: Server | undefined;
let gateway: FastifyInstance | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
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
  stop = undefined;
  gateway = undefined;
  upstream = undefined;
});

describe("PRD §5 scenario 5: an Agent reaches its Token Cap", () => {
  it("warns at 80%, refuses and pauses at 100% with a Notice, and resumes when the cap is raised", async () => {
    // The Office: web-shop, whose coder has a daily cap of 1,000 tokens.
    const bus = createEventBus({ store: memoryEventStore() });
    const stores = memoryStores();
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    await createFloors({ store: stores.floors, github, events: bus }).add(
      "adrianeyre/web-shop",
    );
    const coder = (await stores.agents.list("web-shop")).find(
      ({ role }) => role === "coder",
    );
    if (coder === undefined) {
      throw new Error("web-shop has no coder.");
    }
    await stores.agents.update({
      ...coder,
      tokenCaps: { daily: 1_000, monthly: null },
    });

    // An AI Provider that answers every call.
    let upstreamCalls = 0;
    upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        upstreamCalls++;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(answer);
      });
    });
    await new Promise<void>((resolve) =>
      upstream?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = upstream.address() as AddressInfo;

    // Wired as the server wires it.
    const requestHistory = createRequestHistory({
      store: memoryRequestHistoryStore(),
      encryptor: testEncryptor,
    });
    const tally = createUsageTally({
      load: (from, to) => requestHistory.tokenUsage(from, to),
    });
    const notices = createNotices({ store: stores.notices, events: bus });
    const started: number[] = [];
    const workStore = memoryWorkQueueStore(stores.floors);
    let wake = (): void => undefined;
    const enforcement = createCapEnforcement({
      caps: createTokenCaps({
        store: stores.tokenCaps,
        floors: stores.floors,
        agents: stores.agents,
        events: bus,
        usage: (from, to) => tally.usage(from, to),
      }),
      agents: stores.agents,
      pauses: stores.capPauses,
      notices,
      events: bus,
      onResume: () => {
        wake();
      },
    });
    const observed: Promise<void>[] = [];
    requestHistory.subscribe((request) => {
      tally.record({ ...request, totals: requestTokens(request) });
      if (request.floorId !== null && request.agentId !== null) {
        observed.push(
          enforcement.observe({
            floorId: request.floorId,
            agentId: request.agentId,
            issue: request.issue ?? undefined,
          }),
        );
      }
    });
    const queue = createWorkQueue({
      store: workStore,
      agents: stores.agents,
      events: bus,
      limit: () => Promise.resolve(3),
      execute: (work) => {
        started.push(work.issue);
        return Promise.resolve("finished");
      },
      pausedAgents: () => enforcement.pausedAgents(),
    });
    wake = () => {
      queue.wake();
    };
    const work = createAgentWork();
    gateway = await buildGateway({
      logger: pino({ level: "silent" }),
      accounts: staticAccounts({
        id: null,
        name: "claude-key",
        apiKey: "sk-ant-api03-thescenariosaccountkey-0000000000",
        baseUrl: `http://127.0.0.1:${String(port)}`,
        apiFormat: "anthropic",
      }),
      keys: staticKeys({
        [agentKey]: {
          kind: "agent",
          keyId: "ada-key",
          agentId: coder.id,
          floorId: "web-shop",
          name: coder.name,
        },
      }),
      requestLog: requestHistory,
      capCheck: (subject) => enforcement.check(subject),
      work,
    });
    // The coder's sandbox works #4: its runner holds it for the coder
    // (pen-testing G1-1).
    work.hold(coder.id, { issue: 4 });
    const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
    await enforcement.start();
    await queue.start();
    stop = async () => {
      await queue.stop();
      enforcement.stop();
    };

    /** One of the Agent's model calls, as Claude Code makes it. */
    let recorded = 0;
    const call = async () => {
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          authorization: `Bearer ${agentKey}`,
          "x-ai-office-issue": "4",
          "user-agent": "claude-cli/2.1.0 (external, sdk-cli)",
        },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "Work issue #4." }],
        }),
      });
      const body: unknown = await response.json();
      // Recorded, and Token Caps told, once the answer has gone.
      recorded++;
      await vi.waitFor(async () => {
        expect(
          (await requestHistory.list({ limit: 200 })).requests,
        ).toHaveLength(recorded);
      });
      await Promise.all(observed);
      return { status: response.status, body, headers: response.headers };
    };
    const events = async (): Promise<OfficeEvent[]> =>
      (await bus.eventsAfter(0)).map(({ event }) => event);
    const reached = async () =>
      (await notices.open()).filter(({ title }) =>
        title.startsWith("Token Cap reached"),
      );

    // 425 of 1,000: nothing to say.
    expect((await call()).status).toBe(200);
    expect(await notices.open()).toEqual([]);

    // 850 of 1,000: past 80%, a warning Notice.
    expect((await call()).status).toBe(200);
    expect(await notices.open()).toEqual([
      expect.objectContaining({
        kind: "action",
        title: `Token Cap warning: ${coder.name} has used 85% of its own daily Token Cap (850 of 1,000 tokens)`,
        agentId: coder.id,
      }),
    ]);
    expect(
      (await events()).filter(({ type }) => type === "cap.warning"),
    ).toHaveLength(1);

    // This call is under the cap, so it is served; it takes the Agent to
    // 1,275, past 100%: the Agent is paused, with an action Notice.
    expect((await call()).status).toBe(200);
    expect(enforcement.isPaused(coder.id)).toBe(true);
    const [notice] = await reached();
    expect(notice).toMatchObject({
      kind: "action",
      title: `Token Cap reached: ${coder.name} is paused at its own daily Token Cap (1,275 of 1,000 tokens)`,
      floorId: "web-shop",
      agentId: coder.id,
      actions: [
        { id: tokenCapActions.raiseCap, label: "Raise cap" },
        { id: tokenCapActions.resumeTomorrow, label: "Resume tomorrow" },
      ],
    });
    expect(await events()).toContainEqual({
      type: "cap.reached",
      version: 1,
      level: "agent",
      period: "daily",
      floorId: "web-shop",
      agentId: coder.id,
      issue: 4,
      used: 1_275,
      cap: 1_000,
    });
    expect(await events()).toContainEqual(
      expect.objectContaining({
        type: "agent.status_changed",
        agentId: coder.id,
        status: "capped",
      }),
    );

    // The Gateway refuses its next call with a cap error, sending nothing
    // to the AI Provider.
    const refused = await call();
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-ai-office-refusal")).toBe("token_cap");
    expect(refused.body).toEqual({
      type: "error",
      error: {
        type: "permission_error",
        message: expect.stringContaining(
          `${coder.name} reached its own daily Token Cap (1,000 tokens), so AI Office has paused it.`,
        ) as unknown,
      },
    });
    expect(upstreamCalls).toBe(3);
    // Paused: its work waits in the queue.
    await queue.enqueue({ floorId: "web-shop", issue: 5, stage: "needs-work" });
    await queue.idle();
    expect(started).toEqual([]);

    // The Owner raises the cap from the Notice: the Agent resumes.
    await notices.act(notice?.id ?? "", tokenCapActions.raiseCap);
    expect(enforcement.isPaused(coder.id)).toBe(false);
    const [raised] = (await stores.agents.list("web-shop")).filter(
      ({ id }) => id === coder.id,
    );
    expect(raised?.tokenCaps.daily).toBe(2_275);
    expect(await reached()).toEqual([]);
    await vi.waitFor(() => {
      expect(started).toEqual([5]);
    });
    expect((await call()).status).toBe(200);
    expect(upstreamCalls).toBe(4);
    expect(await events()).toContainEqual({
      type: "agent.status_changed",
      version: 1,
      floorId: "web-shop",
      agentId: coder.id,
      status: "idle",
    });
  });
});
