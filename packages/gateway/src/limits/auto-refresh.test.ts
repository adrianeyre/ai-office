// Auto-refresh (PRD FR-39): with it on, an AI Account whose usage window
// resets gets one minimal request a minute after the reset, so a new
// window starts at once rather than whenever work next arrives. Once per
// window, served or not. With a fake clock and a fake AI Provider.
import { fileURLToPath } from "node:url";

import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type EventOfType,
} from "@ai-office/events";
import type { AutoRefreshSettings } from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { describe, expect, it } from "vitest";

import {
  createAiAccounts,
  credentialContext,
  refreshTokenContext,
  type AiAccounts,
} from "../accounts/accounts.ts";
import {
  memoryAiAccountStore,
  type AiAccountRecord,
  type AiAccountStore,
} from "../accounts/store.ts";
import { readFixture, type Fixture } from "../fixtures.ts";
import { autoRefreshModel } from "./auto-refresh.ts";

const fixture = (name: string) =>
  readFixture(
    fileURLToPath(new URL(`../../fixtures/limits/${name}`, import.meta.url)),
  );
// Five-hour window 82% used, resetting at 14:00; weekly 36.4%, Monday 09:00.
const withUsage = await fixture("anthropic-subscription-usage.json");
const rateLimited = await fixture("anthropic-rate-limited.json");

const encryptor = encryptorFromKey(Buffer.alloc(32, 41));
const minute = 60_000;
const hour = 60 * minute;
const start = Date.parse("2026-10-09T12:00:00.000Z");
const fiveHourReset = new Date("2026-10-09T14:00:00.000Z");
const weeklyReset = new Date("2026-10-12T09:00:00.000Z");
const accessToken = "sk-ant-oat01-autorefreshaccesstoken-0123456789";

/** `withUsage`, its five-hour window reset at `resetsAt`, 1% used. */
const startedAt = (resetsAt: Date): Fixture => ({
  ...withUsage,
  response: {
    ...withUsage.response,
    headers: {
      ...withUsage.response.headers,
      "anthropic-ratelimit-unified-5h-utilization": "0.01",
      "anthropic-ratelimit-unified-5h-reset": String(resetsAt.getTime() / 1000),
    },
  },
});

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface Office {
  readonly accounts: AiAccounts;
  readonly store: AiAccountStore;
  readonly bus: EventBus;
  /** Every request auto-refresh sent. */
  readonly sent: Sent[];
  /** What the AI Provider answers next; unreachable when undefined. */
  answer: Fixture | undefined;
  settings: AutoRefreshSettings;
  at(ms: number): void;
  refreshed(): Promise<EventOfType<"ai_account.window_refreshed">[]>;
}

/**
 * An office with one Claude subscription, "Max", whose windows are those
 * `withUsage` reports, and auto-refresh on.
 */
async function setUp(): Promise<Office> {
  let time = start;
  const store = memoryAiAccountStore();
  const bus = createEventBus({ store: memoryEventStore() });
  const sent: Sent[] = [];
  const office: Office = {
    accounts: createAiAccounts({
      store,
      encryptor,
      events: bus,
      now: () => new Date(time),
      autoRefresh: () => office.settings,
      // Auto-refresh sends a string URL and a JSON string body.
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: input as string,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(init?.body as string),
        });
        const answer = office.answer;
        return answer === undefined
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(
              new Response(answer.response.body, {
                status: answer.response.status,
                headers: answer.response.headers,
              }),
            );
      },
    }),
    store,
    bus,
    sent,
    answer: startedAt(new Date(fiveHourReset.getTime() + 5 * hour + minute)),
    settings: { enabled: true },
    at(ms) {
      time = start + ms;
    },
    refreshed: async () =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (event): event is EventOfType<"ai_account.window_refreshed"> =>
            event.type === "ai_account.window_refreshed",
        ),
  };
  const id = "00000000-0000-4000-8000-000000000001";
  const account: AiAccountRecord = {
    id,
    name: "Max",
    accountType: "oauth",
    aiProvider: "Claude",
    credential: encryptor.encrypt(accessToken, credentialContext(id)),
    endpointUrl: null,
    region: null,
    projectId: null,
    priority: 1,
    paused: false,
    refreshToken: encryptor.encrypt(
      "sk-ant-ort01-autorefreshrefreshtoken-0123456789",
      refreshTokenContext(id),
    ),
    tokenExpiresAt: new Date(start + 24 * hour),
    reauthenticationNeeded: false,
    limitReason: null,
    limitedUntil: null,
    fiveHourUtilization: 82,
    fiveHourResetsAt: fiveHourReset,
    weeklyUtilization: 36.4,
    weeklyResetsAt: weeklyReset,
    fiveHourPauseThreshold: null,
    weeklyPauseThreshold: null,
    forcedModel: null,
    extraUsage: false,
    createdAt: new Date(start),
    updatedAt: new Date(start),
  };
  await store.add(account);
  return office;
}

const max = async (office: Office) =>
  (await office.accounts.list()).find(({ name }) => name === "Max");

/** Runs a round of auto-refresh at `ms` after 12:00. */
const roundAt = async (office: Office, ms: number) => {
  office.at(ms);
  return office.accounts.refreshWindows();
};

describe("auto-refresh", () => {
  it("starts a new window a minute after the old one resets, once per window", async () => {
    const office = await setUp();
    const id = "00000000-0000-4000-8000-000000000001";

    // Before the reset, and within the minute after it, nothing is sent.
    for (const ms of [0, 2 * hour - 1, 2 * hour, 2 * hour + minute - 1]) {
      expect(await roundAt(office, ms)).toEqual({ refreshed: [], failed: [] });
    }
    expect(office.sent).toEqual([]);

    // A minute after it: one minimal request, presented as the
    // subscription presents every request.
    expect(await roundAt(office, 2 * hour + minute)).toEqual({
      refreshed: [id],
      failed: [],
    });
    expect(office.sent).toEqual([
      {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: {
          model: autoRefreshModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "Hi" }],
        },
      },
    ]);
    // The new window is stored as it started: it resets at 19:01.
    const nextReset = new Date("2026-10-09T19:01:00.000Z");
    expect(await max(office)).toMatchObject({
      fiveHourUtilization: 1,
      fiveHourResetsAt: nextReset,
      weeklyResetsAt: weeklyReset,
      limitReason: null,
    });
    expect(await office.refreshed()).toEqual([
      {
        type: "ai_account.window_refreshed",
        version: 1,
        aiAccountId: id,
        name: "Max",
        windows: ["five_hour"],
        served: true,
        resetsAt: nextReset.toISOString(),
      },
    ]);

    // Every minute until that window resets: nothing more.
    for (
      let ms = 2 * hour + 2 * minute;
      ms <= 7 * hour + minute;
      ms += minute
    ) {
      await roundAt(office, ms);
    }
    expect(office.sent).toHaveLength(1);

    // A minute after 19:01, the next window's one request.
    office.answer = startedAt(
      new Date(nextReset.getTime() + 5 * hour + minute),
    );
    expect(await roundAt(office, 7 * hour + 2 * minute)).toEqual({
      refreshed: [id],
      failed: [],
    });
    expect(office.sent).toHaveLength(2);
    expect(await office.refreshed()).toHaveLength(2);
  });

  it("is sent once per window even when it is not served", async () => {
    const office = await setUp();
    const id = "00000000-0000-4000-8000-000000000001";

    // Unreachable: the error says nothing of the credential.
    office.answer = undefined;
    const unreachable = await roundAt(office, 2 * hour + minute);
    expect(unreachable.refreshed).toEqual([]);
    expect(unreachable.failed).toEqual([
      { id, error: new TypeError("fetch failed") },
    ]);
    expect(String(unreachable.failed[0]?.error)).not.toContain(accessToken);
    for (const ms of [2 * hour + 2 * minute, 3 * hour, 6 * hour]) {
      expect(await roundAt(office, ms)).toEqual({ refreshed: [], failed: [] });
    }
    expect(office.sent).toHaveLength(1);
    expect(await office.refreshed()).toEqual([
      expect.objectContaining({
        windows: ["five_hour"],
        served: false,
        resetsAt: null,
      }),
    ]);
  });

  it("reads a refused answer like any other, holding a rate-limited account back", async () => {
    const office = await setUp();
    office.answer = rateLimited;
    const report = await roundAt(office, 2 * hour + minute);
    expect(report.failed.map(({ error }) => String(error))).toEqual([
      "Error: The AI Provider answered auto-refresh with 429.",
    ]);
    expect((await max(office))?.limitReason).toBe("rate_limited");
    // Not sent again for the window, though the limit lifts.
    await office.accounts.checkLimits();
    await roundAt(office, 4 * hour);
    expect(office.sent).toHaveLength(1);
  });

  it("refreshes the weekly window too, once it resets", async () => {
    const office = await setUp();
    // The five-hour window is refreshed at 14:01, and again each reset.
    let nextReset = new Date(fiveHourReset.getTime() + 5 * hour + minute);
    office.answer = startedAt(nextReset);
    await roundAt(office, 2 * hour + minute);
    // Monday 09:00 passes while the five-hour window still runs (and its
    // token, refreshed meanwhile, is valid).
    await office.store.update("00000000-0000-4000-8000-000000000001", {
      updatedAt: new Date(start),
      fiveHourResetsAt: new Date(weeklyReset.getTime() + 2 * hour),
      tokenExpiresAt: new Date(weeklyReset.getTime() + 8 * hour),
    });
    nextReset = new Date(weeklyReset.getTime() + 7 * 24 * hour);
    office.answer = {
      ...withUsage,
      response: {
        ...withUsage.response,
        headers: {
          ...withUsage.response.headers,
          "anthropic-ratelimit-unified-7d-utilization": "0",
          "anthropic-ratelimit-unified-7d-reset": String(
            nextReset.getTime() / 1000,
          ),
        },
      },
    };
    const monday = weeklyReset.getTime() - start;
    await roundAt(office, monday);
    expect(office.sent).toHaveLength(1);
    await roundAt(office, monday + minute);
    expect(office.sent).toHaveLength(2);
    expect((await office.refreshed()).at(-1)).toMatchObject({
      windows: ["weekly"],
      served: true,
    });
    expect((await max(office))?.weeklyResetsAt).toEqual(nextReset);
    await roundAt(office, monday + hour);
    expect(office.sent).toHaveLength(2);
  });

  it("sends nothing while it is off, and refreshes a window that reset once it is on", async () => {
    const office = await setUp();
    office.settings = { enabled: false };
    await roundAt(office, 2 * hour + minute);
    await roundAt(office, 3 * hour);
    expect(office.sent).toEqual([]);
    expect(await office.refreshed()).toEqual([]);

    office.settings = { enabled: true };
    await roundAt(office, 3 * hour + minute);
    expect(office.sent).toHaveLength(1);
  });

  it("starts a rate-limited account's next window once its limit resets, lifting it", async () => {
    const office = await setUp();
    const id = "00000000-0000-4000-8000-000000000001";
    // Rate-limited until its five-hour window resets at 14:00; the
    // minute's check has not lifted the stored limit yet.
    await office.store.update(id, {
      updatedAt: new Date(start),
      limitReason: "rate_limited",
      limitedUntil: fiveHourReset,
    });
    await roundAt(office, 2 * hour);
    expect(office.sent).toEqual([]);
    expect(await roundAt(office, 2 * hour + minute)).toEqual({
      refreshed: [id],
      failed: [],
    });
    // Serving lifts the limit, and the new window is stored.
    expect(await max(office)).toMatchObject({
      limitReason: null,
      limitedUntil: null,
      fiveHourResetsAt: new Date("2026-10-09T19:01:00.000Z"),
    });
  });

  it("does not refresh a window a request has already started", async () => {
    const office = await setUp();
    // An Agent's request at 14:00:30 started the next window.
    office.at(2 * hour + 30_000);
    const account = await office.accounts.select({
      agentTool: "Claude Code",
      forcedAccount: "Max",
    });
    if (account === undefined) {
      throw new Error("No account Max.");
    }
    await office.accounts.report(
      account,
      { kind: "served" },
      {
        five_hour: {
          utilization: 3,
          resetsAt: new Date(fiveHourReset.getTime() + 5 * hour),
        },
      },
    );
    await roundAt(office, 2 * hour + minute);
    await roundAt(office, 4 * hour);
    expect(office.sent).toEqual([]);
  });

  it("waits while an account is paused, held back or signed out, and leaves accounts without windows be", async () => {
    const office = await setUp();
    const id = "00000000-0000-4000-8000-000000000001";
    // An API key reports no windows: it is never sent one.
    await office.accounts.add({
      name: "Key",
      aiProvider: "Claude",
      accountType: "api_key",
      credential: "sk-ant-api03-autorefreshkey-0123456789abcdef",
    });

    await office.accounts.update(id, { paused: true });
    await roundAt(office, 2 * hour + minute);
    await office.accounts.update(id, { paused: false });
    await office.store.update(id, {
      updatedAt: new Date(start),
      reauthenticationNeeded: true,
    });
    await roundAt(office, 2 * hour + 2 * minute);
    await office.store.update(id, {
      updatedAt: new Date(start),
      reauthenticationNeeded: false,
      limitReason: "overloaded",
      limitedUntil: new Date(start + 2 * hour + 4 * minute),
    });
    await roundAt(office, 2 * hour + 3 * minute);
    expect(office.sent).toEqual([]);

    // Free again: the window that reset gets its one request.
    await roundAt(office, 2 * hour + 4 * minute);
    expect(office.sent).toHaveLength(1);
    await roundAt(office, 2 * hour + 5 * minute);
    expect(office.sent).toHaveLength(1);
  });
});
