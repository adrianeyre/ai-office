import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type EventStore,
  type OfficeEvent,
} from "@ai-office/events";
import {
  createRedactor,
  type ConnectionRules,
  type DetailLevel,
  type NewNotice,
} from "@ai-office/shared";
import { encryptorFromKey } from "@ai-office/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createCommunications, type Communications } from "./communications.ts";
import {
  digestCounts,
  digestData,
  digestSystemPrompt,
  gatewayDigestWriter,
  templateDigest,
} from "./digest.ts";
import { heldUntil, isQuiet, nextDigestAt, nextLocalTime } from "./schedule.ts";
import {
  databaseCommunicationsStore,
  memoryCommunicationsStore,
  type CommunicationsStore,
} from "./store.ts";
import { serveFakeWebhook, type FakeWebhook } from "./testing.ts";
import { defaultTransports } from "./transports/defaults.ts";
import type { WebhookBody } from "./transports/webhook.ts";

// What a Connection is told, and when (PRD FR-90, FR-92, FR-95): at its
// detail level, redacted; held in its quiet hours unless an action Notice
// is let through; and Digests, written from structured data by the
// Communications Agent's Model through the AI Gateway with its own
// Gateway Key.

/** 10:00 in London (BST), on a Saturday. */
const start = new Date("2026-10-10T09:00:00.000Z");
const publicUrl = "https://office.example.com";
const london = "Europe/London";
const communicationsKey = "aio_gk_communicationsagentkey0123456789abcdefgh";
const plantedSecret = `sk-ant-api03-${"Q".repeat(40)}`;

/** A request the fake Gateway took, and who it said made it. */
interface GatewayCall {
  /** Who its Gateway Key belongs to. */
  readonly caller: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: {
    readonly model: string;
    readonly max_tokens: number;
    readonly system: string;
    readonly messages: readonly { role: string; content: string }[];
  };
}

interface FakeGateway {
  readonly url: string;
  readonly calls: GatewayCall[];
  /** Answers the next calls with this status and message instead. */
  refuseWith(status: number, message: string): void;
  close(): Promise<void>;
}

/**
 * A fake AI Gateway: the Messages endpoint, which knows whose each
 * Gateway Key is, as the real one does (FR-42), refuses any other with a
 * 401, and answers with `reply`.
 */
async function serveFakeGateway(
  keys: Readonly<Record<string, string>>,
  reply: string,
): Promise<FakeGateway> {
  const calls: GatewayCall[] = [];
  let refusal: { status: number; message: string } | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, body: unknown) => {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      };
      const key = request.headers["x-api-key"];
      const caller = typeof key === "string" ? keys[key] : undefined;
      if (request.url !== "/v1/messages" || caller === undefined) {
        send(401, {
          type: "error",
          error: {
            type: "authentication_error",
            message: "Unknown Gateway Key.",
          },
        });
        return;
      }
      calls.push({
        caller,
        headers: request.headers,
        body: JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as GatewayCall["body"],
      });
      if (refusal !== undefined) {
        send(refusal.status, {
          type: "error",
          error: { type: "permission_error", message: refusal.message },
        });
        return;
      }
      send(200, {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
        usage: { input_tokens: 120, output_tokens: 40 },
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    calls,
    refuseWith(status, message) {
      refusal = { status, message };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const modelReply =
  "Web shop: PR #14 awaits your approval, and pull request #14 was merged.";

interface Setup {
  readonly webhook: FakeWebhook;
  readonly gateway: FakeGateway;
  readonly bus: EventBus;
  readonly agent: Communications;
  readonly advanceTo: (at: Date) => void;
  /** What the webhook received, oldest first. */
  readonly received: () => WebhookBody[];
  readonly add: (
    rules?: Partial<ConnectionRules>,
    detailLevel?: DetailLevel,
  ) => Promise<string>;
}

async function setUp(
  store: CommunicationsStore = memoryCommunicationsStore(),
  eventStore: EventStore = memoryEventStore(),
): Promise<Setup> {
  const webhook = await serveFakeWebhook();
  const gateway = await serveFakeGateway(
    { [communicationsKey]: "the Communications Agent" },
    modelReply,
  );
  servers.push(webhook, gateway);
  const clock = { time: start };
  const bus = createEventBus({ store: eventStore, now: () => clock.time });
  const raiseNotice = (notice: NewNotice) =>
    Promise.resolve({ id: `notice-${notice.title}` });
  const agent = createCommunications({
    store,
    events: bus,
    encryptor: encryptorFromKey(Buffer.alloc(32, 9)),
    transports: defaultTransports(),
    publicUrl,
    floorName: (floorId) =>
      Promise.resolve(floorId === "web-shop" ? "Web shop" : undefined),
    notice: () => Promise.resolve(undefined),
    raiseNotice,
    defaultModels: () => Promise.resolve({ Claude: "claude-haiku-5-5" }),
    agentName: () => "Reception",
    digestWriter: gatewayDigestWriter({
      url: gateway.url,
      key: () => Promise.resolve(communicationsKey),
    }),
    redactor: createRedactor(),
    now: () => clock.time,
  });
  return {
    webhook,
    gateway,
    bus,
    agent,
    advanceTo(at) {
      clock.time = at;
    },
    received: () => webhook.received.map(({ body }) => body as WebhookBody),
    async add(rules = {}, detailLevel) {
      const { id } = await agent.add({
        type: "webhook",
        name: "Webhook",
        credentials: { url: webhook.url },
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
          ...rules,
        },
        ...(detailLevel === undefined ? {} : { detailLevel }),
      });
      return id;
    },
  };
}

const actionNotice = (title = "PR #14 awaiting your approval") =>
  ({
    type: "notice.raised",
    version: 1,
    noticeId: "notice-14",
    kind: "action",
    title,
    floorId: "web-shop",
  }) satisfies OfficeEvent;

const infoNotice = {
  type: "notice.raised",
  version: 1,
  noticeId: "notice-opened",
  kind: "info",
  title: "PR #15 opened",
  floorId: "web-shop",
} satisfies OfficeEvent;

const merged = {
  type: "pull_request.merged",
  version: 1,
  floorId: "web-shop",
  issue: 4,
  pullRequest: 14,
  url: "https://github.com/adrianeyre/web-shop/pull/14",
  sha: "e".repeat(40),
  by: "app",
} satisfies OfficeEvent;

async function publish(setup: Setup, ...events: OfficeEvent[]) {
  for (const event of events) {
    await setup.bus.publish(event);
  }
  await setup.agent.takeIn();
}

/** 23:30 in London: in quiet hours from 22:00 to 07:00. */
const lateEvening = new Date("2026-10-10T22:30:00.000Z");
/** 07:00 in London the next morning, when those quiet hours end. */
const quietEnd = new Date("2026-10-11T06:00:00.000Z");
/** 08:00 in London the next morning. */
const nextMorning = new Date("2026-10-11T07:00:00.000Z");

const quietHours = (actionNotices: boolean) => ({
  quietHours: { start: "22:00", end: "07:00", timeZone: london, actionNotices },
});

describe("detail levels", () => {
  it('"links only" sends kinds and links, never a title or a Floor\'s name', async () => {
    const setup = await setUp();
    await setup.add({ infoNotices: true }, "links_only");
    await publish(setup, actionNotice(), infoNotice, merged);
    await setup.agent.deliverDue();
    const received = setup.received();
    expect(
      received.map(({ kind, title, floor, links }) => ({
        kind,
        title,
        floor,
        links,
      })),
    ).toEqual([
      {
        kind: "action_notice",
        title: "New action Notice",
        floor: null,
        links: {
          aiOffice: `${publicUrl}/notices?notice=notice-14`,
          github: null,
        },
      },
      {
        kind: "info_notice",
        title: "New info Notice",
        floor: null,
        links: {
          aiOffice: `${publicUrl}/notices?notice=notice-opened`,
          github: null,
        },
      },
      {
        kind: "work_complete",
        title: "Work complete",
        floor: null,
        links: {
          aiOffice: `${publicUrl}/activity?floorId=web-shop&issue=4`,
          github: "https://github.com/adrianeyre/web-shop/pull/14",
        },
      },
    ]);
    const sent = JSON.stringify(received);
    expect(sent).not.toContain("awaiting your approval");
    expect(sent).not.toContain("PR #15 opened");
    expect(sent).not.toContain("merged, closing");
    expect(sent).not.toContain("Web shop");
  });

  it('"titles and summaries", the default, sends the title and the Floor', async () => {
    const setup = await setUp();
    const id = await setup.add();
    expect((await setup.agent.get(id)).detailLevel).toBe(
      "titles_and_summaries",
    );
    await publish(setup, actionNotice());
    await setup.agent.deliverDue();
    expect(setup.received()[0]).toMatchObject({
      title: "PR #14 awaiting your approval",
      floor: { id: "web-shop", name: "Web shop" },
    });
  });

  it("is changed with the Connection's other settings, and told to the Activity Feed", async () => {
    const setup = await setUp();
    const id = await setup.add();
    expect(
      await setup.agent.update(id, { detailLevel: "links_only" }),
    ).toMatchObject({ detailLevel: "links_only" });
    const changed = (await setup.bus.eventsAfter(0))
      .map(({ event }) => event)
      .filter(({ type }) => type === "connection.changed");
    expect(changed).toEqual([
      expect.objectContaining({ keys: ["detailLevel"] }),
    ]);
    await publish(setup, actionNotice());
    await setup.agent.deliverDue();
    expect(setup.received()[0]?.title).toBe("New action Notice");
  });
});

describe("redaction", () => {
  it("removes a secret planted in a title from what is sent", async () => {
    const setup = await setUp();
    await setup.add();
    await publish(
      setup,
      actionNotice(`AI Account rejected key ${plantedSecret}`),
    );
    await setup.agent.deliverDue();
    const [body] = setup.received();
    expect(body?.title).toBe("AI Account rejected key [REDACTED]");
    expect(setup.webhook.received[0]?.raw).not.toContain(plantedSecret);
  });
});

describe("quiet hours", () => {
  it("hold action Notices too, unless the Owner lets them through", async () => {
    const held = await setUp();
    await held.add(quietHours(false));
    held.advanceTo(lateEvening);
    await publish(held, actionNotice());
    await held.agent.deliverDue();
    expect(held.received()).toEqual([]);

    const through = await setUp();
    await through.add(quietHours(true));
    through.advanceTo(lateEvening);
    await publish(through, actionNotice(), merged);
    expect(await through.agent.deliverDue()).toBe(1);
    expect(through.received().map(({ kind }) => kind)).toEqual([
      "action_notice",
    ]);
  });
});

describe("a Digest's data", () => {
  it("counts a Batch finished apart from pull requests merged, with its outcome", () => {
    const work = (
      outcome: "merged" | "finished",
      title: string,
    ): Parameters<typeof digestData>[0][number] => ({
      trigger: "workComplete",
      outcome,
      floorId: "web-shop",
      aboutConnectionId: null,
      message: {
        kind: "work_complete",
        title,
        floor: { id: "web-shop", name: "Web shop" },
        aiOfficeUrl: "https://office.example.com/",
        githubUrl: null,
      },
    });
    const data = digestData(
      [
        work("merged", "Pull request #14 merged, closing issue #4"),
        work("finished", "Batch 3 finished: 4 of 4 issues merged"),
      ],
      "titles_and_summaries",
      { since: new Date(0), until: new Date(3_600_000) },
    );
    expect(data.counts).toEqual({
      actionNotices: 0,
      infoNotices: 0,
      workComplete: 1,
      batchesFinished: 1,
    });
    expect(data.items.map(({ outcome }) => outcome)).toEqual([
      "merged",
      "finished",
    ]);
    expect(digestCounts(data)).toBe("1 pull request merged, 1 Batch finished");
    expect(templateDigest(data)).toContain(
      "- Web shop: Batch 3 finished: 4 of 4 issues merged",
    );
  });
});

describe("Digests", () => {
  it("are hourly on the hour, and not sent when nothing happened", async () => {
    const setup = await setUp();
    await setup.add({ workComplete: false, digest: { frequency: "hourly" } });
    setup.advanceTo(new Date("2026-10-10T10:00:00.000Z"));
    await setup.agent.deliverDue();
    expect(setup.received()).toEqual([]);
    expect(setup.gateway.calls).toEqual([]);
    await publish(setup, merged);
    setup.advanceTo(new Date("2026-10-10T10:59:00.000Z"));
    await setup.agent.deliverDue();
    expect(setup.received()).toEqual([]);
    setup.advanceTo(new Date("2026-10-10T11:00:00.000Z"));
    await setup.agent.deliverDue();
    expect(setup.received().map(({ title }) => title)).toEqual([
      "Digest: 1 pull request merged",
    ]);
  });

  it("wait out quiet hours when they fall due in them", async () => {
    const setup = await setUp();
    await setup.add({
      ...quietHours(false),
      workComplete: false,
      digest: { frequency: "hourly" },
    });
    setup.advanceTo(lateEvening);
    await publish(setup, merged);
    setup.advanceTo(new Date("2026-10-11T02:00:00.000Z"));
    await setup.agent.deliverDue();
    expect(setup.received()).toEqual([]);
    setup.advanceTo(quietEnd);
    await setup.agent.deliverDue();
    expect(setup.received().map(({ kind }) => kind)).toEqual(["digest"]);
  });

  it('at "links only" are counts and a link from a template, with no Model call', async () => {
    const setup = await setUp();
    await setup.add(
      {
        actionNotices: false,
        workComplete: false,
        digest: { frequency: "daily", at: "08:00", timeZone: london },
      },
      "links_only",
    );
    await publish(setup, actionNotice(), merged);
    setup.advanceTo(nextMorning);
    await setup.agent.deliverDue();
    expect(setup.gateway.calls).toEqual([]);
    const [digest] = setup.received();
    expect(digest).toMatchObject({
      title: "Digest: 1 action Notice, 1 pull request merged",
      summary: "Since the last Digest: 1 action Notice, 1 pull request merged.",
      links: { aiOffice: `${publicUrl}/activity` },
    });
    expect(JSON.stringify(digest)).not.toContain("awaiting your approval");
    expect(JSON.stringify(digest)).not.toContain("Web shop");
  });

  it("redact a planted secret before the Model reads it, and in what is sent", async () => {
    const setup = await setUp();
    await setup.add({
      actionNotices: false,
      digest: { frequency: "hourly" },
    });
    await publish(setup, actionNotice(`Key ${plantedSecret} was refused`));
    setup.advanceTo(new Date("2026-10-10T10:00:00.000Z"));
    await setup.agent.deliverDue();
    const content = setup.gateway.calls[0]?.body.messages[0]?.content ?? "";
    expect(content).toContain("Key [REDACTED] was refused");
    expect(content).not.toContain(plantedSecret);
    expect(setup.webhook.received[0]?.raw).not.toContain(plantedSecret);
  });

  it("come from a template when the Gateway refuses the Model call, as at a Token Cap", async () => {
    const setup = await setUp();
    await setup.add({
      actionNotices: false,
      workComplete: false,
      digest: { frequency: "hourly" },
    });
    setup.gateway.refuseWith(
      403,
      "The Communications Agent reached the office's daily Token Cap (1,000 tokens).",
    );
    await publish(setup, actionNotice(), merged);
    setup.advanceTo(new Date("2026-10-10T10:00:00.000Z"));
    await setup.agent.deliverDue();
    expect(setup.gateway.calls).toHaveLength(1);
    expect(setup.received()[0]?.summary).toBe(
      [
        "Since the last Digest: 1 action Notice, 1 pull request merged.",
        "",
        "- Web shop: PR #14 awaiting your approval",
        "- Web shop: Pull request #14 merged, closing issue #4",
      ].join("\n"),
    );
  });
});

// What a Connection's quiet hours hold and its Digests summarise is kept
// in its store, so these run with the store in memory and in Postgres 18.
type Case = [name: string, run: (setup: Setup) => Promise<void>];

const storedCases: Case[] = [
  [
    "quiet hours hold a message until they end, then send it",
    async (setup) => {
      const id = await setup.add(quietHours(false));
      setup.advanceTo(lateEvening);
      await publish(setup, merged);
      expect(await setup.agent.deliverDue()).toBe(0);
      expect(setup.received()).toEqual([]);
      expect((await setup.agent.deliveries(id))[0]).toMatchObject({
        status: "pending",
        attempts: 0,
        nextAttemptAt: quietEnd,
      });
      setup.advanceTo(new Date(quietEnd.getTime() - 60_000));
      expect(await setup.agent.deliverDue()).toBe(0);
      expect(setup.received()).toEqual([]);
      setup.advanceTo(quietEnd);
      expect(await setup.agent.deliverDue()).toBe(1);
      expect(setup.received().map(({ title }) => title)).toEqual([
        "Pull request #14 merged, closing issue #4",
      ]);
    },
  ],
  [
    "quiet hours let go at once what they no longer hold when they change",
    async (setup) => {
      const id = await setup.add(quietHours(false));
      setup.advanceTo(lateEvening);
      await publish(setup, merged);
      await setup.agent.deliverDue();
      expect(setup.received()).toEqual([]);
      const { rules } = await setup.agent.get(id);
      await setup.agent.update(id, {
        rules: { ...rules, quietHours: undefined },
      });
      await setup.agent.deliverDue();
      expect(setup.received()).toHaveLength(1);
    },
  ],
  [
    "Digests are written from structured data by the Communications Agent's Model, through the Gateway with its own key",
    async (setup) => {
      const id = await setup.add({
        actionNotices: false,
        workComplete: false,
        digest: { frequency: "daily", at: "08:00", timeZone: london },
      });
      await publish(setup, actionNotice(), infoNotice, merged);
      setup.advanceTo(new Date(nextMorning.getTime() - 60_000));
      await setup.agent.deliverDue();
      expect(setup.gateway.calls).toEqual([]);
      expect(setup.received()).toEqual([]);

      setup.advanceTo(nextMorning);
      expect(await setup.agent.deliverDue()).toBe(1);
      // One call, attributed to the Communications Agent by its own key.
      expect(setup.gateway.calls).toHaveLength(1);
      const [call] = setup.gateway.calls;
      expect(call?.caller).toBe("the Communications Agent");
      expect(call?.headers["x-api-key"]).toBe(communicationsKey);
      expect(call?.body.model).toBe("claude-haiku-5-5");
      expect(call?.body.system).toBe(digestSystemPrompt("Reception"));
      // Structured data only: titles, outcomes and counts.
      expect(call?.body.messages).toHaveLength(1);
      expect(JSON.parse(call?.body.messages[0]?.content ?? "")).toEqual({
        since: start.toISOString(),
        until: nextMorning.toISOString(),
        counts: {
          actionNotices: 1,
          infoNotices: 1,
          workComplete: 1,
          batchesFinished: 0,
        },
        items: [
          {
            kind: "Action Notice",
            floor: "Web shop",
            title: "PR #14 awaiting your approval",
            outcome: "raised",
          },
          {
            kind: "Info Notice",
            floor: "Web shop",
            title: "PR #15 opened",
            outcome: "raised",
          },
          {
            kind: "Work complete",
            floor: "Web shop",
            title: "Pull request #14 merged, closing issue #4",
            outcome: "merged",
          },
        ],
      });

      expect(setup.received()).toEqual([
        {
          id: expect.any(String) as string,
          test: false,
          kind: "digest",
          title:
            "Digest: 1 action Notice, 1 info Notice, 1 pull request merged",
          summary: modelReply,
          floor: null,
          links: { aiOffice: `${publicUrl}/activity`, github: null },
          occurredAt: nextMorning.toISOString(),
        },
      ]);
      expect((await setup.agent.deliveries(id))[0]).toMatchObject({
        status: "delivered",
        message: { kind: "digest" },
      });

      // The next one tells only of what happened since.
      await publish(setup, merged);
      setup.advanceTo(new Date(nextMorning.getTime() + 24 * 60 * 60 * 1000));
      await setup.agent.deliverDue();
      const second = JSON.parse(
        setup.gateway.calls[1]?.body.messages[0]?.content ?? "",
      ) as { counts: unknown };
      expect(second.counts).toEqual({
        actionNotices: 0,
        infoNotices: 0,
        workComplete: 1,
        batchesFinished: 0,
      });
    },
  ],
  [
    "Digests summarise what quiet hours held, instead of sending it after them",
    async (setup) => {
      const id = await setup.add({
        ...quietHours(false),
        digest: { frequency: "daily", at: "08:00", timeZone: london },
      });
      setup.advanceTo(lateEvening);
      await publish(setup, merged);
      await setup.agent.deliverDue();
      // Held for the Digest, past the end of quiet hours.
      expect((await setup.agent.deliveries(id))[0]).toMatchObject({
        status: "pending",
        nextAttemptAt: nextMorning,
      });
      setup.advanceTo(quietEnd);
      await setup.agent.deliverDue();
      expect(setup.received()).toEqual([]);
      setup.advanceTo(nextMorning);
      await setup.agent.deliverDue();
      expect(setup.received().map(({ kind }) => kind)).toEqual(["digest"]);
      expect(
        (await setup.agent.deliveries(id)).map(({ message, status }) => [
          message.kind,
          status,
        ]),
      ).toEqual([
        ["digest", "delivered"],
        ["work_complete", "summarised"],
      ]);
    },
  ],
];

describe("quiet hours and Digests, kept in memory", () => {
  for (const [name, run] of storedCases) {
    it(name, async () => {
      await run(await setUp());
    });
  }
});

describe("quiet hours and Digests, kept in Postgres 18", () => {
  for (const [name, run] of storedCases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseCommunicationsStore(database.db),
          databaseEventStore(database.db),
        ),
      );
    });
  }
});

describe("the clock of a time zone", () => {
  const hours = {
    start: "22:00",
    end: "07:00",
    timeZone: london,
    actionNotices: false,
  };

  it("tells overnight quiet hours, in summer time and out of it", () => {
    expect(isQuiet(hours, new Date("2026-10-10T20:59:00.000Z"))).toBe(false);
    expect(isQuiet(hours, new Date("2026-10-10T21:00:00.000Z"))).toBe(true);
    expect(isQuiet(hours, new Date("2026-10-11T05:59:00.000Z"))).toBe(true);
    expect(isQuiet(hours, new Date("2026-10-11T06:00:00.000Z"))).toBe(false);
    // After the clocks go back on 25 October, 22:00 is 22:00 UTC.
    expect(isQuiet(hours, new Date("2026-10-26T21:30:00.000Z"))).toBe(false);
    expect(isQuiet(hours, new Date("2026-10-26T22:00:00.000Z"))).toBe(true);
    expect(
      isQuiet(
        { ...hours, start: "09:00", end: "17:00" },
        new Date("2026-10-10T12:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("finds the next time of day across the clocks going back", () => {
    expect(
      nextLocalTime("07:00", london, new Date("2026-10-24T22:00:00.000Z")),
    ).toEqual(new Date("2026-10-25T07:00:00.000Z"));
    expect(nextLocalTime("07:00", "America/New_York", start)).toEqual(
      new Date("2026-10-10T11:00:00.000Z"),
    );
  });

  it("puts each Digest after the last, and holds only in quiet hours", () => {
    expect(
      nextDigestAt({ frequency: "hourly" }, new Date("2026-10-10T09:00:00Z")),
    ).toEqual(new Date("2026-10-10T10:00:00.000Z"));
    expect(
      nextDigestAt(
        { frequency: "daily", at: "08:00", timeZone: london },
        new Date("2026-10-11T07:00:00.000Z"),
      ),
    ).toEqual(new Date("2026-10-12T07:00:00.000Z"));
    expect(
      heldUntil({ quietHours: hours }, start, { kind: "work_complete" }, start),
    ).toBeUndefined();
    expect(
      heldUntil(
        { quietHours: hours },
        start,
        { kind: "work_complete" },
        lateEvening,
      ),
    ).toEqual(quietEnd);
    expect(
      heldUntil(
        { quietHours: { ...hours, actionNotices: true } },
        start,
        { kind: "action_notice" },
        lateEvening,
      ),
    ).toBeUndefined();
  });
});
