import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import {
  buildGateway,
  createAgentWork,
  createRequestHistory,
  memoryRequestHistoryStore,
  requestTokens,
  staticAccounts,
  staticKeys,
  type AgentWork,
  type GatewayCaller,
} from "@ai-office/gateway";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createCapEnforcement,
  createFloors,
  createNotices,
  createTokenCaps,
  createUsageTally,
  memoryStores,
  ownerToolCapRefusal,
  type AgentRecord,
  type CapEnforcement,
  type TokenCapService,
} from "@ai-office/orchestrator";
import { terminalKeyName, type TokenCaps } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testEncryptor } from "../test-support.ts";

// G1 (issue #195), "AI Gateway and credentials": Token Caps (PRD §6.7,
// FR-31 to FR-33) as the server wires them (`server.ts`): the real AI
// Gateway in front of a fake AI Provider, its requests recorded in the
// request history, the usage tally, and `createCapEnforcement` asked
// before each of an Agent's calls and told after each is recorded. The
// attacker is a Gateway Key holder: a sandbox's own key (position 3) or a
// stolen one (position 4). These probes show:
// - G1-1 (H11): the issue a call names is the caller's word, so a sandbox
//   slips its issue's cap by naming none, escapes its own cap by naming an
//   issue with a higher one, and pauses another Agent by billing its issue.
// - G1-2: a cap is checked before a call and counted after it, so calls
//   made at once all pass it: an Agent spends past its cap without bound.
// - G1-3: an Owner tool (and the Terminal) has no Token Cap at all, though
//   FR-33 says Owner tools can have caps too.
// And keep holding: the Floor a cap is read on is the key's, not one the
// call names; the Manager's key, which its chat session uses, is capped as
// any Agent's.
//
// Assessed at the branch head (feat/pen-testing); see
// docs/pen-testing/assessments/G1.md.

const keyOf = {
  coder: "aio_gk_thecodersownsandboxkey00000000000000000",
  qa: "aio_gk_theqaagentsownsandboxkey00000000000000",
  manager: "aio_gk_themanagersownchatsessionkey0000000000",
  ownerTool: "aio_gk_theownerslocalclaudecodekey00000000000",
  terminal: "aio_gk_theterminalsownkey000000000000000000000",
} as const;

// Each call uses 300 input and 125 output tokens: 425 against a cap.
const perCall = 425;
const answer = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "Working on it." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 300, output_tokens: 125 },
});

let upstream: Server | undefined;
let gateway: FastifyInstance | undefined;
let enforcement: CapEnforcement | undefined;

afterEach(async () => {
  enforcement?.stop();
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
  enforcement = undefined;
  gateway = undefined;
  upstream = undefined;
});

interface Office {
  readonly coder: AgentRecord;
  readonly qa: AgentRecord;
  readonly manager: AgentRecord;
  readonly caps: TokenCapService;
  readonly enforcement: CapEnforcement;
  /**
   * The work AI Office gives Agents, as the server wires it: a sandbox's
   * runner holds its issue for its Agent while it runs.
   */
  readonly work: AgentWork;
  /** Sets an Agent's own caps. */
  readonly setAgentCaps: (agent: AgentRecord, caps: TokenCaps) => Promise<void>;
  /**
   * One model call with `key`, naming `issue` if given, as an agent tool
   * makes it; resolves once it is recorded and Token Caps are told.
   */
  readonly call: (
    key: string,
    issue?: number,
  ) => Promise<{ readonly status: number; readonly body: unknown }>;
  /** The most calls the AI Provider has held at once. */
  readonly peak: () => number;
  /** Tokens counted, today, for an Agent's own use and for an issue. */
  readonly used: (subject: {
    agentId?: string;
    issue?: number;
  }) => Promise<number>;
}

/**
 * web-shop (Development: a Manager, a coder, a reviewer and QA) and blog,
 * with every Agent's key, an Owner tool's and the Terminal's, wired as the
 * server wires them. `hold` makes the AI Provider wait until that many
 * calls have arrived before it answers any, or until none has arrived for
 * a quarter of a second: every call the Gateway lets through at once is in
 * flight together.
 */
async function office(options: { readonly hold?: number } = {}) {
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const floors = createFloors({ store: stores.floors, github, events: bus });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");
  const team = await stores.agents.list("web-shop");
  const byRole = (role: string): AgentRecord => {
    const found = team.find((agent) => agent.role === role);
    if (found === undefined) {
      throw new Error(`web-shop has no ${role}.`);
    }
    return found;
  };
  const coder = byRole("coder");
  const qa = byRole("qa");
  const manager = byRole("manager");

  let waiting: (() => void)[] = [];
  let quiet: NodeJS.Timeout | undefined;
  let peak = 0;
  const answerAll = () => {
    clearTimeout(quiet);
    const all = waiting;
    waiting = [];
    for (const send of all) {
      send();
    }
  };
  upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(answer);
      };
      if (options.hold === undefined) {
        reply();
        return;
      }
      waiting.push(reply);
      peak = Math.max(peak, waiting.length);
      if (waiting.length >= options.hold) {
        answerAll();
      } else {
        clearTimeout(quiet);
        quiet = setTimeout(answerAll, 250);
      }
    });
  });
  await new Promise<void>((resolve) =>
    upstream?.listen(0, "127.0.0.1", resolve),
  );
  const { port } = upstream.address() as AddressInfo;

  const requestHistory = createRequestHistory({
    store: memoryRequestHistoryStore(),
    encryptor: testEncryptor,
  });
  const tally = createUsageTally({
    load: (from, to) => requestHistory.tokenUsage(from, to),
  });
  const caps = createTokenCaps({
    store: stores.tokenCaps,
    floors: stores.floors,
    agents: stores.agents,
    events: bus,
    usage: (from, to) => tally.usage(from, to),
  });
  const notices = createNotices({ store: stores.notices, events: bus });
  const enforcing = createCapEnforcement({
    caps,
    agents: stores.agents,
    pauses: stores.capPauses,
    notices,
    events: bus,
  });
  enforcement = enforcing;
  const observed: Promise<void>[] = [];
  let recorded = 0;
  requestHistory.subscribe((request) => {
    recorded++;
    tally.record({ ...request, totals: requestTokens(request) });
    if (request.floorId !== null && request.agentId !== null) {
      observed.push(
        enforcing.observe({
          floorId: request.floorId,
          agentId: request.agentId,
          issue: request.issue ?? undefined,
        }),
      );
    }
  });
  const work = createAgentWork();
  const agentCaller = (agent: AgentRecord): GatewayCaller => ({
    kind: "agent",
    keyId: `${agent.role}-key`,
    agentId: agent.id,
    floorId: agent.floorId,
    name: agent.name,
  });
  gateway = await buildGateway({
    logger: pino({ level: "silent" }),
    accounts: staticAccounts({
      id: null,
      name: "claude-key",
      apiKey: "sk-ant-api03-thecapprobesaccountkey-000000000",
      baseUrl: `http://127.0.0.1:${String(port)}`,
      apiFormat: "anthropic",
    }),
    keys: staticKeys({
      [keyOf.coder]: agentCaller(coder),
      [keyOf.qa]: agentCaller(qa),
      [keyOf.manager]: agentCaller(manager),
      [keyOf.ownerTool]: {
        kind: "owner_tool",
        keyId: "laptop-key",
        name: "Laptop Claude Code",
      },
      // As `createGatewayKeys` tells the Terminal's key.
      [keyOf.terminal]: {
        kind: "owner_tool",
        keyId: "terminal-key",
        name: terminalKeyName,
      },
    }),
    requestLog: requestHistory,
    capCheck: (subject) => enforcing.check(subject),
    ownerToolCapCheck: (ownerTool) => ownerToolCapRefusal(caps, ownerTool),
    work,
  });
  const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
  await enforcing.start();

  let sent = 0;
  const result: Office = {
    coder,
    qa,
    manager,
    caps,
    enforcement: enforcing,
    work,
    peak: () => peak,
    async setAgentCaps(agent, agentCaps) {
      const [current] = (await stores.agents.list(agent.floorId)).filter(
        ({ id }) => id === agent.id,
      );
      if (current === undefined) {
        throw new Error(`${agent.name} is gone.`);
      }
      await stores.agents.update({ ...current, tokenCaps: agentCaps });
    },
    async call(key, issue) {
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          authorization: `Bearer ${key}`,
          "user-agent": "claude-cli/2.1.0 (external, sdk-cli)",
          ...(issue === undefined
            ? {}
            : { "x-ai-office-issue": String(issue) }),
        },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "Work the issue." }],
        }),
      });
      const body: unknown = await response.json();
      sent++;
      // A refused call is recorded too.
      await vi.waitFor(() => {
        expect(recorded).toBe(sent);
      });
      await Promise.all(observed);
      return { status: response.status, body };
    },
    async used({ agentId, issue }) {
      const rows = await tally.usage(
        new Date(Date.UTC(2000, 0, 1)),
        new Date(Date.UTC(2100, 0, 1)),
      );
      return rows
        .filter(
          (row) =>
            (agentId === undefined || row.agentId === agentId) &&
            (issue === undefined ||
              (row.floorId === "web-shop" && row.issue === issue)),
        )
        .reduce(
          (sum, row) => sum + row.totals.inputTokens + row.totals.outputTokens,
          0,
        );
    },
  };
  return result;
}

const cap1000: TokenCaps = { daily: 1_000, monthly: null };

describe("G1-1 (H11): slipping a per-issue Token Cap", () => {
  // The coder works #4, whose own cap is 1,000 tokens a day. Its sandbox
  // is told AI_OFFICE_ISSUE=4, and its agent tool sends it as
  // `x-ai-office-issue`; code in the sandbox can send anything, or nothing.
  // The sandbox's runner holds #4 for the coder while it runs, as the
  // server wires it (fixed: G1-1).

  it("the issue's cap holds while the calls name the issue", async () => {
    const { caps, coder, call, work } = await office();
    work.hold(coder.id, { issue: 4 });
    await caps.setIssueCaps("web-shop", 4, cap1000);
    expect((await call(keyOf.coder, 4)).status).toBe(200);
    expect((await call(keyOf.coder, 4)).status).toBe(200);
    expect((await call(keyOf.coder, 4)).status).toBe(200);
    // 1,275 of #4's 1,000: paused, and refused.
    expect((await call(keyOf.coder, 4)).status).toBe(403);
    expect(enforcement?.isPaused(coder.id)).toBe(true);
  });

  it("regression (G1-1): the same work, naming no issue, is no longer kept off #4's cap: it counts against #4, which pauses the coder", async () => {
    const { caps, coder, call, used, work } = await office();
    work.hold(coder.id, { issue: 4 });
    await caps.setIssueCaps("web-shop", 4, cap1000);
    const statuses: number[] = [];
    for (let index = 0; index < 5; index++) {
      statuses.push((await call(keyOf.coder)).status);
    }
    // Before the fix: five 200s, 2,125 tokens, none of them #4's.
    expect(statuses).toEqual([200, 200, 200, 403, 403]);
    expect(await used({ agentId: coder.id })).toBe(3 * perCall);
    expect(await used({ issue: 4 })).toBe(3 * perCall);
    expect(enforcement?.isPaused(coder.id)).toBe(true);
  });

  it("G1-1: an Agent working an issue is refused at the issue's cap, whatever its calls name", async () => {
    const { caps, coder, call, work } = await office();
    work.hold(coder.id, { issue: 4 });
    await caps.setIssueCaps("web-shop", 4, cap1000);
    const statuses: number[] = [];
    for (let index = 0; index < 5; index++) {
      statuses.push((await call(keyOf.coder)).status);
    }
    expect(statuses).toContain(403);
  });

  it("G1-1: naming another issue, or one of another Floor's numbers, counts against the issue the Agent works too", async () => {
    const { caps, coder, call, used, work } = await office();
    work.hold(coder.id, { issue: 4 });
    await caps.setIssueCaps("web-shop", 4, cap1000);
    const statuses: number[] = [];
    for (const named of [9, 7, 123_456]) {
      statuses.push((await call(keyOf.coder, named)).status);
    }
    statuses.push((await call(keyOf.coder, 9)).status);
    expect(statuses).toEqual([200, 200, 200, 403]);
    expect(await used({ issue: 4 })).toBe(3 * perCall);
    expect(await used({ issue: 9 })).toBe(0);
    expect(await used({ issue: 7 })).toBe(0);
  });

  it("G1-1: once the sandbox's run has ended, its Agent's calls count against no issue", async () => {
    const { caps, coder, call, used, work } = await office();
    const release = work.hold(coder.id, { issue: 4 });
    await caps.setIssueCaps("web-shop", 4, cap1000);
    expect((await call(keyOf.coder)).status).toBe(200);
    release();
    expect((await call(keyOf.coder, 4)).status).toBe(200);
    expect((await call(keyOf.coder, 4)).status).toBe(200);
    expect(await used({ issue: 4 })).toBe(perCall);
    expect(await used({ agentId: coder.id })).toBe(3 * perCall);
  });
});

describe("G1-1 (H11): escaping an Agent's own Token Cap through another issue's", () => {
  // The coder's own cap is 1,000 tokens a day. The Owner has given #7, a
  // big issue QA works, a cap of 1,000,000. The most specific cap applies
  // (FR-32); before the fix the issue was whatever the call named.

  it("regression (G1-1): naming #7, the coder no longer spends past its own cap: #7 is billed nothing, and the coder is refused and paused", async () => {
    const { caps, coder, setAgentCaps, call, used } = await office();
    await setAgentCaps(coder, cap1000);
    await caps.setIssueCaps("web-shop", 7, {
      daily: 1_000_000,
      monthly: null,
    });
    const statuses: number[] = [];
    for (let index = 0; index < 5; index++) {
      statuses.push((await call(keyOf.coder, 7)).status);
    }
    // Before the fix: five 200s, 2,125 tokens, never paused.
    expect(statuses).toEqual([200, 200, 200, 403, 403]);
    expect(await used({ agentId: coder.id })).toBe(3 * perCall);
    expect(await used({ issue: 7 })).toBe(0);
    expect(enforcement?.isPaused(coder.id)).toBe(true);
  });

  it("G1-1: an Agent is refused at its own cap, whatever issue its calls name", async () => {
    const { caps, coder, setAgentCaps, call } = await office();
    await setAgentCaps(coder, cap1000);
    await caps.setIssueCaps("web-shop", 7, {
      daily: 1_000_000,
      monthly: null,
    });
    const statuses: number[] = [];
    for (let index = 0; index < 5; index++) {
      statuses.push((await call(keyOf.coder, 7)).status);
    }
    expect(statuses).toContain(403);
  });
});

describe("G1-1 (H11): billing another Agent's issue", () => {
  // QA works #9, whose cap is 1,000 tokens a day. The coder works #4.

  it("regression (G1-1): the coder's calls naming #9 no longer use up its cap: #9 has used nothing, and QA, working #9, is served", async () => {
    const { caps, coder, qa, call, used, work } = await office();
    work.hold(coder.id, { issue: 4 });
    work.hold(qa.id, { issue: 9 });
    await caps.setIssueCaps("web-shop", 9, cap1000);
    for (let index = 0; index < 3; index++) {
      expect((await call(keyOf.coder, 9)).status).toBe(200);
    }
    // Before the fix: #9 had used 1,275, and QA's first call was a 403.
    expect(await used({ issue: 9 })).toBe(0);
    expect(await used({ issue: 4 })).toBe(3 * perCall);
    expect((await call(keyOf.qa, 9)).status).toBe(200);
    expect(enforcement?.isPaused(qa.id)).toBe(false);
  });

  it("G1-1: one Agent's calls never pause another Agent", async () => {
    const { caps, qa, call } = await office();
    await caps.setIssueCaps("web-shop", 9, cap1000);
    for (let index = 0; index < 3; index++) {
      await call(keyOf.coder, 9);
    }
    expect((await call(keyOf.qa, 9)).status).toBe(200);
    expect(enforcement?.isPaused(qa.id)).toBe(false);
  });

  it("an issue is read on the key's own Floor: naming #9 bills web-shop's #9, never another Floor's", async () => {
    const { caps, coder, call } = await office();
    await caps.setIssueCaps("blog", 9, cap1000);
    for (let index = 0; index < 3; index++) {
      await call(keyOf.coder, 9);
    }
    const blog = await caps.floorUsage("blog");
    expect(blog.usage.daily.tokens).toBe(0);
    expect(blog.issues).toEqual([
      expect.objectContaining({
        issue: 9,
        usage: expect.objectContaining({
          daily: expect.objectContaining({ tokens: 0 }) as unknown,
        }) as unknown,
      }),
    ]);
    const shop = await caps.floorUsage("web-shop");
    expect(
      shop.agents.find(({ agentId }) => agentId === coder.id)?.usage.daily
        .tokens,
    ).toBe(3 * perCall);
  });
});

describe("G1-2: calls made at once all pass a cap checked before them", () => {
  // The coder's own cap is 1,000 tokens a day: two calls' worth and a
  // bit. The AI Provider holds what arrives until ten calls have, or until
  // no more come, so every call the Gateway lets through at once is in
  // flight together, as a sandbox's code can send them.
  const parallel = 10;

  it("regression (G1-2): ten calls at once are no longer all served: they reach the AI Provider one at a time, and those past the cap are refused", async () => {
    const { coder, setAgentCaps, call, used, peak } = await office({
      hold: parallel,
    });
    await setAgentCaps(coder, cap1000);
    const statuses = await Promise.all(
      Array.from({ length: parallel }, () => call(keyOf.coder)),
    ).then((answers) => answers.map(({ status }) => status));
    // Before the fix: ten 200s, 4,250 tokens, all ten held at once.
    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 403)).toHaveLength(7);
    expect(peak()).toBe(1);
    expect(await used({ agentId: coder.id })).toBe(3 * perCall);
    expect(enforcement?.isPaused(coder.id)).toBe(true);
  });

  it("G1-2: an Agent's tokens never pass its cap by more than one call's", async () => {
    const { coder, setAgentCaps, call, used } = await office({
      hold: parallel,
    });
    await setAgentCaps(coder, cap1000);
    await Promise.all(
      Array.from({ length: parallel }, () => call(keyOf.coder)),
    );
    expect(await used({ agentId: coder.id })).toBeLessThanOrEqual(
      1_000 + perCall,
    );
  });

  it("G1-2: an issue's cap, too, is passed by no more than one call's", async () => {
    const { caps, coder, call, used, work } = await office({
      hold: parallel,
    });
    work.hold(coder.id, { issue: 4 });
    await caps.setIssueCaps("web-shop", 4, cap1000);
    await Promise.all(
      Array.from({ length: parallel }, () => call(keyOf.coder)),
    );
    expect(await used({ issue: 4 })).toBeLessThanOrEqual(1_000 + perCall);
  });

  it("G1-2: one Agent's calls in flight never hold up another Agent's", async () => {
    const { coder, qa, call, peak } = await office({ hold: 2 });
    // The coder's call is held until QA's arrives too.
    const statuses = await Promise.all([call(keyOf.coder), call(keyOf.qa)]);
    expect(statuses.map(({ status }) => status)).toEqual([200, 200]);
    expect(peak()).toBe(2);
    expect(enforcement?.isPaused(coder.id)).toBe(false);
    expect(enforcement?.isPaused(qa.id)).toBe(false);
  });
});

describe("G1-3: an Owner tool has no Token Cap (FR-33)", () => {
  // The office's caps, the default for every Agent, are 1,000 tokens a
  // day. FR-33: "Owner tools (FR-46) can have caps too." Each Owner tool's
  // key, the Terminal's too, is now held to them, against its own use
  // (fixed: G1-3).

  it("regression (G1-3): an Owner tool's key, and the Terminal's, no longer spend past every cap the Office has: each is refused at the office's daily cap", async () => {
    const { caps, call, used } = await office();
    await caps.setOfficeCaps({ daily: 1_000, monthly: 2_000 });
    for (const key of [keyOf.ownerTool, keyOf.terminal]) {
      const statuses: number[] = [];
      for (let index = 0; index < 6; index++) {
        statuses.push((await call(key)).status);
      }
      // Before the fix: six 200s each.
      expect(statuses).toEqual([200, 200, 200, 403, 403, 403]);
    }
    // 2,550 tokens, three calls each, where before it was 5,100.
    expect(await used({})).toBe(6 * perCall);
  });

  it("G1-3: an Owner tool is refused once its tokens reach a Token Cap", async () => {
    const { caps, call } = await office();
    await caps.setOfficeCaps({ daily: 1_000, monthly: 2_000 });
    const statuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      statuses.push((await call(keyOf.ownerTool)).status);
    }
    expect(statuses).toContain(403);
  });

  it("G1-3: the refusal is a cap error naming the Owner tool and the office's cap, and goes nowhere", async () => {
    const { caps, call } = await office();
    await caps.setOfficeCaps({ daily: 1_000, monthly: 2_000 });
    for (let index = 0; index < 3; index++) {
      await call(keyOf.ownerTool);
    }
    const refused = await call(keyOf.ownerTool);
    expect(refused).toEqual({
      status: 403,
      body: {
        type: "error",
        error: {
          type: "permission_error",
          message:
            "The Owner tool \"Laptop Claude Code\" reached the office's daily Token Cap (1,000 tokens), so AI Office refuses its calls until the day is over, or the Owner raises the office's cap.",
        },
      },
    });
  });

  it("G1-3: an Owner tool's use counts against no Agent's cap, and no Agent's against an Owner tool's", async () => {
    const { caps, coder, call } = await office();
    await caps.setOfficeCaps({ daily: 1_000, monthly: 2_000 });
    for (let index = 0; index < 2; index++) {
      expect((await call(keyOf.coder)).status).toBe(200);
      expect((await call(keyOf.ownerTool)).status).toBe(200);
    }
    expect(enforcement?.isPaused(coder.id)).toBe(false);
  });

  it("G1-3 with G1-2: an Owner tool's calls made at once pass the cap by no more than one call's", async () => {
    const { caps, call, used, peak } = await office({ hold: 10 });
    await caps.setOfficeCaps({ daily: 1_000, monthly: 2_000 });
    await Promise.all(Array.from({ length: 10 }, () => call(keyOf.ownerTool)));
    expect(peak()).toBe(1);
    expect(await used({})).toBeLessThanOrEqual(1_000 + perCall);
  });
});

describe("the Manager chat's Gateway path", () => {
  it("the Manager's key, which its chat session uses, is capped as any Agent's, and names no issue", async () => {
    const { manager, setAgentCaps, call } = await office();
    await setAgentCaps(manager, cap1000);
    for (let index = 0; index < 3; index++) {
      expect((await call(keyOf.manager)).status).toBe(200);
    }
    expect((await call(keyOf.manager)).status).toBe(403);
    expect(enforcement?.isPaused(manager.id)).toBe(true);
  });
});
