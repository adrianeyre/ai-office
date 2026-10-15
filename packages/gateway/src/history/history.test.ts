import { gatewayKeys, gatewayRequestBodies } from "@ai-office/db";
import { postgresTest } from "@ai-office/db/testing";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { GatewayRequestRecord } from "../request-log.ts";
import {
  gatewayKey,
  startFakeUpstream,
  startGateway,
  testCaller,
} from "../test-support.ts";
import { bodyContext, createRequestHistory } from "./history.ts";
import {
  databaseRequestHistoryStore,
  memoryRequestHistoryStore,
  type AnalyticsRow,
  type RequestHistoryStore,
  type SealedBodies,
  type StoredRequest,
} from "./store.ts";

// Request history (PRD FR-44): bodies kept sealed, and only while body
// storage is on; headers without credentials; search, filters and pages;
// and the live stream's subscribers. Each case runs in memory and in
// Postgres 18.

const encryptor = encryptorFromKey(Buffer.alloc(32, 3));
const prompt = "Please refactor src/secret-plan.ts";
const answer = JSON.stringify({
  type: "message",
  content: [{ type: "text", text: "Refactored the plan." }],
  usage: { input_tokens: 9, output_tokens: 4 },
});

interface Setup {
  readonly store: RequestHistoryStore;
  /** The sealed bodies the store holds for a request, if any. */
  sealed(id: number): Promise<SealedBodies | undefined>;
}

type Case = [name: string, run: (setup: Setup) => Promise<void>];

/** Sends one request through a Gateway recording into `store`. */
async function throughGateway(
  setup: Setup,
  storeBodies: boolean,
  body: unknown = { model: "claude-haiku-5-5", messages: [prompt] },
) {
  const upstream = await startFakeUpstream((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "request-id": "req_history",
    });
    response.end(answer);
  });
  const history = createRequestHistory({ store: setup.store, encryptor });
  const recorded: StoredRequest[] = [];
  history.subscribe((request) => recorded.push(request));
  const gateway = await startGateway({
    upstream,
    requestLog: history,
    storeBodies: () => storeBodies,
  });
  try {
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": gatewayKey,
        cookie: "session=abc",
        "anthropic-version": "2023-06-01",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    await response.text();
    await vi.waitFor(() => {
      expect(recorded).toHaveLength(1);
    });
  } finally {
    await gateway.close();
    await upstream.close();
  }
  const [request] = recorded;
  if (request === undefined) {
    throw new Error("Nothing was recorded.");
  }
  return { history, request };
}

const record = (
  fields: Partial<GatewayRequestRecord> = {},
): GatewayRequestRecord => ({
  startedAt: new Date("2026-10-09T12:00:00.000Z"),
  account: "Work",
  accountId: null,
  endpoint: "messages",
  model: "claude-opus-5-5",
  streamed: false,
  status: 200,
  latencyMs: 100,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  upstreamRequestId: null,
  gatewayKeyId: null,
  agentId: null,
  floorId: null,
  ownerTool: "test-tool",
  issue: null,
  pullRequest: null,
  estimatedCostUsd: null,
  timeToFirstByteMs: 50,
  requestHeaders: null,
  responseHeaders: null,
  ...fields,
});

const cases: Case[] = [
  [
    "keeps the bodies sealed while body storage is on",
    async (setup) => {
      const { history, request } = await throughGateway(setup, true);
      const sealed = await setup.sealed(request.id);
      expect(sealed?.request).toMatch(/^aio1:/);
      expect(sealed?.response).toMatch(/^aio1:/);
      expect(JSON.stringify(sealed)).not.toContain("secret-plan");
      expect(JSON.stringify(sealed)).not.toContain("Refactored");
      // Each opens only for its own request.
      expect(
        encryptor.decrypt(
          sealed?.request ?? "",
          bodyContext(request.id, "request"),
        ),
      ).toContain(prompt);
      expect(() =>
        encryptor.decrypt(
          sealed?.request ?? "",
          bodyContext(request.id + 1, "request"),
        ),
      ).toThrow();

      const detail = await history.get(request.id);
      expect(detail?.bodies).toEqual({
        request: JSON.stringify({
          model: "claude-haiku-5-5",
          messages: [prompt],
        }),
        response: answer,
        truncated: false,
      });
    },
  ],
  [
    "keeps no bodies while body storage is off",
    async (setup) => {
      const { history, request } = await throughGateway(setup, false);
      expect(await setup.sealed(request.id)).toBeUndefined();
      const detail = await history.get(request.id);
      expect(detail?.bodies).toBeNull();
      expect(JSON.stringify(detail)).not.toContain("secret-plan");
      // Everything else is kept.
      expect(detail).toMatchObject({
        status: 200,
        model: "claude-haiku-5-5",
        inputTokens: 9,
        outputTokens: 4,
        upstreamRequestId: "req_history",
      });
    },
  ],
  [
    "keeps headers without credentials, and the timings",
    async (setup) => {
      const { history, request } = await throughGateway(setup, false);
      const detail = await history.get(request.id);
      expect(detail?.requestHeaders).toMatchObject({
        "x-api-key": "[REDACTED]",
        cookie: "[REDACTED]",
        "anthropic-version": "2023-06-01",
      });
      expect(detail?.responseHeaders).toMatchObject({
        "content-type": "application/json",
        "request-id": "req_history",
      });
      expect(JSON.stringify(detail)).not.toContain(gatewayKey);
      expect(detail?.timeToFirstByteMs).toBeGreaterThanOrEqual(0);
      expect(detail?.timeToFirstByteMs).toBeLessThanOrEqual(
        detail?.latencyMs ?? 0,
      );
    },
  ],
  [
    "cuts a body longer than it keeps, and says so",
    async (setup) => {
      const { history, request } = await throughGateway(
        setup,
        true,
        `{"model":"m","padding":"${"x".repeat(1_100_000)}"}`,
      );
      const detail = await history.get(request.id);
      expect(detail?.bodies?.truncated).toBe(true);
      expect(Buffer.byteLength(detail?.bodies?.request ?? "")).toBe(
        1024 * 1024,
      );
    },
  ],
  [
    "redacts credentials in a body as it reads it back",
    async (setup) => {
      const { history, request } = await throughGateway(setup, true, {
        model: "m",
        messages: ["my key is sk-ant-api03-leakedinapromptAbCdEf123456"],
      });
      const detail = await history.get(request.id);
      expect(detail?.bodies?.request).toContain("[REDACTED]");
      expect(detail?.bodies?.request).not.toContain("leakedinaprompt");
    },
  ],
  [
    "adds up each Gateway Key's requests, tokens and cost",
    async ({ store }) => {
      const history = createRequestHistory({ store, encryptor });
      const keyId = testCaller.keyId;
      await history.record(
        record({
          gatewayKeyId: keyId,
          inputTokens: 10,
          outputTokens: 5,
          estimatedCostUsd: 0.5,
        }),
      );
      await history.record(
        record({
          gatewayKeyId: keyId,
          inputTokens: 20,
          outputTokens: 7,
          estimatedCostUsd: 0.25,
          startedAt: new Date("2026-10-10T08:00:00.000Z"),
        }),
      );
      await history.record(record({ gatewayKeyId: null }));
      expect(await history.keyUsage()).toEqual([
        {
          gatewayKeyId: keyId,
          requests: 2,
          inputTokens: 30,
          outputTokens: 12,
          estimatedCostUsd: 0.75,
          lastRequestAt: new Date("2026-10-10T08:00:00.000Z"),
        },
      ]);
    },
  ],
  [
    "searches, filters and pages, newest first",
    async ({ store }) => {
      const history = createRequestHistory({ store, encryptor });
      await history.record(record({ model: "claude-opus-5-5", status: 200 }));
      await history.record(
        record({
          model: "claude-haiku-5-5",
          status: 429,
          agentId: "ada",
          floorId: "web-shop",
          ownerTool: null,
        }),
      );
      await history.record(
        record({ endpoint: "responses", status: 503, model: "gpt-5.5" }),
      );
      await history.record(
        record({ upstreamRequestId: "req_FindMe_1", status: 200 }),
      );
      const ids = async (query: Parameters<typeof history.list>[0]) =>
        (await history.list(query)).requests.map(({ id }) => id);

      expect(await ids({ limit: 50 })).toEqual([4, 3, 2, 1]);
      expect(await ids({ limit: 50, status: "4xx" })).toEqual([2]);
      expect(await ids({ limit: 50, status: 503 })).toEqual([3]);
      expect(await ids({ limit: 50, endpoint: "responses" })).toEqual([3]);
      expect(await ids({ limit: 50, agentId: "ada" })).toEqual([2]);
      expect(await ids({ limit: 50, floorId: "web-shop" })).toEqual([2]);
      expect(await ids({ limit: 50, ownerTool: "test-tool" })).toEqual([
        4, 3, 1,
      ]);
      expect(await ids({ limit: 50, q: "HAIKU" })).toEqual([2]);
      expect(await ids({ limit: 50, q: "findme" })).toEqual([4]);
      expect(await ids({ limit: 50, q: "100%_" })).toEqual([]);
      expect(
        await ids({
          limit: 50,
          from: new Date("2026-10-09T13:00:00.000Z"),
        }),
      ).toEqual([]);

      const first = await history.list({ limit: 3 });
      expect(first.requests.map(({ id }) => id)).toEqual([4, 3, 2]);
      expect(first.nextBefore).toBe(2);
      const second = await history.list({ limit: 3, before: 2 });
      expect(second.requests.map(({ id }) => id)).toEqual([1]);
      expect(second.nextBefore).toBeNull();

      expect(
        (await history.after(2, { status: "2xx" })).map(({ id }) => id),
      ).toEqual([4]);
    },
  ],
  [
    "tells subscribers of new requests that match their filter",
    async ({ store }) => {
      const history = createRequestHistory({ store, encryptor });
      const all: number[] = [];
      const errors: number[] = [];
      const stop = history.subscribe((request) => all.push(request.id));
      history.subscribe((request) => errors.push(request.id), {
        status: "5xx",
      });
      await history.record(record({ status: 200 }));
      await history.record(record({ status: 502 }));
      stop();
      await history.record(record({ status: 500 }));
      expect(all).toEqual([1, 2]);
      expect(errors).toEqual([2, 3]);
    },
  ],
  [
    "adds up the tokens of the requests in a period per Floor, Agent, issue and Owner tool, as their records say",
    async ({ store }) => {
      const history = createRequestHistory({ store, encryptor });
      const from = new Date("2026-10-09T00:00:00.000Z");
      const to = new Date("2026-10-10T00:00:00.000Z");
      // Callers: two Agents on one Floor, one on another, an Owner tool.
      const callers = [
        { agentId: "ada", floorId: "web-shop", ownerTool: null },
        { agentId: "linus", floorId: "web-shop", ownerTool: null },
        { agentId: "grace", floorId: "blog", ownerTool: null },
        { agentId: null, floorId: null, ownerTool: "laptop" },
      ];
      const records: GatewayRequestRecord[] = [];
      // A fixed sequence, so the case is the same every run.
      let seed = 7;
      const next = (limit: number) => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return Math.floor(seed / 65_536) % limit;
      };
      const times = [
        new Date(from.getTime() - 1), // the day before: not counted
        from, // its first moment: counted
        new Date("2026-10-09T12:34:56.000Z"),
        new Date(to.getTime() - 1), // its last moment: counted
        to, // the next day: not counted
      ];
      for (let index = 0; index < 60; index += 1) {
        const caller = callers[next(callers.length)] ?? callers[0];
        const counted = next(5) !== 0;
        records.push(
          record({
            ...caller,
            startedAt: times[next(times.length)] ?? from,
            issue:
              caller?.agentId === null ? null : ([null, 4, 7][next(3)] ?? null),
            inputTokens: counted ? next(10_000) : null,
            outputTokens: counted ? next(2_000) : null,
            cacheReadInputTokens: counted ? next(50_000) : null,
            cacheCreationInputTokens: counted ? next(5_000) : null,
            estimatedCostUsd: counted ? next(1_000) / 1_000 : null,
          }),
        );
      }
      for (const entry of records) {
        await history.record(entry);
      }

      // The expected rows, straight from the records.
      const expected = new Map<string, Record<string, unknown>>();
      for (const entry of records) {
        if (entry.startedAt < from || entry.startedAt >= to) {
          continue;
        }
        const key = [
          entry.floorId,
          entry.agentId,
          entry.issue,
          entry.ownerTool,
        ].join("|");
        const row = (expected.get(key) ?? {
          floorId: entry.floorId,
          agentId: entry.agentId,
          issue: entry.issue,
          ownerTool: entry.ownerTool,
          totals: {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            tokens: 0,
            estimatedCostUsd: 0,
          },
        }) as { totals: Record<string, number> };
        const totals = row.totals;
        totals["requests"] = (totals["requests"] ?? 0) + 1;
        totals["inputTokens"] =
          (totals["inputTokens"] ?? 0) + (entry.inputTokens ?? 0);
        totals["outputTokens"] =
          (totals["outputTokens"] ?? 0) + (entry.outputTokens ?? 0);
        totals["cacheReadTokens"] =
          (totals["cacheReadTokens"] ?? 0) + (entry.cacheReadInputTokens ?? 0);
        totals["cacheWriteTokens"] =
          (totals["cacheWriteTokens"] ?? 0) +
          (entry.cacheCreationInputTokens ?? 0);
        totals["tokens"] =
          (totals["tokens"] ?? 0) +
          (entry.inputTokens ?? 0) +
          (entry.outputTokens ?? 0);
        totals["estimatedCostUsd"] =
          (totals["estimatedCostUsd"] ?? 0) + (entry.estimatedCostUsd ?? 0);
        expected.set(key, row);
      }
      const order = (row: {
        floorId: string | null;
        agentId: string | null;
        issue: number | null;
        ownerTool: string | null;
      }) => [row.floorId, row.agentId, row.issue, row.ownerTool].join("|");
      const rows = (await history.tokenUsage(from, to)).sort((a, b) =>
        order(a).localeCompare(order(b)),
      );
      const wanted = [...expected.values()].sort((a, b) =>
        order(a as Parameters<typeof order>[0]).localeCompare(
          order(b as Parameters<typeof order>[0]),
        ),
      );
      expect(rows.length).toBeGreaterThan(4);
      expect(rows).toHaveLength(wanted.length);
      for (const [index, row] of rows.entries()) {
        const want = wanted[index] as { totals: Record<string, number> };
        expect({
          ...row,
          totals: { ...row.totals, estimatedCostUsd: 0 },
        }).toEqual({
          ...want,
          totals: { ...want.totals, estimatedCostUsd: 0 },
        });
        expect(row.totals.estimatedCostUsd).toBeCloseTo(
          want.totals["estimatedCostUsd"] ?? 0,
          9,
        );
      }
      // Nothing outside the period.
      expect(
        await history.tokenUsage(
          new Date("2026-10-11T00:00:00.000Z"),
          new Date("2026-10-12T00:00:00.000Z"),
        ),
      ).toEqual([]);
    },
  ],
  [
    "deletes the bodies of requests started before a cutoff, keeping the requests (retention)",
    async ({ store, ...setup }) => {
      const sealed = (id: number) => setup.sealed(id);
      const history = createRequestHistory({ store, encryptor });
      const bodies = { request: prompt, response: answer, truncated: false };
      for (const startedAt of [
        "2026-10-01T09:00:00.000Z",
        "2026-10-03T08:59:59.999Z",
        "2026-10-03T09:00:00.000Z",
      ]) {
        await history.record({
          ...record({ startedAt: new Date(startedAt) }),
          bodies,
        });
      }
      await history.record(
        record({ startedAt: new Date("2026-10-01T10:00:00.000Z") }),
      );
      const ids = (await history.list({ limit: 10 })).requests
        .map(({ id }) => id)
        .sort((a, b) => a - b);
      expect(ids).toHaveLength(4);
      const [first, second, third, withoutBodies] = ids;

      expect(
        await store.deleteBodiesBefore(new Date("2026-10-03T09:00:00.000Z")),
      ).toBe(2);
      expect(await sealed(first ?? 0)).toBeUndefined();
      expect(await sealed(second ?? 0)).toBeUndefined();
      expect(await sealed(third ?? 0)).toBeDefined();
      // The requests themselves stay.
      expect((await history.get(first ?? 0))?.bodies).toBeNull();
      expect((await history.get(third ?? 0))?.bodies?.request).toBe(prompt);
      expect((await history.get(withoutBodies ?? 0))?.bodies).toBeNull();
      expect((await history.list({ limit: 10 })).requests).toHaveLength(4);
      expect(
        await store.deleteBodiesBefore(new Date("2026-10-03T09:00:00.000Z")),
      ).toBe(0);
    },
  ],
  [
    "deletes requests started before a cutoff, still counting what they used, by the day (retention)",
    async ({ store, ...setup }) => {
      const sealed = (id: number) => setup.sealed(id);
      const history = createRequestHistory({ store, encryptor });
      const ada = {
        agentId: "ada",
        floorId: "web-shop",
        ownerTool: null,
        issue: 4,
      };
      const at = (time: string) => new Date(`2026-10-${time}Z`);
      for (const fields of [
        { ...ada, startedAt: at("01T09:00:00.000"), inputTokens: 100 },
        { ...ada, startedAt: at("09T08:00:00.000"), inputTokens: 10 },
        {
          ...ada,
          startedAt: at("09T09:00:00.000"),
          inputTokens: 20,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          estimatedCostUsd: 0.5,
        },
        { ...ada, startedAt: at("09T23:00:00.000"), inputTokens: 30 },
        { ...ada, issue: null, startedAt: at("09T10:00:00.000") },
        { startedAt: at("09T11:00:00.000"), inputTokens: 7 },
        { ...ada, startedAt: at("10T01:00:00.000"), inputTokens: 1000 },
      ]) {
        await history.record({
          ...record(fields),
          bodies: { request: prompt, response: answer, truncated: false },
        });
      }
      const day = [at("09T00:00:00.000"), at("10T00:00:00.000")] as const;
      const month = [at("01T00:00:00.000"), new Date("2026-11-01")] as const;
      const sorted = async (from: Date, to: Date) =>
        (await history.tokenUsage(from, to)).sort(
          (a, b) =>
            String(a.ownerTool).localeCompare(String(b.ownerTool)) ||
            String(a.issue).localeCompare(String(b.issue)),
        );
      const before = {
        day: await sorted(...day),
        month: await sorted(...month),
        ids: (await history.list({ limit: 10 })).requests.map(({ id }) => id),
      };
      expect(before.day).toHaveLength(3);

      // Part of the 9th first: its morning.
      expect(await store.deleteBefore(at("09T09:30:00.000"))).toBe(3);
      expect(await sorted(...day)).toEqual(before.day);
      expect(await sorted(...month)).toEqual(before.month);
      // Then the rest of it, added to what that day already holds.
      expect(await store.deleteBefore(at("10T00:00:00.000"))).toBe(3);
      expect(await store.deleteBefore(at("10T00:00:00.000"))).toBe(0);
      expect(await sorted(...day)).toEqual(before.day);
      expect(await sorted(...month)).toEqual(before.month);
      expect(
        await sorted(at("10T00:00:00.000"), at("11T00:00:00.000")),
      ).toEqual([
        {
          ...ada,
          totals: {
            requests: 1,
            inputTokens: 1000,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            tokens: 1001,
            estimatedCostUsd: 0,
          },
        },
      ]);
      expect(
        await sorted(at("01T00:00:00.000"), at("02T00:00:00.000")),
      ).toEqual([
        {
          ...ada,
          totals: {
            requests: 1,
            inputTokens: 100,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            tokens: 101,
            estimatedCostUsd: 0,
          },
        },
      ]);

      // The records and their bodies are gone; the 10th's stay.
      const left = (await history.list({ limit: 10 })).requests;
      expect(left.map(({ startedAt }) => startedAt)).toEqual([
        at("10T01:00:00.000"),
      ]);
      for (const id of before.ids.filter((id) => id !== left[0]?.id)) {
        expect(await history.get(id)).toBeUndefined();
        expect(await sealed(id)).toBeUndefined();
      }
      // New requests carry on.
      await history.record(record({ startedAt: at("10T02:00:00.000") }));
      expect((await history.list({ limit: 10 })).requests).toHaveLength(2);
    },
  ],
  [
    "still adds up deleted requests for analytics, by the day (retention and the storage clean-up)",
    async ({ store }) => {
      const history = createRequestHistory({ store, encryptor });
      const at = (time: string) => new Date(`2026-10-${time}Z`);
      const ada = {
        agentId: "ada",
        floorId: "web-shop",
        ownerTool: null,
        issue: 4,
      };
      for (const fields of [
        {
          ...ada,
          startedAt: at("01T09:00:00.000"),
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
          estimatedCostUsd: 0.25,
          latencyMs: 300,
        },
        { ...ada, startedAt: at("01T10:00:00.000"), status: 529 },
        {
          ...ada,
          startedAt: at("01T10:30:00.000"),
          keepAlive: true,
          estimatedCostUsd: 0.125,
        },
        { ...ada, startedAt: at("01T11:00:00.000"), account: null },
        {
          startedAt: at("01T12:00:00.000"),
          model: "gpt-5.5",
          account: "ChatGPT",
          inputTokens: 7,
        },
        { ...ada, startedAt: at("02T08:00:00.000"), latencyMs: 40 },
        { ...ada, startedAt: at("02T20:00:00.000"), latencyMs: 60 },
        { ...ada, startedAt: at("09T12:00:00.000") },
      ]) {
        await history.record(record(fields));
      }
      const from = at("01T00:00:00.000");
      const to = at("10T00:00:00.000");
      const sort = (rows: readonly AnalyticsRow[]) =>
        [...rows].sort(
          (a, b) =>
            a.at.getTime() - b.at.getTime() ||
            String(a.model).localeCompare(String(b.model)) ||
            (a.account ?? "").localeCompare(b.account ?? ""),
        );
      // A deleted request keeps no time to first byte.
      const untimed = (rows: readonly AnalyticsRow[]) =>
        rows.map((row) => ({ ...row, timeToFirstByteMs: 0, timedRequests: 0 }));
      const before = untimed(
        sort(await history.analyticsRows(from, to, "day")),
      );
      expect(before).toHaveLength(5);
      // The 1st's keep-alive is counted, and still is once it is deleted.
      expect(
        before.map(({ keepAliveRequests, keepAliveCostUsd }) => [
          keepAliveRequests,
          keepAliveCostUsd,
        ]),
      ).toContainEqual([1, 0.125]);

      // The 1st, and the 2nd's morning: the 2nd is then partly deleted.
      expect(await store.deleteBefore(at("02T12:00:00.000"))).toBe(6);
      expect(
        untimed(sort(await history.analyticsRows(from, to, "day"))),
      ).toEqual(before);
      // Then the rest of the 2nd, added to what that day already holds.
      expect(await store.deleteBefore(at("03T00:00:00.000"))).toBe(1);
      expect(
        untimed(sort(await history.analyticsRows(from, to, "day"))),
      ).toEqual(before);
      // A range that starts after a deleted day leaves it out.
      expect(
        sort(await history.analyticsRows(at("02T00:00:00.000"), to, "day")).map(
          ({ at: day, requests }) => [day.toISOString(), requests],
        ),
      ).toEqual([
        ["2026-10-02T00:00:00.000Z", 2],
        ["2026-10-09T00:00:00.000Z", 1],
      ]);
      // By the hour, only the requests still kept count: a deleted
      // request's hour is gone with it.
      expect(
        (await history.analyticsRows(from, to, "hour")).map(
          ({ at: hour }) => hour,
        ),
      ).toEqual([at("09T12:00:00.000")]);
    },
  ],
  [
    "adds up requests per hour or day, AI Account, Model and caller for analytics, with their errors, latency and keep-alives",
    async ({ store }) => {
      const history = createRequestHistory({ store, encryptor });
      const at = (time: string) => new Date(`2026-10-09T${time}.000Z`);
      for (const fields of [
        // Ada, on #4, twice in the 09:00 hour: once served, once failed.
        {
          startedAt: at("09:05:00"),
          agentId: "ada",
          floorId: "web-shop",
          ownerTool: null,
          issue: 4,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
          estimatedCostUsd: 0.25,
          latencyMs: 300,
        },
        {
          startedAt: at("09:55:59"),
          agentId: "ada",
          floorId: "web-shop",
          ownerTool: null,
          issue: 4,
          status: 529,
          inputTokens: null,
          outputTokens: null,
          latencyMs: 100,
        },
        // A keep-alive of Ada's prompt cache, in the same hour (FR-39).
        {
          startedAt: at("09:57:00"),
          agentId: "ada",
          floorId: "web-shop",
          ownerTool: null,
          issue: 4,
          inputTokens: 3,
          outputTokens: 0,
          cacheReadInputTokens: 50_000,
          estimatedCostUsd: 0.125,
          latencyMs: 80,
          keepAlive: true,
        },
        // Ada again at 10:00, and refused at her cap: no account.
        {
          startedAt: at("10:00:00"),
          agentId: "ada",
          floorId: "web-shop",
          ownerTool: null,
          issue: 4,
          status: 403,
          account: null,
          inputTokens: null,
          outputTokens: null,
          latencyMs: 2,
        },
        // An Owner tool on another Model.
        {
          startedAt: at("09:30:00"),
          model: "gpt-5.5",
          account: "ChatGPT",
          inputTokens: 7,
          outputTokens: 3,
          latencyMs: 50,
        },
        // Outside the range.
        { startedAt: new Date("2026-10-10T00:00:00.000Z") },
      ]) {
        await history.record(record(fields));
      }
      const from = new Date("2026-10-09T00:00:00.000Z");
      const to = new Date("2026-10-10T00:00:00.000Z");
      const sort = (rows: readonly AnalyticsRow[]) =>
        [...rows].sort(
          (a, b) =>
            a.at.getTime() - b.at.getTime() ||
            String(a.model).localeCompare(String(b.model)) ||
            (a.account ?? "").localeCompare(b.account ?? ""),
        );
      const ada = {
        model: "claude-opus-5-5",
        floorId: "web-shop",
        agentId: "ada",
        issue: 4,
        ownerTool: null,
      };
      expect(sort(await history.analyticsRows(from, to, "hour"))).toEqual([
        {
          at: at("09:00:00"),
          account: "Work",
          ...ada,
          requests: 3,
          errors: 1,
          inputTokens: 103,
          outputTokens: 20,
          cacheReadTokens: 50_005,
          cacheWriteTokens: 3,
          estimatedCostUsd: 0.375,
          latencyMs: 480,
          timeToFirstByteMs: 150,
          timedRequests: 3,
          keepAliveRequests: 1,
          keepAliveCostUsd: 0.125,
        },
        {
          at: at("09:00:00"),
          account: "ChatGPT",
          model: "gpt-5.5",
          floorId: null,
          agentId: null,
          issue: null,
          ownerTool: "test-tool",
          requests: 1,
          errors: 0,
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0,
          latencyMs: 50,
          timeToFirstByteMs: 50,
          timedRequests: 1,
          keepAliveRequests: 0,
          keepAliveCostUsd: 0,
        },
        {
          at: at("10:00:00"),
          account: null,
          ...ada,
          requests: 1,
          errors: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0,
          latencyMs: 2,
          timeToFirstByteMs: 50,
          timedRequests: 1,
          keepAliveRequests: 0,
          keepAliveCostUsd: 0,
        },
      ]);
      // By the day: Ada's two accounts stay apart, in one bucket.
      const daily = await history.analyticsRows(from, to, "day");
      expect(daily.map((row) => row.at)).toEqual([from, from, from]);
      expect(daily.reduce((sum, row) => sum + row.requests, 0)).toBe(5);
    },
  ],
];

describe("request history, kept in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => {
      const store = memoryRequestHistoryStore();
      return run({
        store,
        sealed: (id) => Promise.resolve(store.bodies.get(id)),
      });
    });
  }
});

describe("request history, kept in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      // The Owner tool's key the Gateway's requests are made with.
      await database.db.insert(gatewayKeys).values({
        id: testCaller.keyId,
        kind: "owner_tool",
        name: testCaller.name,
        keyHash: "0".repeat(64),
        hint: "aio_gk_test",
        createdAt: new Date(),
      });
      return run({
        store: databaseRequestHistoryStore(database.db),
        async sealed(id) {
          const [row] = await database.db
            .select()
            .from(gatewayRequestBodies)
            .where(eq(gatewayRequestBodies.requestId, id));
          return row === undefined
            ? undefined
            : {
                request: row.requestBody,
                response: row.responseBody,
                truncated: row.truncated,
              };
        },
      });
    });
  }

  postgresTest("refuses a body that is not sealed", async ({ database }) => {
    const store = databaseRequestHistoryStore(database.db);
    await expect(
      store.insert(record(), () => ({
        request: "in clear",
        response: "in clear",
        truncated: false,
      })),
    ).rejects.toThrow();
  });
});
